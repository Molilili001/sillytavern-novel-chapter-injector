# 小说章节自动注入器

把一篇小说 txt 导入酒馆，按第X章切分，每轮请求后（或手动触发）自动把当前章节写入指定变量，供预设 / 世界书 / 宏读取。

## 依赖

- SillyTavern >= 1.18.0
- **Tavern Helper（JS-Slash-Runner）**：提供变量读写 API。没有它，自动写入变量会降级为「复制到剪贴板」手动粘贴。

## 安装

1. 扩展面板 → Install extension → 粘贴本仓库 URL。
2. 启用「小说章节自动注入器」。
3. 打开扩展面板，在扩展列表展开本扩展，即可看到设置面板（文件选择、作用域、变量名、分隔符、手动注入按钮）。

## 使用

- 默认分隔符为「第」，即按行首「第X章/回/卷/部」切分，标题会保留。
- 导入 txt 后，点「手动注入下一章」即可把第一章写入变量，进度 +1。
- 每轮请求后自动推进（事件绑定需在运行时确认，见下）。
- 在预设或世界书里用宏读取变量，例如：
  - Tavern Helper 宏：`{{getvar::current_chapter}}`
  - 按你的运行时宏语法为准。

## 面板说明

本扩展走酒馆标准「扩展设置面板」，用 `renderExtensionTemplateAsync` 渲染 `settings.html`，设置持久化用 `extensionSettings` + `saveSettingsDebounced`。章节内容（可能很大）单独存 `localStorage`。

## 运行时验证清单（勿跳过）

本骨架所有 `[RUNTIME-CHECK]` 处均未硬编码未验证的符号，落地前需在你的酒馆版本里确认：

1. 变量 API 的确切调用方式与作用域参数（`window.TavernHelper` 下到底叫什么、作用域参数是字符串还是常量）。
2. 事件名（请求发出 / 消息发送）对应的导出常量，以及 `eventSource` 的订阅方法名。
3. `renderExtensionTemplateAsync` 的第一个路径参数是否与你的安装目录一致（第三方扩展通常为 `third-party/<repo-name>`）。

## 目录

```
novel-chapter-injector/
├── manifest.json
├── index.js
├── settings.html
├── style.css
└── README.md
```
