/*
 * 小说章节自动注入器
 * Novel Chapter Injector
 *
 * 功能：导入一个 txt 小说，按第X章切分；每轮请求后（或手动触发），
 *       把当前章节内容写入一个指定变量，供预设 / 世界书 / 宏读取。
 *
 * 本扩展走酒馆标准「扩展设置面板」：用 renderExtensionTemplateAsync 渲染
 * settings.html 挂到扩展面板，设置持久化用 extensionSettings + saveSettingsDebounced。
 *
 * 依赖边界（重要）：
 *   - 变量读写 API 由 Tavern Helper（JS-Slash-Runner）提供，本扩展探测式访问。
 *   - 所有标了 [RUNTIME-CHECK] 的符号，均需在目标酒馆版本里确认确切拼写。
 */
(function () {
  'use strict';

  const MODULE_NAME = 'novel-chapter-injector';
  const STATE_KEY = MODULE_NAME + ':state';

  // —— 默认设置 ——
  const DEFAULT_SETTINGS = Object.freeze({
    // 章节分隔符：'第' 表示按行首「第X章/回/卷/部」切
    chapterSeparator: '第',
    // 目标变量作用域：chat / character / global / extension
    variableScope: 'chat',
    // 目标变量名（章节内容写入这里）
    variableName: 'current_chapter',
    // 进度索引变量名（记录读到第几章）
    indexVariableName: 'current_chapter_index',
    // 是否在请求发出后自动推进
    autoAdvance: true,
  });

  let ctx = null;
  let renderExtensionTemplateAsync = null;
  let extensionSettings = null;
  let saveSettingsDebounced = null;

  // —— 运行时状态（章节数组可能很大，单独存 localStorage）——
  const state = {
    chapters: [],
    index: 0,
  };

  // —— 设置读写（走酒馆 extensionSettings）——
  function getSettings() {
    if (!extensionSettings[MODULE_NAME]) {
      extensionSettings[MODULE_NAME] = structuredClone(DEFAULT_SETTINGS);
    }
    // 补全新版本新增的默认键
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

  // —— 状态读写（localStorage 兜底）——
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
      /* localStorage 满或不可用时静默降级到内存 */
    }
  }

  // —— 章节切分 ——
  function splitChapters(text) {
    const sep = (getSettings().chapterSeparator || '第').trim();
    if (sep === '第') {
      // 按行首「第X章/回/卷/部」切，lookahead 不吞标题
      const re = /\n(?=第[一二三四五六七八九十百千万0-9０-９]+[章节回卷部])/g;
      return text.split(re).map((s) => s.trim()).filter(Boolean);
    }
    return text.split(sep).map((s) => s.trim()).filter(Boolean);
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

  // —— 变量读写（探测式，依赖 Tavern Helper）——
  function hasHelper() {
    return !!(window.TavernHelper && typeof window.TavernHelper.getVariables === 'function');
  }

  async function writeChapterToVariable(content) {
    if (!hasHelper()) {
      try {
        await navigator.clipboard.writeText(content);
        renderStatus('未检测到 Tavern Helper，章节已复制到剪贴板');
      } catch (e) {
        renderStatus('未检测到 Tavern Helper，且剪贴板不可用');
      }
      return false;
    }
    // [RUNTIME-CHECK] 写入 API 与作用域参数按运行时调整。
    try {
      const helper = window.TavernHelper;
      const scope = getSettings().variableScope;
      await helper.insertOrAssignVariables(
        { [getSettings().variableName]: content },
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
      const vars = await window.TavernHelper.getVariables(getSettings().variableScope);
      const raw = vars && vars[getSettings().indexVariableName];
      const n = Number(raw);
      return Number.isFinite(n) ? n : state.index;
    } catch (e) {
      return state.index;
    }
  }

  async function writeIndexToVariable(idx) {
    if (!hasHelper()) return;
    try {
      await window.TavernHelper.insertOrAssignVariables(
        { [getSettings().indexVariableName]: String(idx) },
        getSettings().variableScope
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
    if (!renderExtensionTemplateAsync) return;
    const settings = getSettings();
    // [RUNTIME-CHECK] renderExtensionTemplateAsync 的路径与模板名按实际安装目录确认。
    const html = await renderExtensionTemplateAsync(
      'third-party/' + MODULE_NAME,
      'settings',
      {
        variableName: settings.variableName,
        chapterSeparator: settings.chapterSeparator,
        indexVariableName: settings.indexVariableName,
      }
    );
    // 左列：系统功能；右列（#extensions_settings2）：视觉/UI 相关。本扩展属系统功能，挂左列。
    const target = document.getElementById('extensions_settings') || document.body;
    target.insertAdjacentHTML('beforeend', html);

    bindEvents();
    loadState();
    renderStatus('未导入');
    renderChapterPreview();
  }

  function bindEvents() {
    const fileInput = document.getElementById('nci-file');
    const scopeSel = document.getElementById('nci-scope');
    const varInput = document.getElementById('nci-var');
    const sepInput = document.getElementById('nci-sep');
    const idxInput = document.getElementById('nci-idxvar');
    const nextBtn = document.getElementById('nci-next');

    if (fileInput) {
      fileInput.addEventListener('change', (e) => {
        const f = e.target.files && e.target.files[0];
        if (f) importFile(f);
      });
    }
    if (scopeSel) {
      scopeSel.value = getSettings().variableScope;
      scopeSel.addEventListener('change', () => {
        getSettings().variableScope = scopeSel.value;
        persistSettings();
      });
    }
    if (varInput) {
      varInput.addEventListener('change', () => {
        getSettings().variableName = varInput.value.trim() || 'current_chapter';
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
    if (nextBtn) {
      nextBtn.addEventListener('click', () => advanceChapter());
    }
  }

  // —— 自动推进事件监听 ——
  function registerAutoAdvance() {
    // [RUNTIME-CHECK] 事件名与 eventSource 用法按 ST 版本确认。
    // 自动推进逻辑封装在 advanceChapter，事件绑定成功后每轮触发。
    if (!ctx || !ctx.eventSource) {
      return;
    }
    // 占位：真实事件绑定需以运行时导出的事件常量为准。
  }

  // —— 生命周期 ——
  function init() {
    try {
      const context = window.SillyTavern && window.SillyTavern.getContext
        ? window.SillyTavern.getContext()
        : {};
      ctx = context;
      renderExtensionTemplateAsync = context.renderExtensionTemplateAsync;
      extensionSettings = context.extensionSettings;
      saveSettingsDebounced = context.saveSettingsDebounced;
    } catch (e) {
      /* 保持为 null，面板降级到 body */
    }

    // 确保 settings 容器存在后再渲染
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

  // 若已在扩展环境，立即初始化
  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    init();
  } else {
    document.addEventListener('DOMContentLoaded', init);
  }
})();
