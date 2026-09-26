/*
 * store.js — Store 模块：IndexedDB 持久化层（数据库名：super-simple-chat）
 *
 * Schema：
 * - sessions      会话元数据 { id, title, createdAt, updatedAt, rootId, leafId }
 * - messages      完整消息节点，复合主键 [sessionId, id]；只存完整消息（含 interrupted 标记）；
 *                 user 消息可带 images：Array<string>（base64 data URL，粘贴顺序 = 请求与展示顺序）
 * - message-cache 流式 checkpoint，复合主键 [sessionId, messageId]；流结束/定稿后删除
 * - models        模型配置 { id, label, endpoint, model, apiKey, contextWindow, supportsImages, createdAt }，主键 id；
 *                 supportsImages 仅布尔 true 表示启用（缺省/其它值一律按不支持图片输入处理）
 *
 * 约定：
 * - 所有方法异步（Promise）；每个操作级方法 = 一个原子事务（可跨多存储）
 * - 写入失败 reject；调用方 catch 后告警，不阻断 UI（内存状态为权威来源）
 * - 会话内消息为树状结构：每会话一个 placeholder 根节点（role:'root'），
 *   节点双向指针（parentId + children），会话记录持有 leafId 指向当前分支末端
 */
(function () {
  'use strict';

  window.SSC = window.SSC || {};

  var DB_NAME = 'super-simple-chat';

  var STORE_SESSIONS = 'sessions';
  var STORE_MESSAGES = 'messages';
  var STORE_CACHE = 'message-cache';
  var STORE_MODELS = 'models';

  var db = null;
  var seq = 0;

  /* 上下文窗口大小缺省值（128K）：旧记录缺失/非法时的回退 */
  var DEFAULT_CONTEXT_WINDOW = 131072;

  /* ---------- 底层工具 ---------- */

  /**
   * 把 IDBRequest 包装成 Promise（成功 resolve req.result，失败 reject req.error）。
   * @param {IDBRequest} req IndexedDB 请求
   * @returns {Promise<*>} 请求结果
   */
  function toPromise(req) {
    return new Promise(function (resolve, reject) {
      req.onsuccess = function () { resolve(req.result); }; /* 成功：resolve 请求结果 */
      req.onerror = function () { reject(req.error || new Error('IDB request failed')); }; /* 失败：reject 错误 */
    });
  }

  /**
   * 把 IDBTransaction 的 complete/abort/error 事件包装成 Promise。
   * @param {IDBTransaction} tx IndexedDB 事务
   * @returns {Promise<void>} 事务完成时 resolve；中止或出错时 reject
   */
  function txComplete(tx) {
    return new Promise(function (resolve, reject) {
      tx.oncomplete = function () { resolve(); }; /* 事务提交完成 */
      tx.onabort = function () { reject(tx.error || new Error('IDB transaction aborted')); }; /* 事务被中止 */
      tx.onerror = function () { reject(tx.error || new Error('IDB transaction error')); }; /* 事务出错 */
    });
  }

  /**
   * 在单个 readwrite 事务中执行 fn（事务覆盖 stores）。
   * fn 收到 { storeName: IDBObjectStore } 映射；内部对每个 request 使用 toPromise 等待。
   * 事务提交成功才 resolve；fn 抛错或请求失败时回滚事务并 reject。
   * @param {string|Array<string>} stores 涉及的对象存储名（单个或多个）
   * @param {function(object): Promise<*>} fn 事务内逻辑，参数为 { storeName: IDBObjectStore } 映射
   * @returns {Promise<*>} fn 的返回值（事务提交成功后）
   */
  async function withTx(stores, fn) {
    var names = Array.isArray(stores) ? stores : [stores];
    var tx = db.transaction(names, 'readwrite');
    var os = {};
    names.forEach(function (n) { os[n] = tx.objectStore(n); });
    var done = txComplete(tx);
    try {
      var result = await fn(os);
      await done;
      return result;
    } catch (e) {
      if (tx.active) { try { tx.abort(); } catch (e2) { /* ignore */ } }
      await done.catch(function () {});
      throw e;
    }
  }

  /**
   * 只读单条读取（独立只读事务）。
   * @param {string} store 对象存储名
   * @param {IDBValidKey} key 主键（复合主键为数组）
   * @returns {Promise<*>} 记录值；不存在时 resolve undefined
   */
  function roGet(store, key) {
    var tx = db.transaction(store, 'readonly');
    return toPromise(tx.objectStore(store).get(key));
  }

  /**
   * 只读范围读取全部记录（独立只读事务）。
   * @param {string} store 对象存储名
   * @param {IDBKeyRange|undefined} range 可选键范围，缺省为全部记录
   * @returns {Promise<Array<*>>} 记录数组
   */
  function roGetAll(store, range) {
    var tx = db.transaction(store, 'readonly');
    return toPromise(tx.objectStore(store).getAll(range));
  }

  /**
   * 事务内写入一条记录（按 keyPath 覆盖）。
   * @param {IDBObjectStore} store 对象存储
   * @param {object} value 记录对象
   * @returns {Promise<*>} 主键值
   */
  function putReq(store, value) { return toPromise(store.put(value)); }
  /**
   * 事务内按主键删除一条记录。
   * @param {IDBObjectStore} store 对象存储
   * @param {IDBValidKey} key 主键（复合主键为数组）
   * @returns {Promise<void>}
   */
  function delReq(store, key) { return toPromise(store.delete(key)); }
  /**
   * 事务内按键范围删除全部记录。
   * @param {IDBObjectStore} store 对象存储
   * @param {IDBKeyRange} range 键范围
   * @returns {Promise<void>}
   */
  function delRangeReq(store, range) { return toPromise(store.delete(range)); }

  /**
   * 构造覆盖某会话全部记录的复合主键范围
   *（id 字符集为 [0-9a-z_]，'\uffff' 必大于任何 id，上界保证按字符串比较全覆盖）。
   * @param {string} sessionId 会话 id
   * @returns {IDBKeyRange} 复合主键范围 [[sessionId, ''] 至 [sessionId, '\uffff']]
   */
  function sessionRange(sessionId) {
    return IDBKeyRange.bound([sessionId, ''], [sessionId, '\uffff']);
  }

  /* ---------- 归一化（读盘校验） ---------- */

  /**
   * 判断是否为纯对象（非 null、非数组的 object）。
   * @param {*} x 任意值
   * @returns {boolean}
   */
  function isPlainObject(x) {
    return x !== null && typeof x === 'object' && !Array.isArray(x);
  }

  /**
   * 归一化为字符串：非 string 一律返回空串。
   * @param {*} v 任意值
   * @returns {string}
   */
  function str(v) { return typeof v === 'string' ? v : ''; }
  /**
   * 归一化为有限数字：非 number 或非有限值一律返回 0。
   * @param {*} v 任意值
   * @returns {number}
   */
  function num(v) { return typeof v === 'number' && isFinite(v) ? v : 0; }

  /**
   * 归一化为非负有限数字：非 number / 非有限 / 负数一律返回 null（token 计数字段可空）。
   * @param {*} v 任意值
   * @returns {number|null} token 数；缺失或非法时返回 null
   */
  function numOrNull(v) {
    return typeof v === 'number' && isFinite(v) && v >= 0 ? v : null;
  }

  /**
   * 归一化 id 列表：仅保留非空字符串元素（非法输入返回空数组）。
   * @param {*} v 任意值（期望为字符串数组）
   * @returns {Array<string>}
   */
  function idList(v) {
    return Array.isArray(v)
      ? v.filter(function (x) { return typeof x === 'string' && x.length > 0; })
      : [];
  }

  /**
   * 归一化图片列表：仅保留 "data:" 开头的 data URL 字符串（非法元素丢弃；非法输入返回空数组）。
   * @param {*} v 任意值（期望为 data URL 字符串数组）
   * @returns {Array<string>}
   */
  function imageList(v) {
    return Array.isArray(v)
      ? v.filter(function (x) { return typeof x === 'string' && x.indexOf('data:') === 0; })
      : [];
  }

  /**
   * 会话记录归一化（读盘校验）：字段缺失/类型错误时填默认值；缺 id 视为无效。
   * @param {*} s 读自 sessions 表的原始记录
   * @returns {object|null} 合法时返回 { id, title, createdAt, updatedAt, rootId, leafId }，无效返回 null
   */
  function normalizeSession(s) {
    if (!isPlainObject(s) || !str(s.id)) return null;
    return {
      id: str(s.id),
      title: str(s.title).trim(),
      createdAt: num(s.createdAt) || Date.now(),
      updatedAt: num(s.updatedAt) || Date.now(),
      rootId: str(s.rootId),
      leafId: str(s.leafId)
    };
  }

  /**
   * 消息节点归一化（读盘校验）：缺 sessionId/id 或 role 非法（root/user/assistant/summary）视为无效。
   * thinking 仅 assistant 节点保留；error 空值归一为 null；interrupted 归一为 0/1；
   * images 为粘贴图片的 data URL 列表（仅 user 消息会写入；非 data: URL 的条目丢弃）。
   * inputTokens / outputTokens / cachedTokens 为本轮请求/响应的 token 用量（可空；
   * assistant 为回复轮用量，summary 为压缩请求的用量）。
   * @param {*} n 读自 messages 表的原始记录
   * @returns {object|null} 合法时返回消息节点 { sessionId, id, parentId, children, role, content, images, thinking, error, interrupted, createdAt, modelId, inputTokens, outputTokens, cachedTokens }，无效返回 null
   */
  function normalizeNode(n) {
    if (!isPlainObject(n) || !str(n.sessionId) || !str(n.id)) return null;
    if (n.role !== 'root' && n.role !== 'user' && n.role !== 'assistant' && n.role !== 'summary') return null;
    return {
      sessionId: str(n.sessionId),
      id: str(n.id),
      parentId: str(n.parentId) || null,
      children: idList(n.children),
      role: n.role,
      content: str(n.content),
      images: imageList(n.images),
      thinking: n.role === 'assistant' ? str(n.thinking) : '',
      error: n.error == null || n.error === '' ? null : str(n.error),
      interrupted: n.interrupted ? 1 : 0,
      createdAt: num(n.createdAt) || Date.now(),
      modelId: n.modelId ? str(n.modelId) : null,
      inputTokens: numOrNull(n.inputTokens),
      outputTokens: numOrNull(n.outputTokens),
      cachedTokens: numOrNull(n.cachedTokens)
    };
  }

  /**
   * 流式 checkpoint 记录归一化（读盘校验）：缺 sessionId/messageId 视为无效。
   * role 为待物化节点的角色（assistant 或 summary；旧记录缺 role 时按 assistant 处理）。
   * @param {*} c 读自 message-cache 表的原始记录
   * @returns {object|null} 合法时返回 { sessionId, messageId, parentId, modelId, createdAt, content, thinking, role }，无效返回 null
   */
  function normalizeCheckpoint(c) {
    if (!isPlainObject(c) || !str(c.sessionId) || !str(c.messageId)) return null;
    return {
      sessionId: str(c.sessionId),
      messageId: str(c.messageId),
      parentId: str(c.parentId) || null,
      modelId: c.modelId ? str(c.modelId) : null,
      createdAt: num(c.createdAt) || Date.now(),
      content: str(c.content),
      thinking: str(c.thinking),
      role: c.role === 'summary' ? 'summary' : 'assistant'
    };
  }

  /**
   * 上下文窗口大小归一化：仅有限正整数合法（向下取整），否则回退缺省 131072（128K）。
   * @param {*} v 读自磁盘的原始值
   * @returns {number} 合法的正整数上下文窗口大小
   */
  function normalizeContextWindow(v) {
    var n = Math.floor(Number(v));
    return Number.isFinite(n) && n > 0 ? n : DEFAULT_CONTEXT_WINDOW;
  }

  /**
   * 模型配置记录归一化（读盘校验）：缺 id/endpoint/model 视为无效；
   * contextWindow 归一化为正整数（缺失/非法回退缺省 131072 = 128K）；
   * supportsImages 仅严格等于 true 时启用（缺失/非布尔一律 false，默认不支持图片输入）。
   * @param {*} m 读自 models 表的原始记录
   * @returns {object|null} 合法时返回 { id, label, endpoint, model, apiKey, contextWindow, supportsImages, createdAt }，无效返回 null
   */
  function normalizeModel(m) {
    if (!isPlainObject(m) || !str(m.id)) return null;
    var endpoint = str(m.endpoint).trim();
    var model = str(m.model).trim();
    if (!endpoint || !model) return null;
    return {
      id: str(m.id),
      label: str(m.label).trim(),
      endpoint: endpoint,
      model: model,
      apiKey: str(m.apiKey),
      contextWindow: normalizeContextWindow(m.contextWindow),
      supportsImages: m.supportsImages === true,
      createdAt: num(m.createdAt) || Date.now()
    };
  }

  /**
   * 把 checkpoint 物化为一条 interrupted 的消息节点（崩溃恢复用）。
   * role 取自 checkpoint 记录（assistant 或 summary）；checkpoint 只存内容不存用量，token 计数字段均为 null。
   * @param {object} c 已归一化的 checkpoint 记录（见 normalizeCheckpoint）
   * @returns {object} 消息节点（interrupted:1、children 为空数组、token 计数为空）
   */
  function checkpointToNode(c) {
    return {
      sessionId: c.sessionId,
      id: c.messageId,
      parentId: c.parentId,
      children: [],
      role: c.role === 'summary' ? 'summary' : 'assistant',
      content: c.content,
      images: [],
      thinking: c.thinking,
      error: null,
      interrupted: 1,
      createdAt: c.createdAt,
      modelId: c.modelId,
      inputTokens: null,
      outputTokens: null,
      cachedTokens: null
    };
  }

  /* ---------- Store / DB API ---------- */

  var Store = {
    /** 数据库名（暴露供测试/诊断） */
    DB_NAME: DB_NAME,

    /** 上下文窗口大小缺省值（128K）；暴露给 app 层在表单留空时回退 */
    DEFAULT_CONTEXT_WINDOW: DEFAULT_CONTEXT_WINDOW,

    /**
     * 生成唯一 id（沿用旧版格式：prefix_base36时间_随机_seq）。
     * @param {string} [prefix='id'] id 前缀（会话 's'、消息 'n'、根 'r'、模型 'm'）
     * @returns {string} 唯一 id
     */
    newId: function (prefix) {
      seq += 1;
      return (prefix || 'id') + '_' + Date.now().toString(36) + '_' +
        Math.random().toString(36).slice(2, 8) + '_' + seq;
    },

    /**
     * 打开（或首次创建）数据库；幂等，重复调用复用同一连接。
     * @returns {Promise<void>} 打开完成后 resolve；浏览器不支持 IndexedDB 或打开失败时 reject
     */
    init: async function () {
      if (db) return;
      if (typeof indexedDB === 'undefined') {
        throw new Error(SSC.I18n.t('errNoIdb'));
      }
      db = await new Promise(function (resolve, reject) {
        var req;
        try {
          req = indexedDB.open(DB_NAME, 1);
        } catch (e) { reject(e); return; }
        req.onupgradeneeded = function (e) {
          var d = e.target.result;
          /* 首次建库：创建全部存储 */
          d.createObjectStore(STORE_SESSIONS, { keyPath: 'id' });
          d.createObjectStore(STORE_MESSAGES, { keyPath: ['sessionId', 'id'] });
          d.createObjectStore(STORE_CACHE, { keyPath: ['sessionId', 'messageId'] });
          d.createObjectStore(STORE_MODELS, { keyPath: 'id' });
        };
        req.onsuccess = function () { /* 打开成功：resolve 连接 */ resolve(req.result); };
        req.onerror = function () { /* 打开失败：reject */ reject(req.error || new Error('IndexedDB 打开失败')); };
      });
    },

    /* ---------- sessions ---------- */

    /**
     * 列出全部会话（按 updatedAt 倒序，最新活动在前）。
     * @returns {Promise<Array<object>>} 归一化后的会话记录数组（非法记录被丢弃）
     */
    listSessions: async function () {
      var rows = await roGetAll(STORE_SESSIONS);
      return rows.map(normalizeSession).filter(function (s) { return s; })
        .sort(function (a, b) { return b.updatedAt - a.updatedAt; });
    },

    /**
     * 读取单个会话。
     * @param {string} id 会话 id
     * @returns {Promise<object|null>} 归一化后的会话记录；不存在或非法时返回 null
     */
    getSession: async function (id) {
      var row = await roGet(STORE_SESSIONS, id);
      return row ? normalizeSession(row) : null;
    },

    /**
     * 创建会话：sessions 记录 + placeholder 根消息，单事务（活动会话指针由 app 层写 localStorage）。
     * @param {object} session 会话记录 { id, title, createdAt, updatedAt, rootId, leafId }（rootId/leafId 均指向 root）
     * @param {object} root placeholder 根消息节点（role:'root'、parentId:null、children:[]）
     * @returns {Promise<void>}
     */
    createSession: async function (session, root) {
      await withTx([STORE_SESSIONS, STORE_MESSAGES], async function (os) {
        await putReq(os[STORE_SESSIONS], session);
        await putReq(os[STORE_MESSAGES], root);
      });
    },

    /**
     * 删除会话：sessions 记录 + 该会话全部 messages + 该会话 cache 残留，单事务（活动会话指针由 app 层写 localStorage）。
     * @param {string} sessionId 会话 id
     * @returns {Promise<void>}
     */
    deleteSession: async function (sessionId) {
      var range = sessionRange(sessionId);
      await withTx([STORE_SESSIONS, STORE_MESSAGES, STORE_CACHE], async function (os) {
        await delRangeReq(os[STORE_MESSAGES], range);
        await delRangeReq(os[STORE_CACHE], range);
        await delReq(os[STORE_SESSIONS], sessionId);
      });
    },

    /* ---------- models ---------- */

    /**
     * 列出全部模型（按 createdAt 升序，即用户添加顺序）。
     * @returns {Promise<Array<object>>} 归一化后的模型配置数组（非法记录被丢弃）
     */
    listModels: async function () {
      var rows = await roGetAll(STORE_MODELS);
      return rows.map(normalizeModel).filter(function (m) { return m; })
        .sort(function (a, b) { return a.createdAt - b.createdAt; });
    },

    /**
     * 创建/更新单个模型（按 id 幂等写入）。
     * @param {object} m 模型配置 { id, label, endpoint, model, apiKey, contextWindow, supportsImages, createdAt }
     * @returns {Promise<void>}
     */
    putModel: async function (m) {
      await withTx(STORE_MODELS, async function (os) {
        await putReq(os[STORE_MODELS], m);
      });
    },

    /**
     * 删除单个模型。
     * @param {string} id 模型 id
     * @returns {Promise<void>}
     */
    deleteModel: async function (id) {
      await withTx(STORE_MODELS, async function (os) {
        await delReq(os[STORE_MODELS], id);
      });
    },

    /* ---------- messages（操作级事务） ---------- */

    /**
     * 读取会话全部节点（一次范围读）。
     * @param {string} sessionId 会话 id
     * @returns {Promise<Map<string, object>>} 消息节点映射 { id: node }（已归一化，非法记录被丢弃）
     */
    loadSessionMessages: async function (sessionId) {
      var rows = await roGetAll(STORE_MESSAGES, sessionRange(sessionId));
      var map = new Map();
      rows.forEach(function (r) {
        var n = normalizeNode(r);
        if (n) map.set(n.id, n);
      });
      return map;
    },

    /**
     * send 提交：新增消息节点 + 父节点（children 追加）+ 会话（leafId/updatedAt/title）
     * + 流式 checkpoint 记录，单事务原子。node 可为 user 节点或上下文压缩记录（summary）节点。
     * @param {object} node 新增的消息节点（user 或 summary）
     * @param {object} parentNode 父节点（已把 node.id 追加进 children）
     * @param {object} session 会话记录（leafId 指向占位的 assistant 节点或压缩记录）
     * @param {object} rec 流式 checkpoint 记录（空缓冲）
     * @returns {Promise<void>}
     */
    commitSend: async function (node, parentNode, session, rec) {
      await withTx([STORE_MESSAGES, STORE_SESSIONS, STORE_CACHE], async function (os) {
        await putReq(os[STORE_MESSAGES], node);
        await putReq(os[STORE_MESSAGES], parentNode);
        await putReq(os[STORE_SESSIONS], session);
        await putReq(os[STORE_CACHE], rec);
      });
    },

    /**
     * 流式 checkpoint（高频、单记录替换写）。
     * @param {object} rec checkpoint 记录（content/thinking 为截至当前的完整文本）
     * @returns {Promise<void>}
     */
    checkpoint: async function (rec) {
      await withTx(STORE_CACHE, async function (os) {
        await putReq(os[STORE_CACHE], rec);
      });
    },

    /**
     * 定稿：assistant 节点写 messages + 会话 updatedAt + 删 cache，单事务。
     * @param {object} assistant 完整 assistant 消息节点
     * @param {object|null} session 会话记录（updatedAt 已更新）；null 表示不更新会话
     * @returns {Promise<void>}
     */
    commitFinalize: async function (assistant, session) {
      var cacheKey = [assistant.sessionId, assistant.id];
      await withTx([STORE_MESSAGES, STORE_SESSIONS, STORE_CACHE], async function (os) {
        await putReq(os[STORE_MESSAGES], assistant);
        if (session) await putReq(os[STORE_SESSIONS], session);
        await delReq(os[STORE_CACHE], cacheKey);
      });
    },

    /**
     * fork 提交：新节点们 + 父节点（children 追加）+ 会话（leafId）+ cache 记录，单事务。
     * nodes 中可包含新的 user 版本节点、新的 assistant 节点与/或插入的上下文压缩记录（summary）节点；
     * 顺序即写入顺序。
     * @param {Array<object>} nodes 分叉新增的消息节点（children 已挂好）
     * @param {object} parentNode 父节点（已把新节点 id 追加进 children）
     * @param {object} session 会话记录（leafId 指向分叉后的新末端）
     * @param {object} rec 流式 checkpoint 记录（空缓冲）
     * @returns {Promise<void>}
     */
    commitFork: async function (nodes, parentNode, session, rec) {
      await withTx([STORE_MESSAGES, STORE_SESSIONS, STORE_CACHE], async function (os) {
        for (var i = 0; i < nodes.length; i++) await putReq(os[STORE_MESSAGES], nodes[i]);
        await putReq(os[STORE_MESSAGES], parentNode);
        await putReq(os[STORE_SESSIONS], session);
        await putReq(os[STORE_CACHE], rec);
      });
    },

    /**
     * 分支切换：仅写会话记录（leafId）。
     * @param {object} session 会话记录（leafId 指向新分支末端）
     * @returns {Promise<void>}
     */
    setLeaf: async function (session) {
      await withTx(STORE_SESSIONS, async function (os) {
        await putReq(os[STORE_SESSIONS], session);
      });
    },

    /* ---------- message-cache（崩溃对账） ---------- */

    /**
     * 全部 checkpoint 记录（正常情况至多一条；崩溃时可能残留）。
     * @returns {Promise<Array<object>>} 归一化后的 checkpoint 记录数组
     */
    getAllPending: async function () {
      var rows = await roGetAll(STORE_CACHE);
      return rows.map(normalizeCheckpoint).filter(function (c) { return c; });
    },

    /**
     * 对账：把残留 checkpoint 物化为 interrupted 节点（幂等：节点已存在则仅删 cache）。
     * @param {object} rec checkpoint 记录
     * @returns {Promise<void>}
     */
    materializeCheckpoint: async function (rec) {
      var node = checkpointToNode(rec);
      await withTx([STORE_MESSAGES, STORE_CACHE], async function (os) {
        var existing = await roInTx(os[STORE_MESSAGES], [rec.sessionId, rec.messageId]);
        if (!existing) await putReq(os[STORE_MESSAGES], node);
        await delReq(os[STORE_CACHE], [rec.sessionId, rec.messageId]);
      });
    },

    /**
     * 对账：删除所属会话已不存在的残留 checkpoint。
     * @param {string} sessionId 会话 id
     * @param {string} messageId 消息 id
     * @returns {Promise<void>}
     */
    dropCheckpoint: async function (sessionId, messageId) {
      await withTx(STORE_CACHE, async function (os) {
        await delReq(os[STORE_CACHE], [sessionId, messageId]);
      });
    }
  };

  /* ---------- 事务内读取辅助 ---------- */

  /**
   * 事务内只读单条读取（供 withTx 事务内部使用）。
   * @param {IDBObjectStore} store 对象存储
   * @param {IDBValidKey} key 主键（复合主键为数组）
   * @returns {Promise<*>} 记录值；不存在时 resolve undefined
   */
  function roInTx(store, key) {
    return toPromise(store.get(key));
  }

  window.SSC.Store = Store;
  // 兼容别名：SSC.DB
  window.SSC.DB = Store;
})();
