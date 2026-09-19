/*
 * ui.js — UI 模块：渲染（设置页 / 主界面 / 模型管理 / 消息）+ 事件绑定。
 */
(function () {
  'use strict';

  window.SSC = window.SSC || {};

  var UI = {};

  var handlers = {
    onSave: null,
    onSend: null,
    onStop: null,
    onNewSession: null,
    onSwitchSession: null,
    onDeleteSession: null,
    onSelectModel: null,
    onManageModels: null,
    onToggleTheme: null,
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
  var modelSelect, manageModelsBtn, themeToggleBtn;
  var modelModal, modelModalCard;
  var modelListEl, modelFormEl, modelForm, modelFormTitle;
  var managerModelFields; /* 模型管理模型表单（buildModelFields 返回的字段容器） */
  var currentEditId = null;
  var sidebarEl, sessionListEl;
  var emptyStateEl;

  /* 主题图标 SVG（亮色显太阳、暗色显月亮，由 CSS 按 data-theme 切换显示） */
  var SVG_MOON = '<svg class="theme-icon theme-icon--moon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path></svg>';
  var SVG_SUN = '<svg class="theme-icon theme-icon--sun" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4"></circle><line x1="12" y1="2" x2="12" y2="5"></line><line x1="12" y1="19" x2="12" y2="22"></line><line x1="4.22" y1="4.22" x2="6.34" y2="6.34"></line><line x1="17.66" y1="17.66" x2="19.78" y2="19.78"></line><line x1="2" y1="12" x2="5" y2="12"></line><line x1="19" y1="12" x2="22" y2="12"></line><line x1="4.22" y1="19.78" x2="6.34" y2="17.66"></line><line x1="17.66" y1="6.34" x2="19.78" y2="4.22"></line></svg>';

  /* ---------- 初始化 ---------- */

  UI.init = function (container) {
    container.innerHTML = '';
    buildSettings(container);
    buildMain(container);
    buildModelModal(container);
    // 默认显示设置页；App 通过 showSettings / showMain 切换
    UI.showSettings();
  };

  UI.setHandlers = function (h) {
    for (var key in handlers) {
      if (h.hasOwnProperty(key) && h[key]) handlers[key] = h[key];
    }
  };

  /* ---------- 视图切换 ---------- */

  UI.showSettings = function () {
    if (settingsView) settingsView.hidden = false;
    if (mainView) mainView.hidden = true;
    if (settingsModelFields) settingsModelFields.inputs.endpoint.focus();
  };

  UI.showMain = function () {
    if (mainView) mainView.hidden = false;
    if (settingsView) settingsView.hidden = true;
    UI.focusInput();
  };

  UI.focusInput = function () {
    if (inputEl) inputEl.focus();
  };

  /* ---------- 模型选择器 ---------- */

  /**
   * 填充头部模型下拉框。
   * @param {Array} models - 模型配置数组
   * @param {string} activeId - 当前活动模型 id
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

  UI.openModelManager = function (models, activeId) {
    if (!modelModal) return;
    modelFormTitle.textContent = '模型管理';
    renderModelList(models, activeId);
    modelFormEl.hidden = true;
    modelModal.hidden = false;
  };

  UI.closeModelManager = function () {
    if (modelModal) modelModal.hidden = true;
  };

  /**
   * 显示模型表单（添加或编辑）。
   * @param {object|null} modelData - null 表示新增，对象表示编辑
   */
  UI.showModelForm = function (modelData) {
    var isEdit = !!modelData;
    currentEditId = isEdit ? modelData.id : null;
    modelFormTitle.textContent = isEdit ? '编辑模型' : '添加模型';
    managerModelFields.fillValues(isEdit ? modelData : null);
    modelListEl.hidden = true;
    modelFormEl.hidden = false;
    modelModal.hidden = false;
    managerModelFields.inputs.label.focus();
  };

  function renderModelList(models, activeId) {
    modelListEl.innerHTML = '';
    modelListEl.hidden = false;

    models.forEach(function (m) {
      var isActive = m.id === activeId;
      var item = make('div', 'model-item' + (isActive ? ' active' : ''));

      var nameRow = make('div', 'model-item-name');
      nameRow.appendChild(make('span', 'model-dot' + (isActive ? ' active' : ''), ''));
      nameRow.appendChild(make('span', null, m.label || m.model));
      item.appendChild(nameRow);

      item.appendChild(make('div', 'model-item-detail', m.endpoint + '  /  ' + m.model));

      var btnRow = make('div', 'model-item-actions');
      var editBtn = make('button', 'btn btn-secondary btn-sm', '编辑');
      editBtn.type = 'button';
      editBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        if (handlers.onShowEditForm) handlers.onShowEditForm(m.id);
      });
      var delBtn = make('button', 'btn btn-secondary btn-sm btn-danger', '删除');
      delBtn.type = 'button';
      delBtn.addEventListener('click', function (e) {
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

    var addBtn = make('button', 'btn btn-sm model-add-btn', '+ 添加模型');
    addBtn.type = 'button';
    addBtn.addEventListener('click', function () {
      if (handlers.onShowAddForm) handlers.onShowAddForm();
    });
    modelListEl.appendChild(addBtn);
  }

  /* ---------- 会话列表 ---------- */

  /**
   * 渲染会话列表。
   * @param {Array} sessions - 会话数组（含 id, title）
   * @param {string} activeId - 当前活动会话 id
   */
  UI.setSessions = function (sessions, activeId) {
    if (!sessionListEl) return;
    sessionListEl.innerHTML = '';
    sessions.forEach(function (s) {
      var item = make('div', 'session-item' + (s.id === activeId ? ' active' : ''));
      var title = make('span', 'session-title', s.title || '新会话');
      var del = make('button', 'session-del', '×');
      del.type = 'button';
      del.title = '删除会话';
      del.addEventListener('click', function (e) {
        e.stopPropagation();
        if (handlers.onDeleteSession) handlers.onDeleteSession(s.id);
      });
      item.appendChild(title);
      item.appendChild(del);
      item.addEventListener('click', function () {
        if (s.id !== activeId && handlers.onSwitchSession) {
          handlers.onSwitchSession(s.id);
        }
      });
      sessionListEl.appendChild(item);
    });
  };

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
   * 正文气泡在正文开始输出时才渲染。
   * @returns {{ update: function, thinkUpdate: function, thinkDone: function, finalize: function }} 句柄
   */
  UI.addMessage = function (role, text) {
    if (emptyStateEl) emptyStateEl.hidden = true;
    var msg = make('div', 'msg ' + role);

    var roleEl = make('div', 'role', role === 'user' ? '你' : '助手');

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
      thinkToggle.title = '展开/收起思考过程';

      var thinkText = make('span', 'think-text', '思考中');
      thinkCaret = make('span', 'think-caret', '▸');
      thinkToggle.appendChild(thinkText);
      thinkToggle.appendChild(thinkCaret);

      thinkBody = make('div', 'think-body');
      thinkBody.hidden = true;

      thinkToggle.addEventListener('click', function () {
        setThinkExpanded(thinkBody.hidden); /* 收起→展开，展开→收起 */
      });

      think.appendChild(thinkToggle);
      think.appendChild(thinkBody);
    }

    var bubble = make('div', 'bubble');
    var content = make('div', 'content');
    if (text != null) content.textContent = text;

    var error = make('div', 'error');
    error.hidden = true;

    bubble.appendChild(content);
    bubble.appendChild(error);
    /* 流式消息（text == null）的气泡延迟到正文开始输出时才显示 */
    if (text == null) bubble.hidden = true;

    msg.appendChild(roleEl);
    if (think) msg.appendChild(think);
    msg.appendChild(bubble);
    messagesEl.appendChild(msg);
    scrollToBottom();

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

    /* 思考结束（正文开始 / 定稿时调用）：停止动画，若已展开则自动收起 */
    function thinkDone() {
      if (!thinkingShown || !thinkingActive) return;
      thinkingActive = false;
      think.classList.remove('active');
      if (!thinkBody.hidden) setThinkExpanded(false);
    }

    return {
      /** 思考增量更新（t 为截至当前的完整思考文本） */
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
      /** 思考结束 */
      thinkDone: thinkDone,
      /** 正文流式增量更新 */
      update: function (t) {
        thinkDone();
        if (bubble.hidden) bubble.hidden = false;
        content.textContent = t;
        content.classList.add('streaming');
        scrollToBottom();
      },
      /** 定稿（errText 为 null 表示无错误；stopped 表示用户点击了停止；muted 弱化提示文案样式） */
      finalize: function (t, errText, stopped, muted) {
        thinkDone();
        content.classList.remove('streaming');
        if (t) {
          content.textContent = t;
        } else if (!errText) {
          content.textContent = stopped ? '（已停止生成，未收到内容）' : '（未收到内容）';
          content.classList.add('placeholder');
        }
        if (bubble.hidden) bubble.hidden = false; /* 仅收到思考即停止/出错时也显示占位/错误 */
        if (errText) {
          error.textContent = errText;
          error.hidden = false;
          if (muted) error.classList.add('muted');
        }
        scrollToBottom();
      }
    };
  };

  /* ---------- 输入 ---------- */

  UI.getInputText = function () {
    return inputEl ? inputEl.value.trim() : '';
  };

  UI.clearInput = function () {
    if (inputEl) inputEl.value = '';
  };

  /** on = true：生成中（发送禁用、显示停止） */
  UI.setStreaming = function (on) {
    if (sendBtn) sendBtn.disabled = !!on;
    if (stopBtn) stopBtn.hidden = !on;
  };

  /* ---------- 警告横幅 ---------- */

  var warningEl = null;

  /** 顶部警告条（可关闭）；用于本地存储不可用等异常场景 */
  UI.showWarning = function (text) {
    if (!text) return;
    if (!warningEl) {
      warningEl = document.createElement('div');
      warningEl.className = 'warning-banner';
      var close = make('button', 'warning-close', '×');
      close.type = 'button';
      close.title = '关闭';
      close.addEventListener('click', function () {
        if (warningEl && warningEl.parentNode) warningEl.parentNode.removeChild(warningEl);
        warningEl = null;
      });
      warningEl.appendChild(close);
      warningEl.appendChild(make('span', null, ''));
      document.body.appendChild(warningEl);
    }
    warningEl.lastChild.textContent = text;
  };

  /* ---------- DOM 构建 ---------- */

  /** 创建主题切换按钮（图标显示当前模式，随 data-theme 由 CSS 切换）；extraClass 可选附加类 */
  function makeThemeToggle(extraClass) {
    var btn = make('button', extraClass ? 'theme-toggle ' + extraClass : 'theme-toggle');
    btn.type = 'button';
    btn.title = '切换亮色 / 暗色模式';
    btn.setAttribute('aria-label', '切换亮色 / 暗色模式');
    btn.innerHTML = SVG_MOON + SVG_SUN;
    btn.addEventListener('click', function () {
      if (handlers.onToggleTheme) handlers.onToggleTheme();
    });
    return btn;
  }

  function buildSettings(container) {
    settingsView = make('div', 'view settings');

    /* 主题切换（设置页右上角；首次打开尚未配置模型时的唯一入口） */
    settingsView.appendChild(makeThemeToggle('theme-toggle--floating'));

    var card = make('div', 'settings-card');
    card.appendChild(make('h1', null, 'Super Simple Chat'));
    card.appendChild(make('p', 'settings-hint', '填写你的 LLM API 设置（OpenAI 兼容格式）。数据仅保存在本浏览器中。'));

    var form = make('form');
    settingsModelFields = buildModelFields(form);

    var submit = make('button', 'btn', '保存并开始');
    submit.type = 'submit';
    form.appendChild(submit);

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      if (handlers.onSave) handlers.onSave(settingsModelFields.readValues());
    });

    card.appendChild(form);
    settingsView.appendChild(card);
    container.appendChild(settingsView);
  }

  function buildMain(container) {
    mainView = make('div', 'view main');
    mainView.hidden = true;

    /* 侧边栏 */
    sidebarEl = make('div', 'sidebar');
    var newBtn = make('button', 'btn sidebar-new-btn', '+ 新建会话');
    newBtn.type = 'button';
    newBtn.addEventListener('click', function () {
      if (handlers.onNewSession) handlers.onNewSession();
    });
    sidebarEl.appendChild(newBtn);
    sessionListEl = make('div', 'session-list');
    sidebarEl.appendChild(sessionListEl);

    /* 主面板 */
    var mainPanel = make('div', 'main-panel');

    var header = make('div', 'main-header');
    header.appendChild(make('span', 'app-title', 'Super Simple Chat'));

    modelSelect = document.createElement('select');
    modelSelect.className = 'model-select';
    modelSelect.title = '切换模型';
    modelSelect.addEventListener('change', function () {
      if (handlers.onSelectModel) handlers.onSelectModel(modelSelect.value);
    });
    header.appendChild(modelSelect);

    manageModelsBtn = make('button', 'btn btn-secondary btn-sm', '管理模型');
    manageModelsBtn.type = 'button';
    manageModelsBtn.addEventListener('click', function () {
      if (handlers.onManageModels) handlers.onManageModels();
    });
    header.appendChild(manageModelsBtn);

    /* 主题切换（顶栏最右；图标显示当前模式，由 CSS 按 data-theme 切换） */
    themeToggleBtn = makeThemeToggle();
    header.appendChild(themeToggleBtn);

    messagesEl = make('div', 'messages');

    emptyStateEl = make('div', 'empty-state');
    emptyStateEl.appendChild(make('div', 'empty-text', '开始新的对话'));
    emptyStateEl.appendChild(make('div', 'empty-sub', '输入消息，按 Enter 发送'));
    messagesEl.appendChild(emptyStateEl);

    var inputbar = make('div', 'inputbar');
    inputEl = document.createElement('textarea');
    inputEl.rows = 2;
    inputEl.placeholder = '输入消息，Enter 发送，Shift+Enter 换行';
    inputEl.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        if (handlers.onSend) handlers.onSend();
      }
    });

    sendBtn = make('button', 'btn', '发送');
    sendBtn.type = 'button';
    sendBtn.addEventListener('click', function () {
      if (handlers.onSend) handlers.onSend();
    });

    stopBtn = make('button', 'btn btn-secondary', '停止');
    stopBtn.type = 'button';
    stopBtn.hidden = true;
    stopBtn.addEventListener('click', function () {
      if (handlers.onStop) handlers.onStop();
    });

    inputbar.appendChild(inputEl);
    inputbar.appendChild(sendBtn);
    inputbar.appendChild(stopBtn);

    mainPanel.appendChild(header);
    mainPanel.appendChild(messagesEl);
    mainPanel.appendChild(inputbar);

    mainView.appendChild(sidebarEl);
    mainView.appendChild(mainPanel);
    container.appendChild(mainView);
  }

  function buildModelModal(container) {
    modelModal = make('div', 'modal-overlay');
    modelModal.hidden = true;

    modelModalCard = make('div', 'modal-card');

    /* 弹窗头部 */
    var modalHeader = make('div', 'modal-header');
    modelFormTitle = make('h2', null, '模型管理');
    var closeBtn = make('button', 'modal-close', '×');
    closeBtn.type = 'button';
    closeBtn.title = '关闭';
    closeBtn.addEventListener('click', function () {
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
    var saveBtn = make('button', 'btn', '保存');
    saveBtn.type = 'submit';
    var cancelBtn = make('button', 'btn btn-secondary', '取消');
    cancelBtn.type = 'button';
    cancelBtn.addEventListener('click', function () {
      if (handlers.onBackToModelList) handlers.onBackToModelList();
    });
    formBtnRow.appendChild(saveBtn);
    formBtnRow.appendChild(cancelBtn);
    modelForm.appendChild(formBtnRow);

    modelForm.addEventListener('submit', function (e) {
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
      if (e.target === modelModal) {
        if (handlers.onCloseModelManager) handlers.onCloseModelManager();
      }
    });

    container.appendChild(modelModal);
  }

  /* 统一模型表单字段定义（设置页与模型管理表单共用，新增字段只需改这一处） */
  var MODEL_FIELDS = [
    { key: 'label', text: '标签（显示名称）', type: 'text', placeholder: '如：Qwen3.6', required: false },
    { key: 'endpoint', text: 'API Endpoint', type: 'text', placeholder: 'http://127.0.0.1:8000' },
    { key: 'model', text: '模型名称', type: 'text', placeholder: '如：Qwen3.6-35B-A3B' },
    { key: 'apiKey', text: 'API Key', type: 'password', placeholder: '可留空' }
  ];

  /**
   * 构建模型表单字段区（设置页与模型管理共用）。
   * @param {Element} form - 字段要追加到其上的 form 元素
   * @returns {{ inputs: Object, readValues: function, fillValues: function }}
   */
  function buildModelFields(form) {
    var inputs = {};
    MODEL_FIELDS.forEach(function (f) {
      var field = make('label', 'field');
      field.appendChild(make('span', null, f.text));
      var input = document.createElement('input');
      input.type = f.type;
      input.required = f.required !== false;
      input.autocomplete = 'off';
      if (f.placeholder) input.placeholder = f.placeholder;
      field.appendChild(input);
      form.appendChild(field);
      inputs[f.key] = input;
    });
    return {
      inputs: inputs,
      /** 读取表单当前值（已 trim），key 与 MODEL_FIELDS 对齐 */
      readValues: function () {
        var data = {};
        MODEL_FIELDS.forEach(function (f) {
          data[f.key] = String(inputs[f.key].value || '').trim();
        });
        return data;
      },
      /** 填充表单（新增传 null，编辑传模型对象） */
      fillValues: function (modelData) {
        MODEL_FIELDS.forEach(function (f) {
          inputs[f.key].value = modelData && modelData[f.key] != null ? String(modelData[f.key]) : '';
        });
      }
    };
  }

  function make(tag, cls, text) {
    var el = document.createElement(tag);
    if (cls) el.className = cls;
    if (text != null) el.textContent = text;
    return el;
  }

  function scrollToBottom() {
    if (messagesEl) messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  SSC.UI = UI;
})();
