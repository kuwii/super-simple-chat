/*
 * markdown.js — 轻量级 Markdown 渲染器（零依赖、纯 DOM 构建）。
 *
 * 支持范围（助手正文渲染）：
 * - 加粗：`**x**` / `__x__`
 * - 斜体：`*x*` / `_x_`
 * - 删除线：`~~x~~`
 * - 标题：`#` ~ `######`（ATX 式，# 后须有空格；行尾闭合 # 序列会被剥除）
 * - 分割线：单行 ≥3 个 `-` / `*` / `_`（可含空格，如 `- - -`）
 * - 代码块：``` / ~~~ 围栏（不做高亮；块内内容按原文显示、不解析 Markdown；
 *   流式中未闭合的围栏同样按代码块渲染）
 * - 行内代码：`x`（内容按原文显示；支持单/双反引号定界，可内嵌单个反引号）
 * - 引用块：`>` 前缀（块内可再解析段落 / 列表 / 表格 / 标题 / 分割线 / 代码块 / 嵌套引用）
 * - 无序 / 有序列表（含缩进嵌套、有序列表起始号）
 * - GFM 管道表格（含 `:---` / `:--:` / `---:` 对齐）
 *
 * 明确不做：
 * - 不解析 / 不渲染自定义 HTML（全部输出用 DOM API 构建，天然避免 XSS）
 * - 不解析链接、图片、Setext 式标题（下划线 / 等号线式）等；
 *   这些语法会按字面文本原样显示
 * - 引用块只接受 `>` 开头的行（不支持惰性续行），块内空行不会结束引用块
 * - 下划线 `_` / `__` 的强调受词边界约束，避免误伤 snake_case
 * - 块级判定偏宽松：标题 / 分割线 / 代码围栏 / 引用 / 列表 / 表格行紧跟段落后也开新块
 *   （不严格遵循 CommonMark 的“不可打断段落”规则，贴合 LLM 输出习惯）
 *
 * 设计约束：
 * - 流式场景下每次调用传入“截至当前的完整正文”，本模块无状态，可任意重复调用
 *   （幂等：清空容器后重建）；调用方负责决定是否重渲染。
 * - 段落 / 列表项保留换行（pre-wrap），因此单换行仍显示为换行，贴合聊天体验。
 */
(function () {
  'use strict';

  window.SSC = window.SSC || {};

  var MD = {};

  /* 空白（仅空格 / 制表符；行内切分后不含换行）与词字符（含 CJK / 数字 / _）判定 */
  var RE_SPACE = /[ \t]/;
  var RE_WORD = /[\p{L}\p{N}_]/u;

  /* 行内强调标记定义：mark 越长越优先（同一位置 ** 先于 *）。
     boundary=true 表示开/闭两侧需满足词边界（仅 _ / __，防止 snake_case 误判）。 */
  var INLINE_MARKS = [
    { mark: '**', tag: 'strong', boundary: false },
    { mark: '__', tag: 'strong', boundary: true },
    { mark: '~~', tag: 'del', boundary: false },
    { mark: '*', tag: 'em', boundary: false },
    { mark: '_', tag: 'em', boundary: true }
  ];

  /* 列表项匹配：(缩进)(标记)(内容)；有序标记支持 1. / 1) 两种写法。 */
  var RE_LIST_ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+([\s\S]*)$/;

  /* 分隔行单元格：可选的对齐冒号 + 至少一个短横线。 */
  var RE_TABLE_CELL_SEP = /^:?-+:?$/;

  /* 标题：至多 3 个前导空格 + 1~6 个 # + 至少一个空格/制表符 + 标题内容（可为空）。 */
  var RE_HEADING = /^ {0,3}(#{1,6})[ \t]+(.*)$/;

  /* 分割线：≥3 个同种 - / * / _（可含空格/制表符）。判定须先于列表：`- - -` 同时符合
     列表项格式，分割线优先。 */
  var RE_HR = /^ {0,3}([-*_])([ \t]*\1){2,}[ \t]*$/;

  /* 代码围栏起始行：≥3 个反引号或波浪号（至多 3 个前导空格），后跟可选信息串（语言名，v1 不使用）。 */
  var RE_FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})[ \t]*(.*)$/;

  /* 引用块行：至多 3 个前导空格 + `>`（`>` 后的单个空格由 renderBlockquote 剥除）。 */
  var RE_QUOTE = /^ {0,3}>/;

  /* ---------- 对外接口 ---------- */

  /**
   * 将 Markdown 文本渲染进容器元素（先清空容器再重建，幂等）。
   * 流式场景下每次传入“截至当前的完整正文”即可安全重渲染。
   * @param {Element} container 目标容器（助手正文 .content）
   * @param {string} text 完整 Markdown 文本
   * @param {boolean} streaming true = 流式中，在内容末尾追加一个闪烁光标 ▍
   * @returns {void}
   */
  MD.renderInto = function (container, text, streaming) {
    if (!container) return;
    container.innerHTML = '';
    if (!text) return;

    var lines = String(text).split(/\r\n|\r|\n/);
    var lastBlock = renderBlocks(container, lines);
    if (streaming && lastBlock) appendCursor(lastBlock);
  };

  /* ---------- 块级解析 ---------- */

  /**
   * 块级解析主循环：跳过空行，按 代码围栏 / 标题 / 分割线 / 表格 / 列表 / 引用块 / 段落
   * 的优先级识别块并追加到 parent。判定顺序即优先级：如 `- - -` 先于列表命中分割线，
   * 代码围栏最先判定以整体跳过围栏内容（块内行不再参与块级判定）。
   * @param {Element} parent 块级容器
   * @param {Array<string>} lines 已按行切分的文本
   * @returns {Element|null} 最后一个渲染出的块级元素（供流式光标定位）；无块时返回 null
   */
  function renderBlocks(parent, lines) {
    var lastBlock = null;
    var i = 0;
    while (i < lines.length) {
      var line = lines[i];
      if (isBlank(line)) { i++; continue; }
      if (isFenceOpen(line)) {
        var cb = renderCodeBlock(parent, lines, i);
        lastBlock = cb.el;
        i = cb.end;
      } else if (isHeading(line)) {
        lastBlock = renderHeading(parent, line);
        i++;
      } else if (isHr(line)) {
        lastBlock = renderHr(parent);
        i++;
      } else if (isTableStart(lines, i)) {
        lastBlock = renderTable(parent, lines, i);
        i = tableEndIndex(lines, i);
      } else if (isListLine(line)) {
        var r = renderList(parent, lines, i);
        lastBlock = r.root;
        i = r.end;
      } else if (isQuoteLine(line)) {
        var qEnd = quoteEndIndex(lines, i);
        lastBlock = renderBlockquote(parent, lines, i, qEnd);
        i = qEnd;
      } else {
        lastBlock = renderParagraph(parent, lines, i);
        i = paragraphEndIndex(lines, i);
      }
    }
    return lastBlock;
  }

  /**
   * 渲染一个段落：连续的“非空、非列表项、非表格起点”行，行间用 \n 文本节点分隔
   *（配合 pre-wrap 使单换行显示为换行）。
   * @param {Element} parent 块级容器
   * @param {Array<string>} lines 全部行
   * @param {number} start 段落起始行下标
   * @returns {HTMLParagraphElement} 段落元素
   */
  function renderParagraph(parent, lines, start) {
    var p = document.createElement('p');
    p.className = 'md-p';
    var end = paragraphEndIndex(lines, start);
    /* 逐行行内渲染；行间插入换行文本节点 */
    for (var i = start; i < end; i++) {
      if (i > start) p.appendChild(document.createTextNode('\n'));
      renderInline(p, lines[i]);
    }
    parent.appendChild(p);
    return p;
  }

  /**
   * 计算段落结束行下标（不含该行）：连续的“非空且不命中其它块级起点”行都属于该段落。
   * @param {Array<string>} lines 全部行
   * @param {number} start 段落起始行下标
   * @returns {number} 段落之后的第一行下标
   */
  function paragraphEndIndex(lines, start) {
    var i = start;
    while (i < lines.length) {
      var line = lines[i];
      if (isBlank(line) || isFenceOpen(line) || isHeading(line) || isHr(line) ||
          isQuoteLine(line) || isListLine(line) || isTableStart(lines, i)) break;
      i++;
    }
    return i;
  }

  /* ---------- 标题 / 分割线 / 代码块 / 引用块 ---------- */

  /**
   * 判断某行是否为 ATX 标题（1~6 个 # + 至少一个空格/制表符）。
   * @param {string} line 行文本
   * @returns {boolean}
   */
  function isHeading(line) {
    return RE_HEADING.test(line);
  }

  /**
   * 渲染一个标题（h1~h6）并追加到 parent。标题做行内渲染（支持强调 / 行内代码）；
   * 行尾的闭合 # 序列（如 `# 标题 #`，# 前须有空格）先剥除，避免误伤 C# 之类词尾。
   * @param {Element} parent 块级容器
   * @param {string} line 标题行文本
   * @returns {HTMLElement} 标题元素（h1~h6）
   */
  function renderHeading(parent, line) {
    var m = line.match(RE_HEADING);
    var el = document.createElement('h' + m[1].length);
    el.className = 'md-h md-h' + m[1].length;
    renderInline(el, m[2].replace(/[ \t]+#+[ \t]*$/, '').trim());
    parent.appendChild(el);
    return el;
  }

  /**
   * 判断某行是否为水平分割线（≥3 个同种 - / * / _，可含空格）。
   * @param {string} line 行文本
   * @returns {boolean}
   */
  function isHr(line) {
    return RE_HR.test(line);
  }

  /**
   * 渲染一条水平分割线并追加到 parent。
   * @param {Element} parent 块级容器
   * @returns {HTMLHRElement} hr 元素
   */
  function renderHr(parent) {
    var hr = document.createElement('hr');
    hr.className = 'md-hr';
    parent.appendChild(hr);
    return hr;
  }

  /**
   * 判断某行是否为代码围栏起始行（≥3 个反引号或波浪号，后跟可选语言名）。
   * @param {string} line 行文本
   * @returns {boolean}
   */
  function isFenceOpen(line) {
    return RE_FENCE_OPEN.test(line);
  }

  /**
   * 渲染一个围栏代码块并追加到 parent：内容行以 \n 连接后整体作为 <code> 的
   * 文本节点写入，不做任何 Markdown 解析（块内加粗 / 换行等一律按原文显示）。
   * 从下一行起扫描结束围栏（同字符、长度 ≥ 起始围栏、行余部仅空白）；
   * 找不到（如流式中围栏尚未闭合）时以文本末尾为块尾。
   * @param {Element} parent 块级容器
   * @param {Array<string>} lines 全部行
   * @param {number} start 起始围栏行下标
   * @returns {{el: HTMLPreElement, end: number}} pre 元素与块之后的第一行下标（已跳过结束围栏；未闭合时为 lines.length）
   */
  function renderCodeBlock(parent, lines, start) {
    var fence = lines[start].match(RE_FENCE_OPEN)[1];
    var ch = fence.charAt(0);
    var closeRe = new RegExp('^ {0,3}' + ch + '{' + fence.length + ',}[ \\t]*$');
    var end = lines.length;
    for (var j = start + 1; j < lines.length; j++) {
      if (closeRe.test(lines[j])) { end = j; break; }
    }
    var pre = document.createElement('pre');
    pre.className = 'md-code';
    var code = document.createElement('code');
    code.textContent = lines.slice(start + 1, end).join('\n');
    pre.appendChild(code);
    parent.appendChild(pre);
    return { el: pre, end: end + 1 };
  }

  /**
   * 判断某行是否为引用块行（至多 3 个前导空格 + `>`）。
   * @param {string} line 行文本
   * @returns {boolean}
   */
  function isQuoteLine(line) {
    return RE_QUOTE.test(line);
  }

  /**
   * 计算引用块结束行下标（不含该行）：连续的引用行与空行都属于该引用块
   *（空行不结束引用；遇到第一个非空且不带 `>` 的行时结束；不支持惰性续行）。
   * @param {Array<string>} lines 全部行
   * @param {number} start 首个引用行下标
   * @returns {number} 引用块之后的第一行下标
   */
  function quoteEndIndex(lines, start) {
    var i = start;
    while (i < lines.length && (isQuoteLine(lines[i]) || isBlank(lines[i]))) i++;
    return i;
  }

  /**
   * 渲染一个引用块并追加到 parent：逐行剥掉一层 `>` 前缀（含其后的单个空格），
   * 再对剥出的内层行递归做块级解析（段落 / 列表 / 表格 / 标题 / 分割线 /
   * 代码块 / 嵌套引用均可）。
   * @param {Element} parent 块级容器
   * @param {Array<string>} lines 全部行
   * @param {number} start 首个引用行下标
   * @param {number} end 引用块结束行下标（不含，由 quoteEndIndex 预先算出）
   * @returns {HTMLBlockquoteElement} 引用块元素
   */
  function renderBlockquote(parent, lines, start, end) {
    var inner = [];
    for (var i = start; i < end; i++) {
      inner.push(lines[i].replace(/^ {0,3}>[ \t]?/, ''));
    }
    var q = document.createElement('blockquote');
    q.className = 'md-quote';
    parent.appendChild(q);
    renderBlocks(q, inner);
    return q;
  }

  /* ---------- 表格（GFM 管道表） ---------- */

  /**
   * 判断 i 行是否为表格起点：i 行含 `|`，且 i+1 行为合法分隔行。
   * 要求分隔行至少含一个 `|`，以规避把普通 “---” 水平分割线误判成单列表格。
   * @param {Array<string>} lines 全部行
   * @param {number} i 待判定行下标
   * @returns {boolean}
   */
  function isTableStart(lines, i) {
    var header = lines[i];
    if (header.indexOf('|') === -1) return false;
    var next = lines[i + 1];
    return !!next && isTableSeparator(next);
  }

  /**
   * 判断某行是否为 GFM 表格分隔行：至少一个 `|`，且切分出的每个非空单元格都形如 `:?-+:?`。
   * @param {string} line 待判定行
   * @returns {boolean}
   */
  function isTableSeparator(line) {
    if (line.indexOf('|') === -1) return false;
    var cells = splitTableRow(line);
    if (!cells.length) return false;
    for (var i = 0; i < cells.length; i++) {
      if (!RE_TABLE_CELL_SEP.test(cells[i])) return false;
    }
    return true;
  }

  /**
   * 切分表格行为单元格数组：去掉成对的首尾 `|` 后按 `|` 切分并 trim 每个单元格。
   * 单元格内的转义管道 `\|` 不解析（v1 限制）。
   * @param {string} line 表格行
   * @returns {Array<string>} 单元格文本（已 trim）
   */
  function splitTableRow(line) {
    var s = line.trim();
    if (s.charAt(0) === '|') s = s.slice(1);
    var last = s.length - 1;
    if (last >= 0 && s.charAt(last) === '|') s = s.slice(0, last);
    var cells = [];
    s.split('|').forEach(function (c) {
      cells.push(c.trim());
    });
    return cells;
  }

  /**
   * 根据分隔行单元格文本推导该列对齐方式的 CSS 后缀。
   * @param {string} sep 分隔行单元格文本（如 `:---` / `:--:` / `---:` / `---`）
   * @returns {string} ''（左对齐，默认）| 'center' | 'right'
   */
  function alignSuffix(sep) {
    var left = sep.charAt(0) === ':';
    var right = sep.charAt(sep.length - 1) === ':';
    if (left && right) return 'center';
    if (right) return 'right';
    return '';
  }

  /**
   * 渲染一个表格并追加到 parent。列数取表头与所有数据行单元格数的最大值，
   * 不足补空单元格、超出截断，保证各行列数一致。
   * @param {Element} parent 块级容器
   * @param {Array<string>} lines 全部行
   * @param {number} start 表头行下标
   * @returns {HTMLDivElement} 表格包裹容器（.md-table-wrap，可横向滚动）
   */
  function renderTable(parent, lines, start) {
    var headerCells = splitTableRow(lines[start]);
    var sepCells = splitTableRow(lines[start + 1]);
    var aligns = [];
    for (var s = 0; s < sepCells.length; s++) aligns.push(alignSuffix(sepCells[s]));

    /* 收集数据行并确定列数（取最大列数，行末补空） */
    var end = tableEndIndex(lines, start);
    var rows = [];
    var cols = headerCells.length;
    for (var r = start + 2; r < end; r++) {
      var cells = splitTableRow(lines[r]);
      rows.push(cells);
      if (cells.length > cols) cols = cells.length;
    }
    for (var pad = aligns.length; pad < cols; pad++) aligns.push('');

    var wrap = document.createElement('div');
    wrap.className = 'md-table-wrap';
    var table = document.createElement('table');
    table.className = 'md-table';

    var thead = document.createElement('thead');
    var htr = document.createElement('tr');
    for (var c = 0; c < cols; c++) {
      var th = document.createElement('th');
      th.className = 'md-cell' + (aligns[c] ? ' md-cell--' + aligns[c] : '');
      renderInline(th, c < headerCells.length ? headerCells[c] : '');
      htr.appendChild(th);
    }
    thead.appendChild(htr);
    table.appendChild(thead);

    var tbody = document.createElement('tbody');
    for (var ri = 0; ri < rows.length; ri++) {
      var tr = document.createElement('tr');
      for (var ci = 0; ci < cols; ci++) {
        var td = document.createElement('td');
        td.className = 'md-cell' + (aligns[ci] ? ' md-cell--' + aligns[ci] : '');
        renderInline(td, rows[ri][ci] != null ? rows[ri][ci] : '');
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    wrap.appendChild(table);
    parent.appendChild(wrap);
    return wrap;
  }

  /**
   * 计算表格结束行下标（不含该行）：从表头起，连续含 `|` 的行都属于该表格。
   * @param {Array<string>} lines 全部行
   * @param {number} start 表头行下标
   * @returns {number} 表格之后的第一行下标
   */
  function tableEndIndex(lines, start) {
    var i = start + 2;
    while (i < lines.length && lines[i].indexOf('|') !== -1) i++;
    return i;
  }

  /* ---------- 列表 ---------- */

  /**
   * 判断某行是否为列表项（无序 - / * / + 或有序 数字+点/括号，后须跟至少一个空白）。
   * @param {string} line 待判定行
   * @returns {boolean}
   */
  function isListLine(line) {
    return RE_LIST_ITEM.test(line);
  }

  /**
   * 统计行首空白宽度（制表符按 2 计），用于层级判定。
   * @param {string} line 行文本
   * @returns {number} 行首空白宽度（单位：空格）
   */
  function leadingWidth(line) {
    var w = 0;
    for (var i = 0; i < line.length; i++) {
      var ch = line.charAt(i);
      if (ch === '\t') w += 2;
      else if (ch === ' ') w += 1;
      else break;
    }
    return w;
  }

  /**
   * 由缩进宽度计算列表层级（每 2 个空格为一级）。
   * @param {number} width 行首空白宽度
   * @returns {number} 层级（0 基）
   */
  function levelOf(width) {
    return Math.floor(width / 2);
  }

  /**
   * 渲染一个列表块（含嵌套）并追加到 parent。
   * 用“栈”维护各层级的 <ul>/<ol> 与最近一个 <li>：
   * 缩进更深则在其父 <li> 内新建子列表；缩进更浅则回到上层；同级追加新 <li>。
   * 非列表项且缩进更深于最近项的续行并入该项内容；空行或缩进不足的续行结束列表。
   * @param {Element} parent 块级容器
   * @param {Array<string>} lines 全部行
   * @param {number} start 首个列表项行下标
   * @returns {{root: HTMLUListElement|HTMLOListElement, end: number}} 根列表元素与结束行下标（不含）
   */
  function renderList(parent, lines, start) {
    var first = lines[start].match(RE_LIST_ITEM);
    var firstOrdered = /^\d/.test(first[2]);
    var root = document.createElement(firstOrdered ? 'ol' : 'ul');
    root.className = 'md-list';
    if (firstOrdered) root.start = parseInt(first[2], 10) || 1;
    parent.appendChild(root);

    /* 栈元素：{ level, listEl, lastLi, indent }，indent 为最近项的行首空白宽度 */
    var stack = [{
      level: levelOf(leadingWidth(first[1])),
      listEl: root,
      lastLi: null,
      indent: leadingWidth(first[1])
    }];

    var i = start;
    while (i < lines.length) {
      var line = lines[i];
      var m = line.match(RE_LIST_ITEM);
      if (m) {
        var indent = leadingWidth(m[1]);
        var level = levelOf(indent);
        var ordered = /^\d/.test(m[2]);
        var top = stack[stack.length - 1];

        /* 缩进更浅：回到上层（至少保留根层） */
        while (stack.length > 1 && level < top.level) {
          stack.pop();
          top = stack[stack.length - 1];
        }
        /* 缩进更深：逐层新建子列表并挂在父项内（层级跳跃时补空中间层） */
        while (level > top.level) {
          var sub = document.createElement(ordered ? 'ol' : 'ul');
          sub.className = 'md-list';
          if (ordered) sub.start = parseInt(m[2], 10) || 1;
          if (top.lastLi) top.lastLi.appendChild(sub);
          stack.push({ level: level, listEl: sub, lastLi: null, indent: indent });
          top = stack[stack.length - 1];
        }
        /* 同级：追加新 <li> 并做行内渲染 */
        var li = document.createElement('li');
        li.className = 'md-li';
        renderInline(li, m[3]);
        top.listEl.appendChild(li);
        top.lastLi = li;
        top.indent = indent;
      } else if (isBlank(line)) {
        break; /* 空行结束列表（v1：松散列表不支持跨空行） */
      } else {
        /* 续行：缩进更深于最近项 → 并入该项；否则列表结束（该行留给上层按新块处理） */
        var top2 = stack[stack.length - 1];
        if (top2.lastLi && leadingWidth(line) > top2.indent) {
          top2.lastLi.appendChild(document.createTextNode('\n'));
          renderInline(top2.lastLi, line.trim());
        } else {
          break;
        }
      }
      i++;
    }
    return { root: root, end: i };
  }

  /* ---------- 行内解析 ---------- */

  /**
   * 行内解析：从左到右扫描，每一步取“最早出现”的 行内代码 或 强调标记，
   * 先渲染其前缀文本，再渲染该记号，最后继续渲染剩余部分；两者都找不到时
   * 剩余部分整段按纯文本追加。
   * 行内代码内容作为纯文本写入（内部不再解析任何 Markdown）；
   * 强调标记内容递归做行内解析（支持内部再出现行内代码 / 其它强调）。
   * @param {Element} parent 目标元素
   * @param {string} text 行内文本
   * @returns {void}
   */
  function renderInline(parent, text) {
    var idx = 0;
    while (idx < text.length) {
      var code = findCodeSpan(text, idx);
      var em = findEmphasis(text, idx);
      /* 取位置更靠前者；反引号与强调定界符字符集互斥，同位置不会发生 */
      var isCode = code && (!em || code.index < em.index);
      if (!code && !em) {
        appendText(parent, text.slice(idx));
        break;
      }
      var markStart = isCode ? code.index : em.index;
      if (markStart > idx) appendText(parent, text.slice(idx, markStart));
      if (isCode) {
        var cEl = document.createElement('code');
        cEl.className = 'md-code-inline';
        cEl.textContent = code.content;
        parent.appendChild(cEl);
        idx = code.end;
      } else {
        var el = document.createElement(em.tag);
        renderInline(el, text.slice(em.index + em.mark.length, em.close));
        parent.appendChild(el);
        idx = em.close + em.mark.length;
      }
    }
  }

  /**
   * 从 from 起查找最早的行内代码：一段 N 个反引号（开定界符）之后，
   * 第一个恰好 N 个反引号的段（闭定界符），其间内容非空即为代码内容；
   * 中间长度不同（更短或更长）的反引号段不作为闭定界符（支持双反引号内嵌单反引号）。
   * 找不到匹配的闭定界符时返回 null（反引号按字面文本显示）。
   * @param {string} text 全文
   * @param {number} from 起始扫描下标
   * @returns {{index:number, end:number, content:string}|null}
   *   index=开定界符下标，end=闭定界符之后的第一下标（供游标推进），content=代码内容
   */
  function findCodeSpan(text, from) {
    var i = text.indexOf('`', from);
    while (i !== -1) {
      var openLen = 0;
      while (i + openLen < text.length && text.charAt(i + openLen) === '`') openLen++;
      var j = i + openLen;
      while (j < text.length) {
        var k = text.indexOf('`', j);
        if (k === -1) break;
        var closeLen = 0;
        while (k + closeLen < text.length && text.charAt(k + closeLen) === '`') closeLen++;
        if (closeLen === openLen && k > j) {
          return { index: i, end: k + openLen, content: text.slice(i + openLen, k) };
        }
        j = k + closeLen;
      }
      i = text.indexOf('`', i + 1);
    }
    return null;
  }

  /**
   * 在 from 及之后查找“最早、且能成功闭合”的强调标记：跨所有标记类型比较开标记位置，
   * 同位置时优先更长的标记（如 ** 先于 *）。对每个候选标记：
   * 开标记须满足（boundary 时）前为词边界、后非空白；闭标记取该开标记之后第一个
   * 满足条件者：内容非空、不以空白开头/结尾，且（boundary 时）后为词边界；
   * `*` 的闭标记后不能再跟 `*`（避免吃掉 ** 的起始）。
   * @param {string} text 全文
   * @param {number} from 起始扫描下标
   * @returns {{index:number, close:number, mark:string, tag:string}|null}
   *   index=开标记下标，close=闭标记下标；找不到返回 null
   */
  function findEmphasis(text, from) {
    var best = null;
    for (var p = 0; p < INLINE_MARKS.length; p++) {
      var mk = INLINE_MARKS[p];
      var mark = mk.mark;
      var i = text.indexOf(mark, from);
      while (i !== -1) {
        if (best && i >= best.index) break; /* 后续开标记不可能更早；同位置更长标记已优先 */
        var prevOk = !mk.boundary || i === 0 || !RE_WORD.test(text.charAt(i - 1));
        var afterOpen = text.charAt(i + mark.length);
        var openOk = afterOpen !== '' && !RE_SPACE.test(afterOpen);
        if (prevOk && openOk) {
          var c = text.indexOf(mark, i + mark.length);
          while (c !== -1) {
            var content = text.slice(i + mark.length, c);
            var bodyOk = content.length > 0 &&
              !RE_SPACE.test(content.charAt(0)) &&
              !RE_SPACE.test(content.charAt(content.length - 1));
            if (bodyOk) {
              var afterClose = text.charAt(c + mark.length);
              var closeOk = true;
              if (mk.boundary) closeOk = afterClose === '' || !RE_WORD.test(afterClose);
              else if (mark === '*' && afterClose === '*') closeOk = false; /* 避免吃掉 ** 的起始 */
              if (closeOk) {
                best = { index: i, close: c, mark: mark, tag: mk.tag };
                break; /* 该开标记下的最早有效闭标记 */
              }
            }
            c = text.indexOf(mark, c + 1);
          }
        }
        i = text.indexOf(mark, i + 1);
      }
    }
    return best;
  }

  /* ---------- 工具 ---------- */

  /**
   * 判断行是否为空行（仅含空白）。
   * @param {string} line 行文本
   * @returns {boolean}
   */
  function isBlank(line) {
    return line.trim() === '';
  }

  /**
   * 追加非空文本节点（空字符串跳过，避免产生无用的空节点）。
   * @param {Element} parent 目标元素
   * @param {string} text 文本
   * @returns {void}
   */
  function appendText(parent, text) {
    if (!text) return;
    parent.appendChild(document.createTextNode(text));
  }

  /**
   * 在块级元素末尾追加闪烁光标：沿 lastChild 链下沉到最深的叶子节点再 append，
   * 使光标紧贴最后一段可见内容（流式体验）。
   * hr 为无内容元素、无处安放光标；末块为分割线时跳过（下一块渲染后光标自然恢复）。
   * @param {Element} block 块级元素（段落 / 标题 / 列表 / 表格 / 代码块 / 引用块等）
   * @returns {void}
   */
  function appendCursor(block) {
    if (block.tagName === 'HR') return;
    var cur = block;
    while (cur.lastChild && cur.lastChild.nodeType === 1) cur = cur.lastChild;
    var cursor = document.createElement('span');
    cursor.className = 'md-cursor';
    cursor.textContent = '▍';
    cur.appendChild(cursor);
  }

  SSC.Markdown = MD;
})();
