# 小说章节自动注入器

把一篇小说 txt 导入酒馆，按第X章切分，每轮请求后（或手动触发）自动把当前章节写入**聊天局部变量**，供预设里用 `{{getvar::变量名}}` 读取。

## 依赖

- SillyTavern >= 1.18.0
- 无第三方扩展依赖。聊天局部变量是酒馆核心自带（`chatMetadata.variables`）。

## 安装

1. 扩展面板 → Install extension → 粘贴本仓库 URL。
2. 启用「小说章节自动注入器」。
3. 展开扩展条目，按面板步骤操作：导入 txt → 确认变量名 → 点「手动注入下一章」。

## 使用

1. 默认分隔符为「第」，即按行首「第X章/回/卷/部」切分，标题保留。
2. 导入后点「▶ 手动注入下一章」，把第一章写入聊天局部变量（默认 `current_chapter`），进度 +1。
3. 在预设里写一行读取变量：

```
{{getvar::current_chapter}}
```

4. 每轮请求后自动推进（事件绑定需在运行时确认，见下）。

## 持久化机制（重启不丢）

章节数组与进度存进扩展设置（`extensionSettings`），随酒馆的 `settings.json` 落到服务器，重启后自动恢复，无需重新导入。

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
