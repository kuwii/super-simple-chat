/*
 * store.js — Store 模块：IndexedDB 持久化层（数据库名：super-simple-chat）
 *
 * Schema：
 * - sessions      会话元数据 { id, title, createdAt, updatedAt, rootId, leafId }
 * - messages      完整消息节点，复合主键 [sessionId, id]；只存完整消息（含 interrupted 标记）
 * - message-cache 流式 checkpoint，复合主键 [sessionId, messageId]；流结束/定稿后删除
 * - models        模型配置 { id, label, endpoint, model, apiKey, createdAt }，主键 id
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

  /* ---------- 底层工具 ---------- */

  function toPromise(req) {
    return new Promise(function (resolve, reject) {
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error || new Error('IDB request failed')); };
    });
  }

  function txComplete(tx) {
    return new Promise(function (resolve, reject) {
      tx.oncomplete = function () { resolve(); };
      tx.onabort = function () { reject(tx.error || new Error('IDB transaction aborted')); };
      tx.onerror = function () { reject(tx.error || new Error('IDB transaction error')); };
    });
  }

  /**
   * 在单个 readwrite 事务中执行 fn（事务覆盖 stores）。
   * fn 收到 { storeName: objectStore } 映射；内部对每个 request 使用 toPromise 等待。
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

  function roGet(store, key) {
    var tx = db.transaction(store, 'readonly');
    return toPromise(tx.objectStore(store).get(key));
  }

  function roGetAll(store, range) {
    var tx = db.transaction(store, 'readonly');
    return toPromise(tx.objectStore(store).getAll(range));
  }

  function putReq(store, value) { return toPromise(store.put(value)); }
  function delReq(store, key) { return toPromise(store.delete(key)); }
  function delRangeReq(store, range) { return toPromise(store.delete(range)); }

  /** 覆盖某会话全部记录的键范围（id 字符集为 [0-9a-z_]，\uffff 必大于任何 id） */
  function sessionRange(sessionId) {
    return IDBKeyRange.bound([sessionId, ''], [sessionId, '\uffff']);
  }

  /* ---------- 归一化（读盘校验） ---------- */

  function isPlainObject(x) {
    return x !== null && typeof x === 'object' && !Array.isArray(x);
  }

  function str(v) { return typeof v === 'string' ? v : ''; }
  function num(v) { return typeof v === 'number' && isFinite(v) ? v : 0; }

  function idList(v) {
    return Array.isArray(v)
      ? v.filter(function (x) { return typeof x === 'string' && x.length > 0; })
      : [];
  }

  /** 会话记录；无效返回 null */
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

  /** 消息节点；无效返回 null */
  function normalizeNode(n) {
    if (!isPlainObject(n) || !str(n.sessionId) || !str(n.id)) return null;
    if (n.role !== 'root' && n.role !== 'user' && n.role !== 'assistant') return null;
    return {
      sessionId: str(n.sessionId),
      id: str(n.id),
      parentId: str(n.parentId) || null,
      children: idList(n.children),
      role: n.role,
      content: str(n.content),
      thinking: n.role === 'assistant' ? str(n.thinking) : '',
      error: n.error == null || n.error === '' ? null : str(n.error),
      interrupted: n.interrupted ? 1 : 0,
      createdAt: num(n.createdAt) || Date.now(),
      modelId: n.modelId ? str(n.modelId) : null
    };
  }

  /** 流式 checkpoint 记录；无效返回 null */
  function normalizeCheckpoint(c) {
    if (!isPlainObject(c) || !str(c.sessionId) || !str(c.messageId)) return null;
    return {
      sessionId: str(c.sessionId),
      messageId: str(c.messageId),
      parentId: str(c.parentId) || null,
      modelId: c.modelId ? str(c.modelId) : null,
      createdAt: num(c.createdAt) || Date.now(),
      content: str(c.content),
      thinking: str(c.thinking)
    };
  }

  /** 模型配置记录；无效返回 null */
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
      createdAt: num(m.createdAt) || Date.now()
    };
  }

  /** 把 checkpoint 物化为一条 interrupted 的 assistant 节点（崩溃恢复用） */
  function checkpointToNode(c) {
    return {
      sessionId: c.sessionId,
      id: c.messageId,
      parentId: c.parentId,
      children: [],
      role: 'assistant',
      content: c.content,
      thinking: c.thinking,
      error: null,
      interrupted: 1,
      createdAt: c.createdAt,
      modelId: c.modelId
    };
  }

  /* ---------- Store / DB API ---------- */

  var Store = {
    /** 数据库名（暴露供测试/诊断） */
    DB_NAME: DB_NAME,

    /** 生成唯一 id（沿用旧版格式：prefix_base36时间_随机_seq） */
    newId: function (prefix) {
      seq += 1;
      return (prefix || 'id') + '_' + Date.now().toString(36) + '_' +
        Math.random().toString(36).slice(2, 8) + '_' + seq;
    },

    /** 打开（或首次创建）数据库；幂等 */
    init: async function () {
      if (db) return;
      if (typeof indexedDB === 'undefined') {
        throw new Error('当前浏览器不支持 IndexedDB');
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
        req.onsuccess = function () { resolve(req.result); };
        req.onerror = function () { reject(req.error || new Error('IndexedDB 打开失败')); };
      });
    },

    /* ---------- sessions ---------- */

    /** 列出全部会话（按 updatedAt 倒序） */
    listSessions: async function () {
      var rows = await roGetAll(STORE_SESSIONS);
      return rows.map(normalizeSession).filter(function (s) { return s; })
        .sort(function (a, b) { return b.updatedAt - a.updatedAt; });
    },

    getSession: async function (id) {
      var row = await roGet(STORE_SESSIONS, id);
      return row ? normalizeSession(row) : null;
    },

    /** 创建会话：sessions + placeholder 根消息，单事务（活动会话指针由 app 层写 localStorage） */
    createSession: async function (session, root) {
      await withTx([STORE_SESSIONS, STORE_MESSAGES], async function (os) {
        await putReq(os[STORE_SESSIONS], session);
        await putReq(os[STORE_MESSAGES], root);
      });
    },

    /** 删除会话：sessions + 该会话全部 messages + 该会话 cache 残留，单事务（活动会话指针由 app 层写 localStorage） */
    deleteSession: async function (sessionId) {
      var range = sessionRange(sessionId);
      await withTx([STORE_SESSIONS, STORE_MESSAGES, STORE_CACHE], async function (os) {
        await delRangeReq(os[STORE_MESSAGES], range);
        await delRangeReq(os[STORE_CACHE], range);
        await delReq(os[STORE_SESSIONS], sessionId);
      });
    },

    /* ---------- models ---------- */

    /** 列出全部模型（按 createdAt 升序，即用户添加顺序） */
    listModels: async function () {
      var rows = await roGetAll(STORE_MODELS);
      return rows.map(normalizeModel).filter(function (m) { return m; })
        .sort(function (a, b) { return a.createdAt - b.createdAt; });
    },

    /** 创建/更新单个模型（按 id 幂等写入） */
    putModel: async function (m) {
      await withTx(STORE_MODELS, async function (os) {
        await putReq(os[STORE_MODELS], m);
      });
    },

    /** 删除单个模型 */
    deleteModel: async function (id) {
      await withTx(STORE_MODELS, async function (os) {
        await delReq(os[STORE_MODELS], id);
      });
    },

    /* ---------- messages（操作级事务） ---------- */

    /** 读取会话全部节点（一次范围读），返回 Map<id, node> */
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
     * send 提交：user 节点 + 父节点（children 追加）+ 会话（leafId/updatedAt/title）
     * + 流式 checkpoint 记录，单事务原子。
     */
    commitSend: async function (userNode, parentNode, session, rec) {
      await withTx([STORE_MESSAGES, STORE_SESSIONS, STORE_CACHE], async function (os) {
        await putReq(os[STORE_MESSAGES], userNode);
        await putReq(os[STORE_MESSAGES], parentNode);
        await putReq(os[STORE_SESSIONS], session);
        await putReq(os[STORE_CACHE], rec);
      });
    },

    /** 流式 checkpoint（高频、单记录替换写） */
    checkpoint: async function (rec) {
      await withTx(STORE_CACHE, async function (os) {
        await putReq(os[STORE_CACHE], rec);
      });
    },

    /** 定稿：assistant 节点写 messages + 会话 updatedAt + 删 cache，单事务 */
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
     * nodes 中可包含新的 user 版本节点与/或新的 assistant 节点；顺序即写入顺序。
     */
    commitFork: async function (nodes, parentNode, session, rec) {
      await withTx([STORE_MESSAGES, STORE_SESSIONS, STORE_CACHE], async function (os) {
        for (var i = 0; i < nodes.length; i++) await putReq(os[STORE_MESSAGES], nodes[i]);
        await putReq(os[STORE_MESSAGES], parentNode);
        await putReq(os[STORE_SESSIONS], session);
        await putReq(os[STORE_CACHE], rec);
      });
    },

    /** 分支切换：仅写会话记录（leafId） */
    setLeaf: async function (session) {
      await withTx(STORE_SESSIONS, async function (os) {
        await putReq(os[STORE_SESSIONS], session);
      });
    },

    /* ---------- message-cache（崩溃对账） ---------- */

    /** 全部 checkpoint 记录（正常情况至多一条） */
    getAllPending: async function () {
      var rows = await roGetAll(STORE_CACHE);
      return rows.map(normalizeCheckpoint).filter(function (c) { return c; });
    },

    /** 对账：把残留 checkpoint 物化为 interrupted 节点（幂等：节点已存在则仅删 cache） */
    materializeCheckpoint: async function (rec) {
      var node = checkpointToNode(rec);
      await withTx([STORE_MESSAGES, STORE_CACHE], async function (os) {
        var existing = await roInTx(os[STORE_MESSAGES], [rec.sessionId, rec.messageId]);
        if (!existing) await putReq(os[STORE_MESSAGES], node);
        await delReq(os[STORE_CACHE], [rec.sessionId, rec.messageId]);
      });
    },

    /** 对账：删除所属会话已不存在的残留 checkpoint */
    dropCheckpoint: async function (sessionId, messageId) {
      await withTx(STORE_CACHE, async function (os) {
        await delReq(os[STORE_CACHE], [sessionId, messageId]);
      });
    }
  };

  /* ---------- 事务内读取辅助 ---------- */

  function roInTx(store, key) {
    return toPromise(store.get(key));
  }

  window.SSC.Store = Store;
  // 兼容别名：SSC.DB
  window.SSC.DB = Store;
})();
