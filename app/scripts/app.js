/*
 * app.js — App 模块：内存状态与操作（send / stop / 会话管理 / 模型管理），程序入口与启动。
 *
 * Schema：
 * - 会话与消息持久化到 IndexedDB（SSC.DB）；会话内消息为树：
 *   每会话一个 placeholder 根节点（role:'root'），节点双向指针（parentId + children），
 *   会话记录持有 rootId / leafId（leafId = 当前分支末端）
 * - 模型配置持久化到 IndexedDB（models 表）；活动模型指针存 localStorage
 * - 流式生成：内存累积 + 节流 checkpoint（message-cache 存储）；
 *   定稿（完成/停止/出错）单事务写入 messages 并删除 checkpoint
 * - 启动时对账 message-cache 残留 → 物化为 interrupted 的助手消息（保留进度，不续流）
 * - 主题偏好与活动会话指针存 localStorage
 */
(function () {
  'use strict';

  window.SSC = window.SSC || {};

  var App = {};

  var ACTIVE_KEY = 'ssc.activeSession.v1';   /* 活动会话指针（UI 偏好；启动校验失效则回退） */
  var ACTIVE_MODEL_KEY = 'ssc.activeModel.v1'; /* 活动模型指针（UI 偏好；启动校验失效则回退到第一个模型） */
  var CHECK_INTERVAL_MS = 1500;   /* checkpoint 最小间隔 */
  var CHECK_MIN_GROWTH = 40;      /* checkpoint 最小新增字符数（正文+思考） */

  /* 内存状态（streaming/abort 等为运行时字段，不落盘） */
  var state = {
    models: [],
    activeModelId: null,
    sessions: [],           // 元数据 [{id, title, createdAt, updatedAt, rootId, leafId}]
    activeSessionId: null,
    activeCache: null,      // Map<nodeId, node>：活跃会话全部节点（含 placeholder 根）
    streaming: false,
    stopRequested: false,
    abort: null,
    editingNode: null,    // 正在编辑的 user 节点 id（纯内存，不持久化）
    dbBroken: false         // IndexedDB 不可用：纯内存模式（不持久化）
  };

  /* 进行中的流：{ node, handle, buf:{content,thinking}, rec, lastCk, usage } */
  var stream = null;

  /* ---------- 入口 ---------- */

  /**
   * 程序启动入口：构建 UI、绑定全部事件处理器、初始化主题，
   * 注册 pagehide/visibilitychange 落盘与编辑态离开确认，最后执行启动流程 bootstrap。
   * @returns {void}
   */
  App.init = function () {
    SSC.UI.init(document.getElementById('app'));
    SSC.UI.setHandlers({
      onSave: App.saveConfig,
      onSend: App.send,
      onStop: App.stop,
      onStartEdit: App.startEdit,
      onCancelEdit: App.cancelEdit,
      onSwitchVersion: App.switchVersion,
      onNewSession: App.newSession,
      onSwitchSession: App.switchSession,
      onDeleteSession: App.deleteSession,
      onSelectModel: App.switchModel,
      onManageModels: App.openModelManager,
      onToggleTheme: App.toggleTheme,
      onShowAddForm: App.showAddModelForm,
      onShowEditForm: App.showEditModelForm,
      onAddModel: App.addModel,
      onEditModel: App.editModel,
      onDeleteModel: App.deleteModel,
      onCloseModelManager: App.closeModelManager,
      onBackToModelList: App.backToModelList
    });

    App.initTheme();

    /* 页面隐藏/关闭时尽力把流式进度 checkpoint 落盘 */
    /* 页面隐藏/关闭时尽力把流式进度 checkpoint 落盘 */
    window.addEventListener('pagehide', function () {
      /* 页面隐藏/关闭：有进行中流则强制落盘 checkpoint */
      if (stream) doCheckpoint(true);
    });
    if (document.addEventListener) {
      document.addEventListener('visibilitychange', function () {
        /* 标签页切到后台：有进行中流则强制落盘 checkpoint */
        if (document.visibilityState === 'hidden' && stream) doCheckpoint(true);
      });
    }

    /* 关闭/刷新标签页：编辑态不落盘，触发浏览器离开确认提示 */
    /* 关闭/刷新标签页：编辑态不落盘，触发浏览器离开确认提示 */
    window.addEventListener('beforeunload', function (e) {
      /* 编辑中（修改未发送）时阻止静默离开，触发浏览器确认 */
      if (state.editingNode) {
        e.preventDefault();
        e.returnValue = '';
      }
    });

    bootstrap();
  };

  /* ---------- 启动 ---------- */

  /**
   * 启动流程：打开数据库 → 载入会话/模型 → 恢复活动会话指针 → 对账残留 checkpoint → 渲染主界面。
   * IndexedDB 不可用或读盘失败时降级：dbBroken=true，按纯内存（全新）模式继续。
   * @returns {Promise<void>}
   */
  async function bootstrap() {
    try {
      await SSC.DB.init();
    } catch (e) {
      state.dbBroken = true;
      console.warn('[ssc] IndexedDB 不可用，进入纯内存模式（数据不会持久化）：', e);
      SSC.UI.showWarning('本地存储（IndexedDB）不可用：当前为内存模式，数据不会保存。');
      return;
    }
    try {
      state.sessions = await SSC.DB.listSessions();
      state.models = await SSC.DB.listModels();
      loadActiveModelId();

      /* activeSessionId：读 localStorage；命中现有会话才采用，否则取列表第一个（updatedAt 最新） */
      var savedActive = null;
      try { savedActive = window.localStorage.getItem(ACTIVE_KEY); } catch (e) { savedActive = null; }
      state.activeSessionId = null;
      for (var i = 0; i < state.sessions.length; i++) {
        if (state.sessions[i].id === savedActive) {
          state.activeSessionId = state.sessions[i].id;
          break;
        }
      }
      if (!state.activeSessionId && state.sessions.length) {
        state.activeSessionId = state.sessions[0].id;
      }
      saveActiveSession(); /* 规整陈旧指针 */

      await reconcilePending();

      if (state.models.length) {
        SSC.UI.showMain();
        SSC.UI.setModelOptions(state.models, state.activeModelId);
        SSC.UI.setSessions(state.sessions, state.activeSessionId);
        await loadActiveSession();
      }
      /* 无已存模型：保留设置引导页（会话已在 IDB 中持久化） */
    } catch (e) {
      console.warn('[ssc] 读取持久化数据失败，按全新状态启动：', e);
      state.dbBroken = true;
      state.sessions = [];
      state.activeSessionId = null;
      state.activeCache = null;
      state.editingNode = null;
      SSC.UI.showWarning('读取本地数据失败，已按全新状态启动。');
      if (state.models.length) {
        SSC.UI.showMain();
        SSC.UI.setModelOptions(state.models, state.activeModelId);
        SSC.UI.setSessions(state.sessions, state.activeSessionId);
      }
    }
  }

  /**
   * 对账 message-cache 残留（崩溃时未定稿的流）→ 物化为 interrupted 助手消息；
   * 所属会话已不存在的残留直接丢弃。
   * @returns {Promise<void>}
   */
  async function reconcilePending() {
    var pending = await SSC.DB.getAllPending();
    if (!pending.length) return;
    var known = {};
    state.sessions.forEach(function (s) { known[s.id] = true; });
    for (var i = 0; i < pending.length; i++) {
      var rec = pending[i];
      if (known[rec.sessionId]) await SSC.DB.materializeCheckpoint(rec);
      else await SSC.DB.dropCheckpoint(rec.sessionId, rec.messageId);
    }
  }

  /**
   * 载入活跃会话的全部节点到内存（state.activeCache，一次范围读），
   * 校验 leafId 合法性（缺失时回退到父节点或根并落盘）并渲染当前分支。
   * @returns {Promise<void>}
   */
  async function loadActiveSession() {
    var s = activeSession();
    state.activeCache = new Map();
    SSC.UI.clearMessages();
    if (!s) return;
    if (!state.dbBroken) {
      state.activeCache = await SSC.DB.loadSessionMessages(s.id);
    }
    /* 防御：leafId 指向缺失节点（事务保证下正常不会出现）→ 回退到其父或根 */
    if (s.leafId && !state.activeCache.has(s.leafId)) {
      var parent = null;
      state.activeCache.forEach(function (n) {
        if (!parent && n.children.indexOf(s.leafId) !== -1) parent = n;
      });
      s.leafId = parent ? parent.id : s.rootId;
      persistOp(SSC.DB.setLeaf(s));
    }
    renderBranch(s);
  }

  /* ---------- 设置 / 模型配置（models 表持久化；活动模型指针在 localStorage） ---------- */

  /**
   * 读取活动模型指针（localStorage）；指针失效/陈旧时回退到第一个模型，写入 state.activeModelId。
   * @returns {void}
   */
  function loadActiveModelId() {
    var saved = null;
    try { saved = window.localStorage.getItem(ACTIVE_MODEL_KEY); } catch (e) { saved = null; }
    for (var i = 0; i < state.models.length; i++) {
      if (state.models[i].id === saved) { state.activeModelId = saved; return; }
    }
    state.activeModelId = state.models.length ? state.models[0].id : null;
  }

  /**
   * 持久化活动模型指针到 localStorage；无活动模型时移除指针（陈旧指针由启动回退自愈）。
   * @returns {void}
   */
  function saveActiveModelId() {
    try {
      if (state.activeModelId) window.localStorage.setItem(ACTIVE_MODEL_KEY, state.activeModelId);
      else window.localStorage.removeItem(ACTIVE_MODEL_KEY);
    } catch (e) {
      console.warn('[ssc] 保存活动模型指针失败：', e);
    }
  }

  /**
   * 持久化活动会话指针到 localStorage；无活动会话时移除指针（陈旧指针由启动回退自愈）。
   * @returns {void}
   */
  function saveActiveSession() {
    try {
      if (state.activeSessionId) window.localStorage.setItem(ACTIVE_KEY, state.activeSessionId);
      else window.localStorage.removeItem(ACTIVE_KEY);
    } catch (e) {
      console.warn('[ssc] 保存活动会话指针失败：', e);
    }
  }

  /**
   * 设置页「保存并开始」：校验 endpoint/model 后保存模型配置
   *（同一 endpoint+model 更新并复用原记录，否则新增），置为活动模型并切换到主界面。
   * endpoint 或 model 为空时静默返回。
   * @param {object} cfg 表单原始值 { endpoint: string, model: string, apiKey: string, label: string }
   * @returns {void}
   */
  App.saveConfig = function (cfg) {
    var endpoint = trim(cfg.endpoint);
    var model = trim(cfg.model);
    if (!endpoint || !model) return;
    var apiKey = trim(cfg.apiKey);
    var label = trim(cfg.label);

    /* 同一 endpoint + model 的配置：更新并复用；否则新增 */
    var existing = null;
    for (var i = 0; i < state.models.length; i++) {
      if (state.models[i].endpoint === endpoint && state.models[i].model === model) {
        existing = state.models[i];
        break;
      }
    }
    var target;
    if (existing) {
      existing.label = label || existing.label;
      if (apiKey) existing.apiKey = apiKey;
      target = existing;
    } else {
      target = {
        id: SSC.DB.newId('m'),
        label: label || model,
        endpoint: endpoint,
        model: model,
        apiKey: apiKey,
        createdAt: Date.now()
      };
      state.models.push(target);
    }
    persistOp(SSC.DB.putModel(target));
    state.activeModelId = target.id;
    saveActiveModelId();
    SSC.UI.showMain();
    SSC.UI.setModelOptions(state.models, state.activeModelId);
    SSC.UI.setSessions(state.sessions, state.activeSessionId);
    renderBranch(activeSession());
  };

  /* ---------- 发送 / 停止 ---------- */

  /**
   * 发送当前输入：在分支末端创建 user 节点 + 占位 assistant 节点，单事务提交（含 checkpoint）后启动流式生成。
   * 编辑态下发送 = 对目标消息「编辑分叉」（内容未改则视为取消编辑）。
   * 生成中 / 无可用模型 / 输入为空 / 无当前会话可发送时静默返回。
   * @returns {void}
   */
  App.send = function () {
    if (state.streaming) return;
    var model = activeModel();
    if (!model) return;

    var text = SSC.UI.getInputText();
    if (!text) return;

    /* 编辑态：发送 = 对目标消息分叉出新版本（父节点下新增子节点），随后正常生成回复 */
    if (state.editingNode) {
      var T = state.activeCache.get(state.editingNode);
      var isEdit = T && T.role === 'user' ? T : null;
      state.editingNode = null;
      SSC.UI.setEditing(null);
      if (isEdit && text !== isEdit.content) {
        SSC.UI.clearInput();
        App.fork(isEdit.id, text);
        return;
      }
      if (isEdit) return; /* 内容未修改：视为取消编辑，不产生新版本 */
    }

    var session = activeSession() || createSessionRecord();

    /* 父节点 = 当前分支末端（空会话时为 placeholder 根，恒存在） */
    var parent = state.activeCache.get(session.leafId);
    if (!parent) {
      console.error('[ssc] leafId 指向缺失节点，无法发送：', session.leafId);
      return;
    }

    var now = Date.now();
    var aId = SSC.DB.newId('n');
    var uNode = {
      id: SSC.DB.newId('n'), sessionId: session.id,
      parentId: parent.id, children: [aId],
      role: 'user', content: text, thinking: '',
      error: null, interrupted: 0, createdAt: now, modelId: null,
      inputTokens: null, outputTokens: null, cachedTokens: null
    };
    var aNode = {
      id: aId, sessionId: session.id,
      parentId: uNode.id, children: [],
      role: 'assistant', content: '', thinking: '',
      error: null, interrupted: 0, createdAt: now, modelId: model.id,
      inputTokens: null, outputTokens: null, cachedTokens: null
    };

    parent.children.push(uNode.id);
    state.activeCache.set(uNode.id, uNode);
    state.activeCache.set(aNode.id, aNode);

    session.leafId = aNode.id;
    session.updatedAt = now;
    /* 自动标题：取首条用户消息开头 */
    if (!session.title) {
      session.title = text.length > 20 ? text.slice(0, 20) + '…' : text;
    }

    var rec = makeCheckpointRec(aNode, model.id);

    persistOp(SSC.DB.commitSend(uNode, parent, session, rec));

    SSC.UI.setSessions(state.sessions, state.activeSessionId); /* 刷新侧边栏（标题/updatedAt） */
    SSC.UI.addMessage('user', text, { id: uNode.id });
    SSC.UI.clearInput();
    var handle = SSC.UI.addMessage('assistant', null);
    setStreaming(true);

    beginStream(aNode, uNode.id, handle, rec);
  };

  /**
   * 停止生成：中止当前流（已接收内容保留，finalizeStream 按 stopped 收尾）。
   * @returns {void}
   */
  App.stop = function () {
    if (!state.streaming || !state.abort) return;
    state.stopRequested = true;
    state.abort.abort();
  };

  /* ---------- 会话管理 ---------- */

  /**
   * 新建会话并切换：创建会话记录（含 placeholder 根），清空消息区与输入框。
   * 生成中不执行；编辑态未发送修改时先弹确认。
   * @returns {void}
   */
  App.newSession = function () {
    if (state.streaming) return;
    if (!confirmDiscardEditing()) return;
    createSessionRecord();
    SSC.UI.setSessions(state.sessions, state.activeSessionId);
    SSC.UI.clearMessages();
    SSC.UI.clearInput();
    SSC.UI.focusInput();
  };

  /**
   * 切换到指定会话：更新活动指针（含 localStorage）并重新渲染。
   * 生成中、目标即当前会话、或编辑态确认放弃时不执行。
   * @param {string} id 目标会话 id
   * @returns {void}
   */
  App.switchSession = function (id) {
    if (state.streaming || id === state.activeSessionId) return;
    if (!confirmDiscardEditing()) return;
    state.activeSessionId = id;
    saveActiveSession();
    SSC.UI.setSessions(state.sessions, state.activeSessionId);
    loadActiveSession();
  };

  /**
   * 删除指定会话（含其全部消息与 checkpoint，单事务落盘）。
   * 删除后若会话列表为空则自动新建并置为活动；若删的是活动会话则切到最近更新者。
   * 生成中不执行；删除前弹确认（活动会话且有编辑态时额外提示修改丢失）。
   * @param {string} id 目标会话 id
   * @returns {void}
   */
  App.deleteSession = function (id) {
    if (state.streaming) return;
    var idx = -1;
    for (var i = 0; i < state.sessions.length; i++) {
      if (state.sessions[i].id === id) { idx = i; break; }
    }
    if (idx === -1) return;
    var title = state.sessions[idx].title || '新会话';
    var msg = '确定删除会话「' + title + '」？';
    if (state.activeSessionId === id && state.editingNode) {
      msg = '正在编辑一条消息（未发送的修改将丢失）。' + msg;
    }
    if (!window.confirm(msg)) return;

    var wasActive = state.activeSessionId === id;
    if (wasActive && state.editingNode) {
      state.editingNode = null;
      SSC.UI.setEditing(null);
      SSC.UI.clearInput();
    }
    state.sessions.splice(idx, 1);
    var recreated = false;
    if (state.sessions.length === 0) {
      createSessionRecord(); /* 沿用现状：删空后自动新建并置为活动（指针在内部写 localStorage） */
      recreated = true;
    } else if (wasActive) {
      var best = 0;
      for (var j = 1; j < state.sessions.length; j++) {
        if (state.sessions[j].updatedAt > state.sessions[best].updatedAt) best = j;
      }
      state.activeSessionId = state.sessions[best].id;
      saveActiveSession();
    }
    persistOp(SSC.DB.deleteSession(id));
    SSC.UI.setSessions(state.sessions, state.activeSessionId);
    if (recreated) {
      SSC.UI.clearMessages();
      SSC.UI.clearInput();
      SSC.UI.focusInput();
    } else if (wasActive) {
      loadActiveSession();
    }
  };

  /**
   * 创建会话 + placeholder 根（内存 + 落盘），置为活动会话；不操作 UI。
   * @returns {object} 新建的会话记录（已写入 state.sessions / state.activeSessionId / state.activeCache）
   */
  function createSessionRecord() {
    var now = Date.now();
    var s = { id: SSC.DB.newId('s'), title: '', createdAt: now, updatedAt: now, rootId: null, leafId: null };
    var root = {
      id: SSC.DB.newId('r'), sessionId: s.id,
      parentId: null, children: [], role: 'root',
      content: '', thinking: '', error: null, interrupted: 0,
      createdAt: now, modelId: null,
      inputTokens: null, outputTokens: null, cachedTokens: null
    };
    s.rootId = root.id;
    s.leafId = root.id;
    var cache = new Map();
    cache.set(root.id, root);
    state.sessions.push(s);
    state.activeSessionId = s.id;
    state.activeCache = cache;
    persistOp(SSC.DB.createSession(s, root));
    saveActiveSession();
    return s;
  }

  /* ---------- 分叉与分支切换（数据层入口，为分叉 UI 准备） ---------- */

  /**
   * 对目标节点分叉：在其父节点下创建新版本节点并从此处重新生成。
   * - 目标为 user 节点：editedText 非空为“编辑分叉”，否则原样分叉；随后自动挂新 assistant 并开流。
   * - 目标为 assistant 节点：原样重新生成（新兄弟节点）。
   * 旧分支完整保留，可通过 switchBranch 切回。
   * 生成中 / 无会话 / 无模型 / 目标不存在或为 root / 父节点缺失时静默返回。
   * @param {string} nodeId 分叉目标（不可为 root）
   * @param {string|null} editedText 编辑后的文本（仅 user 节点有效；空表示原样分叉）
   * @returns {void}
   */
  App.fork = function (nodeId, editedText) {
    if (state.streaming) return;
    var session = activeSession();
    var model = activeModel();
    if (!session || !model) return;
    var T = state.activeCache.get(nodeId);
    if (!T || T.role === 'root') return;
    var P = T.parentId ? state.activeCache.get(T.parentId) : null;
    if (!P) return;

    var now = Date.now();
    var N = {
      id: SSC.DB.newId('n'), sessionId: session.id,
      parentId: T.parentId, children: [],
      role: T.role,
      content: T.role === 'user' ? (editedText != null ? editedText : T.content) : '',
      thinking: '', error: null, interrupted: 0,
      createdAt: now, modelId: null,
      inputTokens: null, outputTokens: null, cachedTokens: null
    };
    var A = null;
    var streamTarget;
    if (N.role === 'user') {
      A = {
        id: SSC.DB.newId('n'), sessionId: session.id,
        parentId: N.id, children: [],
        role: 'assistant', content: '', thinking: '',
        error: null, interrupted: 0, createdAt: now, modelId: model.id,
        inputTokens: null, outputTokens: null, cachedTokens: null
      };
      N.children.push(A.id);
      streamTarget = A;
    } else {
      streamTarget = N;
    }

    P.children.push(N.id);
    state.activeCache.set(N.id, N);
    if (A) state.activeCache.set(A.id, A);
    session.leafId = streamTarget.id;
    session.updatedAt = now;

    var rec = makeCheckpointRec(streamTarget, model.id);
    var toPersist = [N];
    if (A) toPersist.push(A);
    persistOp(SSC.DB.commitFork(toPersist, P, session, rec));

    SSC.UI.setSessions(state.sessions, state.activeSessionId);
    var handles = renderBranch(session, streamTarget.id);
    beginStream(streamTarget, streamTarget.parentId, handles[handles.length - 1], rec);
  };

  /**
   * 切到以 nodeId 为末端的历史分支（任意节点可作分支头，含旧分支末端）：
   * 更新 leafId（含落盘）并重新渲染分支路径。
   * 生成中、目标为 root、或已是当前分支末端时不执行。
   * @param {string} nodeId 分支头节点 id
   * @returns {void}
   */
  App.switchBranch = function (nodeId) {
    if (state.streaming) return;
    var session = activeSession();
    if (!session) return;
    var n = state.activeCache.get(nodeId);
    if (!n || n.role === 'root' || nodeId === session.leafId) return;
    session.leafId = nodeId;
    persistOp(SSC.DB.setLeaf(session));
    renderBranch(session);
  };

  /* ---------- 编辑历史消息（纯内存状态，不持久化） ---------- */

  /**
   * 进入编辑某条用户消息的状态：高亮气泡 + 输入框预填原文。
   * 仅 user 节点可编辑；已在编辑另一条且输入框有改动时先弹确认。
   * 生成中、无会话、目标不存在或重复编辑同一条时不执行。
   * @param {string} nodeId 要编辑的 user 消息节点 id
   * @returns {void}
   */
  App.startEdit = function (nodeId) {
    if (state.streaming) return;
    var session = activeSession();
    if (!session) return;
    var n = state.activeCache.get(nodeId);
    if (!n || n.role !== 'user' || state.editingNode === nodeId) return;

    /* 已在编辑另一条且输入框已有改动：先确认丢弃 */
    if (state.editingNode) {
      var old = state.activeCache.get(state.editingNode);
      if (old && SSC.UI.getInputText() !== old.content) {
        if (!window.confirm('当前正在编辑的消息修改尚未发送，确定改为编辑另一条消息吗？')) return;
      }
    }

    state.editingNode = nodeId;
    SSC.UI.setEditing(nodeId);
    SSC.UI.setInputText(n.content);
    SSC.UI.focusInput();
  };

  /**
   * 取消编辑某条历史消息：退出编辑态并清空输入框。
   * 若输入内容相对原文已修改则先弹确认，确认后丢弃修改并退出；内容未改动时直接退出。
   * 非编辑态时直接返回。
   * @returns {void}
   */
  App.cancelEdit = function () {
    if (!state.editingNode) return;
    var n = state.activeCache.get(state.editingNode);
    if (n && SSC.UI.getInputText() !== n.content) {
      if (!window.confirm('输入框内容已修改，确定放弃修改并退出编辑吗？')) return;
    }
    clearEditing();
  };

  /**
   * 切换到某个版本（分叉节点）：跳到该版本子树中最新的末端分支（委托 switchBranch）。
   * @param {string} nodeId 分叉版本节点 id（不可为 root）
   * @returns {void}
   */
  App.switchVersion = function (nodeId) {
    if (state.streaming) return;
    var session = activeSession();
    if (!session) return;
    var n = state.activeCache.get(nodeId);
    if (!n || n.role === 'root') return;
    var leafId = latestLeafInSubtree(nodeId);
    if (!leafId) return;
    App.switchBranch(leafId);
  };

  /**
   * 子树中最新的末端节点 id（无子节点的节点中 createdAt 最大者；DFS 遍历 activeCache）。
   * @param {string} rootId 子树根节点 id
   * @returns {string|null} 末端节点 id；子树为空/不存在时返回 null
   */
  function latestLeafInSubtree(rootId) {
    var bestId = null;
    var bestAt = -1;
    var stack = [rootId];
    while (stack.length) {
      var id = stack.pop();
      var n = state.activeCache.get(id);
      if (!n) continue;
      if (n.children.length === 0 && n.createdAt > bestAt) {
        bestAt = n.createdAt;
        bestId = id;
      }
      for (var i = 0; i < n.children.length; i++) stack.push(n.children[i]);
    }
    return bestId;
  }

  /**
   * 清除编辑态：去掉高亮、清空输入框（像没点过编辑按钮一样）。非编辑态时直接返回。
   * @returns {void}
   */
  function clearEditing() {
    if (!state.editingNode) return;
    state.editingNode = null;
    SSC.UI.setEditing(null);
    SSC.UI.clearInput();
  }

  /**
   * 编辑态下执行会丢失修改的操作（新建/切换会话等）前的确认：
   * 非编辑态直接放行；编辑态弹确认，确认后清除编辑态。
   * @returns {boolean} 是否继续（true = 放行）
   */
  function confirmDiscardEditing() {
    if (!state.editingNode) return true;
    if (!window.confirm('正在编辑一条消息，未发送的修改将丢失。确定继续吗？')) return false;
    clearEditing();
    return true;
  }

  /* ---------- 模型管理 ---------- */

  /**
   * 切换当前活动模型（不检查生成中）：更新指针（含 localStorage）并刷新头部下拉框。
   * @param {string} id 目标模型 id；不存在时静默返回
   * @returns {void}
   */
  App.switchModel = function (id) {
    var found = false;
    for (var i = 0; i < state.models.length; i++) {
      if (state.models[i].id === id) { found = true; break; }
    }
    if (!found) return;
    state.activeModelId = id;
    saveActiveModelId();
    SSC.UI.setModelOptions(state.models, state.activeModelId);
  };

  /**
   * 打开模型管理弹窗（生成中不打开）。
   * @returns {void}
   */
  App.openModelManager = function () {
    if (state.streaming) return;
    SSC.UI.openModelManager(state.models, state.activeModelId);
  };

  /**
   * 模型管理弹窗内显示「添加模型」表单。
   * @returns {void}
   */
  App.showAddModelForm = function () {
    SSC.UI.showModelForm(null);
  };

  /**
   * 模型管理弹窗内显示指定模型的编辑表单；id 不存在时静默返回。
   * @param {string} id 模型 id
   * @returns {void}
   */
  App.showEditModelForm = function (id) {
    for (var i = 0; i < state.models.length; i++) {
      if (state.models[i].id === id) {
        SSC.UI.showModelForm(state.models[i]);
        return;
      }
    }
  };

  /**
   * 新增模型配置（模型管理弹窗表单提交）：落盘、置为活动模型并刷新弹窗列表。
   * @param {object} data 表单值 { label: string, endpoint: string, model: string, apiKey: string }（已 trim；label 可为空串）
   * @returns {void}
   */
  App.addModel = function (data) {
    var m = {
      id: SSC.DB.newId('m'),
      label: data.label || data.model,
      endpoint: data.endpoint,
      model: data.model,
      apiKey: data.apiKey,
      createdAt: Date.now()
    };
    state.models.push(m);
    state.activeModelId = m.id;
    persistOp(SSC.DB.putModel(m));
    saveActiveModelId();
    SSC.UI.setModelOptions(state.models, state.activeModelId);
    SSC.UI.openModelManager(state.models, state.activeModelId);
  };

  /**
   * 编辑模型配置（模型管理弹窗表单提交）：更新内存与持久化并刷新弹窗列表；id 不存在时静默返回。
   * @param {string} id 模型 id
   * @param {object} data 表单值 { label: string, endpoint: string, model: string, apiKey: string }（已 trim）
   * @returns {void}
   */
  App.editModel = function (id, data) {
    for (var i = 0; i < state.models.length; i++) {
      if (state.models[i].id === id) {
        state.models[i].label = data.label || data.model;
        state.models[i].endpoint = data.endpoint;
        state.models[i].model = data.model;
        state.models[i].apiKey = data.apiKey;
        persistOp(SSC.DB.putModel(state.models[i]));
        break;
      }
    }
    saveActiveModelId();
    SSC.UI.setModelOptions(state.models, state.activeModelId);
    SSC.UI.openModelManager(state.models, state.activeModelId);
  };

  /**
   * 删除模型配置（弹确认）：删除后若无剩余模型则关闭弹窗回设置页；
   * 删的是活动模型时活动指针回退到第一个模型。
   * @param {string} id 模型 id；不存在时静默返回
   * @returns {void}
   */
  App.deleteModel = function (id) {
    var idx = -1;
    for (var i = 0; i < state.models.length; i++) {
      if (state.models[i].id === id) { idx = i; break; }
    }
    if (idx === -1) return;
    var m = state.models[idx];
    if (!window.confirm('确定删除模型「' + (m.label || m.model) + '」？')) return;
    state.models.splice(idx, 1);
    persistOp(SSC.DB.deleteModel(id));
    if (state.models.length === 0) {
      state.activeModelId = null;
      saveActiveModelId();
      SSC.UI.closeModelManager();
      SSC.UI.showSettings();
    } else {
      if (state.activeModelId === id) {
        state.activeModelId = state.models[0].id;
      }
      saveActiveModelId();
      SSC.UI.setModelOptions(state.models, state.activeModelId);
      SSC.UI.openModelManager(state.models, state.activeModelId);
    }
  };

  /**
   * 关闭模型管理弹窗。
   * @returns {void}
   */
  App.closeModelManager = function () {
    SSC.UI.closeModelManager();
  };

  /**
   * 模型管理弹窗内从表单返回模型列表。
   * @returns {void}
   */
  App.backToModelList = function () {
    SSC.UI.openModelManager(state.models, state.activeModelId);
  };

  /* ---------- 主题（亮色 / 暗色） ---------- */

  var THEME_KEY = 'ssc.theme';

  /**
   * 读取已保存的显式主题偏好（localStorage）。
   * @returns {string|null} 'light' 或 'dark'；未保存或读取失败返回 null（表示跟随系统）
   */
  function savedTheme() {
    try {
      var t = window.localStorage.getItem(THEME_KEY);
      return t === 'light' || t === 'dark' ? t : null;
    } catch (e) {
      return null;
    }
  }

  /**
   * 应用主题到 <html>：'dark' 时设置 data-theme="dark"，否则移除（按亮色渲染）。
   * @param {string} theme 'dark' 或其他（按亮色处理）
   * @returns {void}
   */
  function applyTheme(theme) {
    if (theme === 'dark') document.documentElement.setAttribute('data-theme', 'dark');
    else document.documentElement.removeAttribute('data-theme');
  }

  /**
   * 当前生效主题 = 已保存显式偏好；未保存时为系统/浏览器偏好（无 matchMedia 时默认亮色）。
   * @returns {string} 'light' 或 'dark'
   */
  function effectiveTheme() {
    var t = savedTheme();
    if (t) return t;
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  /**
   * 注册系统主题变化监听：未显式保存偏好时跟随系统切换（初始应用由 index.html 内联脚本完成）。
   * @returns {void}
   */
  App.initTheme = function () {
    var mq = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
    if (!mq) return;
    var onChange = function (e) {
      if (!savedTheme()) applyTheme(e.matches ? 'dark' : 'light');
    };
    if (typeof mq.addEventListener === 'function') mq.addEventListener('change', onChange);
    else if (typeof mq.addListener === 'function') mq.addListener(onChange); /* 旧浏览器 */
  };

  /**
   * 切换主题（切到当前生效主题的相反）并持久化显式偏好。
   * @returns {void}
   */
  App.toggleTheme = function () {
    var next = effectiveTheme() === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    try {
      window.localStorage.setItem(THEME_KEY, next);
    } catch (e) { /* 隐私模式等：localStorage 不可用，仅本次生效 */ }
  };

  /* ---------- 内部 ---------- */

  /**
   * 当前分支路径：leafId 沿 parentId 回溯（不含 placeholder 根）；遇到悬空指针即停止（防御）。
   * @param {string} leafId 分支末端节点 id
   * @returns {Array<object>} 消息节点数组，顺序 [旧 → 新]
   */
  function branchPath(leafId) {
    var path = [];
    var cur = leafId;
    while (cur && state.activeCache) {
      var n = state.activeCache.get(cur);
      if (!n) break;                    /* 防御：悬空指针 */
      if (n.parentId === null) break;   /* placeholder 根，不包含 */
      path.unshift(n);
      cur = n.parentId;
    }
    return path;
  }

  /**
   * 构造请求体：分支历史中 user 消息全收、assistant 仅收非空 content（沿用现有语义）。
   * @param {string} headId 分支末端节点 id（通常是 assistant 的父节点）
   * @returns {Array<{role: string, content: string}>} OpenAI 格式消息数组（[旧 → 新]）
   */
  function buildRequestBody(headId) {
    return branchPath(headId)
      .filter(function (m) {
        return m.role === 'user' || (m.role === 'assistant' && m.content);
      })
      .map(function (m) { return { role: m.role, content: m.content }; });
  }

  /**
   * 把当前分支渲染到界面（启动 / 切会话 / 切分支 / 分叉后）；返回逐节点 UI 句柄。
   * 分叉节点（父有多个子）附带版本切换条；编辑态高亮随重渲染恢复。
   * @param {object|null} session 会话记录（取 leafId 定分支）；null 时仅清空消息区
   * @param {string|null} pendingLeafId 即将开流的助手节点 id：其空气泡不定稿（不显示"未收到内容"占位），
   *   与正常新发送时"正文首字出现前气泡隐藏"的表现一致。
   * @returns {Array<object>} 各节点 UI 句柄（见 UI.addMessage 返回值），顺序与分支路径一致
   */
  function renderBranch(session, pendingLeafId) {
    var handles = [];
    SSC.UI.clearMessages();
    if (!session) return handles;
    /* 逐节点渲染分支：分叉版本条 + 思考区 + 定稿态 */
    branchPath(session.leafId).forEach(function (n) {
      var opts = { id: n.id };
      if (n.parentId) {
        var p = state.activeCache.get(n.parentId);
        if (p && p.children.length > 1) {
          /* 父节点有多个子 → 版本切换条（按创建时间升序，当前节点标记 active） */
          var versions = p.children
            .map(function (cid) {
              var c = state.activeCache.get(cid);
              return { id: cid, createdAt: c ? c.createdAt : 0, active: cid === n.id };
            })
            .sort(function (a, b) { return a.createdAt - b.createdAt; });
          opts.versions = versions;
        }
      }
      var handle = SSC.UI.addMessage(n.role, n.content || null, opts);
      if (n.role === 'assistant') {
        if (n.thinking) {
          handle.thinkUpdate(n.thinking);
          /* 正文已开始输出、或流正常结束 → 思考阶段完整；停止/出错中断且无正文 → 思考未完成 */
          handle.thinkDone(!!n.content || !n.interrupted);
        }
        if (!n.content && n.id !== pendingLeafId) {
          handle.finalize('', n.error || (n.interrupted ? '生成已中断（未收到内容）' : null), false, !n.error);
        } else if (n.error) {
          handle.finalize(n.content, n.error);
        } else if (n.interrupted) {
          handle.finalize(n.content, '生成已中断', false, true);
        }
        /* 显示本轮 token 用量小字（无用量时隐藏） */
        if (n.inputTokens != null || n.outputTokens != null || n.cachedTokens != null) {
          handle.usage({
            inputTokens: n.inputTokens,
            outputTokens: n.outputTokens,
            cachedTokens: n.cachedTokens
          });
        }
      }
      handles.push(handle);
    });
    if (state.editingNode) SSC.UI.setEditing(state.editingNode); /* 编辑态高亮随重渲染恢复 */
    return handles;
  }

  /**
   * 切换生成中状态（同步更新 UI：发送禁用/停止按钮显隐）。
   * @param {boolean} on true = 生成中
   * @returns {void}
   */
  function setStreaming(on) {
    state.streaming = on;
    SSC.UI.setStreaming(on);
    if (!on) SSC.UI.focusInput();
  }

  /**
   * 当前活动模型配置；activeModelId 失效时回退到第一个模型。
   * @returns {object|null} 模型配置 { id, label, endpoint, model, apiKey, createdAt }；无模型时返回 null
   */
  function activeModel() {
    for (var i = 0; i < state.models.length; i++) {
      if (state.models[i].id === state.activeModelId) return state.models[i];
    }
    return state.models[0] || null;
  }

  /**
   * 当前活动会话记录。
   * @returns {object|null} 会话记录 { id, title, createdAt, updatedAt, rootId, leafId }；不存在时返回 null
   */
  function activeSession() {
    for (var i = 0; i < state.sessions.length; i++) {
      if (state.sessions[i].id === state.activeSessionId) return state.sessions[i];
    }
    return null;
  }

  /* ---------- 流式：增量处理 + checkpoint ---------- */

  /**
   * 构造 assistant 节点的 checkpoint 记录（空缓冲，等待流式增量填充）。
   * @param {object} node assistant 消息节点（取 sessionId/id/parentId）
   * @param {string} modelId 生成该回复的模型 id
   * @returns {object} checkpoint 记录 { sessionId, messageId, parentId, modelId, createdAt, content, thinking }
   */
  function makeCheckpointRec(node, modelId) {
    return {
      sessionId: node.sessionId, messageId: node.id, parentId: node.parentId,
      modelId: modelId, createdAt: Date.now(), content: '', thinking: ''
    };
  }

  /**
   * 启动一次流式生成（send / fork 共用）。
   * @param {object} node assistant 节点（由流填充）
   * @param {string} bodyHeadId 请求体的末端节点 id（assistant 的父节点）
   * @param {object} handle 该 assistant 消息的 UI 句柄
   * @param {object} rec checkpoint 记录（应已包含在前置持久化事务中）
   * @returns {void} 无可用模型时直接返回
   */
  function beginStream(node, bodyHeadId, handle, rec) {
    var model = activeModel();
    if (!model) return;
    stream = {
      node: node, handle: handle, buf: { content: '', thinking: '' },
      rec: rec, lastCk: 0, usage: null /* 本轮用量（服务端在流末尾 chunk 返回） */
    };
    var controller = new AbortController();
    state.abort = controller;
    setStreaming(true);

    SSC.Api.stream(
      { endpoint: model.endpoint, model: model.model, apiKey: model.apiKey },
      buildRequestBody(bodyHeadId),
      {
        onThinking: function (t) { onStreamDelta(t, true); }, /* 思考增量 */
        onToken: function (t) { onStreamDelta(t, false); }, /* 正文增量 */
        onUsage: function (u) {
          if (stream) stream.usage = u; /* 记录本轮用量，定稿时写入节点 */
        },
        onDone: function () { finalizeStream(null); }, /* 正常结束（含用户停止） */
        onError: function (err) { finalizeStream(err && err.message ? err.message : String(err)); } /* 出错定稿 */
      },
      controller.signal
    );
  }

  /**
   * 处理流式增量：累加到缓冲、同步到节点与 UI，并触发节流 checkpoint。
   * @param {string} t 增量文本（空则忽略）
   * @param {boolean} isThinking true = 思考增量（写入 thinking），false = 正文增量（写入 content）
   * @returns {void} 无进行中流时直接返回
   */
  function onStreamDelta(t, isThinking) {
    var st = stream;
    if (!st || !t) return;
    if (isThinking) st.buf.thinking += t; else st.buf.content += t;
    st.node.content = st.buf.content;
    st.node.thinking = st.buf.thinking;
    if (isThinking) st.handle.thinkUpdate(st.buf.thinking);
    else st.handle.update(st.buf.content);
    maybeCheckpoint();
  }

  /**
   * 自上次 checkpoint 后新增的字符数（正文 + 思考）。
   * @param {object} st 进行中的流状态 { buf: {content, thinking}, rec, lastCk }
   * @returns {number} 新增字符数
   */
  function checkpointGrowth(st) {
    return (st.buf.content.length - st.rec.content.length) +
      (st.buf.thinking.length - st.rec.thinking.length);
  }

  /**
   * 节流 checkpoint：满足最小增量（CHECK_MIN_GROWTH）与最小间隔（CHECK_INTERVAL_MS）时落盘。
   * @returns {void}
   */
  function maybeCheckpoint() {
    var st = stream;
    if (!st || state.dbBroken) return;
    if (checkpointGrowth(st) < CHECK_MIN_GROWTH) return;
    if (Date.now() - st.lastCk < CHECK_INTERVAL_MS) return;
    doCheckpoint(true);
  }

  /**
   * 把当前缓冲写入 message-cache（force=true 忽略节流条件，用于页面隐藏/关闭前尽力落盘）。
   * @param {boolean} force true = 忽略最小增量/间隔条件立即落盘
   * @returns {void}
   */
  function doCheckpoint(force) {
    var st = stream;
    if (!st || state.dbBroken) return;
    if (!force) {
      if (checkpointGrowth(st) < CHECK_MIN_GROWTH) return;
      if (Date.now() - st.lastCk < CHECK_INTERVAL_MS) return;
    }
    st.lastCk = Date.now();
    st.rec.content = st.buf.content;
    st.rec.thinking = st.buf.thinking;
    persistOp(SSC.DB.checkpoint(st.rec));
  }

  /**
   * 定稿：把完整助手消息写入 messages、删除 checkpoint、更新会话（单事务，fire-and-forget）。
   * 完成/停止/出错三种结局统一在此收尾：stopped 或出错时节点打 interrupted 标记。
   * @param {string|null} errText 错误描述；null 表示正常完成（用户停止也走此入口传 null）
   * @returns {void} 无进行中流时直接返回
   */
  function finalizeStream(errText) {
    var st = stream;
    if (!st) return;
    stream = null;

    var stopped = state.stopRequested;
    state.streaming = false;
    state.abort = null;
    state.stopRequested = false;

    var node = st.node;
    node.content = st.buf.content;
    node.thinking = st.buf.thinking;
    node.error = errText || null;
    node.interrupted = (stopped || errText) ? 1 : 0;
    /* 写入本轮用量（API 未返回时为 null，可为空） */
    node.inputTokens = st.usage ? st.usage.inputTokens : null;
    node.outputTokens = st.usage ? st.usage.outputTokens : null;
    node.cachedTokens = st.usage ? st.usage.cachedTokens : null;

    var session = activeSession();
    if (session) session.updatedAt = Date.now();

    st.handle.finalize(node.content, node.error, stopped);
    /* 气泡下方小字显示 token 用量（无用量信息时保持隐藏） */
    st.handle.usage({
      inputTokens: node.inputTokens,
      outputTokens: node.outputTokens,
      cachedTokens: node.cachedTokens
    });
    setStreaming(false);
    if (session) SSC.UI.setSessions(state.sessions, state.activeSessionId); /* 刷新侧边栏 */

    persistOp(SSC.DB.commitFinalize(node, session || null));
  }

  /**
   * 持久化 fire-and-forget：失败仅告警，不阻断 UI（内存状态为权威来源）。
   * @param {Promise<void>|null} p 持久化操作 Promise；dbBroken 或 p 为 null 时跳过
   * @returns {void}
   */
  function persistOp(p) {
    if (state.dbBroken || !p) return;
    p.then(function () {}, function (e) {
      console.warn('[ssc] 持久化失败：', e);
    });
  }

  /**
   * 安全 trim：null/undefined 按空串处理。
   * @param {*} s 任意值
   * @returns {string} 去除首尾空白后的字符串
   */
  function trim(s) {
    return String(s == null ? '' : s).trim();
  }

  SSC.App = App;

  // 程序入口（script 位于 body 末尾，DOM 已就绪）
  SSC.App.init();
})();
