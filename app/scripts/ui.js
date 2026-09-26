/*
 * ui.js — UI 模块：渲染（设置页 / 主界面 / 模型管理 / 消息）+ 事件绑定。
 *
 * 文案：界面文字一律取自 SSC.I18n（见 i18n.js），本文件不出现硬编码自然语言文本。
 * 静态元素在构建时用 I18n.bind 绑定（写入 data-i18n* 属性），动态元素在创建/更新时绑定，
 * 切换语言后由 UI.applyLanguage → I18n.applyAll 原地重渲染，无需重建 DOM。
 */
(function () {
  'use strict';

  window.SSC = window.SSC || {};

  var UI = {};

  var handlers = {
    onSave: null,
    onSend: null,
    onStop: null,
    onStartEdit: null,
    onCancelEdit: null,
    onSwitchVersion: null,
    onNewSession: null,
    onSwitchSession: null,
    onDeleteSession: null,
    onSelectModel: null,
    onManageModels: null,
    onToggleTheme: null,
    onToggleLanguage: null,
    onShowAddForm: null,
    onShowEditForm: null,
    onAddModel: null,
    onEditModel: null,
    onDeleteModel: null,
    onCloseModelManager: null,
    onBackToModelList: null
  };

  var settingsView, mainView;
  var settingsModelFields; /* 设置页模型表单（buildModelFields 返回的字段容器） */
  var messagesEl, inputEl, sendBtn, stopBtn;
  var ctxInfoEl; /* 上下文窗口使用指示（输入区底部操作行左端，默认隐藏） */
  var ctxInfoData = null; /* 最近一次 setContextUsage 的入参（语言切换后据此重渲染指示文案） */
  var modelSelect, manageModelsBtn, themeToggleBtn;
  var langToggleBtns = []; /* 语言切换按钮（主界面顶栏 + 设置页浮动各一个；按钮文字为语言标记，需单独刷新） */
  var modelModal, modelModalCard;
  var modelListEl, modelFormEl, modelForm, modelFormTitle;
  var managerModelFields; /* 模型管理模型表单（buildModelFields 返回的字段容器） */
  var currentEditId = null;
  var sidebarEl, sessionListEl;
  var emptyStateEl;
  var editingNodeId = null; /* 当前处于编辑态的 user 节点 id（UI 侧镜像，供编辑/取消按钮判断） */

  /* 图标标记：图形放在 resources/ 下的独立 SVG 文件中，由 CSS 通过 mask 渲染（颜色跟随按钮 currentColor，
     见 styles.css 中 .theme-icon / .edit-icon / .cancel-icon 的 mask 规则）。
     主题图标亮色显太阳、暗色显月亮，由 CSS 按 data-theme 切换显示。 */
  var ICON_MOON = '<span class="theme-icon theme-icon--moon" aria-hidden="true"></span>';
  var ICON_SUN = '<span class="theme-icon theme-icon--sun" aria-hidden="true"></span>';
  /* 编辑图标（铅笔；消息编辑按钮用） */
  var ICON_EDIT = '<span class="edit-icon" aria-hidden="true"></span>';
  /* 取消图标（×；消息进入编辑态后编辑按钮切换为此图标） */
  var ICON_CANCEL = '<span class="cancel-icon" aria-hidden="true"></span>';

  /* GitHub 仓库链接占位符：index.html 默认赋此值表示“未配置”，部署时由 GitHub Action 替换为真实地址。
     采用不易被误匹配的哨兵值，即使被误访问也不会跳转到真实页面 */
  var CODE_REPO_LINK_PLACEHOLDER = '__CODE_REPO_LINK_PLACEHOLDER__';

  /* ---------- 初始化 ---------- */

  /**
   * 初始化 UI：在容器内构建设置页、主界面与模型管理弹窗，默认显示设置页。
   * @param {Element} container 挂载容器（#app）
   * @returns {void}
   */
  UI.init = function (container) {
    container.innerHTML = '';
    langToggleBtns = []; /* 旧按钮已随容器清空，避免 applyLanguage 刷新已脱离文档的元素 */
    buildSettings(container);
    buildMain(container);
    buildModelModal(container);
    // 默认显示设置页；App 通过 showSettings / showMain 切换
    UI.showSettings();
  };

  /**
   * 注册事件处理器（App 层回调）：仅覆盖 h 中提供的键，未提供的保持原值。
   * @param {object} h 处理器集合（键与内部 handlers 一致，值为 function）
   * @returns {void}
   */
  UI.setHandlers = function (h) {
    for (var key in handlers) {
      if (h.hasOwnProperty(key) && h[key]) handlers[key] = h[key];
    }
  };

  /* ---------- 视图切换 ---------- */

  /**
   * 显示设置页（隐藏主界面），并聚焦 endpoint 输入框。
   * @returns {void}
   */
  UI.showSettings = function () {
    if (settingsView) settingsView.hidden = false;
    if (mainView) mainView.hidden = true;
    if (settingsModelFields) settingsModelFields.inputs.endpoint.focus();
  };

  /**
   * 显示主界面（隐藏设置页）并聚焦输入框。
   * @returns {void}
   */
  UI.showMain = function () {
    if (mainView) mainView.hidden = false;
    if (settingsView) settingsView.hidden = true;
    UI.focusInput();
  };

  /**
   * 聚焦消息输入框。
   * @returns {void}
   */
  UI.focusInput = function () {
    if (inputEl) inputEl.focus();
  };

  /* ---------- 模型选择器 ---------- */

  /**
   * 填充头部模型下拉框（显示 label，无 label 时显示模型名）。
   * @param {Array<object>} models 模型配置数组 { id, label, model, ... }
   * @param {string|null} activeId 当前活动模型 id（选中对应项）
   * @returns {void}
   */
  UI.setModelOptions = function (models, activeId) {
    if (!modelSelect) return;
    modelSelect.innerHTML = '';
    models.forEach(function (m) {
      var opt = document.createElement('option');
      opt.value = m.id;
      opt.textContent = m.label || m.model;
      if (m.id === activeId) opt.selected = true;
      modelSelect.appendChild(opt);
    });
  };

  /* ---------- 模型管理弹窗 ---------- */

  /**
   * 打开模型管理弹窗并渲染模型列表（标题固定为「模型管理」）。
   * @param {Array<object>} models 模型配置数组
   * @param {string|null} activeId 当前活动模型 id（对应行加 active 样式）
   * @returns {void}
   */
  UI.openModelManager = function (models, activeId) {
    if (!modelModal) return;
    SSC.I18n.bind(modelFormTitle, 'modelManager');
    renderModelList(models, activeId);
    modelFormEl.hidden = true;
    modelModal.hidden = false;
  };

  /**
   * 关闭模型管理弹窗。
   * @returns {void}
   */
  UI.closeModelManager = function () {
    if (modelModal) modelModal.hidden = true;
  };

  /**
   * 显示模型表单（添加或编辑）：切换弹窗内容为表单并预填值。
   * @param {object|null} modelData null = 新增；模型对象 = 编辑（记录 currentEditId）
   * @returns {void}
   */
  UI.showModelForm = function (modelData) {
    var isEdit = !!modelData;
    currentEditId = isEdit ? modelData.id : null;
    SSC.I18n.bind(modelFormTitle, isEdit ? 'editModelTitle' : 'addModelTitle');
    managerModelFields.fillValues(isEdit ? modelData : null);
    modelListEl.hidden = true;
    modelFormEl.hidden = false;
    modelModal.hidden = false;
    managerModelFields.inputs.label.focus();
  };

  /**
   * 渲染模型管理弹窗内的模型列表：每行含名称/端点/「编辑」「删除」按钮，
   * 点击行切换模型（当前活动行不触发），底部附「+ 添加模型」按钮。
   * @param {Array<object>} models 模型配置数组
   * @param {string|null} activeId 当前活动模型 id
   * @returns {void}
   */
  function renderModelList(models, activeId) {
    modelListEl.innerHTML = '';
    modelListEl.hidden = false;

    /* 每个模型渲染一行（名称 + 端点 + 编辑/删除按钮，点击行切换） */
    models.forEach(function (m) {
      var isActive = m.id === activeId;
      var item = make('div', 'model-item' + (isActive ? ' active' : ''));

      var nameRow = make('div', 'model-item-name');
      nameRow.appendChild(make('span', 'model-dot' + (isActive ? ' active' : ''), ''));
      nameRow.appendChild(make('span', null, m.label || m.model));
      item.appendChild(nameRow);

      item.appendChild(make('div', 'model-item-detail', m.endpoint + '  /  ' + m.model));

      var btnRow = make('div', 'model-item-actions');
      var editBtn = make('button', 'btn btn-secondary btn-sm');
      editBtn.type = 'button';
      SSC.I18n.bind(editBtn, 'edit');
      editBtn.addEventListener('click', function (e) {
        /* 编辑按钮（阻止冒泡，避免触发整行切换模型） */
        e.stopPropagation();
        if (handlers.onShowEditForm) handlers.onShowEditForm(m.id);
      });
      var delBtn = make('button', 'btn btn-secondary btn-sm btn-danger');
      delBtn.type = 'button';
      SSC.I18n.bind(delBtn, 'delete');
      delBtn.addEventListener('click', function (e) {
        /* 删除按钮（阻止冒泡，避免触发整行切换模型） */
        e.stopPropagation();
        if (handlers.onDeleteModel) handlers.onDeleteModel(m.id);
      });
      btnRow.appendChild(editBtn);
      btnRow.appendChild(delBtn);
      item.appendChild(btnRow);

      // 点击行切换模型
      item.addEventListener('click', function () {
        if (!isActive && handlers.onSelectModel) {
          handlers.onSelectModel(m.id);
        }
      });

      modelListEl.appendChild(item);
    });

    var addBtn = make('button', 'btn btn-sm model-add-btn');
    addBtn.type = 'button';
    SSC.I18n.bind(addBtn, 'addModelBtn');
    addBtn.addEventListener('click', function () {
      /* 点击「+ 添加模型」：打开新增表单 */
      if (handlers.onShowAddForm) handlers.onShowAddForm();
    });
    modelListEl.appendChild(addBtn);
  }

  /* ---------- 会话列表 ---------- */

  /**
   * 渲染侧边栏会话列表（标题缺省显示「新会话」；点击行切换、× 删除）。
   * @param {Array<object>} sessions 会话数组 { id, title, ... }
   * @param {string|null} activeId 当前活动会话 id（加 active 样式）
   * @returns {void}
   */
  UI.setSessions = function (sessions, activeId) {
    if (!sessionListEl) return;
    sessionListEl.innerHTML = '';
    /* 每个会话渲染一行（标题 + 删除按钮，点击行切换） */
    sessions.forEach(function (s) {
      var item = make('div', 'session-item' + (s.id === activeId ? ' active' : ''));
      var title = make('span', 'session-title');
      /* 有标题用数据本身（不绑定，避免语言切换覆盖用户内容）；无标题绑定缺省文案 */
      if (s.title) title.textContent = s.title;
      else SSC.I18n.bind(title, 'untitledSession');
      var del = make('button', 'session-del', '×');
      del.type = 'button';
      SSC.I18n.bind(del, 'deleteSessionBtn', null, 'title');
      del.addEventListener('click', function (e) {
        /* 删除会话（阻止冒泡，避免触发整行切换） */
        e.stopPropagation();
        if (handlers.onDeleteSession) handlers.onDeleteSession(s.id);
      });
      item.appendChild(title);
      item.appendChild(del);
      item.addEventListener('click', function () {
        /* 点击行切换会话（当前活动会话不触发） */
        if (s.id !== activeId && handlers.onSwitchSession) {
          handlers.onSwitchSession(s.id);
        }
      });
      sessionListEl.appendChild(item);
    });
  };

  /**
   * 清空消息区全部消息，并恢复「开始新的对话」空状态提示。
   * @returns {void}
   */
  UI.clearMessages = function () {
    if (!messagesEl) return;
    var msgs = messagesEl.querySelectorAll('.msg');
    for (var i = 0; i < msgs.length; i++) msgs[i].parentNode.removeChild(msgs[i]);
    if (emptyStateEl) emptyStateEl.hidden = false;
  };

  /* ---------- 消息 ---------- */

  /**
   * 追加一条消息（text == null 表示内容稍后流式填充）。
   * 助手消息的思考区：模型输出 reasoning_content 时才显示（灰色弱化、可展开）；
   * 正文气泡在正文开始输出时才渲染，正文内容用 Markdown 渲染（SSC.Markdown）；
   * user 消息纯文本显示。opts.versions 多于 1 个时显示分叉版本切换条；
   * user 消息显示编辑按钮。
   * 助手消息额外带一个 token 用量小字区（默认隐藏；API 返回用量后调用 handle.usage(...) 显示）。
   * @param {string} role 'user' | 'assistant'（其它值按助手样式渲染）
   * @param {string|null} text 初始文本；null = 流式消息（气泡延迟到首个正文出现）
   * @param {object|null} opts { id: string 节点 id（编辑高亮/定位用）, versions: Array<{id: string, active: boolean}> 分叉版本列表 }
   * @returns {{ update: function, thinkUpdate: function, thinkDone: function, finalize: function, usage: function }} 消息句柄（方法见下）
   */
  UI.addMessage = function (role, text, opts) {
    if (emptyStateEl) emptyStateEl.hidden = true;
    var msg = make('div', 'msg ' + role);
    if (opts && opts.id) msg.setAttribute('data-node-id', opts.id);

    var roleEl = make('div', 'role');
    SSC.I18n.bind(roleEl, role === 'user' ? 'roleUser' : 'roleAssistant');

    /* 思考区（仅助手消息；无思考内容时整段隐藏） */
    var think = null, thinkToggle = null, thinkBody = null, thinkCaret = null;
    var thinkingBuf = '';
    var thinkingShown = false;
    var thinkingActive = false;

    if (role === 'assistant') {
      think = make('div', 'think');
      think.hidden = true;

      thinkToggle = make('button', 'think-toggle');
      thinkToggle.type = 'button';
      thinkToggle.setAttribute('aria-expanded', 'false');
      SSC.I18n.bind(thinkToggle, 'thinkToggle', null, 'title');

      var thinkText = make('span', 'think-text');
      SSC.I18n.bind(thinkText, 'thinking');
      thinkCaret = make('span', 'think-caret', '▸');
      thinkToggle.appendChild(thinkText);
      thinkToggle.appendChild(thinkCaret);

      thinkBody = make('div', 'think-body');
      thinkBody.hidden = true;

      thinkToggle.addEventListener('click', function () {
        /* 切换思考区展开状态（收起→展开，展开→收起） */
        setThinkExpanded(thinkBody.hidden);
      });

      think.appendChild(thinkToggle);
      think.appendChild(thinkBody);
    }

    var bubble = make('div', 'bubble');
    var content = make('div', 'content');
    if (text != null) {
      /* 助手消息：Markdown 渲染；用户消息：纯文本（pre-wrap） */
      if (role === 'assistant') SSC.Markdown.renderInto(content, text, false);
      else content.textContent = text;
    }

    var error = make('div', 'error');
    error.hidden = true;

    /* token 用量小字区（仅助手消息；API 未返回用量时保持隐藏） */
    var usageEl = null;
    if (role === 'assistant') {
      usageEl = make('div', 'msg-usage');
      usageEl.hidden = true;
    }

    bubble.appendChild(content);
    bubble.appendChild(error);
    /* 流式消息（text == null）的气泡延迟到正文开始输出时才显示 */
    if (text == null) bubble.hidden = true;

    msg.appendChild(roleEl);
    if (think) msg.appendChild(think);
    msg.appendChild(bubble);
    if (usageEl) msg.appendChild(usageEl);
    appendMessageMeta(msg, role, opts);
    messagesEl.appendChild(msg);
    scrollToBottom();

    /**
     * 展开/收起思考区（同步 aria-expanded、箭头符号；展开时同步全文并滚动到底部）。
     * @param {boolean} on true = 展开
     * @returns {void}
     */
    function setThinkExpanded(on) {
      if (!think) return;
      thinkBody.hidden = !on;
      thinkToggle.setAttribute('aria-expanded', on ? 'true' : 'false');
      thinkCaret.textContent = on ? '▾' : '▸';
      if (on && thinkingBuf) {
        thinkBody.textContent = thinkingBuf;
        thinkBody.scrollTop = thinkBody.scrollHeight;
      }
    }

    /**
     * 思考结束（正文开始 / 定稿时调用）：停止动画，若已展开则自动收起。
     * @param {boolean} completed true = 思考阶段已完整输出（标签变「思考完成」）；
     *   false = 停止/出错中断（标签保持「思考中」）
     * @returns {void}
     */
    function thinkDone(completed) {
      if (!thinkingShown || !thinkingActive) return;
      thinkingActive = false;
      if (completed) SSC.I18n.bind(thinkText, 'thinkingDone');
      think.classList.remove('active');
      if (!thinkBody.hidden) setThinkExpanded(false);
    }

    return {
      /**
       * 思考增量更新：首次出现时显示思考区并开始动画；已展开时同步全文并滚动到底部。
       * @param {string|null} t 截至当前的完整思考文本（null 忽略）
       */
      thinkUpdate: function (t) {
        if (t == null) return;
        thinkingBuf = t;
        if (!thinkingShown) {
          thinkingShown = true;
          think.hidden = false;
          thinkingActive = true;
          think.classList.add('active');
          scrollToBottom();
        }
        if (!thinkBody.hidden) {
          thinkBody.textContent = thinkingBuf;
          thinkBody.scrollTop = thinkBody.scrollHeight;
        }
      },
      /**
       * 思考结束（同内部 thinkDone）。
       * @param {boolean} completed 思考是否完整
       */
      thinkDone: thinkDone,
      /**
       * 正文流式增量更新：结束思考区、显示气泡，替换全文并加 streaming 样式。
       * @param {string} t 截至当前的完整正文文本
       */
      update: function (t) {
        thinkDone(true); /* 正文已开始输出 → 思考阶段必然已结束 */
        if (bubble.hidden) bubble.hidden = false;
        SSC.Markdown.renderInto(content, t, true);
        content.classList.add('streaming');
        scrollToBottom();
      },
      /**
       * 定稿：移除 streaming 样式；无内容时显示占位文案；有错误时内联显示错误。
       * @param {string} t 最终正文（空 = 无内容，显示占位）
       * @param {string|null} errText 错误描述；null = 无错误
       * @param {boolean} stopped 是否用户主动停止（影响占位文案）
       * @param {boolean} muted 错误文案是否弱化样式（用于「生成已中断」类提示）
       */
      finalize: function (t, errText, stopped, muted) {
        thinkDone(!errText && !stopped); /* 仅在流正常结束时认为思考完整 */
        content.classList.remove('streaming');
        if (t) {
          SSC.Markdown.renderInto(content, t, false);
        } else if (!errText) {
          /* 占位文案放在子 span 上绑定：后续若有正文渲染会连同该 span 一起被替换，
             不会留下「语言切换覆盖正文」的陈旧绑定 */
          content.textContent = '';
          var ph = make('span');
          SSC.I18n.bind(ph, stopped ? 'stoppedNoContent' : 'noContent');
          content.appendChild(ph);
          content.classList.add('placeholder');
        }
        if (bubble.hidden) bubble.hidden = false; /* 仅收到思考即停止/出错时也显示占位/错误 */
        if (errText) {
          /* 错误文案由产生方（api.js / app.js）按当时语言解析后传入，可能已随节点落盘，
             故此处不做 i18n 绑定：它是历史记录，语言切换后保持原样 */
          error.textContent = errText;
          error.hidden = false;
          if (muted) error.classList.add('muted');
        }
        scrollToBottom();
      },
      /**
       * 在气泡下方小字显示本轮 token 用量（委托 fillUsageEl；无用量时隐藏）。
       * @param {object|null} u { inputTokens: number|null 输入 token, outputTokens: number|null 输出 token, cachedTokens: number|null 缓存命中输入 token }
       */
      usage: function (u) {
        if (usageEl) fillUsageEl(usageEl, u);
      }
    };
  };

  /**
   * 切换单条编辑/取消按钮的呈现：编辑态显示「取消」图标与提示，否则显示「编辑」铅笔图标。
   * 按钮元素本身不变（同一 .edit-btn），仅替换图标、文案与 class。
   * @param {HTMLButtonElement} btn .edit-btn 按钮
   * @param {boolean} isEditing true = 该消息正处于编辑态（显示取消图标）
   * @returns {void}
   */
  function updateEditButton(btn, isEditing) {
    if (isEditing) {
      btn.innerHTML = ICON_CANCEL;
      SSC.I18n.bind(btn, 'cancelEditTitle', null, 'title');
      SSC.I18n.bind(btn, 'cancelEditAria', null, 'aria');
      btn.classList.add('edit-btn--cancel');
    } else {
      btn.innerHTML = ICON_EDIT;
      SSC.I18n.bind(btn, 'editMsgTitle', null, 'title');
      SSC.I18n.bind(btn, 'editMsgAria', null, 'aria');
      btn.classList.remove('edit-btn--cancel');
    }
  }

  /**
   * 绑定压缩记录的行文案（.sum-text）：override 非空时用该状态键（压缩中 / 失败 / 中断），
   * 否则按「已完成」文案渲染（有压缩条数时附条数，英文按单复数选键）。
   * @param {Element} el .sum-text 文案元素
   * @param {string|null} override 覆盖状态的文案键（'sumCompressing' | 'sumFailed' | 'sumInterrupted'）；null = 已完成
   * @param {number} count 压缩掉的消息条数（0 = 不显示条数）
   * @returns {void}
   */
  function bindSummaryLabel(el, override, count) {
    if (override) { SSC.I18n.bind(el, override); return; }
    if (count) SSC.I18n.bindCount(el, 'sumDoneCount', count);
    else SSC.I18n.bind(el, 'sumDone');
  }

  /**
   * 追加一条上下文压缩记录（特殊消息，非普通气泡）：
   * 默认仅显示一行记录（状态文案 + 压缩掉的消息条数），压缩后的上下文全文默认隐藏，
   * 点击记录行可展开查看（与思考区类似的交互）；记录下方小字显示该轮压缩请求的 token 用量。
   * opts.versions 多于 1 个时附带分叉版本切换条（压缩记录也可成为分叉点）。
   * @param {string|null} text 初始摘要全文；null = 流式中（记录处于"正在压缩上下文…"状态）
   * @param {object|null} opts { id: string 节点 id, count: number 压缩掉的消息条数（记录行展示用）,
   *   versions: Array<{id: string, active: boolean}> 分叉版本列表 }
   * @returns {{ update: function, finalize: function, usage: function, thinkUpdate: function, thinkDone: function }}
   *   消息句柄（接口与 addMessage 对齐；think* 为空实现）
   */
  UI.addSummary = function (text, opts) {
    if (emptyStateEl) emptyStateEl.hidden = true;
    var msg = make('div', 'msg summary');
    if (opts && opts.id) msg.setAttribute('data-node-id', opts.id);

    var count = opts && opts.count ? opts.count : 0;
    var buf = text == null ? '' : text;

    var toggle = make('button', 'sum-toggle');
    toggle.type = 'button';
    toggle.setAttribute('aria-expanded', 'false');
    SSC.I18n.bind(toggle, 'sumToggle', null, 'title');
    var caret = make('span', 'sum-caret', '▸');
    var label = make('span', 'sum-text');
    bindSummaryLabel(label, text == null ? 'sumCompressing' : null, count);
    toggle.appendChild(caret);
    toggle.appendChild(label);

    var body = make('div', 'sum-body');
    body.hidden = true;

    var usageEl = make('div', 'msg-usage');
    usageEl.hidden = true;
    var error = make('div', 'error');
    error.hidden = true;

    if (text == null) msg.classList.add('active'); /* 压缩中：脉动提示 */

    toggle.addEventListener('click', function () {
      /* 展开/收起压缩全文（无内容时不响应） */
      if (!buf) return;
      setExpanded(body.hidden);
    });

    msg.appendChild(toggle);
    msg.appendChild(body);
    msg.appendChild(usageEl);
    msg.appendChild(error);
    appendMessageMeta(msg, 'summary', opts);
    messagesEl.appendChild(msg);
    scrollToBottom();

    /**
     * 展开/收起压缩全文（同步 aria-expanded 与箭头；展开时同步全文并滚动到底部）。
     * @param {boolean} on true = 展开
     * @returns {void}
     */
    function setExpanded(on) {
      body.hidden = !on;
      toggle.setAttribute('aria-expanded', on ? 'true' : 'false');
      caret.textContent = on ? '▾' : '▸';
      if (on && buf) {
        body.textContent = buf;
        body.scrollTop = body.scrollHeight;
      }
    }

    return {
      /**
       * 压缩全文流式增量更新：已展开时同步全文并滚动到底部。
       * @param {string|null} t 截至当前的完整摘要文本（null 忽略）
       */
      update: function (t) {
        if (t == null) return;
        buf = t;
        if (!body.hidden) {
          body.textContent = buf;
          body.scrollTop = body.scrollHeight;
        }
        scrollToBottom();
      },
      /** 空实现：压缩记录无思考区（与 addMessage 句柄接口对齐） */
      thinkUpdate: function () {},
      /** 空实现：同上 */
      thinkDone: function () {},
      /**
       * 定稿：记录文案切到完成/失败/中断状态；出错时内联显示错误。
       * @param {string} t 最终摘要全文（空 = 无内容，不显示展开区）
       * @param {string|null} errText 错误描述；null = 无错误
       * @param {boolean} stopped 是否用户主动停止（影响记录文案）
       * @param {boolean} muted 错误文案是否弱化样式（用于中断类提示）
       */
      finalize: function (t, errText, stopped, muted) {
        if (typeof t === 'string' && t) buf = t;
        msg.classList.remove('active');
        bindSummaryLabel(label, errText ? 'sumFailed' : (stopped ? 'sumInterrupted' : null), count);
        if (!buf) {
          body.hidden = true; /* 无内容：不显示展开区 */
        } else if (!body.hidden) {
          body.textContent = buf;
          body.scrollTop = body.scrollHeight;
        }
        if (errText) {
          /* 错误文案由产生方解析后传入（可能已落盘），同 addMessage：不做 i18n 绑定 */
          error.textContent = errText;
          error.hidden = false;
          if (muted) error.classList.add('muted');
        }
        scrollToBottom();
      },
      /**
       * 记录下方小字显示本轮压缩请求的 token 用量（无用量时保持隐藏）。
       * @param {object|null} u { inputTokens: number|null, outputTokens: number|null, cachedTokens: number|null }
       */
      usage: function (u) {
        fillUsageEl(usageEl, u);
      }
    };
  };

  /**
   * 消息下方操作区：分叉版本切换条（版本数 >1 时显示）+ 编辑按钮（仅用户消息）。
   * 压缩记录（role='summary'）仅可能带版本切换条，无编辑按钮。
   * @param {Element} msg .msg 容器
   * @param {string} role 'user' | 'assistant' | 'summary'（其它值按助手样式处理）
   * @param {object|null} opts { id: string, versions: Array<{id, active}> }（见 addMessage）
   * @returns {void} 无分叉且不可编辑时不添加任何元素
   */
  function appendMessageMeta(msg, role, opts) {
    if (!opts) return;
    var hasForks = opts.versions && opts.versions.length > 1;
    var canEdit = role === 'user' && !!opts.id;
    if (!hasForks && !canEdit) return;

    var meta = make('div', 'msg-meta');
    if (hasForks) {
      var forks = make('div', 'forks');
      var forksLabel = make('span', 'forks-label');
      /* 版本数此处恒 > 1（hasForks 条件），英文无需单数变体 */
      SSC.I18n.bind(forksLabel, 'versionsLabel', [opts.versions.length]);
      forks.appendChild(forksLabel);
      /* 每个版本一个切换按钮（编号 1..n，当前版本高亮） */
      opts.versions.forEach(function (v, idx) {
        var b = make('button', 'fork-btn' + (v.active ? ' active' : ''), String(idx + 1));
        b.type = 'button';
        SSC.I18n.bind(b, 'switchToVersion', [idx + 1], 'title');
        b.addEventListener('click', function () {
          /* 版本按钮：切换到对应版本分支 */
          if (handlers.onSwitchVersion) handlers.onSwitchVersion(v.id);
        });
        forks.appendChild(b);
      });
      meta.appendChild(forks);
    }
    if (canEdit) {
      var edit = make('button', 'edit-btn');
      edit.type = 'button';
      SSC.I18n.bind(edit, 'editMsgTitle', null, 'title');
      SSC.I18n.bind(edit, 'editMsgAria', null, 'aria');
      edit.innerHTML = ICON_EDIT;
      edit.addEventListener('click', function () {
        /* 编辑/取消按钮：该消息正处于编辑态 → 取消编辑；否则进入编辑态 */
        if (editingNodeId === opts.id) {
          if (handlers.onCancelEdit) handlers.onCancelEdit();
        } else if (handlers.onStartEdit) {
          handlers.onStartEdit(opts.id);
        }
      });
      meta.appendChild(edit);
    }
    msg.appendChild(meta);
  }

  /* ---------- 输入 ---------- */

  /**
   * 读取输入框文本（已 trim）。
   * @returns {string} 输入内容
   */
  UI.getInputText = function () {
    return inputEl ? inputEl.value.trim() : '';
  };

  /**
   * 清空输入框。
   * @returns {void}
   */
  UI.clearInput = function () {
    if (inputEl) inputEl.value = '';
  };

  /**
   * 向输入框填入文本（编辑历史消息时预填原始内容）。
   * @param {string|null} t 要填入的文本（null/undefined 时清空）
   * @returns {void}
   */
  UI.setInputText = function (t) {
    if (inputEl) inputEl.value = t == null ? '' : t;
  };

  /**
   * 高亮正在编辑的消息气泡（nodeId 为 null 时清除全部高亮）。
   * @param {string|null} nodeId 被编辑的节点 id
   * @returns {void}
   */
  UI.setEditing = function (nodeId) {
    if (!messagesEl) return;
    editingNodeId = nodeId || null;
    var msgs = messagesEl.querySelectorAll('.msg[data-node-id]');
    for (var i = 0; i < msgs.length; i++) {
      /* 同步高亮 + 编辑/取消按钮图标：仅目标消息处于编辑态 */
      var isEditing = !!nodeId && msgs[i].getAttribute('data-node-id') === nodeId;
      msgs[i].classList.toggle('editing', isEditing);
      var btn = msgs[i].querySelector('.edit-btn');
      if (btn) updateEditButton(btn, isEditing);
    }
  };

  /**
   * 切换生成中 UI 状态（on = true：发送禁用、显示停止按钮）。
   * @param {boolean} on true = 生成中
   * @returns {void}
   */
  UI.setStreaming = function (on) {
    if (sendBtn) sendBtn.disabled = !!on;
    if (stopBtn) stopBtn.hidden = !on;
  };

  /**
   * 更新输入区底部操作行左端的上下文窗口使用指示：
   * 显示「上下文 xx.x% · 已用/窗口」（千分位数字）；估算结果在数值后附「（估算）」；
   * 分支含压缩记录时 tooltip 附注。（含压缩摘要）。
   * info 为 null 或窗口大小非法时隐藏指示。
   * @param {object|null} info { percent: number 使用百分比（可超 100）, used: number 已用 token（最后一轮输入 + 输出）, window: number 上下文窗口大小,
   *   estimated: boolean 是否估算值, basis: string 估算依据（'anchor'=锚点+增量 / 'full'=全文估算 /
   *   'mixed'=输入为 API 回报 + 输出按文本估算，仅估算时用于 tooltip 文案）,
   *   hasSummary: boolean 当前分支是否包含压缩记录 }
   * @returns {void}
   */
  UI.setContextUsage = function (info) {
    if (!ctxInfoEl) return;
    ctxInfoData = info || null; /* 缓存入参：语言切换后 applyLanguage 据此按新语言重渲染 */
    var win = Number(info && info.window);
    if (!info || !Number.isFinite(win) || win <= 0) {
      ctxInfoEl.hidden = true;
      return;
    }
    var pct = Number(info.percent);
    if (!Number.isFinite(pct)) pct = 0;
    var used = Number(info.used);
    if (!Number.isFinite(used) || used < 0) used = 0;
    var text = SSC.I18n.t('ctxInfo', [(Math.round(pct * 10) / 10).toFixed(1), formatTokens(used), formatTokens(win)]);
    if (info.estimated) text += SSC.I18n.t('ctxEstimated');
    var titlePrefix = !info.estimated ? SSC.I18n.t('ctxTipApi')
      : (info.basis === 'anchor' ? SSC.I18n.t('ctxTipAnchor')
        : info.basis === 'mixed' ? SSC.I18n.t('ctxTipMixed')
        : SSC.I18n.t('ctxTipFull'));
    ctxInfoEl.title = titlePrefix +
      SSC.I18n.t('ctxTipBody', [formatTokens(used), formatTokens(win)]) +
      (info.estimated ? SSC.I18n.t('ctxEstimated') : '') +
      (info.hasSummary ? SSC.I18n.t('ctxTipSummary') : '');
    ctxInfoEl.textContent = text;
    ctxInfoEl.hidden = false;
  };

  /* ---------- 警告横幅 ---------- */

  var warningEl = null;

  /**
   * 显示顶部警告条（可关闭）；重复调用复用同一条横幅并更新文案。
   * 用于本地存储不可用等异常场景。文案按 i18n 键绑定，语言切换后随之刷新。
   * @param {string} key i18n 文案键（见 i18n.js 的 STRINGS）
   * @returns {void}
   */
  UI.showWarning = function (key) {
    if (!key) return;
    if (!warningEl) {
      warningEl = document.createElement('div');
      warningEl.className = 'warning-banner';
      var close = make('button', 'warning-close', '×');
      close.type = 'button';
      SSC.I18n.bind(close, 'close', null, 'title');
      close.addEventListener('click', function () {
        /* 关闭警告条并释放引用 */
        if (warningEl && warningEl.parentNode) warningEl.parentNode.removeChild(warningEl);
        warningEl = null;
      });
      warningEl.appendChild(close);
      warningEl.appendChild(make('span', null, ''));
      document.body.appendChild(warningEl);
    }
    SSC.I18n.bind(warningEl.lastChild, key);
  };

  /* ---------- 语言 ---------- */

  /**
   * 按当前语言重渲染界面（语言切换后调用）：
   * 1. 刷新语言切换按钮上的语言标记（按钮文字是 'EN' / '中' 标记而非文案键，需单独设置）；
   * 2. 用缓存入参重渲染上下文使用指示（其文案由数字与多段拼接而成，无法只靠绑定属性还原）；
   * 3. 其余带 data-i18n* 绑定的元素统一交给 I18n.applyAll 原地刷新——不重建 DOM，
   *    因此进行中的流式消息句柄仍然有效，切换语言不会打断生成。
   * @returns {void}
   */
  UI.applyLanguage = function () {
    /* 逐个刷新语言按钮上的当前语言标记 */
    langToggleBtns.forEach(function (btn) { btn.textContent = SSC.I18n.label(); });
    SSC.I18n.applyAll();
    UI.setContextUsage(ctxInfoData);
  };

  /* ---------- DOM 构建 ---------- */

  /**
   * 创建主题切换按钮（亮/暗双图标由 CSS 按 data-theme 切换显示）。
   * @param {string|null} extraClass 附加 class（如设置页的 'theme-toggle--floating'）
   * @returns {HTMLButtonElement} 主题切换按钮
   */
  function makeThemeToggle(extraClass) {
    var btn = make('button', extraClass ? 'theme-toggle ' + extraClass : 'theme-toggle');
    btn.type = 'button';
    SSC.I18n.bind(btn, 'themeToggle', null, 'title');
    SSC.I18n.bind(btn, 'themeToggle', null, 'aria');
    btn.innerHTML = ICON_MOON + ICON_SUN;
    btn.addEventListener('click', function () {
      /* 点击切换主题 */
      if (handlers.onToggleTheme) handlers.onToggleTheme();
    });
    return btn;
  }

  /**
   * 创建语言切换按钮（按钮文字为当前语言标记：英文 'EN'、中文 '中'，由 applyLanguage 刷新）。
   * @param {string|null} extraClass 附加 class（如设置页的 'lang-toggle--floating'）
   * @returns {HTMLButtonElement} 语言切换按钮
   */
  function makeLangToggle(extraClass) {
    var btn = make('button', extraClass ? 'lang-toggle ' + extraClass : 'lang-toggle', SSC.I18n.label());
    btn.type = 'button';
    SSC.I18n.bind(btn, 'langToggle', null, 'title');
    SSC.I18n.bind(btn, 'langToggle', null, 'aria');
    btn.addEventListener('click', function () {
      /* 点击切换界面语言 */
      if (handlers.onToggleLanguage) handlers.onToggleLanguage();
    });
    langToggleBtns.push(btn);
    return btn;
  }

  /**
   * 读取并校验全局仓库链接：仅当 window.code_repo_link 为非空字符串、且不是占位符值时
   * 才视为有效配置。
   * @returns {string|null} 有效仓库链接；未配置或仍是占位符时返回 null（不显示按钮）
   */
  function readCodeRepoLink() {
    var link = window.code_repo_link;
    if (typeof link !== 'string') return null;
    link = link.trim();
    /* 空值或占位符值：视为未配置 */
    if (!link || link === CODE_REPO_LINK_PLACEHOLDER) return null;
    return link;
  }

  /**
   * 创建 GitHub 仓库按钮（亮/暗双图标由 CSS 按 data-theme 切换显示）。
   * 以 <a> 实现跳转：点击在新标签页打开仓库链接。
   * @param {string} url 仓库链接（已通过 readCodeRepoLink 校验有效）
   * @param {string|null} extraClass 附加 class（如设置页浮动的 'github-btn--floating'）
   * @returns {HTMLAnchorElement} GitHub 按钮
   */
  function makeGithubButton(url, extraClass) {
    var btn = make('a', extraClass ? 'github-btn ' + extraClass : 'github-btn');
    btn.href = url;
    btn.target = '_blank';
    btn.rel = 'noopener noreferrer';
    SSC.I18n.bind(btn, 'githubLink', null, 'title');
    SSC.I18n.bind(btn, 'githubLink', null, 'aria');
    /* 亮色模式显示黑标（light）、暗色模式显示白标（dark），逻辑与主题图标一致 */
    btn.innerHTML =
      '<img class="github-icon github-icon--light" src="resources/github-black.svg" width="16" height="16" alt="" aria-hidden="true" />' +
      '<img class="github-icon github-icon--dark" src="resources/github-white.svg" width="16" height="16" alt="" aria-hidden="true" />';
    return btn;
  }

  /**
   * 构建设置页：标题卡片 + 模型表单（buildModelFields）+ 右上角按钮（GitHub / 语言 / 主题）；
   * 表单提交时回调 handlers.onSave（传已 trim 的表单值）。
   * @param {Element} container 挂载容器
   * @returns {void}
   */
  function buildSettings(container) {
    settingsView = make('div', 'view settings');

    /* 右上角浮动按钮（首次打开尚未配置模型时的唯一入口）：
       GitHub 仓库按钮（仅在配置了有效链接时显示）→ 语言切换 → 主题切换 */
    var codeRepoLink = readCodeRepoLink();
    if (codeRepoLink) {
      settingsView.appendChild(makeGithubButton(codeRepoLink, 'github-btn--floating'));
    }
    settingsView.appendChild(makeLangToggle('lang-toggle--floating'));
    settingsView.appendChild(makeThemeToggle('theme-toggle--floating'));

    var card = make('div', 'settings-card');
    var title = make('h1');
    SSC.I18n.bind(title, 'appName');
    card.appendChild(title);
    var hint = make('p', 'settings-hint');
    SSC.I18n.bind(hint, 'settingsHint');
    card.appendChild(hint);

    var form = make('form');
    settingsModelFields = buildModelFields(form);

    var submit = make('button', 'btn');
    submit.type = 'submit';
    SSC.I18n.bind(submit, 'saveAndStart');
    form.appendChild(submit);

    form.addEventListener('submit', function (e) {
      /* 表单提交：阻止默认刷新，回调 onSave */
      e.preventDefault();
      if (handlers.onSave) handlers.onSave(settingsModelFields.readValues());
    });

    card.appendChild(form);
    settingsView.appendChild(card);
    container.appendChild(settingsView);
  }

  /**
   * 构建主界面：侧边栏（新建会话 + 会话列表）+ 主面板（顶栏模型选择/管理与右侧 GitHub/语言/主题按钮、
   * 消息区、输入框与下方操作行（左：上下文窗口使用指示；右：发送/停止，预留更多功能位））；绑定 Enter 发送等事件。
   * @param {Element} container 挂载容器
   * @returns {void}
   */
  function buildMain(container) {
    mainView = make('div', 'view main');
    mainView.hidden = true;

    /* 侧边栏 */
    sidebarEl = make('div', 'sidebar');
    var newBtn = make('button', 'btn sidebar-new-btn');
    newBtn.type = 'button';
    SSC.I18n.bind(newBtn, 'newChatBtn');
    newBtn.addEventListener('click', function () {
      /* 点击「+ 新建会话」 */
      if (handlers.onNewSession) handlers.onNewSession();
    });
    sidebarEl.appendChild(newBtn);
    sessionListEl = make('div', 'session-list');
    sidebarEl.appendChild(sessionListEl);

    /* 主面板 */
    var mainPanel = make('div', 'main-panel');

    var header = make('div', 'main-header');

    modelSelect = document.createElement('select');
    modelSelect.className = 'model-select';
    SSC.I18n.bind(modelSelect, 'switchModel', null, 'title');
    modelSelect.addEventListener('change', function () {
      /* 下拉框切换模型 */
      if (handlers.onSelectModel) handlers.onSelectModel(modelSelect.value);
    });
    header.appendChild(modelSelect);

    manageModelsBtn = make('button', 'btn btn-secondary btn-sm');
    manageModelsBtn.type = 'button';
    SSC.I18n.bind(manageModelsBtn, 'manageModels');
    manageModelsBtn.addEventListener('click', function () {
      /* 点击「管理模型」：打开模型管理弹窗 */
      if (handlers.onManageModels) handlers.onManageModels();
    });
    header.appendChild(manageModelsBtn);

    /* 顶栏右侧按钮组：整体推到最右并垂直居中，顺序为 GitHub → 语言切换 → 主题切换 */
    var headerActions = make('div', 'header-actions');

    /* GitHub 仓库按钮：仅当配置了有效仓库链接时才创建（否则不显示） */
    var codeRepoLink = readCodeRepoLink();
    if (codeRepoLink) {
      headerActions.appendChild(makeGithubButton(codeRepoLink));
    }

    /* 语言切换（按钮文字显示当前语言：EN / 中） */
    headerActions.appendChild(makeLangToggle(null));

    /* 主题切换（图标显示当前模式，由 CSS 按 data-theme 切换） */
    themeToggleBtn = makeThemeToggle();
    headerActions.appendChild(themeToggleBtn);
    header.appendChild(headerActions);

    messagesEl = make('div', 'messages');

    emptyStateEl = make('div', 'empty-state');
    var emptyText = make('div', 'empty-text');
    SSC.I18n.bind(emptyText, 'emptyTitle');
    var emptySub = make('div', 'empty-sub');
    SSC.I18n.bind(emptySub, 'emptySub');
    emptyStateEl.appendChild(emptyText);
    emptyStateEl.appendChild(emptySub);
    messagesEl.appendChild(emptyStateEl);

    var inputbar = make('div', 'inputbar');

    /* 输入框所在行（预留左侧/同排加入功能按钮的空间） */
    var inputRow = make('div', 'input-row');
    inputEl = document.createElement('textarea');
    inputEl.rows = 2;
    SSC.I18n.bind(inputEl, 'inputPlaceholder', null, 'placeholder');
    inputEl.addEventListener('keydown', function (e) {
      /* Enter 发送（Shift+Enter 换行；输入法组合中不触发） */
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        if (handlers.onSend) handlers.onSend();
      }
    });
    inputRow.appendChild(inputEl);

    /* 输入框下方的操作行：上下文使用指示左对齐，按钮右对齐，未来可在此行加入更多功能按钮 */
    var inputActions = make('div', 'input-actions');

    /* 上下文窗口使用指示（默认隐藏；会话载入 / 发送 / 定稿 / 模型切换后由 App 计算并调用 setContextUsage 刷新） */
    ctxInfoEl = make('span', 'ctx-info', '');
    ctxInfoEl.hidden = true;

    sendBtn = make('button', 'btn');
    sendBtn.type = 'button';
    SSC.I18n.bind(sendBtn, 'send');
    sendBtn.addEventListener('click', function () {
      /* 点击「发送」 */
      if (handlers.onSend) handlers.onSend();
    });

    stopBtn = make('button', 'btn btn-secondary');
    stopBtn.type = 'button';
    SSC.I18n.bind(stopBtn, 'stop');
    stopBtn.hidden = true;
    stopBtn.addEventListener('click', function () {
      /* 点击「停止」：中止当前生成 */
      if (handlers.onStop) handlers.onStop();
    });

    inputActions.appendChild(ctxInfoEl);
    inputActions.appendChild(sendBtn);
    inputActions.appendChild(stopBtn);

    inputbar.appendChild(inputRow);
    inputbar.appendChild(inputActions);

    mainPanel.appendChild(header);
    mainPanel.appendChild(messagesEl);
    mainPanel.appendChild(inputbar);

    mainView.appendChild(sidebarEl);
    mainView.appendChild(mainPanel);
    container.appendChild(mainView);
  }

  /**
   * 构建模型管理弹窗：头部（标题 + 关闭）+ 模型列表 + 模型表单（添加/编辑）；
   * 点击遮罩空白处关闭；表单提交时回调 onEditModel（编辑）或 onAddModel（新增）。
   * @param {Element} container 挂载容器
   * @returns {void}
   */
  function buildModelModal(container) {
    modelModal = make('div', 'modal-overlay');
    modelModal.hidden = true;

    modelModalCard = make('div', 'modal-card');

    /* 弹窗头部 */
    var modalHeader = make('div', 'modal-header');
    modelFormTitle = make('h2');
    SSC.I18n.bind(modelFormTitle, 'modelManager');
    var closeBtn = make('button', 'modal-close', '×');
    closeBtn.type = 'button';
    SSC.I18n.bind(closeBtn, 'close', null, 'title');
    closeBtn.addEventListener('click', function () {
      /* 点击弹窗「×」关闭 */
      if (handlers.onCloseModelManager) handlers.onCloseModelManager();
    });
    modalHeader.appendChild(modelFormTitle);
    modalHeader.appendChild(closeBtn);
    modelModalCard.appendChild(modalHeader);

    /* 模型列表 */
    modelListEl = make('div', 'model-list');
    modelModalCard.appendChild(modelListEl);

    /* 模型表单（添加 / 编辑） */
    modelFormEl = make('div', 'model-form');
    modelFormEl.hidden = true;

    modelForm = make('form');
    managerModelFields = buildModelFields(modelForm);

    var formBtnRow = make('div', 'model-form-actions');
    var saveBtn = make('button', 'btn');
    saveBtn.type = 'submit';
    SSC.I18n.bind(saveBtn, 'save');
    var cancelBtn = make('button', 'btn btn-secondary');
    cancelBtn.type = 'button';
    SSC.I18n.bind(cancelBtn, 'cancel');
    cancelBtn.addEventListener('click', function () {
      /* 「取消」：返回模型列表 */
      if (handlers.onBackToModelList) handlers.onBackToModelList();
    });
    formBtnRow.appendChild(saveBtn);
    formBtnRow.appendChild(cancelBtn);
    modelForm.appendChild(formBtnRow);

    modelForm.addEventListener('submit', function (e) {
      /* 表单提交：endpoint/model 必填；编辑态回调 onEditModel，否则 onAddModel */
      e.preventDefault();
      var data = managerModelFields.readValues();
      if (!data.endpoint || !data.model) return;
      if (currentEditId && handlers.onEditModel) {
        handlers.onEditModel(currentEditId, data);
      } else if (handlers.onAddModel) {
        handlers.onAddModel(data);
      }
    });

    modelFormEl.appendChild(modelForm);
    modelModalCard.appendChild(modelFormEl);
    modelModal.appendChild(modelModalCard);

    /* 点击遮罩关闭 */
    modelModal.addEventListener('click', function (e) {
      /* 点击遮罩空白处（而非弹窗内容）关闭 */
      if (e.target === modelModal) {
        if (handlers.onCloseModelManager) handlers.onCloseModelManager();
      }
    });

    container.appendChild(modelModal);
  }

  /* 统一模型表单字段定义（设置页与模型管理表单共用，新增字段只需改这一处）。
     字段属性：key（表单值键）/ textKey（标签的 i18n 键）/ phKey（placeholder 的 i18n 键）/ type / required；
     可选 —— numeric（仅纯数字：input 事件实时剔除非数字字符，移动端数字键盘）、
     maxLen（数字位数上限）、fallback（字段缺失时回填的值，如上下文窗口缺省）、
     hint（function(value) → { key: string, args: Array<*>|null }：输入框下方提示文案的 i18n 键与参数，
     随输入与填充刷新） */
  var MODEL_FIELDS = [
    { key: 'label', textKey: 'fieldLabel', phKey: 'phLabel', type: 'text', required: false },
    { key: 'endpoint', textKey: 'fieldEndpoint', phKey: 'phEndpoint', type: 'text' },
    { key: 'model', textKey: 'fieldModel', phKey: 'phModel', type: 'text' },
    /* 上下文窗口大小：纯数字（token 数），留空按缺省 128K（131072）处理，为后续上下文窗口管理预留 */
    {
      key: 'contextWindow',
      textKey: 'fieldContextWindow',
      phKey: 'phContextWindow',
      type: 'text',
      required: false,
      numeric: true,
      maxLen: 9,
      fallback: '131072',
      hint: function (v) {
        var n = parseInt(v, 10);
        /* 未填有效正整数 → 提示缺省；否则显示对应 k 大小 */
        return (Number.isFinite(n) && n > 0) ? { key: 'ctxHintApprox', args: [formatK(n)] } : { key: 'ctxHintDefault' };
      }
    },
    { key: 'apiKey', textKey: 'fieldApiKey', phKey: 'phApiKey', type: 'password', required: false } /* 可留空：本地端点无 key */
  ];

  /**
   * 按字段 hint 函数的返回值（i18n 键 + 模板参数）重绑定提示行文案。
   * @param {Element} el .field-hint 提示行元素
   * @param {function(string): {key: string, args: Array<*>|null}} fn 字段的 hint 函数
   * @param {string} value 当前输入值
   * @returns {void}
   */
  function applyHint(el, fn, value) {
    var r = fn(value) || {};
    SSC.I18n.bind(el, r.key, r.args || null);
  }

  /**
   * 构建模型表单字段区（设置页与模型管理共用，字段定义见 MODEL_FIELDS）。
   * numeric 字段实时剔除非数字字符（仅纯数字）并限长；hint 字段在输入框下方渲染提示行并随输入刷新。
   * @param {HTMLFormElement} form 字段要追加到其上的 form 元素
   * @returns {{ inputs: Object<string, HTMLInputElement>, readValues: function(): object, fillValues: function(object|null): void }}
   *   inputs 按字段 key 索引；readValues 读取已 trim 的表单值；fillValues 按模型对象预填
   */
  function buildModelFields(form) {
    var inputs = {};
    var hintEls = []; /* { key, el, fn }：填充值后需同步刷新的提示行 */
    MODEL_FIELDS.forEach(function (f) {
      var field = make('label', 'field');
      var labelEl = make('span');
      SSC.I18n.bind(labelEl, f.textKey);
      field.appendChild(labelEl);
      var input = document.createElement('input');
      input.type = f.type;
      input.required = f.required !== false;
      input.autocomplete = 'off';
      if (f.phKey) SSC.I18n.bind(input, f.phKey, null, 'placeholder');
      if (f.numeric) {
        /* 纯数字：移动端数字键盘（inputmode）；pattern 仅作声明；位数上限防溢出 */
        input.setAttribute('inputmode', 'numeric');
        input.setAttribute('pattern', '[0-9]*');
        if (f.maxLen != null) input.maxLength = f.maxLen;
      }
      field.appendChild(input);
      var hint = null;
      if (typeof f.hint === 'function') {
        /* 提示行位于输入框下方 */
        hint = make('span', 'field-hint');
        applyHint(hint, f.hint, input.value);
        field.appendChild(hint);
        hintEls.push({ key: f.key, el: hint, fn: f.hint });
      }
      input.addEventListener('input', function () {
        if (f.numeric) {
          /* 仅保留数字（覆盖粘贴/自动填充场景） */
          var clean = input.value.replace(/[^0-9]/g, '');
          if (clean !== input.value) input.value = clean;
        }
        if (hint) applyHint(hint, f.hint, input.value); /* 同步更新输入框下方提示 */
      });
      form.appendChild(field);
      inputs[f.key] = input;
    });
    return {
      inputs: inputs,
      /**
       * 读取表单当前值（已 trim），key 与 MODEL_FIELDS 对齐。
       * @returns {object} { label, endpoint, model, contextWindow, apiKey }（均为 string；contextWindow 为纯数字串或空串）
       */
      readValues: function () {
        var data = {};
        MODEL_FIELDS.forEach(function (f) {
          data[f.key] = String(inputs[f.key].value || '').trim();
        });
        return data;
      },
      /**
       * 填充表单（新增传 null，编辑传模型对象）；字段缺失时用 fallback 预填（如上下文窗口缺省值），否则清空。
       * 填充后同步刷新各提示行文案。
       * @param {object|null} modelData 模型配置对象；null = 新增（清空或按 fallback 预填）
       */
      fillValues: function (modelData) {
        MODEL_FIELDS.forEach(function (f) {
          inputs[f.key].value = modelData && modelData[f.key] != null ? String(modelData[f.key])
            : (f.fallback != null ? f.fallback : '');
        });
        hintEls.forEach(function (h) { applyHint(h.el, h.fn, inputs[h.key].value); });
      }
    };
  }

  /**
   * 填充 token 用量小字区（助手消息与压缩记录共用）：
   * u 为 null 或三个字段均为 null 时清空并隐藏；否则有值字段按 输入/输出/缓存命中 顺序显示，缺失字段省略。
   * @param {Element} el .msg-usage 容器
   * @param {object|null} u { inputTokens: number|null 输入 token, outputTokens: number|null 输出 token, cachedTokens: number|null 缓存命中输入 token }
   * @returns {void}
   */
  function fillUsageEl(el, u) {
    var hasAny =
      u &&
      (u.inputTokens != null ||
        u.outputTokens != null ||
        u.cachedTokens != null);
    if (!hasAny) {
      el.innerHTML = '';
      el.hidden = true;
      return;
    }
    el.innerHTML = '';
    /* 按固定顺序拼接片段，缺失字段省略，段间用“·”分隔；各片段绑定 i18n 键（参数为已格式化的 token 数） */
    var parts = [];
    if (u.inputTokens != null) parts.push({ key: 'usageInput', args: [formatTokens(u.inputTokens)] });
    if (u.outputTokens != null) parts.push({ key: 'usageOutput', args: [formatTokens(u.outputTokens)] });
    if (u.cachedTokens != null) parts.push({ key: 'usageCached', args: [formatTokens(u.cachedTokens)] });
    parts.forEach(function (p, i) {
      if (i > 0) el.appendChild(make('span', 'msg-usage-sep', '·'));
      var item = make('span', 'msg-usage-item');
      SSC.I18n.bind(item, p.key, p.args);
      el.appendChild(item);
    });
    el.hidden = false;
  }

  /**
   * 把 token 数格式化为千分位字符串（气泡下方小字展示用），按当前语言对应的 locale 分组。
   * @param {number} n token 数
   * @returns {string} 如 "12,345"（非有限值返回 "0"）
   */
  function formatTokens(n) {
    var v = Number(n);
    return Number.isFinite(v) ? Math.round(v).toLocaleString(SSC.I18n.locale()) : '0';
  }

  /**
   * 把 token 数格式化为近似 k 大小（上下文窗口字段提示用）。
   * @param {number} n token 数
   * @returns {string} 如 "128K" / "976.6K"；非有限或非正值返回 ""
   */
  function formatK(n) {
    var v = Number(n);
    if (!Number.isFinite(v) || v <= 0) return '';
    var k = Math.round(v / 1024 * 10) / 10;
    return (k % 1 === 0) ? String(k) + 'K' : k.toFixed(1) + 'K';
  }

  /**
   * DOM 快捷创建：创建元素并可选设置 className 与文本内容。
   * @param {string} tag 标签名（如 'div'）
   * @param {string|null} cls CSS class（null 时跳过）
   * @param {string|null} text 文本内容（null 时跳过）
   * @returns {Element} 创建的元素
   */
  function make(tag, cls, text) {
    var el = document.createElement(tag);
    if (cls) el.className = cls;
    if (text != null) el.textContent = text;
    return el;
  }

  /**
   * 消息区滚动到底部。
   * @returns {void}
   */
  function scrollToBottom() {
    if (messagesEl) messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  SSC.UI = UI;
})();
