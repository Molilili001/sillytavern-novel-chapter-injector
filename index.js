/*
 * 小说章节自动注入器
 * Novel Chapter Injector
 *
 * 功能：导入一个 txt 小说，按章节切分；每轮请求发出后（或手动触发），
 *       把当前章节内容写入一个指定变量，供预设 / 世界书 / 宏读取。
 *
 * 依赖边界（重要）：
 *   - 变量读写 API 由 Tavern Helper（JS-Slash-Runner）提供。
 *   - 本扩展通过 window.TavernHelper 探测式访问，检测不到时降级为手动复制模式。
 *
 * 所有标了 [RUNTIME-CHECK] 的符号，均需在你的酒馆版本里确认确切拼写与签名，
 * 本骨架不做凭记忆的硬编码，避免在未验证的运行时上翻车。
 */
(function () {
  'use strict';

  const EXT_ID = 'novel-chapter-injector';
  const SETTINGS_KEY = EXT_ID + ':settings';
  const STATE_KEY = EXT_ID + ':state';

  // —— 默认配置 ——
  const DEFAULTS = {
    // 章节分隔符：默认按行首「第X章」切。填 '第' 即启用标题切分。
    chapterSeparator: '第',
    // 目标变量作用域：chat / character / global / extension
    variableScope: 'chat',
    // 目标变量名（章节内容写入这里）
    variableName: 'current_chapter',
    // 进度索引变量名（记录读到第几章）
    indexVariableName: 'current_chapter_index',
    // 是否在请求发出后自动推进
    autoAdvance: true,
  };

  // —— 运行时状态 ——
  const state = {
    chapters: [],
    index: 0,
  };

  // —— 设置与状态持久化（用扩展自己的 settings 存储）——
  let settings = { ...DEFAULTS };
  let listeners = [];

  function loadSettings() {
    // [RUNTIME-CHECK] 扩展设置读取 API 的准确调用方式需按你的 ST 版本确认。
    // 此处用最保守的 localStorage 兜底，避免依赖未验证的 settings 接口。
    try {
      const raw = localStorage.getItem(SETTINGS_KEY);
      if (raw) settings = { ...DEFAULTS, ...JSON.parse(raw) };
    } catch (e) {
      settings = { ...DEFAULTS };
    }
  }

  function saveSettings() {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    } catch (e) {
      /* 静默，localStorage 不可用时降级到内存 */
    }
  }

  function loadState() {
    try {
      const raw = localStorage.getItem(STATE_KEY);
      if (raw) {
        const s = JSON.parse(raw);
        state.chapters = s.chapters || [];
        state.index = s.index || 0;
      }
    } catch (e) {
      state.chapters = [];
      state.index = 0;
    }
  }

  function saveState() {
    try {
      localStorage.setItem(STATE_KEY, JSON.stringify(state));
    } catch (e) {
      /* 静默 */
    }
  }

  // —— 章节切分 ——
  function splitChapters(text) {
    const sep = (settings.chapterSeparator || '第').trim();
    // 「第」：按行首「第X章/回/卷/部」切，保留标题（lookahead 不吞字）。
    if (sep === '第') {
      const re = /\n(?=第[一二三四五六七八九十百千万0-9０-９]+[章节回卷部])/g;
      return text
        .split(re)
        .map((s) => s.trim())
        .filter(Boolean);
    }
    // 其它单/双汉字分隔符：按普通字符串切。
    return text
      .split(sep)
      .map((s) => s.trim())
      .filter(Boolean);
  }

  // —— 文件导入 ——
  function importFile(file) {
    const reader = new FileReader();
    reader.onload = () => {
      const text = String(reader.result || '');
      state.chapters = splitChapters(text);
      state.index = 0;
      saveState();
      renderStatus('已导入 ' + state.chapters.length + ' 章');
      renderChapterPreview();
    };
    reader.onerror = () => renderStatus('读取文件失败');
    reader.readAsText(file, 'utf-8');
  }

  // —— 变量读写（探测式）——
  // [RUNTIME-CHECK] getVariables / insertOrAssignVariables 属于 Tavern Helper。
  // 签名与作用域参数需在你的版本确认；此处做能力探测并提供降级。
  function hasHelper() {
    return !!(window.TavernHelper && typeof window.TavernHelper.getVariables === 'function');
  }

  async function writeChapterToVariable(content) {
    if (!hasHelper()) {
      // 降级：把当前章节复制到剪贴板，供手动粘贴。
      try {
        await navigator.clipboard.writeText(content);
        renderStatus('未检测到 Tavern Helper，章节已复制到剪贴板');
      } catch (e) {
        renderStatus('未检测到 Tavern Helper，且剪贴板不可用');
      }
      return false;
    }
    // [RUNTIME-CHECK] 确切的写入 API 与作用域参数按运行时调整。
    // 这里以核心事实索引中列出的符号名为基准，参数形状需实测。
    try {
      const helper = window.TavernHelper;
      const scope = settings.variableScope;
      await helper.insertOrAssignVariables(
        { [settings.variableName]: content },
        scope
      );
      return true;
    } catch (e) {
      renderStatus('写入变量失败：' + (e && e.message ? e.message : e));
      return false;
    }
  }

  async function readIndexFromVariable() {
    if (!hasHelper()) return state.index;
    try {
      const helper = window.TavernHelper;
      const vars = await helper.getVariables(settings.variableScope);
      const raw = vars && vars[settings.indexVariableName];
      const n = Number(raw);
      return Number.isFinite(n) ? n : state.index;
    } catch (e) {
      return state.index;
    }
  }

  async function writeIndexToVariable(idx) {
    if (!hasHelper()) return;
    try {
      const helper = window.TavernHelper;
      await helper.insertOrAssignVariables(
        { [settings.indexVariableName]: String(idx) },
        settings.variableScope
      );
    } catch (e) {
      /* 静默 */
    }
  }

  // —— 推进一章 ——
  async function advanceChapter() {
    if (!state.chapters.length) {
      renderStatus('尚未导入小说');
      return;
    }
    let idx = await readIndexFromVariable();
    if (idx >= state.chapters.length) {
      renderStatus('已读完最后一章');
      return;
    }
    const content = state.chapters[idx];
    const ok = await writeChapterToVariable(content);
    if (ok) {
      idx += 1;
      state.index = idx;
      saveState();
      await writeIndexToVariable(idx);
      renderStatus('已注入第 ' + idx + ' / ' + state.chapters.length + ' 章');
      renderChapterPreview();
    }
  }

  // —— 简易 UI ——
  let panel = null;

  function buildPanel() {
    panel = document.createElement('div');
    panel.id = EXT_ID + '-panel';
    panel.innerHTML = [
      '<div class="nci-header">小说章节自动注入器</div>',
      '<div class="nci-row"><input type="file" id="nci-file" accept=".txt,.md,text/plain"></div>',
      '<div class="nci-row"><label>作用域</label><select id="nci-scope">',
      '<option value="chat">chat（跟聊天走）</option>',
      '<option value="character">character（跟卡走）</option>',
      '<option value="global">global（全局）</option>',
      '<option value="extension">extension</option>',
      '</select></div>',
      '<div class="nci-row"><label>变量名</label><input type="text" id="nci-var" value="current_chapter"></div>',
      '<div class="nci-row"><label>分隔符</label><input type="text" id="nci-sep" value="第" placeholder="第（按第X章切）"></div>',
      '<div class="nci-row"><button id="nci-next">手动注入下一章</button></div>',
      '<div class="nci-status" id="nci-status">未导入</div>',
      '<div class="nci-preview" id="nci-preview"></div>',
    ].join('');
    document.body.appendChild(panel);

    const fileInput = panel.querySelector('#nci-file');
    const scopeSel = panel.querySelector('#nci-scope');
    const varInput = panel.querySelector('#nci-var');
    const sepInput = panel.querySelector('#nci-sep');
    const nextBtn = panel.querySelector('#nci-next');

    fileInput.addEventListener('change', (e) => {
      const f = e.target.files && e.target.files[0];
      if (f) importFile(f);
    });

    scopeSel.value = settings.variableScope;
    varInput.value = settings.variableName;
    sepInput.value = settings.chapterSeparator || '第';

    scopeSel.addEventListener('change', () => {
      settings.variableScope = scopeSel.value;
      saveSettings();
    });
    varInput.addEventListener('change', () => {
      settings.variableName = varInput.value.trim() || 'current_chapter';
      saveSettings();
    });
    sepInput.addEventListener('change', () => {
      settings.chapterSeparator = sepInput.value || '第';
      saveSettings();
    });
    nextBtn.addEventListener('click', () => advanceChapter());
  }

  function renderStatus(msg) {
    const el = panel && panel.querySelector('#nci-status');
    if (el) el.textContent = msg;
  }

  function renderChapterPreview() {
    const el = panel && panel.querySelector('#nci-preview');
    if (!el) return;
    const cur = state.chapters[state.index] || '';
    el.textContent = cur.length > 200 ? cur.slice(0, 200) + '…' : cur;
  }

  // —— 事件监听：请求发出后自动推进 ——
  function registerAutoAdvance() {
    // [RUNTIME-CHECK] 事件名与 eventSource 用法需按你的 ST 版本确认。
    // 此处不硬编码事件字符串；通过 getContext 探测可用的事件源。
    // 自动推进逻辑封装在 advanceChapter，事件绑定成功后即可每轮触发。
    const ctx = window.SillyTavern && window.SillyTavern.getContext
      ? window.SillyTavern.getContext()
      : null;
    if (!ctx || !ctx.eventSource) {
      renderStatus('事件源不可用，请使用手动注入按钮');
      return;
    }
    // 占位：真实事件绑定需以运行时导出的事件常量为准。
    // 示例（需验证）：
    //   const onMsg = () => { if (settings.autoAdvance) advanceChapter(); };
    //   ctx.eventSource.on(<EVENT_CONSTANT>, onMsg);
    //   listeners.push({ src: ctx.eventSource, name: <EVENT_CONSTANT>, fn: onMsg });
  }

  // —— 生命周期 ——
  function init() {
    loadSettings();
    loadState();
    buildPanel();
    registerAutoAdvance();
  }

  function dispose() {
    // 清理监听器、DOM
    listeners.forEach((l) => {
      try {
        if (l.src && typeof l.src.off === 'function') l.src.off(l.name, l.fn);
      } catch (e) { /* 静默 */ }
    });
    listeners = [];
    if (panel && panel.parentNode) panel.parentNode.removeChild(panel);
    panel = null;
  }

  // —— 导出 hooks（供 manifest 引用，名称与 manifest.hooks 对应）——
  window[EXT_ID] = {
    init: init,
    dispose: dispose,
    advanceChapter: advanceChapter,
  };

  init();
})();
