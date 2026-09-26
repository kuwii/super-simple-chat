# AGENTS.md

## 项目简介

超轻量级纯静态聊天工具（无构建、无依赖、无后端），与任意 OpenAI 兼容 LLM API 通信，数据全部保存在浏览器本地存储。详见 [README.md](README.md)。

代码集中在 `app/` 目录，按 `i18n.js`（界面文案中英双语常量与语言状态）→ `store.js`（IndexedDB 持久化）→ `api.js`（请求与 SSE 解析）→ `markdown.js`（轻量 Markdown 渲染器，零依赖）→ `ui.js`（DOM 渲染与事件）→ `app.js`（内存状态与程序入口）顺序加载，统一挂在 `window.SSC` 命名空间下（普通 `<script>`，非 ES module）。界面文字一律经 `SSC.I18n` 取当前语言文案（约定见 `i18n.js` 头部注释），其它模块不得硬编码自然语言文本。

## 目录结构约定（必须遵守）

`app/` 内部按职责分层，禁止把所有文件堆在 `app/` 根目录：

| 目录 | 内容 | 说明 |
| --- | --- | --- |
| `app/`（根） | 仅 `index.html` | 入口页面；所有功能逻辑、样式、资源都不得散落在根目录 |
| `app/scripts/` | 全部 `.js` 文件 | 页面所有功能逻辑（含 `i18n.js` / `store.js` / `api.js` / `ui.js` / `app.js`）一律写在这里 |
| `app/styles/` | 全部 `.css` 文件 | 页面所有样式、风格等非功能逻辑一律写在这里 |
| `app/resources/` | 其余非 HTML 资源（图片、图标等） | 如 `github-black.svg` / `github-white.svg` |

### 规则

- **新增文件**：`.js` → `app/scripts/`，`.css` → `app/styles/`，图片等其它非 HTML 资源 → `app/resources/`；`app/` 根目录只保留 `index.html`。
- **引用路径**：`index.html` 中引用脚本用 `scripts/xxx.js`、样式用 `styles/xxx.css`；`resources/` 下的资源由 JS/HTML 用相对路径 `resources/xxx` 引用（如 `ui.js` 中的 `resources/github-black.svg`）。移动或新增文件后必须同步更新所有引用位置。
- **构建脚本**：`.github/workflows/deploy.yml` 的 cache-bust 步骤会遍历 `app/styles` 与 `app/scripts` 两个目录下的全部文件，逐文件计算哈希并按文件名替换 HTML 中对应的 `?v=__CACHE_BUST__` 引用（新增文件后无需改动构建脚本）；调整目录结构或 HTML 引用格式时务必同步修改，否则部署会取不到文件。

## README 维护约定（必须遵守）

README 按语言分版本维护：`README.md`（英文）与 `README.zh_CN.md`（中文），各版本内容一致、仅语言不同。

- **同步更新**：更新 README 时必须同时更新**所有**语言版本——任何章节、特性、用法的新增/修改/删除都要落到每一个版本上，不得只改其中一个；两版本出现内容漂移视为缺陷。
- **语言切换按钮组**：每个版本开头第一行为文字模拟的按钮组 `[ English | 中文 ]`（整行用方括号包裹）：本语言对应的单词为纯文字，其余语言的单词为指向对应版本文件的 Markdown 链接（如英文版中 `中文` 链接到 `README.zh_CN.md`）。新增语言版本时，所有版本的按钮组都要同步扩展。

## Git 提交约定（必须遵守）

- **commit message 用英文编写**：标题与正文（body）均使用英文，遵循惯用的 conventional 风格（如 `feat:` / `fix:` / `docs:` / `chore:` 前缀，标题一行简述）。

## 注释标准（必须遵守）

JavaScript 无类型系统，可读性较差，长期维护容易"看不懂代码"。因此本项目所有 JS 代码**每个函数都必须带标准注释**，说明参数（含义与类型）、返回值（含义与类型）。

### 格式

使用 JSDoc 块注释（`/** ... */`），紧贴函数定义上方，包含：

1. **功能描述**：一句话说清"做什么"；非显而易见的行为（副作用、边界条件、提前返回条件、幂等性、节流、fire-and-forget 等）补充说明。
2. **@param**：每个参数一条，格式 `@param {类型} 参数名 说明`。对象/数组参数用内联结构标注，例如：
   - `{object} config { endpoint: string, model: string, apiKey: string }`
   - `{Array<{role: string, content: string}>} messages`
   - `{function(string): void} onToken`
3. **@returns**：必写，含类型与说明。无返回值写 `{void}`；异步写 `Promise<...>`；联合类型写 `{string|null}` 并说明各分支含义。
4. **@throws**：会主动 `throw` 的函数必须注明触发条件。

示例：

```js
/**
 * 构造覆盖某会话全部记录的复合主键范围。
 * @param {string} sessionId 会话 id
 * @returns {IDBKeyRange} 复合主键范围
 */
function sessionRange(sessionId) { ... }

/**
 * 定稿：把完整助手消息写入 messages、删除 checkpoint、更新会话（单事务，fire-and-forget）。
 * @param {string|null} errText 错误描述；null 表示正常完成
 * @returns {void} 无进行中流时直接返回
 */
function finalizeStream(errText) { ... }
```

### 规则

- **新增函数**：必须带上述标准注释，不允许裸函数。
- **修改函数**：改签名（增删参数、类型变化）或改行为（返回值语义、副作用、边界条件）时，必须同步更新对应注释。
- **回调 / 闭包**：
  - 有参数或返回值且语义不自明 → 用完整 JSDoc（如返回给外部使用的句柄方法、传给其它模块的回调）。
  - 一行且语义自明（如 `resolve(req.result)`、空 `then` 回调）→ 可省略，必要时加简短行注释。
  - 事件处理器回调 → 一行简短注释说明触发场景（如 `/* Enter 发送（Shift+Enter 换行） */`）。
  - 含非自明逻辑的迭代回调（forEach / map / filter）→ 至少一行注释说明每次迭代做什么。
- **注释语言**：中文（与现有代码一致）；JSDoc 类型标注用英文。
- **注释与代码同步维护**：过期的注释比没有注释更危险，修改代码后请复查其注释是否仍然准确。
