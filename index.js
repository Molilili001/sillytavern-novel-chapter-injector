/*
 * 小说章节自动注入器
 * Novel Chapter Injector
 *
 * 功能：导入一个 txt 小说，按第X章切分；每轮请求后（或手动触发），
 *       把当前章节内容写入「聊天局部变量」，供预设里用 {{getvar::变量名}} 读取。
 *
 * 持久化策略（重启不丢）：
 *   - 章节数组 + 进度：存进 extensionSettings[MODULE_NAME]，随酒馆 settings.json 落到服务器。
 *   - 当前章内容 + 进度：写进聊天局部变量 chatMetadata.variables，供 {{getvar::}} 读取。
 *
 * 变量写入走 SillyTavern 核心的 STScript 聊天局部变量：
 *   getContext().chatMetadata.variables[name] = value，然后 saveMetadata()。
 *   {{getvar::name}} 读的就是这个存储（官方权威依据：SillyTavern/Extension-Variables 示例插件）。
 *
 * 依赖边界（重要）：
 *   - 聊天局部变量是酒馆核心自带的，不依赖 Tavern Helper。
 *   - 所有标了 [RUNTIME-CHECK] 的符号，均需在目标酒馆版本里确认确切拼写。
 */
(function () {
  'use strict';

  const MODULE_NAME = 'novel-chapter-injector';
  // 酒馆 Git 导入时，扩展目录名 = 仓库名。此值必须与实际安装目录一致，否则模板读不到。
  const EXTENSION_FOLDER_NAME = 'sillytavern-novel-chapter-injector';

  // —— 默认设置 ——
  const DEFAULT_SETTINGS = Object.freeze({
    // 分割模式：'chapter' 按章节切，'char' 按字数切
    splitMode: 'char',
    // 字数分割模式下每段多少字
    splitSize: 10000,
    // 章节分隔符：'第' 表示按行首「第X章/回/卷/部」切
    chapterSeparator: '第',
    // 目标变量名（章节内容写入这里，供 {{getvar::变量名}} 读取）
    variableName: 'current_chapter',
    // 进度索引变量名（记录读到第几章）
    indexVariableName: 'current_chapter_index',
    // 每次注入多少章（1=单章，3=一次拼 3 章）
    batchSize: 1,
    // 是否在请求发出后自动推进
    autoAdvance: true,
    // 循环模式：读到最后一章后，下一次从头开始，而不是停下
    loopMode: false,
    // 手动注入模式：在输入框上方挂一个按钮，点一下注入一段，自动推进失效
    manualMode: false,
  });

  let ctx = null;
  let renderExtensionTemplateAsync = null;
  let renderExtensionTemplate = null; // 同步版 fallback（低版本兼容）
  let extensionSettings = null;
  let saveSettingsDebounced = null;
  let saveMetadata = null;
  let localforage = null;
  let eventSource = null;
  let eventTypes = null;
  let autoAdvanceHandler = null;

  // —— 运行时状态 ——
  const state = {
    chapters: [],
    index: 0,
    chatId: null, // 当前 index 属于哪个聊天（多聊天进度隔离）
    detectedFormat: '', // 导入时自动检测到的章节格式（如「第X章」），空串表示未检测到
  };

  // 输入框上方的手动注入按钮（动态挂载，切换聊天后靠 keeper 自动找回位置）
  let injectButton = null;
  let injectButtonKeeper = null;
  let initialized = false;

  // —— 设置读写（走酒馆 extensionSettings）——
  function getSettings() {
    if (!extensionSettings[MODULE_NAME]) {
      extensionSettings[MODULE_NAME] = structuredClone(DEFAULT_SETTINGS);
    }
    for (const key of Object.keys(DEFAULT_SETTINGS)) {
      if (!Object.hasOwn(extensionSettings[MODULE_NAME], key)) {
        extensionSettings[MODULE_NAME][key] = DEFAULT_SETTINGS[key];
      }
    }
    return extensionSettings[MODULE_NAME];
  }

  function persistSettings() {
    if (typeof saveSettingsDebounced === 'function') saveSettingsDebounced();
  }

  // —— 当前聊天 ID：进度按聊天隔离，正文变量本就是每张聊天独立的 ——
  function getCurrentChatId() {
    try {
      const context = window.SillyTavern && window.SillyTavern.getContext
        ? window.SillyTavern.getContext()
        : null;
      if (context) {
        if (typeof context.getCurrentChatId === 'function') {
          const id = context.getCurrentChatId();
          if (id) return String(id);
        }
        if (context.chatId) return String(context.chatId);
      }
    } catch (e) {
      /* 静默 */
    }
    return 'default';
  }

  // —— 章节持久化：存 localforage（官方推荐的大块数据存储，IndexedDB）——
  // 官方文档明确禁止往 extensionSettings 塞大块数据，应改用 localforage。
  // 存 localforage 独立于 settings.json，重启不丢，容量大。
  // 章节数组全局共享（同一本小说）；进度 index 按当前聊天 ID 分开存，避免多聊天串档。
  async function loadChapters() {
    if (!localforage) return;
    try {
      const chapters = await localforage.getItem(MODULE_NAME + ':chapters');
      if (Array.isArray(chapters) && chapters.length) {
        state.chapters = chapters;
      }
      const fmt = await localforage.getItem(MODULE_NAME + ':detectedFormat');
      if (typeof fmt === 'string' && fmt) state.detectedFormat = fmt;
      await loadIndexForCurrentChat();
    } catch (e) {
      /* 静默 */
    }
  }

  async function loadIndexForCurrentChat() {
    if (!localforage) return;
    try {
      const chatId = getCurrentChatId();
      const index = await localforage.getItem(MODULE_NAME + ':index:' + chatId);
      state.index = Number(index) || 0;
      state.chatId = chatId;
    } catch (e) {
      /* 静默 */
    }
  }

  async function saveChapters() {
    if (!localforage) return;
    try {
      await localforage.setItem(MODULE_NAME + ':chapters', state.chapters);
      await localforage.setItem(MODULE_NAME + ':detectedFormat', state.detectedFormat || '');
      await saveIndexForCurrentChat();
    } catch (e) {
      renderStatus('持久化失败：' + (e && e.message ? e.message : e));
    }
  }

  async function saveIndexForCurrentChat() {
    if (!localforage) return;
    try {
      const chatId = getCurrentChatId();
      await localforage.setItem(MODULE_NAME + ':index:' + chatId, state.index);
      state.chatId = chatId;
    } catch (e) {
      /* 静默 */
    }
  }

  // 切换聊天后首次推进前，重新加载对应聊天的进度
  async function ensureIndexLoaded() {
    if (state.chatId !== getCurrentChatId()) {
      await loadIndexForCurrentChat();
    }
  }

  // —— 中文小说章节标题识别 ——
  // 覆盖常见网文格式：
  //   第X章/回/卷/部/节/篇/集/幕/话（阿拉伯、全角、中文数字混用）
  //   特殊标题词：序章/楔子/引子/前言/终章/尾声/番外/外传等
  //   纯数字序号：1. 01、1）(1) 1：
  //   中文序号：一、 （一） 一．
  const CN_NUM_CHARS = '零〇一二三四五六七八九十百千万两';
  const HEADING_DI_RE = new RegExp('^第[0-9０-９' + CN_NUM_CHARS + ']+[章节回卷部篇集幕話话](?:\\s|[:：.、．]|$)');
  const HEADING_SPECIAL_RE = /^(序章|序言|楔子|引子|前言|自序|终章|尾声|后记|番外(?:篇)?|外传|卷首语)(?:\s|[:：.、．]|$)/;
  const HEADING_NUM_RE = /^\s*[0-9０-９]+\s*[.、．·:：)）]/;
  const HEADING_CNNUM_RE = /^\s*[（(]?[一二三四五六七八九十百千万零〇]+\s*[、.．)）]/;
  // 章节式标题（第X章 + 序章/番外等特殊词）合用的切分正则
  const HEADING_DI_SPECIAL_RE = new RegExp(
    '^(?:第[0-9０-９' + CN_NUM_CHARS + ']+[章节回卷部篇集幕話话]|序章|序言|楔子|引子|前言|自序|终章|尾声|后记|番外(?:篇)?|外传|卷首语)(?:\\s|[:：.、．]|$)'
  );

  // 判断某行是否为任意章节标题行（用于目录标题提取）
  function isHeadingLine(line) {
    return HEADING_DI_RE.test(line) || HEADING_SPECIAL_RE.test(line) || HEADING_NUM_RE.test(line) || HEADING_CNNUM_RE.test(line);
  }

  // 扫描全文，判断属于哪种章节格式；检测不到返回 mode:'char' 让上层降级
  function detectChapterFormat(text) {
    const clean = (text || '').replace(/\r\n/g, '\n').trim();
    const empty = { mode: 'char', label: '', count: 0, headingRe: null };
    if (!clean) return empty;
    let di = 0;
    let special = 0;
    let num = 0;
    let cnnum = 0;
    for (const raw of clean.split('\n')) {
      const line = raw.trim();
      if (!line) continue;
      if (HEADING_DI_RE.test(line)) { di++; continue; }
      if (HEADING_SPECIAL_RE.test(line)) { special++; continue; }
      if (HEADING_NUM_RE.test(line)) { num++; continue; }
      if (HEADING_CNNUM_RE.test(line)) cnnum++;
    }
    if (di + special >= 2) {
      return { mode: 'chapter', label: '第X章/序章等标题', count: di + special, headingRe: HEADING_DI_SPECIAL_RE };
    }
    if (num >= 3) return { mode: 'chapter', label: '数字序号', count: num, headingRe: HEADING_NUM_RE };
    if (cnnum >= 3) return { mode: 'chapter', label: '中文序号', count: cnnum, headingRe: HEADING_CNNUM_RE };
    return empty;
  }

  // —— 文本切分（导入时自动检测章节格式，检测不到再走字数切分）——
  function splitChapters(text) {
    const detected = detectChapterFormat(text);
    if (detected.mode === 'chapter') {
      state.detectedFormat = detected.label;
      return { chapters: splitByChapter(text, detected.headingRe), detected: detected, fallback: false };
    }
    state.detectedFormat = '';
    // 用户手动选了「按章节」却检测不到标题，算降级，导入后要提示
    const manualChapter = (getSettings().splitMode || 'char') === 'chapter';
    return { chapters: splitBySize(text), detected: detected, fallback: manualChapter };
  }

  // 章节模式：按标题行切，支持第X章/序章/番外/数字序号/中文序号
  function splitByChapter(text, headingRe) {
    const clean = (text || '').replace(/\r\n/g, '\n').trim();
    if (!clean) return [];
    const re = headingRe || HEADING_DI_SPECIAL_RE;
    const parts = [];
    let cur = [];
    for (const line of clean.split('\n')) {
      if (re.test(line.trim())) {
        if (cur.join('\n').trim()) parts.push(cur.join('\n'));
        cur = [line];
      } else {
        cur.push(line);
      }
    }
    if (cur.join('\n').trim()) parts.push(cur.join('\n'));
    return parts.map((s) => s.trim()).filter(Boolean);
  }

  // 字数模式：按目标字数切，尽量在句末/换行处断开，避免拦腰斩句
  function splitBySize(text) {
    let size = Number(getSettings().splitSize);
    if (!Number.isFinite(size) || size < 1) size = 10000;
    size = Math.floor(size);

    const clean = text.replace(/\r\n/g, '\n').trim();
    if (!clean) return [];
    if (clean.length <= size) return [clean];

    const chunks = [];
    let start = 0;
    const total = clean.length;
    while (start < total) {
      let end = Math.min(start + size, total);
      if (end < total) {
        // 在 [start + size*0.5, end] 内找最近的断点（换行优先，其次句末标点）
        const windowStart = Math.floor(start + size * 0.5);
        const slice = clean.slice(windowStart, end);
        let best = -1;
        const nl = slice.lastIndexOf('\n');
        if (nl >= 0) best = windowStart + nl + 1;
        const punctRe = /[。！？!?；;]/g;
        let m;
        while ((m = punctRe.exec(slice)) !== null) {
          best = windowStart + m.index + 1;
        }
        if (best > start && best < end) end = best;
      }
      chunks.push(clean.slice(start, end).trim());
      start = end;
    }
    return chunks.filter(Boolean);
  }

  // —— 文件导入（支持自动嗅探 GBK / UTF-8）——
  function importFile(file) {
    const reader = new FileReader();
    reader.onload = async () => {
      const buffer = reader.result;
      let text = '';
      try {
        // 优先尝试严格 UTF-8 解码。如果遇到非法字节会抛错，直接跳到 catch
        const utf8Decoder = new TextDecoder('utf-8', { fatal: true });
        text = utf8Decoder.decode(buffer);
      } catch (e) {
        // 不是纯净 UTF-8，大概率是 GBK/GB2312。用 gb18030 兜底。
        // 为什么用 gb18030 而不是 gbk：gb18030 是标准强制支持的编码标签，
        // 且兼容 GBK/GB2312，浏览器兼容性最稳。
        try {
          const gbDecoder = new TextDecoder('gb18030');
          text = gbDecoder.decode(buffer);
        } catch (e2) {
          // 极端兜底：连 gb18030 都不支持时，用宽松 UTF-8 解，至少不崩
          const looseDecoder = new TextDecoder('utf-8');
          text = looseDecoder.decode(buffer);
        }
      }

      const splitResult = splitChapters(text);
      state.chapters = splitResult.chapters;
      state.index = 0;
      state.chatId = null;
      await saveChapters();
      if (splitResult.detected.mode === 'chapter') {
        renderStatus('已导入 ' + state.chapters.length + ' 章（检测到章节格式：' + splitResult.detected.label + '，共 ' + splitResult.detected.count + ' 个标题）');
      } else if (splitResult.fallback) {
        renderStatus('未检测到章节标题，已降级按字数切分，共 ' + state.chapters.length + ' 段');
      } else {
        renderStatus('已导入 ' + state.chapters.length + ' 段（未检测到章节标题，按字数切分）');
      }
      renderToc();
      renderChapterPreview();
      // 导入后立即注入第一段，保证第一条消息时 {{getvar::}} 已就位
      await advanceChapter();
    };
    reader.onerror = () => renderStatus('读取文件失败');
    // 核心：改用 readAsArrayBuffer，不让浏览器瞎猜编码，自己拿原始字节解码
    reader.readAsArrayBuffer(file);
  }

  // —— 变量读写（写 STScript 聊天局部变量：chatMetadata.variables）——
  // 官方权威依据：SillyTavern/Extension-Variables 示例插件。
  // {{getvar::name}} 读的就是 getContext().chatMetadata.variables[name]。
  // 注意：chatMetadata 引用会在切换聊天时失效，所以每次都要重新取。
  function getChatVariables() {
    const context = window.SillyTavern && window.SillyTavern.getContext
      ? window.SillyTavern.getContext()
      : null;
    if (!context || !context.chatMetadata) return null;
    if (!context.chatMetadata.variables) context.chatMetadata.variables = {};
    return context.chatMetadata.variables;
  }

  async function writeChapterToVariable(content) {
    try {
      const vars = getChatVariables();
      if (!vars) {
        renderStatus('拿不到聊天元数据，写入失败');
        return false;
      }
      vars[getSettings().variableName] = content;
      if (typeof saveMetadata === 'function') await saveMetadata();
      return true;
    } catch (e) {
      renderStatus('写入变量失败：' + (e && e.message ? e.message : e));
      return false;
    }
  }

  async function writeIndexToVariable(idx) {
    try {
      const vars = getChatVariables();
      if (!vars) return;
      vars[getSettings().indexVariableName] = String(idx);
      if (typeof saveMetadata === 'function') await saveMetadata();
    } catch (e) {
      /* 静默 */
    }
  }

  // —— 推进章节（支持批量：一次注入 N 章；支持循环：读完从头开始）——
  async function advanceChapter(options = {}) {
    if (!state.chapters.length) {
      renderStatus('尚未导入小说');
      return;
    }
    await ensureIndexLoaded();
    let size = Number(getSettings().batchSize);
    if (!Number.isFinite(size) || size < 1) size = 1;
    size = Math.floor(size);

    let start = state.index;
    if (start >= state.chapters.length) {
      // 读完了：开启循环模式就回到开头，否则停下
      if (getSettings().loopMode) {
        start = 0;
      } else {
        renderStatus('已读完最后一' + unitWord());
        return;
      }
    }
    const end = Math.min(start + size, state.chapters.length);

    // 取 [start, end) 这几章，用空行拼接
    const batch = state.chapters.slice(start, end);
    const content = batch.join('\n\n');

    const ok = await writeChapterToVariable(content);
    if (ok) {
      const newIdx = end;
      state.index = newIdx;
      await saveChapters();
      await writeIndexToVariable(newIdx);
      let msg = '已注入第 ' + (start + 1) + ' ~ ' + newIdx + ' ' + unitWord() + '（共 ' + batch.length + ' ' + unitWord() + '）';
      if (getSettings().loopMode && newIdx >= state.chapters.length) {
        msg += '，已到末尾，下次从头开始';
      }
      renderStatus(msg);
      renderChapterPreview();
      syncTocSelection();
      // 手动注入时给用户明确的成功反馈（toast 气泡 + 按钮文字闪一下）
      if (options.toast) notifyInjected(msg);
    }
  }

  // —— 注入成功提醒：手动注入时给用户明确反馈 ——
  // 优先用酒馆自带的 toastr（屏幕右上角气泡），不可用时退回改按钮文字。
  function notifyInjected(msg) {
    try {
      if (window.toastr && typeof window.toastr.success === 'function') {
        window.toastr.success(msg, '注入成功');
      }
    } catch (e) {
      /* 静默 */
    }
    // 按钮层面反馈：短暂变成功文字，给不看右上角的人兜底
    const btn = injectButton;
    if (btn) {
      const original = btn.textContent;
      btn.textContent = '✅ 已注入';
      btn.classList.add('nci-inject-ok');
      setTimeout(() => {
        if (btn.textContent === '✅ 已注入') btn.textContent = original;
        btn.classList.remove('nci-inject-ok');
      }, 1600);
    }
  }

  // —— 模板渲染兼容层：优先 async，低版本退回同步版 ——
  function renderTemplate(folderPath, templateName, data) {
    if (typeof renderExtensionTemplateAsync === 'function') {
      return renderExtensionTemplateAsync(folderPath, templateName, data);
    }
    if (typeof renderExtensionTemplate === 'function') {
      // 同步版已 deprecated，但老版本只有它。返回 Promise 统一调用方式。
      return Promise.resolve(renderExtensionTemplate(folderPath, templateName, data));
    }
    return Promise.reject(new Error('renderExtensionTemplate 不可用'));
  }

  // —— 单位词：章节模式叫「章」，字数模式叫「段」——
  function unitWord() {
    if (state.detectedFormat) return '章';
    return getSettings().splitMode === 'char' ? '段' : '章';
  }

  // —— 面板渲染 ——
  function renderStatus(msg) {
    const el = document.getElementById('nci-status');
    if (el) el.textContent = msg;
  }

  function renderChapterPreview() {
    const el = document.getElementById('nci-preview');
    if (!el) return;
    if (state.index >= state.chapters.length) {
      // 读到末尾：循环模式预告从第一段重来，否则提示已读完
      if (getSettings().loopMode && state.chapters.length) {
        const first = state.chapters[0] || '';
        el.textContent = '（已读完，下次从第一' + unitWord() + '重新开始）\n' + (first.length > 200 ? first.slice(0, 200) + '…' : first);
      } else {
        el.textContent = '已读完最后一' + unitWord() + '，全文结束';
      }
      return;
    }
    const cur = state.chapters[state.index] || '';
    el.textContent = cur.length > 200 ? cur.slice(0, 200) + '…' : cur;
  }

  // —— 目录：提取每段的标题（标题行或段开头若干字）——
  function getChapterTitle(idx) {
    const ch = state.chapters[idx];
    if (!ch) return '';
    const firstLine = ch.split('\n').map((s) => s.trim()).find(Boolean) || '';
    const t = firstLine || ch.trim();
    if (isHeadingLine(t)) {
      return t.length > 28 ? t.slice(0, 28) + '…' : t;
    }
    const flat = t.replace(/\s+/g, ' ');
    return flat.length > 20 ? flat.slice(0, 20) + '…' : flat;
  }

  function renderToc() {
    const sel = document.getElementById('nci-toc');
    if (!sel) return;
    const prev = sel.value;
    sel.innerHTML = '';
    const ph = document.createElement('option');
    ph.value = '';
    ph.textContent = '—— 选择要跳转的段落 ——';
    sel.appendChild(ph);
    state.chapters.forEach((ch, i) => {
      const opt = document.createElement('option');
      opt.value = String(i + 1);
      opt.textContent = (i + 1) + '. ' + getChapterTitle(i);
      sel.appendChild(opt);
    });
    if (prev && [...sel.options].some((o) => o.value === prev)) sel.value = prev;
  }

  // 同步目录下拉的选中项到当前进度（注入后调用）
  function syncTocSelection() {
    const sel = document.getElementById('nci-toc');
    if (!sel) return;
    const v = String(state.index);
    if (state.index >= 1 && [...sel.options].some((o) => o.value === v)) sel.value = v;
  }

  // —— 手动跳转：定位到第 N 段并注入，进度推进到 N+1 ——
  async function jumpToIndex(n) {
    if (!state.chapters.length) {
      renderStatus('尚未导入小说');
      return;
    }
    if (!Number.isFinite(n) || n < 1 || n > state.chapters.length) {
      renderStatus('段号超出范围（1 ~ ' + state.chapters.length + '）');
      return;
    }
    state.index = n - 1;
    await saveChapters();
    await advanceChapter({ toast: true });
  }

  async function renderPanel() {
    if (!renderExtensionTemplateAsync && !renderExtensionTemplate) return;
    // 移除旧面板，防止重复 init 时 DOM 重复、事件绑到旧节点
    const oldDrawer = document.getElementById('nci-drawer');
    if (oldDrawer) oldDrawer.remove();
    const settings = getSettings();
    // 模板是 Handlebars 语法（{{var}}），路径用扩展目录名。
    const html = await renderTemplate(
      'third-party/' + EXTENSION_FOLDER_NAME,
      'settings',
      {
        variableName: settings.variableName,
        splitMode: settings.splitMode,
        splitSize: settings.splitSize,
        chapterSeparator: settings.chapterSeparator,
        indexVariableName: settings.indexVariableName,
        batchSize: settings.batchSize,
        autoAdvance: settings.autoAdvance,
        loopMode: settings.loopMode,
        manualMode: settings.manualMode,
      }
    );
    const target = document.getElementById('extensions_settings') || document.body;
    target.insertAdjacentHTML('beforeend', html);

    bindEvents();
    await loadChapters();
    updateSettingsVisibility();
    if (state.chapters.length) {
      renderStatus('已恢复 ' + state.chapters.length + ' ' + unitWord() + '（当前第 ' + (state.index + 1) + ' ' + unitWord() + '）');
    } else {
      renderStatus('未导入');
    }
    renderChapterPreview();
    renderToc();
    ensureManualInjectButton();
  }

  // —— 根据当前设置，动态显示/隐藏相关设置行 ——
  function updateSettingsVisibility() {
    const mode = getSettings().splitMode || 'char';
    const sizeRow = document.getElementById('nci-row-splitsize');
    const sepRow = document.getElementById('nci-row-sep');
    if (sizeRow) sizeRow.style.display = (mode === 'char') ? '' : 'none';
    if (sepRow) sepRow.style.display = (mode === 'chapter') ? '' : 'none';

    // 手动注入模式开启时，提示自动推进已失效；反之亦然
    const autoHint = document.getElementById('nci-auto-hint');
    const manualHint = document.getElementById('nci-manual-hint');
    const settings = getSettings();
    if (autoHint) autoHint.style.display = settings.manualMode ? '' : 'none';
    if (manualHint) manualHint.style.display = settings.autoAdvance ? '' : 'none';
  }

  function bindEvents() {
    const fileInput = document.getElementById('nci-file');
    const importBtn = document.getElementById('nci-import-btn');
    const varInput = document.getElementById('nci-var');
    const splitModeSel = document.getElementById('nci-splitmode');
    const splitSizeInput = document.getElementById('nci-splitsize');
    const sepInput = document.getElementById('nci-sep');
    const idxInput = document.getElementById('nci-idxvar');
    const batchInput = document.getElementById('nci-batch');
    const nextBtn = document.getElementById('nci-next');
    const autoCheck = document.getElementById('nci-auto');
    const manualCheck = document.getElementById('nci-manual');
    const loopCheck = document.getElementById('nci-loop');
    const tocSel = document.getElementById('nci-toc');
    const jumpInput = document.getElementById('nci-jump');
    const jumpBtn = document.getElementById('nci-jump-btn');

    // 点醒目的「导入」按钮，触发隐藏的 file input 打开文件选择框。
    if (importBtn && fileInput) {
      importBtn.addEventListener('click', () => fileInput.click());
    }
    if (fileInput) {
      fileInput.addEventListener('change', (e) => {
        const f = e.target.files && e.target.files[0];
        if (f) importFile(f);
        e.target.value = '';
      });
    }
    if (varInput) {
      varInput.addEventListener('change', () => {
        getSettings().variableName = varInput.value.trim() || 'current_chapter';
        persistSettings();
      });
    }
    if (splitModeSel) {
      splitModeSel.value = getSettings().splitMode || 'char';
      splitModeSel.addEventListener('change', () => {
        getSettings().splitMode = splitModeSel.value === 'char' ? 'char' : 'chapter';
        persistSettings();
        updateSettingsVisibility();
      });
    }
    if (splitSizeInput) {
      splitSizeInput.value = String(getSettings().splitSize || 10000);
      splitSizeInput.addEventListener('change', () => {
        let n = Number(splitSizeInput.value);
        if (!Number.isFinite(n) || n < 1) n = 10000;
        getSettings().splitSize = Math.floor(n);
        persistSettings();
      });
    }
    if (sepInput) {
      sepInput.addEventListener('change', () => {
        getSettings().chapterSeparator = sepInput.value || '第';
        persistSettings();
      });
    }
    if (idxInput) {
      idxInput.addEventListener('change', () => {
        getSettings().indexVariableName = idxInput.value.trim() || 'current_chapter_index';
        persistSettings();
      });
    }
    if (batchInput) {
      batchInput.value = String(getSettings().batchSize);
      batchInput.addEventListener('change', () => {
        let n = Number(batchInput.value);
        if (!Number.isFinite(n) || n < 1) n = 1;
        getSettings().batchSize = Math.floor(n);
        persistSettings();
      });
    }
    if (nextBtn) {
      nextBtn.addEventListener('click', () => advanceChapter());
    }

    // —— 目录下拉 + 手动跳转 ——
    if (tocSel) {
      tocSel.addEventListener('change', () => {
        const n = Number(tocSel.value);
        if (n >= 1) jumpToIndex(n);
      });
    }
    if (jumpBtn && jumpInput) {
      const doJump = () => jumpToIndex(Number(jumpInput.value));
      jumpBtn.addEventListener('click', doJump);
      jumpInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') doJump();
      });
    }

    // —— 推进模式：自动推进 / 手动注入 互斥 ——
    if (autoCheck) {
      autoCheck.checked = !!getSettings().autoAdvance;
      autoCheck.addEventListener('change', () => {
        getSettings().autoAdvance = autoCheck.checked;
        if (autoCheck.checked) {
          // 开自动推进就关手动注入
          getSettings().manualMode = false;
          if (manualCheck) manualCheck.checked = false;
        }
        persistSettings();
        updateSettingsVisibility();
        ensureManualInjectButton();
      });
    }
    if (manualCheck) {
      manualCheck.checked = !!getSettings().manualMode;
      manualCheck.addEventListener('change', () => {
        getSettings().manualMode = manualCheck.checked;
        if (manualCheck.checked) {
          // 开手动注入就关自动推进
          getSettings().autoAdvance = false;
          if (autoCheck) autoCheck.checked = false;
        }
        persistSettings();
        updateSettingsVisibility();
        ensureManualInjectButton();
      });
    }
    if (loopCheck) {
      loopCheck.checked = !!getSettings().loopMode;
      loopCheck.addEventListener('change', () => {
        getSettings().loopMode = loopCheck.checked;
        persistSettings();
      });
    }
  }

  // —— 手动注入按钮：挂在输入框（#send_textarea）上方 ——
  // 酒馆输入区结构：#send_form（flex + flex-wrap:wrap）> #nonQRFormItems（横向 flex）> textarea。
  // 若把按钮插进 #nonQRFormItems，会跟 textarea 挤在同一行，所以必须放进 #send_form 顶部，
  // 再靠 flex-basis:100% 换行，独占输入栏最上面一行。
  function ensureManualInjectButton() {
    const enabled = getSettings().manualMode;
    if (!enabled) {
      if (injectButton && injectButton.parentElement) {
        injectButton.parentElement.removeChild(injectButton);
      }
      injectButton = null;
      return;
    }

    if (!injectButton) {
      injectButton = document.createElement('button');
      injectButton.type = 'button';
      injectButton.id = 'nci-inject-btn';
      injectButton.className = 'menu_button nci-inject-btn';
      injectButton.textContent = '📖 注入下一段';
      injectButton.addEventListener('click', () => advanceChapter({ toast: true }));
    }

    // 首选：插到 #send_form 顶部（输入栏最上方，独占一行）
    const form = document.getElementById('send_form');
    if (form) {
      if (injectButton.parentElement !== form) {
        form.insertBefore(injectButton, form.firstChild);
      }
      return;
    }

    // 兜底：找不到 #send_form 时，退回 textarea 的父容器顶部
    const anchor = document.getElementById('send_textarea');
    if (anchor && anchor.parentElement && injectButton.parentElement !== anchor.parentElement) {
      anchor.parentElement.insertBefore(injectButton, anchor.parentElement.firstChild);
    }
  }

  function startInjectButtonKeeper() {
    if (injectButtonKeeper) return;
    injectButtonKeeper = setInterval(() => {
      // 只在手动注入模式开启时才检查，成本极低
      if (getSettings().manualMode) ensureManualInjectButton();
    }, 1500);
  }

  // —— 自动推进事件监听 ——
  // 官方 API：getContext().eventSource.on(event_types.XXX, handler)
  // 在「生成完成」后推进下一章，这样下一轮请求读到的就是新章节。
  function registerAutoAdvance() {
    if (!eventSource || !eventTypes) {
      renderStatus('事件源不可用，自动注入失效，请用手动按钮');
      return;
    }
    if (autoAdvanceHandler) return; // 防止重复绑定
    autoAdvanceHandler = () => {
      // 手动注入模式下，自动推进失效
      if (getSettings().manualMode) return;
      if (getSettings().autoAdvance) advanceChapter();
    };
    // [RUNTIME-CHECK] event_types 里的确切常量名按 ST 版本确认，常见为 GENERATION_ENDED。
    // 找不到 GENERATION_ENDED 时退回 MESSAGE_RECEIVED。
    const evt = eventTypes.GENERATION_ENDED || eventTypes.MESSAGE_RECEIVED;
    if (!evt) {
      renderStatus('事件常量缺失，自动注入失效');
      return;
    }
    eventSource.on(evt, autoAdvanceHandler);
  }

  function unregisterAutoAdvance() {
    if (eventSource && autoAdvanceHandler) {
      const evt = eventTypes && (eventTypes.GENERATION_ENDED || eventTypes.MESSAGE_RECEIVED);
      if (evt) eventSource.off(evt, autoAdvanceHandler);
    }
    autoAdvanceHandler = null;
  }

  // —— 清理资源：事件监听 + 定时器 + 挂载的按钮 ——
  function cleanup() {
    unregisterAutoAdvance();
    if (injectButtonKeeper) {
      clearInterval(injectButtonKeeper);
      injectButtonKeeper = null;
    }
    if (injectButton && injectButton.parentElement) {
      injectButton.parentElement.removeChild(injectButton);
    }
    injectButton = null;
  }

  // —— 生命周期 ——
  function init() {
    // 防重入：重复 init 先清理旧资源，再重新绑定
    if (initialized) {
      cleanup();
    }
    initialized = true;
    try {
      const context = window.SillyTavern && window.SillyTavern.getContext
        ? window.SillyTavern.getContext()
        : {};
      ctx = context;
      renderExtensionTemplateAsync = context.renderExtensionTemplateAsync;
      renderExtensionTemplate = context.renderExtensionTemplate;
      extensionSettings = context.extensionSettings;
      saveSettingsDebounced = context.saveSettingsDebounced;
      saveMetadata = context.saveMetadata;
      // [重要] localforage 挂在 SillyTavern.libs 全局对象上，不在 getContext() 返回里。
      // 官方文档：const { localforage } = SillyTavern.libs;
      localforage = window.SillyTavern && window.SillyTavern.libs && window.SillyTavern.libs.localforage;
      eventSource = context.eventSource;
      eventTypes = context.event_types;
    } catch (e) {
      /* 保持为 null，面板降级到 body */
    }

    const tryRender = () => {
      if (document.getElementById('extensions_settings')) {
        renderPanel();
      } else {
        setTimeout(tryRender, 100);
      }
    };
    tryRender();
    registerAutoAdvance();
    startInjectButtonKeeper();
  }

  window[MODULE_NAME] = {
    init: init,
    advanceChapter: advanceChapter,
    jumpToIndex: jumpToIndex,
  };

  // 页面卸载时清理定时器与事件，避免泄漏
  window.addEventListener('beforeunload', cleanup);

  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    init();
  } else {
    document.addEventListener('DOMContentLoaded', init);
  }
})();
