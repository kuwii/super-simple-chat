# Super Simple Chat

超轻量级极简纯静态网页聊天工具：无构建、无依赖、无后端、无云端，纯本地运行。与任意 OpenAI 兼容格式 LLM API 通信；一切数据（对话、会话、配置）仅存于浏览器本地存储，绝不离开你的设备。

> 本项目由 AI 生成。

## 特点

- **零安装零部署**：托管到任意静态服务器（GitHub Pages、Netlify、Vercel 等）或本地静态服务器即可使用
- **零外部依赖**：纯 HTML/CSS/JS，无构建步骤、无 npm 包、无后端
- **数据本地化**：对话、会话、模型配置全部存在浏览器 `IndexedDB`，不出个人浏览器；各自配置互不干扰
- **流式输出**：SSE 逐字显示回复，可随时停止生成（已接收内容保留）
- **Markdown 渲染**：助手正文支持加粗 / 斜体 / 删除线 / 标题 / 列表 / 表格 / 代码块与行内代码 / 引用块 / 分割线（零依赖手写渲染器，流式动态渲染）
- **推理模型支持**：展示 `reasoning_content` 思考过程（灰色弱化、可展开/收起），正文开始后自动收起
- **Token 用量统计**：流式请求自动附带 `stream_options.include_usage`；API 返回用量后，在助手气泡下方小字显示该轮输入 / 输出 / 缓存命中 token 数
- **多模型管理**：可添加/编辑/删除多个模型配置（endpoint + 模型名 + key），聊天中随时切换
- **会话管理**：新建/切换/删除会话，标题自动取首条消息，重开页面恢复最近会话
- **错误内联显示**：连接失败、API 错误、流中断等错误直接显示在对应回复位置

## 快速开始

### 方式一：在线直接使用

main 分支的最新版本部署在 [https://kuwii.xyz/super-simple-chat/](https://kuwii.xyz/super-simple-chat/) ，打开即可使用。

### 方式二：静态托管

把 `app/` 目录的内容上传到任意静态托管服务，通过浏览器访问即可。例如 GitHub Pages：

```
git push → 在仓库设置中开启 Pages → 指定 app/ 目录
```

### 方式三：本地静态服务器

在项目根目录下，将 `app/` 作为静态站点根：

```powershell
python -m http.server 8000 --directory app
# 或
npx serve app
```

然后在浏览器中访问 `http://localhost:8000`（`npx serve` 默认为 `http://localhost:3000`）。

## 使用

1. **首次引导**：打开页面后填写 API Endpoint、模型名称、API Key（本地端点无 key 时可留空）与标签（可选，默认用模型名），点击「保存并开始」
2. **发送消息**：在输入框输入，按 Enter 或点击「发送」；Shift+Enter 换行
3. **停止生成**：流式输出过程中点击「停止」，已接收内容保留
4. **会话管理**：左侧边栏「+ 新建会话」；点击会话切换；悬停出现「×」删除
5. **多模型**：顶部「管理模型」按钮打开模型管理弹窗，可添加/编辑/删除；顶部下拉框随时切换当前模型

### Endpoint 填写说明

- 支持 `http://host:port`、`http://host:port/v1` 等写法，末尾缺 `/chat/completions` 时自动补全
- 缺省协议时默认按 `http://` 处理
- 请求体为标准 OpenAI Chat Completions 格式（`model` + `messages` + `stream: true` + `stream_options.include_usage`，请求流式 token 用量）；API Key 非空时携带 `Authorization: Bearer` 头

## 数据与隐私

- 数据仅存于当前浏览器：会话与消息树、模型配置存在 `IndexedDB`（数据库 `super-simple-chat`，表：`sessions` / `messages` / `message-cache` / `models`）；主题偏好与活动会话/模型指针存在 `localStorage`
- 刷新页面、重启浏览器数据不丢失；清除浏览器数据会丢失全部记录
- 无账户、无上传、无第三方服务；你的对话只发往你自己配置的 API Endpoint
- 已知限制：浏览器本地存储配额（`IndexedDB`）远大于传统 `localStorage`，但仍有限额，大量长对话后请及时删除旧会话

## 前提

- 目标 API 需允许浏览器跨域访问（CORS）——Ollama / LM Studio 默认允许；自建网关请自行确认
- 支持 OpenAI 兼容格式的 API（含本地部署模型）

## 明确不做

- 账户 / 登录 / 后端服务

## License

见 [LICENSE](LICENSE)。
