/*
 * app.js — App 模块：内存状态与操作（send / stop / 会话管理 / 模型管理），程序入口与启动。
 *
 * Schema：
 * - 会话与消息持久化到 IndexedDB（SSC.DB）；会话内消息为树：
 *   每会话一个 placeholder 根节点（role:'root'），节点双向指针（parentId + children），
 *   会话记录持有 rootId / leafId（leafId = 当前分支末端）
 * - 特殊消息 role 'summary'：上下文压缩记录。请求输入预估超出上下文窗口一定比例（缺省 80%）时，
 *   先调用 LLM 把旧对话压缩为摘要，插入 summary 节点并以其内容为上下文继续对话；
 *   请求体只含最后一个内容非空的压缩记录（包装成 system 消息）及其之后的消息；
 *   压缩失败/中断（摘要为空）时回退到上一条非空摘要（或完整历史）继续生成
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
  var MAX_CONTEXT_WINDOW = 999999999; /* 上下文窗口大小上限（9 位数字，与表单 maxLength 一致） */
  var COMPRESSION_THRESHOLD = 0.8; /* 上下文压缩触发阈值：待发送请求的预估输入超过上下文窗口的 80% 时先压缩 */

  /* 压缩记录的请求包装前缀（发给 LLM 时拼在摘要前，说明其语义） */
  var SUMMARY_PREFIX = '以下是此前对话的压缩摘要（更早的原始内容已省略，请基于该摘要继续对话）：\n\n';

  /* 上下文压缩请求附带的压缩指令（追加在旧历史末尾的 user 消息） */
  var COMPRESSION_PROMPT = '请将以上全部对话压缩为一份摘要。这份摘要将替代原始对话，作为后续对话的上下文。要求：\n' +
    '1. 使用与上方对话相同的语言撰写摘要；\n' +
    '2. 保留继续对话所需的全部关键信息：用户的目标与要求、重要的事实与数据、已做出的决定、约束与偏好；\n' +
    '3. 重要的代码、文件路径、命令、参数值原样保留；\n' +
    '4. 助手回复只保留要点与结论，删除冗余与重复内容；\n' +
    '5. 明确列出尚未解决的问题与接下来的计划；\n' +
    '6. 只输出摘要内容本身，不要解释压缩过程，也不要添加任何额外说明。';

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

  /* 进行中的流：{ node, handle, buf:{content,thinking}, rec, lastCk, usage, onSettled } */
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
   * @param {object} cfg 表单原始值 { endpoint: string, model: string, apiKey: string, label: string, contextWindow: string }
   * @returns {void}
   */
  App.saveConfig = function (cfg) {
    var endpoint = trim(cfg.endpoint);
    var model = trim(cfg.model);
    if (!endpoint || !model) return;
    var apiKey = trim(cfg.apiKey);
    var label = trim(cfg.label);
    var contextWindow = parseContextWindow(cfg.contextWindow);

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
      existing.contextWindow = contextWindow; /* 表单恒有值（留空时为缺省值），直接更新 */
      target = existing;
    } else {
      target = {
        id: SSC.DB.newId('m'),
        label: label || model,
        endpoint: endpoint,
        model: model,
        apiKey: apiKey,
        contextWindow: contextWindow,
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

    /* 阈值检查：含本条消息的预估请求输入超过上下文窗口的 COMPRESSION_THRESHOLD 时，
       先在本条消息前插入压缩记录，把旧上下文压缩后再基于压缩结果生成回复 */
    var summary = null;
    var est = estimateRequest(uNode.id, null);
    if (est.est > model.contextWindow * COMPRESSION_THRESHOLD) {
      summary = insertSummaryNode(parent);
    }

    session.leafId = aNode.id;
    session.updatedAt = now;
    /* 自动标题：取首条用户消息开头 */
    if (!session.title) {
      session.title = text.length > 20 ? text.slice(0, 20) + '…' : text;
    }

    var rec = summary ? makeCheckpointRec(summary, model.id) : makeCheckpointRec(aNode, model.id);
    if (summary) {
      persistOp(SSC.DB.commitFork([summary, uNode, aNode], parent, session, rec));
    } else {
      persistOp(SSC.DB.commitSend(uNode, parent, session, rec));
    }

    SSC.UI.setSessions(state.sessions, state.activeSessionId); /* 刷新侧边栏（标题/updatedAt） */
    var sumHandle = null;
    if (summary) {
      sumHandle = SSC.UI.addSummary(null, { id: summary.id, count: countCompressedMessages(summary.id) });
    }
    SSC.UI.addMessage('user', text, { id: uNode.id });
    SSC.UI.clearInput();
    var handle = SSC.UI.addMessage('assistant', null);
    setStreaming(true);

    if (summary) {
      /* 压缩阶段：流式填充压缩记录；定稿后按（可能为空的）压缩结果继续回复流 */
      beginStream(summary, compressionMessages(summary.parentId), sumHandle, rec, {
        onSettled: function (stopped, errText) {
          if (stopped) {
            SSC.UI.showWarning('上下文压缩已中断，回复未开始。');
            /* 占位 assistant 定稿为中断并落盘（重载后展示与现场一致） */
            aNode.interrupted = 1;
            aNode.error = '压缩已中断，回复未开始';
            persistOp(SSC.DB.commitFinalize(aNode, session));
            handle.finalize('', '压缩已中断，回复未开始', false, true);
            return;
          }
          if (errText) SSC.UI.showWarning('上下文压缩失败，已按完整上下文继续生成。');
          beginStream(aNode, buildRequestBody(uNode.id), handle, makeCheckpointRec(aNode, model.id));
        }
      });
    } else {
      beginStream(aNode, buildRequestBody(uNode.id), handle, rec);
    }
    refreshContextInfo(); /* 进行中请求通常尚未回报用量 → 一般按估算显示 */
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
    refreshContextInfo(); /* 空会话无助手回复 → 隐藏上下文使用指示 */
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
      refreshContextInfo(); /* 空会话 → 隐藏上下文使用指示 */
      SSC.UI.focusInput();
    } else if (wasActive) {
      loadActiveSession(); /* 内部重渲染时刷新上下文使用指示 */
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
   * 旧分支完整保留，可通过 switchBranch 切回。压缩记录（summary）不可作为分叉目标。
   * 新分支的预估请求输入超出上下文压缩阈值时，先在新节点前插入压缩记录压缩旧上下文再开流（同 send）。
   * 生成中 / 无会话 / 无模型 / 目标不存在或为 root/summary / 父节点缺失时静默返回。
   * @param {string} nodeId 分叉目标（不可为 root 或 summary）
   * @param {string|null} editedText 编辑后的文本（仅 user 节点有效；空表示原样分叉）
   * @returns {void}
   */
  App.fork = function (nodeId, editedText) {
    if (state.streaming) return;
    var session = activeSession();
    var model = activeModel();
    if (!session || !model) return;
    var T = state.activeCache.get(nodeId);
    if (!T || T.role === 'root' || T.role === 'summary') return;
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

    /* 阈值检查：同 send——新分支预估请求输入超阈时，在新节点前插入压缩记录 */
    var summary = null;
    var est = estimateRequest(streamTarget.id, null);
    if (est.est > model.contextWindow * COMPRESSION_THRESHOLD) {
      summary = insertSummaryNode(P);
    }

    session.leafId = streamTarget.id;
    session.updatedAt = now;

    var rec = summary ? makeCheckpointRec(summary, model.id) : makeCheckpointRec(streamTarget, model.id);
    var toPersist = [];
    if (summary) toPersist.push(summary);
    toPersist.push(N);
    if (A) toPersist.push(A);
    persistOp(SSC.DB.commitFork(toPersist, P, session, rec));

    SSC.UI.setSessions(state.sessions, state.activeSessionId);
    var rendered = renderBranch(session, streamTarget.id, summary ? summary.id : null);
    var targetHandle = rendered.byId[streamTarget.id];
    var sumHandle = summary ? rendered.byId[summary.id] : null;

    if (summary) {
      /* 压缩阶段：流式填充压缩记录；定稿后按（可能为空的）压缩结果继续回复流 */
      beginStream(summary, compressionMessages(summary.parentId), sumHandle, rec, {
        onSettled: function (stopped, errText) {
          if (stopped) {
            SSC.UI.showWarning('上下文压缩已中断，回复未开始。');
            /* 占位气泡定稿为中断并落盘（重载后展示与现场一致） */
            streamTarget.interrupted = 1;
            streamTarget.error = '压缩已中断，回复未开始';
            persistOp(SSC.DB.commitFinalize(streamTarget, session));
            targetHandle.finalize('', '压缩已中断，回复未开始', false, true);
            return;
          }
          if (errText) SSC.UI.showWarning('上下文压缩失败，已按完整上下文继续生成。');
          beginStream(streamTarget, buildRequestBody(streamTarget.parentId), targetHandle,
            makeCheckpointRec(streamTarget, model.id));
        }
      });
    } else {
      beginStream(streamTarget, buildRequestBody(streamTarget.parentId), targetHandle, rec);
    }
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
    refreshContextInfo(); /* 上下文窗口大小随模型变化 */
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
   * @param {object} data 表单值 { label: string, endpoint: string, model: string, apiKey: string, contextWindow: string }（已 trim；label 可为空串）
   * @returns {void}
   */
  App.addModel = function (data) {
    var m = {
      id: SSC.DB.newId('m'),
      label: data.label || data.model,
      endpoint: data.endpoint,
      model: data.model,
      apiKey: data.apiKey,
      contextWindow: parseContextWindow(data.contextWindow),
      createdAt: Date.now()
    };
    state.models.push(m);
    state.activeModelId = m.id;
    persistOp(SSC.DB.putModel(m));
    saveActiveModelId();
    SSC.UI.setModelOptions(state.models, state.activeModelId);
    SSC.UI.openModelManager(state.models, state.activeModelId);
    refreshContextInfo(); /* 活动模型/上下文窗口大小已变化 */
  };

  /**
   * 编辑模型配置（模型管理弹窗表单提交）：更新内存与持久化并刷新弹窗列表；id 不存在时静默返回。
   * @param {string} id 模型 id
   * @param {object} data 表单值 { label: string, endpoint: string, model: string, apiKey: string, contextWindow: string }（已 trim）
   * @returns {void}
   */
  App.editModel = function (id, data) {
    for (var i = 0; i < state.models.length; i++) {
      if (state.models[i].id === id) {
        state.models[i].label = data.label || data.model;
        state.models[i].endpoint = data.endpoint;
        state.models[i].model = data.model;
        state.models[i].apiKey = data.apiKey;
        state.models[i].contextWindow = parseContextWindow(data.contextWindow);
        persistOp(SSC.DB.putModel(state.models[i]));
        break;
      }
    }
    saveActiveModelId();
    SSC.UI.setModelOptions(state.models, state.activeModelId);
    SSC.UI.openModelManager(state.models, state.activeModelId);
    refreshContextInfo(); /* 上下文窗口大小可能已修改 */
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
    refreshContextInfo(); /* 活动模型可能已回退，上下文窗口大小随之变化 */
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
   * 构造请求体（有效历史）：按分支上最后一个内容非空的压缩记录截断——
   * 存在时，请求只包含【其压缩摘要（包装为 system 消息）】+ 其后的消息
   *（user 全收、assistant 仅收非空 content）；无压缩记录时包含整条分支历史（同一纳入规则）。
   * 内容为空的压缩记录（失败/中断的压缩）视同不存在（截断点取更早的非空记录，保证回退请求不丢旧摘要）。
   * @param {string} headId 历史末端节点 id（请求包含 branchPath(headId)）
   * @returns {Array<{role: string, content: string}>} OpenAI 格式消息数组（[旧 → 新]）
   */
  function buildRequestBody(headId) {
    var path = branchPath(headId);
    var summary = null;
    var summaryIdx = -1;
    for (var i = 0; i < path.length; i++) {
      if (path[i].role === 'summary' && path[i].content) { summary = path[i]; summaryIdx = i; }
    }
    var messages = [];
    if (summary) {
      messages.push({ role: 'system', content: SUMMARY_PREFIX + summary.content });
    }
    var start = summary ? summaryIdx + 1 : 0;
    for (i = start; i < path.length; i++) {
      var m = path[i];
      if (m.role === 'user' || (m.role === 'assistant' && m.content)) {
        messages.push({ role: m.role, content: m.content });
      }
    }
    return messages;
  }

  /**
   * 估算以 headId 为历史末端（含压缩摘要截断）将发送的请求的输入 token 数，可附加一条额外 user 消息。
   * 锚点优化：有效历史（最后一个压缩记录之后）内存在 API 回报过 inputTokens 的 assistant 时，
   * 取最近一个作基准（其请求历史是目标请求的前缀），只估算锚点之后新增的消息（含 extra）；
   * 无锚点则对整个请求体从头估算（基础 3 + 每条 4 + 内容估算）。
   * @param {string} headId 历史末端节点 id（请求包含 branchPath(headId) 的有效历史）
   * @param {string|null} extra 请求末尾追加的 user 消息文本；null = 不追加
   * @returns {{ est: number, basis: string }} est = 预估输入 token；basis = 'anchor'（锚点基准+增量）| 'full'（全文估算）
   */
  function estimateRequest(headId, extra) {
    var path = branchPath(headId);
    var sIdx = -1;
    /* 截断点 = 最后一个内容非空的压缩记录（与 buildRequestBody 一致） */
    for (var i = 0; i < path.length; i++) {
      if (path[i].role === 'summary' && path[i].content) sIdx = i;
    }
    var anchorIdx = -1;
    /* 锚点必须位于最后一个压缩记录之后（否则其基准历史与有效历史不一致，不可用） */
    for (i = path.length - 1; i > sIdx; i--) {
      if (path[i].role === 'assistant' && path[i].inputTokens != null) { anchorIdx = i; break; }
    }
    var est;
    var basis;
    if (anchorIdx !== -1) {
      est = path[anchorIdx].inputTokens;
      basis = 'anchor';
      /* 锚点自身请求不含其正文：从锚点自身起累加增量，纳入规则与 buildRequestBody 一致 */
      for (i = anchorIdx; i < path.length; i++) {
        var m = path[i];
        if (m.role === 'user' || (m.role === 'assistant' && m.content)) {
          est += 4 + estimateTextTokens(m.content);
        }
      }
    } else {
      est = estimateRequestTokens(buildRequestBody(headId));
      basis = 'full';
    }
    if (extra) est += 4 + estimateTextTokens(extra);
    return { est: est, basis: basis };
  }

  /**
   * 在 parent 与其最后一个子节点（待回复的新消息）之间插入一条上下文压缩记录节点：
   * 新节点成为 parent 的末位子节点，原末子改挂其下；两者均写入 activeCache（未落盘，由调用方提交）。
   * @param {object} parent 分支末端节点（压缩范围截止于此；其最后一个子节点须为待回复的新消息）
   * @returns {object|null} 创建的 summary 节点；parent 无子节点或无活动模型时返回 null
   */
  function insertSummaryNode(parent) {
    var model = activeModel();
    var lastChildId = parent.children[parent.children.length - 1];
    var lastChild = lastChildId ? state.activeCache.get(lastChildId) : null;
    if (!model || !lastChild) return null;
    var sNode = {
      id: SSC.DB.newId('n'), sessionId: lastChild.sessionId,
      parentId: parent.id, children: [lastChildId],
      role: 'summary', content: '', thinking: '',
      error: null, interrupted: 0, createdAt: Date.now(), modelId: model.id,
      inputTokens: null, outputTokens: null, cachedTokens: null
    };
    parent.children[parent.children.length - 1] = sNode.id;
    lastChild.parentId = sNode.id;
    state.activeCache.set(sNode.id, sNode);
    return sNode;
  }

  /**
   * 构造上下文压缩请求体：headId 为止的有效历史（含旧压缩记录包装）+ 末尾追加一条压缩指令 user 消息。
   * @param {string} headId 待压缩历史的末端节点 id
   * @returns {Array<{role: string, content: string}>} 压缩请求的消息数组
   */
  function compressionMessages(headId) {
    return buildRequestBody(headId).concat([{ role: 'user', content: COMPRESSION_PROMPT }]);
  }

  /**
   * 统计某压缩记录之前请求实际包含的消息条数（即该记录压缩掉的消息数，
   * 不含旧压缩记录本身或其摘要包装）。
   * @param {string} headId 分支路径末端节点 id（通常传压缩记录自身 id，即统计至其父节点为止）
   * @returns {number} 纳入的 user / 非空 assistant 消息条数
   */
  function countCompressedMessages(headId) {
    var path = branchPath(headId);
    path.pop(); /* 排除末端节点自身（统计其父节点为止的历史） */
    var cnt = 0;
    /* 逐节点累计；遇到内容非空的旧压缩记录则重新计数（其摘要已覆盖更早消息，与 buildRequestBody 截断规则一致） */
    path.forEach(function (n) {
      if (n.role === 'summary' && n.content) { cnt = 0; return; }
      if (n.role === 'user' || (n.role === 'assistant' && n.content)) cnt += 1;
    });
    return cnt;
  }

  /**
   * 粗略估算单条文本的 token 数：CJK 字符（中日韩文字、中文标点、全角形式）按每字 1 token，
   * 其余字符按约 4 字符 1 token（常见 BPE tokenizer 的经验值；混排文本误差有限，仅用于粗略估算）。
   * @param {string} text 消息内容（null/undefined 按空串处理）
   * @returns {number} 估算 token 数（空串为 0）
   */
  function estimateTextTokens(text) {
    var s = String(text == null ? '' : text);
    if (!s.length) return 0;
    var m = s.match(/[\u2F00-\u2FDF\u2E80-\u2EFF\u3000-\u303F\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF]/g);
    var cjk = m ? m.length : 0; /* CJK 类字符：每字 1 token */
    return cjk + Math.ceil((s.length - cjk) / 4); /* 其余字符：约 4 字 1 token */
  }

  /**
   * 粗略估算 OpenAI Chat Completions 请求体的输入 token 数：
   * 基础 3（固定提示包装）+ 每条消息 4（role 与分隔符开销）+ 各消息内容估算。
   * @param {Array<{role: string, content: string}>} messages 请求消息数组
   * @returns {number} 估算的输入 token 数
   */
  function estimateRequestTokens(messages) {
    var total = 3;
    /* 逐条累加每条消息的开销与内容估算 */
    messages.forEach(function (m) {
      total += 4 + estimateTextTokens(m.content);
    });
    return total;
  }

  /**
   * 计算当前会话的上下文窗口使用量（基于当前分支最后一条助手回复）。
   * 取值优先级：
   * 1. 最后一条助手回复之后还出现了压缩记录（如压缩刚完成、回复尚未生成）
   *    → 下一次请求将基于截断后的上下文，按之估算（estimated=true）；
   * 2. 最后一条回复有 API 回报的 inputTokens → 直接使用（精确，estimated=false）；
   * 3. 否则按有效历史（最后一个压缩记录之后）内最近一条有用量回报的回复作锚点估算增量
   *    （见 estimateRequest）；无锚点则对整个请求体从头估算。
   * @returns {object|null} { percent: number 使用百分比（可超 100）, used: number 已用 token,
   *   window: number 上下文窗口大小, estimated: boolean 是否估算值,
   *   basis: 'anchor'|'full' 估算依据（仅 estimated=true 时有意义：anchor=锚点+增量，full=全文估算）,
   *   hasSummary: boolean 当前分支是否包含压缩记录 }；
   *   无活动模型或当前分支没有助手回复时返回 null
   */
  function contextUsageInfo() {
    var model = activeModel();
    var session = activeSession();
    if (!model || !session) return null;
    var path = branchPath(session.leafId);
    var lastIdx = -1;
    var sIdx = -1;
    for (var i = 0; i < path.length; i++) {
      if (path[i].role === 'summary' && path[i].content) sIdx = i;
      if (path[i].role === 'assistant') lastIdx = i;
    }
    if (lastIdx === -1) return null;
    var last = path[lastIdx];
    var win = model.contextWindow;
    var hasSummary = sIdx !== -1;
    if (sIdx > lastIdx) {
      /* 最后回复之后有压缩记录：下一次请求按截断后的上下文估算 */
      var r = estimateRequest(session.leafId, null);
      return { percent: r.est / win * 100, used: r.est, window: win, estimated: true, basis: r.basis, hasSummary: true };
    }
    if (last.inputTokens != null) {
      return { percent: last.inputTokens / win * 100, used: last.inputTokens, window: win, estimated: false, hasSummary: hasSummary };
    }
    var r2 = estimateRequest(last.parentId, null);
    return { percent: r2.est / win * 100, used: r2.est, window: win, estimated: true, basis: r2.basis, hasSummary: hasSummary };
  }

  /**
   * 刷新输入区下方的上下文窗口使用指示（按当前会话 + 当前模型计算，结果为 null 时隐藏指示）。
   * @returns {void}
   */
  function refreshContextInfo() {
    SSC.UI.setContextUsage(contextUsageInfo());
  }

  /**
   * 计算某节点的分叉版本切换条选项：父节点有多个子节点（发生过分叉）时，
   * 返回版本列表（按创建时间升序，当前节点标记 active）；否则返回 null。
   * @param {object} n 消息节点
   * @returns {Array<{id: string, createdAt: number, active: boolean}>|null} 版本列表或 null
   */
  function versionsFor(n) {
    if (!n.parentId) return null;
    var p = state.activeCache.get(n.parentId);
    if (!p || p.children.length <= 1) return null;
    /* 父节点的全部子节点即各版本，按创建时间升序 */
    return p.children
      .map(function (cid) {
        var c = state.activeCache.get(cid);
        return { id: cid, createdAt: c ? c.createdAt : 0, active: cid === n.id };
      })
      .sort(function (a, b) { return a.createdAt - b.createdAt; });
  }

  /**
   * 把当前分支渲染到界面（启动 / 切会话 / 切分支 / 分叉后）；返回逐节点 UI 句柄。
   * 分叉节点（父有多个子）附带版本切换条；编辑态高亮随重渲染恢复。
   * @param {object|null} session 会话记录（取 leafId 定分支）；null 时仅清空消息区
   * @param {string|null} pendingLeafId 即将开流的助手节点 id：其空气泡不定稿（不显示"未收到内容"占位），
   *   与正常新发送时"正文首字出现前气泡隐藏"的表现一致。
   * @param {string|null} pendingSummaryId 即将开流的压缩记录 id：以流式态渲染（"正在压缩上下文…"）。
   * @returns {{ handles: Array<object>, byId: object<string, object> }} handles 为逐节点 UI 句柄（顺序与分支路径一致），
   *   byId 按节点 id 索引同一批句柄
   */
  function renderBranch(session, pendingLeafId, pendingSummaryId) {
    var handles = [];
    var byId = {};
    SSC.UI.clearMessages();
    if (!session) {
      refreshContextInfo(); /* 无会话 → 隐藏上下文使用指示 */
      return { handles: handles, byId: byId };
    }
    /* 逐节点渲染分支：压缩记录 / 分叉版本条 + 思考区 + 定稿态 */
    branchPath(session.leafId).forEach(function (n) {
      if (n.role === 'summary') {
        /* 压缩记录：默认仅一行记录，点击展开压缩全文；待压缩的记录保持流式态 */
        var sumOpts = { id: n.id, count: countCompressedMessages(n.id), versions: versionsFor(n) };
        var sh = SSC.UI.addSummary(n.id === pendingSummaryId ? null : (n.content || null), sumOpts);
        if (n.id !== pendingSummaryId) {
          if (n.error) sh.finalize(n.content, n.error, false, false);
          else if (n.interrupted) sh.finalize(n.content, null, true, true); /* 中断（无错误）→「上下文压缩已中断」而非“失败” */
          else sh.finalize(n.content, null, false, false);
        }
        if (n.inputTokens != null || n.outputTokens != null || n.cachedTokens != null) {
          sh.usage({
            inputTokens: n.inputTokens,
            outputTokens: n.outputTokens,
            cachedTokens: n.cachedTokens
          });
        }
        handles.push(sh);
        byId[n.id] = sh;
        return;
      }
      var opts = { id: n.id };
      var versions = versionsFor(n);
      if (versions) opts.versions = versions;
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
      byId[n.id] = handle;
    });
    if (state.editingNode) SSC.UI.setEditing(state.editingNode); /* 编辑态高亮随重渲染恢复 */
    refreshContextInfo(); /* 上下文使用指示随分支/会话变化刷新 */
    return { handles: handles, byId: byId };
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
   * @returns {object|null} 模型配置 { id, label, endpoint, model, apiKey, contextWindow, createdAt }；无模型时返回 null
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
   * 构造节点的 checkpoint 记录（空缓冲，等待流式增量填充）。
   * @param {object} node 消息节点（assistant 或 summary；取 sessionId/id/parentId/role）
   * @param {string} modelId 生成内容的模型 id
   * @returns {object} checkpoint 记录 { sessionId, messageId, parentId, modelId, createdAt, content, thinking, role }
   */
  function makeCheckpointRec(node, modelId) {
    return {
      sessionId: node.sessionId, messageId: node.id, parentId: node.parentId,
      modelId: modelId, createdAt: Date.now(), content: '', thinking: '',
      role: node.role === 'summary' ? 'summary' : 'assistant'
    };
  }

  /**
   * 启动一次流式生成（send / fork / 上下文压缩共用）。
   * 同时把 checkpoint 记录写盘（幂等；前置事务未包含时由此补齐，如压缩阶段的回复流）。
   * @param {object} node 由流填充的节点（assistant 回复或 summary 压缩记录）
   * @param {Array<{role: string, content: string}>} messages 完整请求体（OpenAI 格式，调用方构造）
   * @param {object} handle 该节点的 UI 句柄（addMessage / addSummary 返回值）
   * @param {object} rec checkpoint 记录
   * @param {object|null} opts { onSettled: function(stopped: boolean, errText: string|null): void }
   *   定稿完成后的回调（压缩阶段用它衔接回复流；stopped/errText 语义同 finalizeStream）；可省略
   * @returns {void} 无可用模型时直接返回
   */
  function beginStream(node, messages, handle, rec, opts) {
    var model = activeModel();
    if (!model) return;
    stream = {
      node: node, handle: handle, buf: { content: '', thinking: '' },
      rec: rec, lastCk: 0, usage: null, /* 本轮用量（服务端在流末尾 chunk 返回） */
      onSettled: opts && opts.onSettled ? opts.onSettled : null
    };
    var controller = new AbortController();
    state.abort = controller;
    setStreaming(true);

    persistOp(SSC.DB.checkpoint(rec)); /* 确保 checkpoint 在盘（幂等替换写） */

    SSC.Api.stream(
      { endpoint: model.endpoint, model: model.model, apiKey: model.apiKey },
      messages,
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
    refreshContextInfo(); /* 本轮用量已写入节点 → 刷新上下文使用指示 */

    persistOp(SSC.DB.commitFinalize(node, session || null));
    /* 压缩阶段结束：回调调用方续接（stopped/失败由回调自行处理，不启动回复流） */
    if (st.onSettled) st.onSettled(stopped, node.error);
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

  /**
   * 解析表单的上下文窗口大小：纯数字且 0 < 值 ≤ MAX_CONTEXT_WINDOW 才合法；
   * 为空或非法时回退缺省 131072（128K）。UI 层已过滤非数字，此处为防御性复检。
   * @param {*} v 表单原始值（string，可能为空）
   * @returns {number} 正整数上下文窗口大小
   */
  function parseContextWindow(v) {
    var s = String(v == null ? '' : v).trim();
    var n = Number(s);
    if (!/^\d+$/.test(s) || !Number.isFinite(n) || n <= 0 || n > MAX_CONTEXT_WINDOW) {
      return SSC.DB.DEFAULT_CONTEXT_WINDOW;
    }
    return n;
  }

  SSC.App = App;

  // 程序入口（script 位于 body 末尾，DOM 已就绪）
  SSC.App.init();
})();
