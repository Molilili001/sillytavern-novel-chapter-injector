# 小说章节自动注入器

把一篇小说 txt 导入酒馆，按第X章或字数切分，把当前段写入**聊天局部变量**，供预设里用 `{{getvar::变量名}}` 读取。支持自动推进、手动注入（输入框上方按钮）、循环模式（读完从头开始）。

## 依赖

- SillyTavern >= 1.13.0（含低版本兼容层，优先用 async 模板 API，缺失时退回同步版）
- 无第三方扩展依赖。聊天局部变量是酒馆核心自带（`chatMetadata.variables`）。

## 安装

1. 扩展面板 → Install extension → 粘贴本仓库 URL。
2. 启用「小说章节自动注入器」。
3. 展开扩展条目，按面板步骤操作：导入 txt → 确认变量名 → 点「手动注入下一章」。

## 使用

1. 默认分隔符为「第」，即按行首「第X章/回/卷/部」切分，标题保留。
2. 导入后点「▶ 手动注入下一章」，把章节写入聊天局部变量（默认 `current_chapter`），进度推进。
3. 面板「每次注入章数」可设批量注入，比如填 3，就一次把 3 章拼在一起写入变量、进度一次跳 3 章。
4. 在预设里写一行读取变量：

```
{{getvar::current_chapter}}
```

5. 每轮请求后自动推进（事件绑定需在运行时确认，见下）。

## 推进模式

面板「推进模式」区块里有三个开关，可自由组合：

- **自动推进**：生成结束后自动把下一段写入变量（默认开启）。
- **手动注入模式**：开启后在输入框上方挂一个「📖 注入下一段」按钮，点一下注入一段，不再随请求自动推进。与自动推进互斥。
- **循环模式**：读到最后一段后，下一次从头开始，而不是停下。

自动推进与手动注入互斥：勾选其中一个会自动取消另一个。

## 持久化机制（重启不丢）

章节数组与进度存进 `localforage`（SillyTavern.libs 提供的 IndexedDB 封装），独立于 `settings.json`，重启后自动恢复，无需重新导入，也不拖累全局设置。

官方文档明确禁止往 `extensionSettings` 塞大块数据，推荐用 `localforage`。

当前章内容与进度另写入聊天局部变量（`chatMetadata.variables`），供预设里 `{{getvar::}}` 读取。

## 变量机制（为什么之前读不到）

`{{getvar::name}}` 读的是酒馆核心的**聊天局部变量**，存储位置是 `getContext().chatMetadata.variables[name]`。本扩展就是往这个存储里写，所以预设里 `{{getvar::name}}` 能直接读到。

**不要**在预设里写 `{{setvar::current_chapter::xxx}}`，那会把扩展写入的章节内容覆盖掉。

## 运行时验证清单（勿跳过）

1. `saveMetadata` / `chatMetadata` / `renderExtensionTemplateAsync` 等符号是否在 `getContext()` 里可用（按你的 ST 版本）。
2. 自动推进的事件名（请求发出 / 消息发送）对应的导出常量，以及 `eventSource` 的订阅方法名。
3. `renderExtensionTemplateAsync` 的第一个路径参数是否与安装目录一致（第三方扩展通常为 `third-party/<repo-name>`）。

## 目录

```
novel-chapter-injector/
├── manifest.json
├── index.js
├── settings.html
├── style.css
└── README.md
```
