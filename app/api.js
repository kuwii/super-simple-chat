/*
 * api.js — Api 模块：OpenAI Chat Completions 请求 + SSE 流解析 + AbortController。
 */
(function () {
  'use strict';

  window.SSC = window.SSC || {};

  var Api = {};

  /**
   * 构造完整请求 URL。
   * endpoint 可为 `http://host:port`、`http://host:port/v1`（甚至缺省协议）；
   * 末尾缺 `/chat/completions` 时自动补全。
   * @param {string} endpoint
   * @returns {string}
   */
  Api.buildUrl = function (endpoint) {
    var base = String(endpoint || '').trim().replace(/\/+$/, '');
    if (!base) throw new Error('Endpoint 不能为空');
    if (!/^https?:\/\//i.test(base)) base = 'http://' + base;
    if (!/\/chat\/completions$/.test(base)) base += '/chat/completions';
    return base;
  };

  /**
   * 发起流式聊天请求。
   * @param {object} config { endpoint, model, apiKey }
   * @param {Array<{role: string, content: string}>} messages
   * @param {object} callbacks { onThinking(text), onToken(text), onDone(), onError(Error) }
   * @param {AbortSignal} signal 中止（停止生成）视为正常结束，不触发 onError
   */
  Api.stream = function (config, messages, callbacks, signal) {
    var url;
    try {
      url = Api.buildUrl(config.endpoint);
    } catch (err) {
      callbacks.onError(err);
      return;
    }

    var settled = false;
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
        stream: true
      }),
      signal: signal
    })
      .then(function (res) {
        if (!res.ok) {
          return res.text().then(function (txt) {
            throw new Error(extractHttpError(res.status, txt));
          });
        }
        return readSse(
          res,
          {
            onDelta: callbacks.onToken,
            onReason: callbacks.onThinking || function () {},
            onEnd: function () {
              if (!settled) { settled = true; callbacks.onDone(); }
            },
            onErr: function (err) {
              if (!settled) { settled = true; callbacks.onError(err); }
            }
          },
          signal
        );
      })
      .catch(function (err) {
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
   */
  function readSse(res, cb, signal) {
    var reader = res.body.getReader();
    var decoder = new TextDecoder('utf-8');
    var buf = '';
    var gotDone = false;

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
      var choice = obj && obj.choices && obj.choices[0];
      if (!choice || !choice.delta) return;
      var delta = choice.delta;
      var reasoning = delta.reasoning_content != null ? delta.reasoning_content : delta.reasoning;
      if (typeof reasoning === 'string' && reasoning) cb.onReason(reasoning);
      if (typeof delta.content === 'string' && delta.content) cb.onDelta(delta.content);
    }

    function pump() {
      return reader.read().then(
        function (r) {
          if (r.done) {
            if (signal && signal.aborted) { cb.onEnd(); return; } // 停止生成：正常结束
            if (gotDone) {
              cb.onEnd();
            } else {
              cb.onErr(new Error('流中断：服务器在回复结束前关闭了连接'));
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
          cb.onErr(new Error('流中断：' + (err && err.message ? err.message : '读取流失败')));
        }
      );
    }

    return pump();
  }

  /** 非 2xx：优先取 API 返回的错误信息（OpenAI 格式 {error:{message}}），附中文提示 */
  var HTTP_HINTS = {
    400: '请求参数有误',
    401: '认证失败（请检查 API Key）',
    403: '无权限访问该模型',
    404: '端点或模型不存在',
    408: '请求超时',
    429: '请求过于频繁，请稍后再试',
    500: '服务器内部错误',
    502: '网关错误',
    503: '服务暂时不可用',
    504: '网关超时'
  };

  function extractHttpError(status, text) {
    var hint = HTTP_HINTS[status] || 'API 错误';
    var base = hint + '（HTTP ' + status + '）';
    if (!text) return base;
    try {
      var j = JSON.parse(text);
      var m = (j && j.error && j.error.message) || (j && j.message);
      if (typeof m === 'string' && m) return base + '：' + m;
    } catch (e) { /* 非 JSON 响应，继续 */ }
    var t = String(text).trim().replace(/\s+/g, ' ').slice(0, 160);
    return t ? base + '：' + t : base;
  }

  /** 连接失败（fetch 网络错误） */
  function describeFetchError(err, url) {
    if (err instanceof TypeError) {
      return '连接失败：无法连接到 ' + url + '（请检查端点是否启动、地址是否正确）';
    }
    return err && err.message ? err.message : String(err);
  }

  SSC.Api = Api;
})();
