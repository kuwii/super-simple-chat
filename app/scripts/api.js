/*
 * api.js — Api 模块：OpenAI Chat Completions 请求 + SSE 流解析 + AbortController。
 *
 * 面向用户的错误描述一律取自 SSC.I18n（见 i18n.js），按抛出时的界面语言解析；
 * 解析后的文本会被 app.js 随消息节点落盘，因此属历史记录，语言切换后保持原样。
 */
(function () {
  'use strict';

  window.SSC = window.SSC || {};

  var Api = {};

  /**
   * 构造完整请求 URL。
   * endpoint 可为 `http://host:port`、`http://host:port/v1`（甚至缺省协议）；
   * 末尾缺 `/chat/completions` 时自动补全。
   * @param {string} endpoint 用户配置的 API 端点
   * @returns {string} 补全后的完整请求 URL
   * @throws {Error} endpoint 为空时
   */
  Api.buildUrl = function (endpoint) {
    var base = String(endpoint || '').trim().replace(/\/+$/, '');
    if (!base) throw new Error(SSC.I18n.t('errEmptyEndpoint'));
    if (!/^https?:\/\//i.test(base)) base = 'http://' + base;
    if (!/\/chat\/completions$/.test(base)) base += '/chat/completions';
    return base;
  };

  /**
   * 发起流式聊天请求（异步，通过 callbacks 回报进度；中止视为正常结束，走 onDone 不触发 onError）。
   * 请求体自动附带 stream_options.include_usage=true，请服务器在流末尾的 chunk 里回报 token 用量
   *（OpenAI 标准；不支持该参数的服务器会忽略或仅少返回 usage，onUsage 不触发即可）。
   * @param {object} config 模型配置 { endpoint: string, model: string, apiKey: string }
   * @param {Array<{role: string, content: string}>} messages 对话历史（OpenAI Chat Completions 格式）
   * @param {object} callbacks 回调集合 { onThinking: function(string): void, onToken: function(string): void, onUsage: function({inputTokens: number|null, outputTokens: number|null, cachedTokens: number|null}): void, onDone: function(): void, onError: function(Error): void }
   * @param {AbortSignal|null} signal 中止信号（用户点击“停止生成”）
   * @returns {void}
   */
  Api.stream = function (config, messages, callbacks, signal) {
    var url;
    try {
      url = Api.buildUrl(config.endpoint);
    } catch (err) {
      callbacks.onError(err); /* URL 非法（endpoint 为空）：直接报错返回 */
      return;
    }

    var settled = false; /* 保证 onDone/onError 至多触发一次 */
    var headers = { 'Content-Type': 'application/json' };
    if (config.apiKey && String(config.apiKey).trim()) {
      headers['Authorization'] = 'Bearer ' + String(config.apiKey).trim();
    }

    fetch(url, {
      method: 'POST',
      headers: headers,
      body: JSON.stringify({
        model: config.model,
        messages: messages,
        stream: true,
        stream_options: { include_usage: true }
      }),
      signal: signal
    })
      .then(function (res) {
        /* 响应成功：非 2xx 转为带本地化提示的 Error；2xx 则进入 SSE 解析 */
        if (!res.ok) {
          return res.text().then(function (txt) {
            throw new Error(extractHttpError(res.status, txt));
          });
        }
        return readSse(
          res,
          {
            onDelta: callbacks.onToken, /* 正文增量 → onToken */
            onReason: callbacks.onThinking || function () {}, /* 思考增量 → onThinking（未提供时忽略） */
            onUsage: callbacks.onUsage || function () {}, /* 用量信息 → onUsage（未提供时忽略） */
            onEnd: function () {
              if (!settled) { settled = true; callbacks.onDone(); } /* 流正常结束 */
            },
            onErr: function (err) {
              if (!settled) { settled = true; callbacks.onError(err); } /* 流中断/解析异常 */
            }
          },
          signal
        );
      })
      .catch(function (err) {
        /* 统一错误出口：fetch 网络错误 / 非 2xx / SSE 解析失败 */
        if (signal && signal.aborted) {
          // 用户点击"停止生成"：正常结束，调用方保留已接收内容
          if (!settled) { settled = true; callbacks.onDone(); }
          return;
        }
        if (!settled) {
          settled = true;
          callbacks.onError(describeFetchError(err, url));
        }
      });
  };

  /**
   * 读取并解析 SSE 流：
   * - 逐行解析 `data: {json}`，增量取 choices[0].delta.content（正文）
   *   与 choices[0].delta.reasoning_content（思考，兼容 delta.reasoning）
   * - `data: [DONE]` 结束；其余行（空行 / keep-alive / 注释）忽略
   * - 未收到 [DONE] 流即结束 / 读取中断 → 按错误处理
   * - signal 已中止（停止生成）→ 按正常结束处理
   * @param {Response} res fetch 成功响应（res.ok 为 true，body 为 ReadableStream）
   * @param {object} cb 回调 { onDelta: function(string): void, onReason: function(string): void, onEnd: function(): void, onErr: function(Error): void }
   * @param {AbortSignal|null} signal 中止信号
   * @returns {Promise<void>} 流处理完毕（onEnd 或 onErr 已触发）后 resolve
   */
  function readSse(res, cb, signal) {
    var reader = res.body.getReader();
    var decoder = new TextDecoder('utf-8');
    var buf = '';
    var gotDone = false;

    /**
     * 处理 SSE 单行：仅处理 `data:` 开头行；`[DONE]` 触发 onEnd，JSON 行分发思考/正文增量，
     * 其余行（空行 / keep-alive / 注释 / 无法解析）忽略。
     * @param {string} line 一行 SSE 文本（行尾 \n 已去掉，\r 已剥离）
     * @returns {void}
     */
    function handleLine(line) {
      if (line.indexOf('data:') !== 0) return;
      var data = line.slice(5).trim();
      if (data === '[DONE]') {
        if (!gotDone) { gotDone = true; cb.onEnd(); }
        return;
      }
      var obj;
      try {
        obj = JSON.parse(data);
      } catch (e) {
        return; // 忽略无法解析的行
      }
      /* 用量信息：开启 include_usage 后到达在末尾 chunk（此时 choices 可能为空数组），
         必须在 delta 检查之前提取 */
      var usage = obj && obj.usage;
      if (usage && cb.onUsage) cb.onUsage(normalizeUsage(usage));
      var choice = obj && obj.choices && obj.choices[0];
      if (!choice || !choice.delta) return;
      var delta = choice.delta;
      var reasoning = delta.reasoning_content != null ? delta.reasoning_content : delta.reasoning;
      if (typeof reasoning === 'string' && reasoning) cb.onReason(reasoning);
      if (typeof delta.content === 'string' && delta.content) cb.onDelta(delta.content);
    }

    /**
     * 递归泵读：每次读一块流数据，按行切分交给 handleLine，直到流结束或读取失败。
     * 结束时：已收到 [DONE] 或 signal 已中止 → onEnd；否则 onErr（流中断）。
     * @returns {Promise<void>} 整个流处理完毕（onEnd 或 onErr 已触发）后 resolve
     */
    function pump() {
      return reader.read().then(
        function (r) {
          if (r.done) {
            if (signal && signal.aborted) { cb.onEnd(); return; } // 停止生成：正常结束
            if (gotDone) {
              cb.onEnd();
            } else {
              cb.onErr(new Error(SSC.I18n.t('errStreamClosed')));
            }
            return;
          }
          buf += decoder.decode(r.value, { stream: true });
          var nl;
          while ((nl = buf.indexOf('\n')) !== -1) {
            handleLine(buf.slice(0, nl).replace(/\r$/, ''));
            buf = buf.slice(nl + 1);
          }
          return pump();
        },
        function (err) {
          if (signal && signal.aborted) { cb.onEnd(); return; } // 停止生成：正常结束
          cb.onErr(new Error(SSC.I18n.t('errStreamRead',
            [err && err.message ? err.message : SSC.I18n.t('errStreamReadFail')])));
        }
      );
    }

    return pump();
  }

  /**
   * 归一化单个 token 计数：仅接受非负有限 number，其余（缺失/字符串/负数/NaN）返回 null。
   * @param {*} v 原始值
   * @returns {number|null} token 数；无效时返回 null
   */
  function toTokenCount(v) {
    return typeof v === 'number' && isFinite(v) && v >= 0 ? v : null;
  }

  /**
   * 归一化 SSE chunk 中的 usage 对象：兼容 OpenAI 标准字段
   *（prompt_tokens / completion_tokens / prompt_tokens_details.cached_tokens）
   * 与 DeepSeek 风格的 prompt_cache_hit_tokens；三个字段各自可空。
   * @param {object} u 原始 usage 对象
   * @returns {{ inputTokens: number|null, outputTokens: number|null, cachedTokens: number|null }}
   */
  function normalizeUsage(u) {
    var details = u && u.prompt_tokens_details;
    var cached = toTokenCount(details && details.cached_tokens);
    if (cached == null) cached = toTokenCount(u && u.prompt_cache_hit_tokens);
    return {
      inputTokens: toTokenCount(u && u.prompt_tokens),
      outputTokens: toTokenCount(u && u.completion_tokens),
      cachedTokens: cached
    };
  }

  /** 非 2xx 状态码 → i18n 文案键（提示附在错误描述前；未列出的状态码用 httpGeneric） */
  var HTTP_HINT_KEYS = {
    400: 'http400',
    401: 'http401',
    403: 'http403',
    404: 'http404',
    408: 'http408',
    429: 'http429',
    500: 'http500',
    502: 'http502',
    503: 'http503',
    504: 'http504'
  };

  /**
   * 构造非 2xx 响应的错误描述：本地化提示 + HTTP 状态码 + API 返回的错误信息
   *（优先取 OpenAI 格式 {error:{message}}，其次 {message}；非 JSON 响应截取前 160 字符）。
   * @param {number} status HTTP 状态码
   * @param {string} text 响应体文本（可能为空或非 JSON）
   * @returns {string} 面向用户的错误描述（当前界面语言）
   */
  function extractHttpError(status, text) {
    var hint = SSC.I18n.t(HTTP_HINT_KEYS[status] || 'httpGeneric');
    var base = SSC.I18n.t('httpBase', [hint, status]);
    if (!text) return base;
    try {
      var j = JSON.parse(text);
      var m = (j && j.error && j.error.message) || (j && j.message);
      if (typeof m === 'string' && m) return SSC.I18n.t('httpDetail', [base, m]);
    } catch (e) { /* 非 JSON 响应，继续 */ }
    var t = String(text).trim().replace(/\s+/g, ' ').slice(0, 160);
    return t ? SSC.I18n.t('httpDetail', [base, t]) : base;
  }

  /**
   * 构造 fetch 阶段（连接层）错误的描述。
   * @param {Error} err fetch 抛出的错误（连接失败时通常为 TypeError）
   * @param {string} url 请求 URL（用于提示用户检查端点）
   * @returns {string} 面向用户的错误描述（当前界面语言）
   */
  function describeFetchError(err, url) {
    if (err instanceof TypeError) {
      return SSC.I18n.t('errConnect', [url]);
    }
    return err && err.message ? err.message : String(err);
  }

  SSC.Api = Api;
})();
