# 小说章节自动注入器

把一篇小说 txt 导入酒馆，按章节切分，每轮请求后（或手动触发）自动把当前章节写入指定变量，供预设 / 世界书 / 宏读取。

## 依赖

- SillyTavern >= 1.18.0
- **Tavern Helper（JS-Slash-Runner）**：提供变量读写 API。没有它，自动写入变量会降级为「复制到剪贴板」手动粘贴。

## 安装

1. 把整个 `novel-chapter-injector` 目录放进 SillyTavern 的扩展目录（`public/scripts/extensions/third-party/`）。
2. 扩展面板里找到「小说章节自动注入器」，启用。
3. 在面板里：选作用域、填变量名、设分隔符、导入 txt。

## 使用

- 默认分隔符为「第」，即按行首「第X章/回/卷/部」切分，标题会保留。
- 导入 txt 后，点「手动注入下一章」即可把第一章写入变量，进度 +1。
- 每轮请求后自动推进（事件绑定需在运行时确认，见下）。
- 在预设或世界书里用宏读取变量，例如：
  - Tavern Helper 宏：`{{getvar::current_chapter}}`
  - 按你的运行时宏语法为准。

## 运行时验证清单（勿跳过）

本骨架所有 `[RUNTIME-CHECK]` 处均未硬编码未验证的符号，落地前需在你的酒馆版本里确认：

1. 变量 API 的确切调用方式与作用域参数（`window.TavernHelper` 下到底叫什么、作用域参数是字符串还是常量）。
2. 事件名（请求发出 / 消息发送）对应的导出常量，以及 `eventSource` 的订阅方法名（`on` / `off` 还是别的）。
3. 扩展 `settings` 读写 API 若要替换 `localStorage` 兜底，确认其签名。

## 目录

```
novel-chapter-injector/
├── manifest.json
├── index.js
├── style.css
└── README.md
```
