# AGENTS.md

## 项目简介

超轻量级纯静态聊天工具（无构建、无依赖、无后端），与任意 OpenAI 兼容 LLM API 通信，数据全部保存在浏览器本地存储。详见 [README.md](README.md)。

代码集中在 `app/` 目录，按 `store.js`（IndexedDB 持久化）→ `api.js`（请求与 SSE 解析）→ `ui.js`（DOM 渲染与事件）→ `app.js`（内存状态与程序入口）顺序加载，统一挂在 `window.SSC` 命名空间下（普通 `<script>`，非 ES module）。

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
