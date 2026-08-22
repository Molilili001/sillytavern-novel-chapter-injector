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
    splitMode: 'chapter',
    // 字数分割模式下每段多少字
    splitSize: 1000,
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
  };

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

  // —— 章节持久化：存 localforage（官方推荐的大块数据存储，IndexedDB）——
  // 官方文档明确禁止往 extensionSettings 塞大块数据，应改用 localforage。
  // 存 localforage 独立于 settings.json，重启不丢，容量大。
  async function loadChapters() {
    if (!localforage) return;
    try {
      const chapters = await localforage.getItem(MODULE_NAME + ':chapters');
      const index = await localforage.getItem(MODULE_NAME + ':index');
      if (Array.isArray(chapters) && chapters.length) {
        state.chapters = chapters;
        state.index = Number(index) || 0;
      }
    } catch (e) {
      /* 静默 */
    }
  }

  async function saveChapters() {
    if (!localforage) return;
    try {
      await localforage.setItem(MODULE_NAME + ':chapters', state.chapters);
      await localforage.setItem(MODULE_NAME + ':index', state.index);
    } catch (e) {
      renderStatus('持久化失败：' + (e && e.message ? e.message : e));
    }
  }

  // —— 文本切分（章节模式 / 字数模式二选一）——
  function splitChapters(text) {
    const mode = getSettings().splitMode || 'chapter';
    if (mode === 'char') {
      return splitBySize(text);
    }
    return splitByChapter(text);
  }

  // 章节模式：按行首「第X章/回/卷/部」切
  function splitByChapter(text) {
    const sep = (getSettings().chapterSeparator || '第').trim();
    if (sep === '第') {
      // 按行首「第X章/回/卷/部」切，lookahead 不吞标题
      const re = /\n(?=第[一二三四五六七八九十百千万0-9０-９]+[章节回卷部])/g;
      return text.split(re).map((s) => s.trim()).filter(Boolean);
    }
    return text.split(sep).map((s) => s.trim()).filter(Boolean);
  }

  // 字数模式：按目标字数切，尽量在句末/换行处断开，避免拦腰斩句
  function splitBySize(text) {
    let size = Number(getSettings().splitSize);
    if (!Number.isFinite(size) || size < 1) size = 1000;
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

  // —— 文件导入 ——
  function importFile(file) {
    const reader = new FileReader();
    reader.onload = async () => {
      const text = String(reader.result || '');
      state.chapters = splitChapters(text);
      state.index = 0;
      await saveChapters();
      renderStatus('已导入 ' + state.chapters.length + ' 章');
      renderChapterPreview();
    };
    reader.onerror = () => renderStatus('读取文件失败');
    reader.readAsText(file, 'utf-8');
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

  // —— 推进章节（支持批量：一次注入 N 章）——
  async function advanceChapter() {
    if (!state.chapters.length) {
      renderStatus('尚未导入小说');
      return;
    }
    const start = state.index;
    if (start >= state.chapters.length) {
      renderStatus('已读完最后一章');
      return;
    }
    let size = Number(getSettings().batchSize);
    if (!Number.isFinite(size) || size < 1) size = 1;
    size = Math.floor(size);
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
      renderStatus('已注入第 ' + (start + 1) + ' ~ ' + newIdx + ' 章（共 ' + batch.length + ' 章）');
      renderChapterPreview();
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

  // —— 面板渲染 ——
  function renderStatus(msg) {
    const el = document.getElementById('nci-status');
    if (el) el.textContent = msg;
  }

  function renderChapterPreview() {
    const el = document.getElementById('nci-preview');
    if (!el) return;
    const cur = state.chapters[state.index] || '';
    el.textContent = cur.length > 200 ? cur.slice(0, 200) + '…' : cur;
  }

  async function renderPanel() {
    if (!renderExtensionTemplateAsync && !renderExtensionTemplate) return;
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
      }
    );
    const target = document.getElementById('extensions_settings') || document.body;
    target.insertAdjacentHTML('beforeend', html);

    bindEvents();
    await loadChapters();
    if (state.chapters.length) {
      renderStatus('已恢复 ' + state.chapters.length + ' 章（当前第 ' + (state.index + 1) + ' 章）');
    } else {
      renderStatus('未导入');
    }
    renderChapterPreview();
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
      splitModeSel.value = getSettings().splitMode || 'chapter';
      splitModeSel.addEventListener('change', () => {
        getSettings().splitMode = splitModeSel.value === 'char' ? 'char' : 'chapter';
        persistSettings();
      });
    }
    if (splitSizeInput) {
      splitSizeInput.value = String(getSettings().splitSize || 1000);
      splitSizeInput.addEventListener('change', () => {
        let n = Number(splitSizeInput.value);
        if (!Number.isFinite(n) || n < 1) n = 1000;
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

  // —— 生命周期 ——
  function init() {
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
  }

  window[MODULE_NAME] = {
    init: init,
    advanceChapter: advanceChapter,
  };

  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    init();
  } else {
    document.addEventListener('DOMContentLoaded', init);
  }
})();
