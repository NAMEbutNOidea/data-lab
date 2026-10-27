/* =============================================================
 * DataLab 前端 · 01-base.js
 * 常量 / 状态 / 通用工具 / 后端状态窗 / API / 列信息
 * 源区间：原 app.js 第 8–605 行（按分节切分，未改动任何函数体）
 * 加载顺序由 index.html 决定：必须先加载它前面的脚本，不能单独引用。
 * ============================================================= */
(function (G) {
  'use strict';

  /* ------------------------------------------------------------
   * 一、常量
   * ---------------------------------------------------------- */

  // 14 种图表类型（kind 与 contract 第 6 节一致）
  var KINDS = [
    { id: 'line', name: '折线', needX: true },
    { id: 'scatter', name: '散点', needX: true },
    { id: 'line_marker', name: '点线', needX: true },
    { id: 'errorbar', name: '误差棒', needX: true },
    { id: 'bar', name: '柱状', needX: true },
    { id: 'bar_grouped', name: '分组柱', needX: true },
    { id: 'bar_stacked', name: '堆叠柱', needX: true },
    { id: 'hist', name: '直方图', needX: false },
    { id: 'box', name: '箱线图', needX: false },
    { id: 'violin', name: '小提琴', needX: false },
    { id: 'residual', name: '残差图', needX: true, needFit: true },
    { id: 'qq', name: 'Q-Q 图', needX: false },
    { id: 'heatmap', name: '热力图', needX: true },
    { id: 'pie', name: '饼图', needX: true }
  ];

  // 类型按钮的极简线性图标（viewBox 0 0 20 20）
  var KIND_ICONS = {
    line: '<path d="M2 15 L7 8 L12 12 L18 4"/>',
    scatter: '<circle cx="4.5" cy="13" r="1.7" fill="currentColor" stroke="none"/><circle cx="9.5" cy="8" r="1.7" fill="currentColor" stroke="none"/><circle cx="14.5" cy="5" r="1.7" fill="currentColor" stroke="none"/><circle cx="17" cy="14" r="1.7" fill="currentColor" stroke="none"/>',
    line_marker: '<path d="M2 15 L8 7 L13 12 L18 4"/><circle cx="8" cy="7" r="1.5" fill="currentColor" stroke="none"/><circle cx="13" cy="12" r="1.5" fill="currentColor" stroke="none"/>',
    errorbar: '<path d="M10 3 v14 M6.5 5 h7 M6.5 15 h7"/><circle cx="10" cy="10" r="1.6" fill="currentColor" stroke="none"/>',
    bar: '<rect x="3" y="10" width="3.4" height="7"/><rect x="8.3" y="6" width="3.4" height="11"/><rect x="13.6" y="12" width="3.4" height="5"/>',
    bar_grouped: '<rect x="2.5" y="9" width="2.2" height="8"/><rect x="5.2" y="6" width="2.2" height="11"/><rect x="8.4" y="11" width="2.2" height="6"/><rect x="11.1" y="7" width="2.2" height="10"/><rect x="14.3" y="12" width="2.2" height="5"/><rect x="17" y="9" width="2.2" height="8"/>',
    bar_stacked: '<rect x="4" y="10" width="4" height="7"/><rect x="4" y="5" width="4" height="4.5"/><rect x="12" y="12" width="4" height="5"/><rect x="12" y="4" width="4" height="7.5"/>',
    hist: '<rect x="2.5" y="12" width="3" height="5"/><rect x="5.9" y="8" width="3" height="9"/><rect x="9.3" y="4" width="3" height="13"/><rect x="12.7" y="9" width="3" height="8"/><rect x="16.1" y="13" width="2.4" height="4"/>',
    box: '<rect x="6" y="7" width="8" height="7"/><path d="M10 3 v4 M10 14 v3 M6.5 3 h7 M6.5 17 h7"/>',
    violin: '<path d="M10 2 C6.5 5.5 6.5 14.5 10 18 C13.5 14.5 13.5 5.5 10 2 Z"/><path d="M10 2 v16" opacity=".45"/>',
    residual: '<path d="M2 10 h16" opacity=".45"/><circle cx="5" cy="6" r="1.5" fill="currentColor" stroke="none"/><circle cx="10" cy="13.5" r="1.5" fill="currentColor" stroke="none"/><circle cx="15" cy="6.8" r="1.5" fill="currentColor" stroke="none"/>',
    qq: '<path d="M3 17 L17 3"/><circle cx="6" cy="14" r="1.4" fill="currentColor" stroke="none"/><circle cx="10" cy="10" r="1.4" fill="currentColor" stroke="none"/><circle cx="14" cy="6" r="1.4" fill="currentColor" stroke="none"/>',
    heatmap: '<rect x="3" y="3" width="4.4" height="4.4"/><rect x="7.8" y="3" width="4.4" height="4.4" opacity=".55"/><rect x="12.6" y="3" width="4.4" height="4.4" opacity=".28"/><rect x="3" y="7.8" width="4.4" height="4.4" opacity=".55"/><rect x="7.8" y="7.8" width="4.4" height="4.4" fill="currentColor" stroke="none"/><rect x="12.6" y="7.8" width="4.4" height="4.4" opacity=".4"/><rect x="3" y="12.6" width="4.4" height="4.4" opacity=".28"/><rect x="7.8" y="12.6" width="4.4" height="4.4" opacity=".4"/><rect x="12.6" y="12.6" width="4.4" height="4.4" opacity=".2"/>',
    pie: '<circle cx="10" cy="10" r="7"/><path d="M10 10 V3 A7 7 0 0 1 17 10 Z" fill="currentColor" opacity=".35"/>',
    // 三维图型由后端下发 IDs，这里预先备好图标，按钮才不会空着一个方框
    scatter3d: '<path d="M3 15 L10 17 L17 15 M10 17 L10 9 M10 9 L10 3" opacity=".4"/><path d="M10 9 L17 7 M10 9 L4 6"/><circle cx="17" cy="7" r="1.4" fill="currentColor" stroke="none"/><circle cx="4" cy="6" r="1.4" fill="currentColor" stroke="none"/><circle cx="10" cy="3" r="1.4" fill="currentColor" stroke="none"/><circle cx="10" cy="9" r="1.7" fill="currentColor" stroke="none"/>',
    line3d: '<path d="M3 15 L10 17 L17 15 M10 17 L10 9 M10 9 L10 3" opacity=".4"/><path d="M4 13 L8 7 L13 10 L17 5"/><circle cx="8" cy="7" r="1.3" fill="currentColor" stroke="none"/><circle cx="13" cy="10" r="1.3" fill="currentColor" stroke="none"/>',
    surface3d: '<path d="M3 15 L10 17 L17 15 M10 17 L10 9 M10 9 L10 3" opacity=".4"/><path d="M3 13 L8 10 L13 11 L18 8"/><path d="M3 16 L8 13 L13 14 L18 11"/><path d="M3 13 L3 16 M8 10 L8 13 M13 11 L13 14 M18 8 L18 11" opacity=".55"/>',
    bar3d: '<path d="M3 15 L10 17 L17 15 M10 17 L10 9 M10 9 L10 3" opacity=".4"/><path d="M5 14 L5 9 L8 8 L8 13 Z"/><path d="M10 16 L10 11 L13 10 L13 15 Z" opacity=".7"/><path d="M14 15 L14 7.5 L17 6.5 L17 14 Z" opacity=".45"/>'
  };

  var MODEL_ORDER = ['linear', 'poly', 'exp', 'exp_offset', 'power', 'log', 'gaussian', 'lorentz', 'sine'];

  var FALLBACK_MODELS = {
    linear: { name: '线性' },
    poly: { name: '多项式' },
    exp: { name: '指数' },
    exp_offset: { name: '带偏移指数' },
    power: { name: '幂函数' },
    log: { name: '对数' },
    gaussian: { name: '高斯' },
    lorentz: { name: '洛伦兹' },
    sine: { name: '正弦' }
  };

  var THEME_ORDER = ['paper_nature', 'paper_aps', 'ieee', 'modern_light', 'dark', 'minimal', 'notebook', 'poster'];

  var FALLBACK_THEMES = {
    paper_nature: { name: 'Nature 论文', description: '双栏期刊，细线内向刻度' },
    paper_aps: { name: 'APS 物理', description: '物理期刊单栏，紧凑布局' },
    ieee: { name: 'IEEE 单栏', description: '工程期刊，无衬线字体' },
    modern_light: { name: '现代浅色', description: '简洁明亮，适合幻灯片' },
    dark: { name: '深色演示', description: '深底浅字，投影清晰' },
    minimal: { name: '极简', description: '去边框留白，突出数据' },
    notebook: { name: '笔记本', description: '网格底纹，适合记录' },
    poster: { name: '海报', description: '大字号粗线条，远距离可读' }
  };

  var PALETTE_ORDER = ['npg', 'science', 'lancet', 'nejm', 'highcontrast', 'grayscale', 'cool', 'warm'];

  var FALLBACK_PALETTES = {
    npg: { name: 'Nature 配色', colors: ['#E64B35', '#4DBBD5', '#00A087', '#3C5488', '#F39B7F', '#8491B4', '#91D1C2', '#DC0000'] },
    science: { name: 'Science 配色', colors: ['#3B4992', '#EE0000', '#008B45', '#631879', '#008280', '#BB0021', '#5F559B', '#A20056'] },
    lancet: { name: '柳叶刀', colors: ['#00468B', '#ED0000', '#42B540', '#0099B4', '#925E9F', '#FDAF91', '#AD002A', '#ADB6B6'] },
    nejm: { name: 'NEJM 配色', colors: ['#BC3C29', '#0072B5', '#E18727', '#20854E', '#7876B1', '#6F99AD', '#FFDC91', '#EE4C97'] },
    highcontrast: { name: '高对比', colors: ['#000000', '#D55E00', '#0072B2', '#009E73', '#CC79A7', '#E69F00'] },
    grayscale: { name: '灰度打印', colors: ['#000000', '#3F3F3F', '#737373', '#A6A6A6', '#C9C9C9', '#E6E6E6'] },
    cool: { name: '冷色', colors: ['#1F4E79', '#2E75B6', '#5B9BD5', '#9DC3E6', '#1F9E89', '#4DBBD5'] },
    warm: { name: '暖色', colors: ['#B22222', '#E07B39', '#F2B134', '#D9A441', '#8C3B3B', '#C0504D'] }
  };

  var DEFAULT_COLORS = ['#2F6FED', '#E64B35', '#00A087', '#E18727', '#7876B1', '#4DBBD5'];

  var TESTS = [
    { id: 'ttest_1samp', name: '单样本 t 检验', needY: false },
    { id: 'ttest_ind', name: '独立样本 t 检验', needY: true },
    { id: 'ttest_rel', name: '配对样本 t 检验', needY: true },
    { id: 'ftest', name: '方差齐性 F 检验', needY: true },
    { id: 'anova', name: '单因素方差分析', needY: true },
    { id: 'shapiro', name: 'Shapiro-Wilk 正态性检验', needY: false },
    { id: 'levene', name: 'Levene 方差齐性检验', needY: true },
    { id: 'pearson', name: 'Pearson 相关分析', needY: true },
    { id: 'spearman', name: 'Spearman 秩相关', needY: true },
    { id: 'mannwhitney', name: 'Mann-Whitney U 检验', needY: true },
    { id: 'wilcoxon', name: 'Wilcoxon 符号秩检验', needY: true },
    { id: 'chisq_gof', name: '卡方拟合优度检验', needY: false, optionalY: true }
  ];

  // 描述统计指标展示顺序（key 与 stats_engine 返回一致）
  var METRICS = [
    ['n', '样本数 n'],
    ['mean', '平均值'],
    ['std', '标准差 s'],
    ['std_err', '标准误'],
    ['median', '中位数'],
    ['mode', '众数'],
    ['variance', '方差'],
    ['cv', '变异系数 CV'],
    ['min', '最小值'],
    ['max', '最大值'],
    ['range', '极差'],
    ['q1', '下四分位 Q1'],
    ['q3', '上四分位 Q3'],
    ['iqr', '四分位距 IQR'],
    ['skewness', '偏度'],
    ['kurtosis', '峰度'],
    ['ci95_low', '95% CI 下限'],
    ['ci95_high', '95% CI 上限'],
    ['sum', '总和']
  ];

  // 可以叠加拟合曲线的图表类型
  var FIT_KINDS = { line: 1, scatter: 1, line_marker: 1, errorbar: 1, residual: 1 };

  // X 轴是类别（系列名/列名）而不是数值的图表类型
  var CATEGORICAL_AXIS = {
    bar: 1, bar_grouped: 1, bar_stacked: 1, box: 1, violin: 1, heatmap: 1, pie: 1
  };

  // 支持双纵轴（次要 Y 轴）的图型。**必须**与后端 plot_engine._TWIN_OK_KINDS 保持一致：
  // 给清单外的图型发 axis 字段后端会静默忽略，界面上也不该显示左右轴开关（让用户
  // 点了没反应比没有这个功能更糟）。后端清单：line / scatter / line_marker / errorbar / bar
  var TWIN_AXIS_KINDS = { line: 1, scatter: 1, line_marker: 1, errorbar: 1, bar: 1 };

  var MAX_ROWS = 200000;

  /* ------------------------------------------------------------
   * 二、状态
   * ---------------------------------------------------------- */

  var state = {
    ds: null,
    filename: '',
    sheets: [],
    sheet: null,
    columns: [],
    previewColumns: [],
    uploadColumns: [],
    rows: [],
    total: 0,
    page: 0,
    pageSize: 50,
    truncated: false,
    kind: 'line',
    selectedCols: { x: null, ys: [], xerr: null, yerr: null },
    fit: null,
    fitKey: '',
    theme: 'paper_nature',
    palette: 'npg',
    dpi: 300,
    figW: 6.4,
    figH: 4.2,
    fontSize: 11,
    lineWidth: 1.6,
    markerSize: 5,
    themes: {},
    palettes: {},
    models: {},
    lastRender: null,
    lastSpec: null,
    lastElapsed: null,

    /* ---- 多子图：panels 存每个面板的配置，activePanel 是当前编辑的面板 ---- */
    gridShape: [1, 1],
    shareAxes: false,
    // 多子图时画布跟着网格放大：开着才能保证每格的物理尺寸、字号、清晰度
    // 不随子图数量下降。要钉死整图版面（期刊限宽）就关掉。
    canvasGrow: true,
    panels: null,
    activePanel: 0,

    /* ---- 数据变换 / 最近打开 / 缩放 ---- */
    transforms: {},
    recent: [],
    zoom: { scale: 1, x: 0, y: 0 }
  };

  // 拆成多文件后，模块级 var 会各自变成文件私有的。凡是"甲文件写、乙文件读"的
  // 可变状态都必须挂在同一个对象上 —— 对象身份共享，各文件拿到的是同一份。
  // 只在本文件内用到的（renderSeq / renderTimer / domCache）保持原样。
  var shared = {
    numericCache: Object.create(null),
    dragPayload: null,
    bkInfo: { python: '', exe: '', patched: null, port: 0, uptime: 0 }
  };

  var domCache = Object.create(null);

  // 与后端 _sanitize_spec() 的 dpi 收敛区间保持一致，避免"填了却被悄悄改"
  var DPI_MIN = 50;
  var DPI_MAX = 1200;

  var SESSION_KEY = 'datalab.session';
  var HIST_MAX = 50;
  var ZOOM_MIN = 0.5;
  var ZOOM_MAX = 8;

  /* ------------------------------------------------------------
   * 三、通用工具
   * ---------------------------------------------------------- */

  function el(id) {
    if (!(id in domCache)) domCache[id] = document.getElementById(id);
    return domCache[id];
  }

  function h(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function clear(node) {
    if (!node) return;
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  function esc(s) {
    return String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* ------------------------------------------------------------
   * 三·五、工作台状态：工作流步骤条 + 后端状态窗口
   * ---------------------------------------------------------- */

  // /api/connection 回传的服务端信息，存在 shared.bkInfo（见「二、状态」后的 shared）
  function kindName(id) {
    for (var i = 0; i < KINDS.length; i++) {
      if (KINDS[i].id === id) return KINDS[i].name;
    }
    return String(id || '图表');
  }

  // 取图型元数据。needZ / needMatrix 这类能力只有后端下发过才有，
  // 内置清单里没有，取不到一律按 false 处理（退化成普通二维图的界面）。
  function kindMeta(id) {
    for (var i = 0; i < KINDS.length; i++) {
      if (KINDS[i].id === id) return KINDS[i];
    }
    return null;
  }

  // 三维图：matplotlib 的 Axes3D 没有可用的对数轴，scale 字段发了也会被忽略
  function kindIs3D(id) {
    var m = kindMeta(id);
    return !!(m && (m.needZ || m.needMatrix));
  }

  // 当前面板的「列名 → 左/右轴」映射。面板还没铺好时返回空对象，
  // 避免渲染 chips 的阶段性问题炸掉整个右栏。
  function panelYAxis() {
    var p = Array.isArray(state.panels) ? state.panels[state.activePanel] : null;
    if (!p) return {};
    if (!p.yAxis || typeof p.yAxis !== 'object') p.yAxis = {};
    return p.yAxis;
  }

  /**
   * 「共享坐标轴」打开时是否真的存在刻度冲突。
   *
   * matplotlib 的 sharex/sharey 会把 set_xscale/set_yscale 传播到整组共享轴，
   * 于是逐面板设置的 xscale/yscale 会被强制统一 —— 这是共享轴的语义而不是 bug，
   * 但用户不知道的话就会以为"调对数没生效"（用户诉求 1 的根因）。
   * 这里只做检测与提示，**不改**用户的值（改了等于丢数据）。
   */
  function axesShareConflict() {
    if (!state.shareAxes) return false;
    if (!Array.isArray(state.panels) || state.panels.length < 2) return false;
    var seenX = {};
    var seenY = {};
    var nX = 0;
    var nY = 0;
    state.panels.forEach(function (p) {
      if (!p || !p.area) return;        // 没有位置的面板不参与绘制，不计入
      var sx = (p.xscale === 'log') ? 'log' : 'linear';
      var sy = (p.yscale === 'log') ? 'log' : 'linear';
      if (!seenX[sx]) { seenX[sx] = 1; nX++; }
      if (!seenY[sy]) { seenY[sy] = 1; nY++; }
    });
    return nX > 1 || nY > 1;
  }

  function markAnalysis(msg) {
    if (msg) {
      setBackendState('ready', '就绪');
      setBackendMsg(msg, 'ok');
    }
  }

  function markExported(msg) {
    if (msg) {
      setBackendState('ready', '就绪');
      setBackendMsg(msg, 'ok');
    }
  }

  function setBackendState(tone, label) {
    var pill = el('bkPill');
    if (!pill) return;
    pill.className = 'status-pill' + (tone ? ' ' + tone : '');
    clear(pill);
    pill.appendChild(h('i'));
    pill.appendChild(document.createTextNode(label || '待命'));
  }

  function setBackendMsg(text, tone) {
    var msg = el('bkMsg');
    if (!msg) return;
    msg.textContent = text || '';
    msg.className = 'backend-msg' + (tone ? ' ' + tone : '');
  }

  function syncBackend(elapsed) {
    var addr = el('bkAddr');
    if (addr) addr.textContent = '127.0.0.1:' + (shared.bkInfo.port || window.location.port || '8765');
    var py = el('bkPython');
    if (py) py.textContent = shared.bkInfo.python ? ('Python ' + shared.bkInfo.python) : '—';
    var rows = el('bkRows');
    if (rows) {
      rows.textContent = state.rows.length
        ? (state.rows.length + ' 行 × ' + state.columns.length + ' 列')
        : '—';
    }
    if (elapsed !== null && elapsed !== undefined) {
      var box = el('bkElapsed');
      if (box) box.textContent = elapsed + ' ms';
    }
  }

  function toNum(v) {
    if (v === null || v === undefined || v === '') return null;
    if (typeof v === 'boolean') return null;
    var n = typeof v === 'number' ? v : Number(String(v).trim());
    return Number.isFinite(n) ? n : null;
  }

  function numOrNull(v) {
    if (v === null || v === undefined) return null;
    if (typeof v === 'string' && v.trim() === '') return null;
    var n = Number(v);
    return Number.isFinite(n) ? n : null;
  }

  function fmtNum(v, digits) {
    var n = toNum(v);
    // 后端自由度可能是 "2, 12" 这类字符串，原样展示而不是变成「—」
    if (n === null) {
      if (v === null || v === undefined) return '—';
      var raw = String(v).trim();
      return raw === '' ? '—' : raw;
    }
    var d = (digits === undefined || digits === null) ? 4 : digits;
    if (n !== 0 && (Math.abs(n) < 1e-4 || Math.abs(n) >= 1e7)) {
      return n.toExponential(Math.min(d, 6));
    }
    var s = n.toFixed(d);
    if (s.indexOf('.') >= 0) s = s.replace(/0+$/, '').replace(/\.$/, '');
    if (s === '-0') s = '0';
    return s;
  }

  function fmtInt(v) {
    var n = toNum(v);
    if (n === null) {
      if (v === null || v === undefined) return '—';
      var raw = String(v).trim();
      return raw === '' ? '—' : raw;
    }
    return String(Math.round(n));
  }

  // 取路径最后一段，避免长路径把提示条撑满（完整路径进日志）
  function baseName(p) {
    var s = String(p === null || p === undefined ? '' : p);
    var i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
    return i >= 0 ? s.slice(i + 1) : s;
  }

  // 列类型显示成中文（numeric / datetime / text）
  function dtypeLabel(dtype) {
    var d = String(dtype === null || dtype === undefined ? '' : dtype).toLowerCase();
    if (!d) return '';
    if (d.indexOf('datetime') >= 0 || d.indexOf('date') >= 0 || d.indexOf('time') >= 0) return '时间';
    if (d.indexOf('num') >= 0 || d.indexOf('int') >= 0 || d.indexOf('float') >= 0) return '数值';
    if (d.indexOf('text') >= 0 || d.indexOf('str') >= 0 || d.indexOf('object') >= 0) return '文本';
    return String(dtype);
  }

  // 列名尾部已经带了同样的单位时，不再重复显示「(单位)」
  function unitTag(name, unit) {
    if (unit === null || unit === undefined || unit === '') return '';
    var u = String(unit).trim();
    if (!u) return '';
    var n = String(name === null || name === undefined ? '' : name);
    if (n.indexOf('(' + u + ')') >= 0 || n.indexOf('（' + u + '）') >= 0) return '';
    if (n.slice(-u.length) === u) return '';
    return '(' + u + ')';
  }

  function stamp() {
    var t = new Date();
    function p(n) { return n < 10 ? '0' + n : String(n); }
    return p(t.getHours()) + ':' + p(t.getMinutes()) + ':' + p(t.getSeconds());
  }

  /* ---------------- toast / 日志 ---------------- */

  function toast(msg, type) {
    var wrap = el('toastWrap');
    if (!wrap) return;
    var box = h('div', 'toast toast-' + (type || 'info'));
    box.appendChild(h('span', 'toast-dot'));
    box.appendChild(h('span', 'toast-text', msg));
    wrap.appendChild(box);
    while (wrap.childElementCount > 4) wrap.removeChild(wrap.firstChild);
    setTimeout(function () {
      box.classList.add('toast-out');
      setTimeout(function () { if (box.parentNode) box.parentNode.removeChild(box); }, 260);
    }, 3600);
  }

  function log(msg, level) {
    var pane = el('logPane');
    if (!pane) return;
    var line = document.createElement('div');
    line.className = 'log-line' + (level ? ' log-' + level : '');
    line.textContent = '[' + stamp() + '] ' + msg;
    pane.appendChild(line);
    while (pane.childElementCount > 400) pane.removeChild(pane.firstElementChild);
    pane.scrollTop = pane.scrollHeight;
  }

  /* ---------------- 复制 / 下载 ---------------- */

  function copyText(text) {
    var body = String(text === null || text === undefined ? '' : text);
    return new Promise(function (resolve) {
      if (!body) { resolve(false); return; }
      if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(body).then(function () { resolve(true); }, function () { resolve(fallback()); });
        return;
      }
      resolve(fallback());
      function fallback() {
        try {
          var ta = document.createElement('textarea');
          ta.value = body;
          ta.style.position = 'fixed';
          ta.style.left = '-9999px';
          document.body.appendChild(ta);
          ta.select();
          var ok = document.execCommand('copy');
          document.body.removeChild(ta);
          return ok;
        } catch (e) { return false; }
      }
    });
  }

  function stripDataUri(s) {
    var t = String(s === null || s === undefined ? '' : s);
    if (/^data:/i.test(t)) {
      var i = t.indexOf(',');
      return i >= 0 ? t.slice(i + 1) : '';
    }
    return t;
  }

  function b64ToBlob(b64, mime) {
    var raw = stripDataUri(b64).replace(/\s+/g, '');
    var bin = atob(raw);
    var len = bin.length;
    var buf = new Uint8Array(len);
    for (var i = 0; i < len; i++) buf[i] = bin.charCodeAt(i);
    return new Blob([buf], { type: mime });
  }

  function downloadBlob(blob, filename) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
  }

  /* ------------------------------------------------------------
   * 四、API
   * ---------------------------------------------------------- */

  function api(path, body) {
    var opt = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    };
    if (body !== undefined) opt.body = JSON.stringify(body);
    return fetch(path, opt).then(function (res) {
      return res.text().then(function (text) {
        var data = null;
        try { data = text ? JSON.parse(text) : null; } catch (e) { data = null; }
        if (data === null) {
          throw new Error('服务端返回了非 JSON 响应（HTTP ' + res.status + '）');
        }
        if (!res.ok || data.ok === false) {
          throw new Error(data.error || ('请求失败（HTTP ' + res.status + '）'));
        }
        return data;
      });
    }, function () {
      throw new Error('无法连接后端服务，请先通过 run.bat 启动本地服务');
    });
  }

  function apiGet(path) {
    return fetch(path, { method: 'GET' }).then(function (res) {
      return res.text().then(function (text) {
        var data = null;
        try { data = JSON.parse(text); } catch (e) { data = null; }
        if (data === null) throw new Error('服务端返回了非 JSON 响应（HTTP ' + res.status + '）');
        if (!res.ok || data.ok === false) throw new Error(data.error || ('请求失败（HTTP ' + res.status + '）'));
        return data;
      });
    }, function () {
      throw new Error('无法连接后端服务');
    });
  }

  /* ------------------------------------------------------------
   * 五、数据规范化与列信息
   * ---------------------------------------------------------- */

  function normalizeColumns(cols) {
    if (!Array.isArray(cols)) return [];
    return cols.map(function (c) {
      if (c === null || c === undefined) return { name: '', dtype: '', n_valid: null, n_missing: null, unit: null };
      if (typeof c === 'string' || typeof c === 'number') {
        return { name: String(c), dtype: '', n_valid: null, n_missing: null, unit: null };
      }
      return {
        name: String(c.name !== undefined ? c.name : (c.col !== undefined ? c.col : '')),
        dtype: String(c.dtype !== undefined ? c.dtype : (c.type !== undefined ? c.type : '')),
        n_valid: c.n_valid !== undefined ? c.n_valid : null,
        n_missing: c.n_missing !== undefined ? c.n_missing : null,
        unit: c.unit !== undefined ? c.unit : null
      };
    });
  }

  function normalizeSheets(sheets) {
    if (!Array.isArray(sheets)) return [];
    return sheets.map(function (s) {
      if (s === null || s === undefined) return { name: '', row_count: null, columns: [] };
      if (typeof s === 'string' || typeof s === 'number') {
        return { name: String(s), row_count: null, columns: [] };
      }
      return {
        name: String(s.name !== undefined ? s.name : (s.sheet !== undefined ? s.sheet : '')),
        row_count: s.row_count !== undefined ? s.row_count : null,
        columns: normalizeColumns(s.columns)
      };
    }).filter(function (s) { return s.name !== ''; });
  }

  function previewColumnNames() {
    var pc = state.previewColumns;
    if (!Array.isArray(pc)) return [];
    return pc.map(function (c) {
      if (c === null || c === undefined) return '';
      if (typeof c === 'string' || typeof c === 'number') return String(c);
      return String(c.name !== undefined ? c.name : (c.col !== undefined ? c.col : ''));
    });
  }

  function columnNames() {
    return state.columns.map(function (c) { return c.name; });
  }

  function colIndex(name) {
    if (!name) return -1;
    var pc = previewColumnNames();
    var i = pc.indexOf(name);
    if (i >= 0) return i;
    for (var k = 0; k < state.columns.length; k++) {
      if (state.columns[k].name === name) return k;
    }
    return -1;
  }

  function isNumericColumn(name) {
    if (!name) return false;
    if (shared.numericCache[name] !== undefined) return shared.numericCache[name];
    var meta = null;
    for (var i = 0; i < state.columns.length; i++) {
      if (state.columns[i].name === name) { meta = state.columns[i]; break; }
    }
    var dt = meta && meta.dtype ? String(meta.dtype).toLowerCase() : '';
    var result;
    if (/int|float|double|decimal|num|数值|整数|小数|实数/.test(dt)) {
      result = true;
    } else if (/str|text|char|object|date|time|bool|类别|文本|日期|时间/.test(dt)) {
      result = false;
    } else {
      var idx = colIndex(name);
      var seen = 0;
      result = false;
      if (idx >= 0) {
        for (var r = 0; r < state.rows.length && seen < 20; r++) {
          var v = state.rows[r][idx];
          if (v === null || v === undefined || v === '') continue;
          if (toNum(v) === null) { result = false; seen = 20; break; }
          result = true;
          seen++;
        }
      }
    }
    shared.numericCache[name] = result;
    return result;
  }

  function numericColumns() {
    return columnNames().filter(isNumericColumn);
  }

  // 时间列：可以当 X 轴（x 值直接用 ISO 字符串），但不能当 Y
  function isDatetimeColumn(name) {
    if (!name) return false;
    for (var i = 0; i < state.columns.length; i++) {
      if (state.columns[i].name === name) {
        return String(state.columns[i].dtype || '').toLowerCase().indexOf('datetime') >= 0;
      }
    }
    return false;
  }

  function normalizeRows(rows) {
    if (!Array.isArray(rows) || !rows.length) return [];
    if (Array.isArray(rows[0])) return rows;
    var names = previewColumnNames();
    if (!names.length) names = columnNames();
    return rows.map(function (r) {
      if (r === null || r === undefined || typeof r !== 'object') return [];
      return names.map(function (n) { return r[n] === undefined ? null : r[n]; });
    });
  }

  /* ---- 挂到全局，供后续文件互调（无打包器，靠全局作用域） ---- */
  G.KINDS = KINDS;
  G.KIND_ICONS = KIND_ICONS;
  G.MODEL_ORDER = MODEL_ORDER;
  G.FALLBACK_MODELS = FALLBACK_MODELS;
  G.THEME_ORDER = THEME_ORDER;
  G.FALLBACK_THEMES = FALLBACK_THEMES;
  G.PALETTE_ORDER = PALETTE_ORDER;
  G.FALLBACK_PALETTES = FALLBACK_PALETTES;
  G.DEFAULT_COLORS = DEFAULT_COLORS;
  G.TESTS = TESTS;
  G.METRICS = METRICS;
  G.FIT_KINDS = FIT_KINDS;
  G.CATEGORICAL_AXIS = CATEGORICAL_AXIS;
  G.TWIN_AXIS_KINDS = TWIN_AXIS_KINDS;
  G.MAX_ROWS = MAX_ROWS;
  G.state = state;
  G.shared = shared;
  // 共享轴冲突检测要被 03/07 两处钩子用，挂到 shared 上随同一个对象走，
  // 免得拆文件时各自 import 一份（这里没有打包器，只有 window）。
  shared.axesShareConflict = axesShareConflict;
  G.DPI_MIN = DPI_MIN;
  G.DPI_MAX = DPI_MAX;
  G.SESSION_KEY = SESSION_KEY;
  G.HIST_MAX = HIST_MAX;
  G.ZOOM_MIN = ZOOM_MIN;
  G.ZOOM_MAX = ZOOM_MAX;
  G.el = el;
  G.h = h;
  G.clear = clear;
  G.esc = esc;
  G.bkInfo = shared.bkInfo;
  G.kindName = kindName;
  G.kindMeta = kindMeta;
  G.kindIs3D = kindIs3D;
  G.panelYAxis = panelYAxis;
  G.axesShareConflict = axesShareConflict;
  G.markAnalysis = markAnalysis;
  G.markExported = markExported;
  G.setBackendState = setBackendState;
  G.setBackendMsg = setBackendMsg;
  G.syncBackend = syncBackend;
  G.toNum = toNum;
  G.numOrNull = numOrNull;
  G.fmtNum = fmtNum;
  G.fmtInt = fmtInt;
  G.baseName = baseName;
  G.dtypeLabel = dtypeLabel;
  G.unitTag = unitTag;
  G.stamp = stamp;
  G.toast = toast;
  G.log = log;
  G.copyText = copyText;
  G.stripDataUri = stripDataUri;
  G.b64ToBlob = b64ToBlob;
  G.downloadBlob = downloadBlob;
  G.api = api;
  G.apiGet = apiGet;
  G.normalizeColumns = normalizeColumns;
  G.normalizeSheets = normalizeSheets;
  G.previewColumnNames = previewColumnNames;
  G.columnNames = columnNames;
  G.colIndex = colIndex;
  G.isNumericColumn = isNumericColumn;
  G.numericColumns = numericColumns;
  G.isDatetimeColumn = isDatetimeColumn;
  G.normalizeRows = normalizeRows;
})(window);
