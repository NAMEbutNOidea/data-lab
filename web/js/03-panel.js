/* =============================================================
 * DataLab 前端 · 03-panel.js
 * 多子图面板 / 网格占位（area）/ 跨格
 * 源区间：原 app.js 第 1084–1334 行（按分节切分，未改动任何函数体）
 * 加载顺序由 index.html 决定：必须先加载它前面的脚本，不能单独引用。
 * ============================================================= */
(function (G) {
  'use strict';

  /* ------------------------------------------------------------
   * 八·五、多子图面板
   *
   * 约定：state.kind / state.selectedCols / 右侧那几个输入框，永远代表
   * 「当前选中的面板」。切换面板时先把值写回 state.panels[旧]，
   * 再把 state.panels[新] 载入这几个字段与控件。
   * 1×1 时只有一个面板，于是行为与单图版本完全一致。
   *
   * 占位（area）是 docs/panel-layout.md 第 1.2 节约定的 [row, col, rowSpan, colSpan]，
   * 全部 0 基、单位是网格格。面板可以跨格，所以「格数 ≠ 面板数」；
   * 放不下的面板留在 state.panels 里但 area = null：不渲染、不进切换条，
   * 只保留配置，等布局放大或跨格收回时再放回去（撤销也要能还原）。
   * ---------------------------------------------------------- */

  function newPanel() {
    return {
      kind: 'line',
      x: null,
      ys: [],
      xerr: null,
      yerr: null,
      title: '',
      xlabel: '',
      ylabel: '',
      autoTitle: true,
      autoXlabel: true,
      autoYlabel: true,
      xscale: 'linear',
      yscale: 'linear',
      grid: true,
      legend: true,
      // 逐列指派左右纵轴：{列名: 'left'|'right'}，没记到的列一律按左轴算
      yAxis: {},
      // 右侧 Y₂ 轴：只有上面 yAxis 里真的有 'right' 才发得出去，见 04-spec
      y2label: '',
      y2scale: 'linear',
      // null = 暂时没有位置（不渲染、不进切换条）
      area: null
    };
  }

  function clonePanel(src) {
    return normalizePanel(src);
  }

  // 会话恢复 / 撤销重做会把 JSON 直接塞回来，这里补全缺省字段
  // 左右轴指派收紧成「只有 'right' 算右轴」：其余任何值（true / 'L' / 数字）都落成左轴，
  // 与后端 _sanitize_series 对 axis 的收敛规则一致，避免脏会话把图画的莫名其妙。
  function normalizeYAxis(raw) {
    var out = {};
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
    Object.keys(raw).forEach(function (k) {
      if (raw[k] === 'right') out[String(k)] = 'right';
    });
    return out;
  }

  function normalizePanel(src) {
    var p = newPanel();
    if (!src || typeof src !== 'object') return p;
    if (src.kind) p.kind = String(src.kind);
    p.x = src.x ? String(src.x) : null;
    p.ys = Array.isArray(src.ys) ? src.ys.map(String) : [];
    p.xerr = src.xerr ? String(src.xerr) : null;
    p.yerr = src.yerr ? String(src.yerr) : null;
    p.title = src.title === undefined || src.title === null ? '' : String(src.title);
    p.xlabel = src.xlabel === undefined || src.xlabel === null ? '' : String(src.xlabel);
    p.ylabel = src.ylabel === undefined || src.ylabel === null ? '' : String(src.ylabel);
    p.autoTitle = src.autoTitle !== false;
    p.autoXlabel = src.autoXlabel !== false;
    p.autoYlabel = src.autoYlabel !== false;
    p.xscale = src.xscale === 'log' ? 'log' : 'linear';
    p.yscale = src.yscale === 'log' ? 'log' : 'linear';
    p.yAxis = normalizeYAxis(src.yAxis);
    p.y2label = (src.y2label === undefined || src.y2label === null) ? '' : String(src.y2label);
    p.y2scale = src.y2scale === 'log' ? 'log' : 'linear';
    p.grid = src.grid !== false;
    p.legend = src.legend !== false;
    // 老会话没有 area：保持 null，由 ensurePanels 统一铺位（等价于旧版每格一个面板）。
    // 这里只校验结构，网格边界留给 areaValid —— 恢复时 gridShape 可能还没写回来。
    p.area = null;
    if (Array.isArray(src.area) && src.area.length === 4) {
      var a = [];
      var ok = true;
      for (var i = 0; i < 4; i++) {
        var n = Number(src.area[i]);
        if (!isFinite(n) || Math.abs(n - Math.round(n)) > 1e-9) { ok = false; break; }
        a.push(Math.round(n));
      }
      if (ok && a[0] >= 0 && a[1] >= 0 && a[2] >= 1 && a[3] >= 1) p.area = a;
    }
    return p;
  }

  function gridRows() {
    var r = Number(state.gridShape && state.gridShape[0]) || 1;
    return Math.max(1, Math.min(4, Math.round(r)));
  }

  function gridCols() {
    var c = Number(state.gridShape && state.gridShape[1]) || 1;
    return Math.max(1, Math.min(4, Math.round(c)));
  }

  function panelTotal() {
    return gridRows() * gridCols();
  }

  // 0 -> a, 25 -> z，与后端 _panel_label_text 的编号保持一致
  function panelLetter(i) {
    var letters = 'abcdefghijklmnopqrstuvwxyz';
    var n = Math.max(0, Math.floor(i));
    var s = '';
    while (true) {
      s = letters.charAt(n % 26) + s;
      n = Math.floor(n / 26) - 1;
      if (n < 0) break;
    }
    return s;
  }

  /* ---- 网格占位工具（全部是纯计算，不改 state） ---- */

  function areaValid(area) {
    if (!Array.isArray(area) || area.length !== 4) return false;
    var v = [];
    for (var i = 0; i < 4; i++) {
      var n = Number(area[i]);
      if (!isFinite(n) || Math.abs(n - Math.round(n)) > 1e-9) return false;
      v.push(Math.round(n));
    }
    var rows = gridRows();
    var cols = gridCols();
    return v[0] >= 0 && v[1] >= 0 && v[2] >= 1 && v[3] >= 1
      && v[0] + v[2] <= rows && v[1] + v[3] <= cols;
  }

  function areasOverlap(a, b) {
    if (!a || !b) return false;
    return a[0] < b[0] + b[2] && b[0] < a[0] + a[2]
      && a[1] < b[1] + b[3] && b[1] < a[1] + a[3];
  }

  // 空格子表：occ[row][col] = true 表示已被占
  function emptyGrid() {
    var rows = gridRows();
    var cols = gridCols();
    var g = [];
    for (var r = 0; r < rows; r++) {
      var line = [];
      for (var c = 0; c < cols; c++) line.push(false);
      g.push(line);
    }
    return g;
  }

  function markArea(occ, area) {
    for (var r = area[0]; r < area[0] + area[2]; r++) {
      for (var c = area[1]; c < area[1] + area[3]; c++) {
        if (occ[r] && occ[r][c] !== undefined) occ[r][c] = true;
      }
    }
  }

  function areaFree(occ, area) {
    for (var r = area[0]; r < area[0] + area[2]; r++) {
      for (var c = area[1]; c < area[1] + area[3]; c++) {
        if (!occ[r] || occ[r][c]) return false;
      }
    }
    return true;
  }

  // exceptIdx：计算"除了某个面板之外"的占用（拖拽时判断目标格是否空着）
  function buildOccupancy(exceptIdx) {
    var occ = emptyGrid();
    state.panels.forEach(function (p, i) {
      if (i === exceptIdx) return;
      if (!p.area || !areaValid(p.area)) return;
      markArea(occ, p.area);
    });
    return occ;
  }

  // 按阅读顺序（先行后列）找第一个放得下 rowSpan×colSpan 的空块
  function firstFreeArea(occ, rowSpan, colSpan) {
    var rows = gridRows();
    var cols = gridCols();
    var rs = Math.max(1, Math.min(Math.round(rowSpan) || 1, rows));
    var cs = Math.max(1, Math.min(Math.round(colSpan) || 1, cols));
    for (var r = 0; r + rs <= rows; r++) {
      for (var c = 0; c + cs <= cols; c++) {
        var a = [r, c, rs, cs];
        if (areaFree(occ, a)) return a;
      }
    }
    return null;
  }

  function areaFreeFor(area, exceptIdx) {
    if (!areaValid(area)) return false;
    return areaFree(buildOccupancy(exceptIdx), area);
  }

  // 把越界 / 互相重叠的 area 清成 null（第一个出现的面板优先占位）
  function normalizeAreas() {
    var occ = emptyGrid();
    state.panels.forEach(function (p) {
      if (!p.area) return;
      if (!areaValid(p.area) || !areaFree(occ, p.area)) { p.area = null; return; }
      markArea(occ, p.area);
    });
  }

  function hasAnyArea() {
    for (var i = 0; i < state.panels.length; i++) {
      if (state.panels[i].area) return true;
    }
    return false;
  }

  // 只给"没位置"的面板找空位。跨格吃掉的面板不在这里复活 ——
  // 那是有意的（契约 1.4），收回跨格 / 换更大布局时由调用方显式调一次。
  function placePanels() {
    var occ = buildOccupancy(-1);
    state.panels.forEach(function (p) {
      if (p.area) return;
      var spot = firstFreeArea(occ, 1, 1);
      if (!spot) return;
      p.area = spot;
      markArea(occ, spot);
    });
  }

  /**
   * 有位置的面板，按 area 的阅读顺序（先 row 后 col）排好。
   * 编号 (a)(b)(c) 用这个顺序，**不是**数组下标 —— 拖动过位置之后两者会不一样。
   */
  function placedList() {
    var list = [];
    state.panels.forEach(function (p, i) {
      if (!p.area || !areaValid(p.area)) return;
      list.push({ index: i, area: p.area.slice(), row: p.area[0], col: p.area[1] });
    });
    list.sort(function (a, b) {
      if (a.row !== b.row) return a.row - b.row;
      if (a.col !== b.col) return a.col - b.col;
      return a.index - b.index;
    });
    return list;
  }

  // 面板的下标 -> 放置序号（拿不到返回 -1，说明它没有位置）
  function panelPlacement(idx) {
    var list = placedList();
    for (var i = 0; i < list.length; i++) {
      if (list[i].index === idx) return i;
    }
    return -1;
  }

  // 面板的 (a)/(b) 编号（按放置顺序，不是下标）
  function panelLabel(idx) {
    var pos = panelPlacement(idx);
    return pos >= 0 ? '(' + panelLetter(pos) + ')' : '';
  }

  function spanText(area) {
    if (!area) return '';
    if (area[2] > 1 && area[3] > 1) return area[2] + '×' + area[3];
    if (area[3] > 1) return area[3] + '列';
    if (area[2] > 1) return area[2] + '行';
    return '';
  }

  // 保证 state.panels 的长度至少等于布局格数，并让每个面板有合法占位
  function ensurePanels() {
    var n = panelTotal();
    if (!Array.isArray(state.panels) || !state.panels.length) {
      state.panels = [newPanel()];
      state.activePanel = 0;
    }
    state.panels = state.panels.map(normalizePanel);

    // 布局变大时补面板：克隆上一格的映射，避免出现"空白面板"让人以为坏了。
    var before = state.panels.length;
    var needPad = before < n;

    normalizeAreas();
    // 两种情况要把"没位置"的面板放回去：
    // 1) 谁都没有位置（老会话没有 area / 全新状态）→ 按阅读顺序铺满，等价于旧版每格一个面板；
    // 2) 网格变大 → 先按数组顺序安置老面板，再补新格子。
    // 顺序反过来的话，新补的面板会抢走靠前的格子，面板下标与放置顺序就错位了
    // （切换条的 data-panel 用的是下标，错位后会点到不存在的面板）。
    if (!hasAnyArea() || needPad) placePanels();

    while (state.panels.length < n) {
      var np = normalizePanel(state.panels[state.panels.length - 1]);
      np.area = null;
      state.panels.push(np);
    }
    if (state.panels.length > before) {
      // 只给这次新补出来的格子找位置；老面板里因放不下而落空的，留给切布局时统一处理
      var occ = buildOccupancy(-1);
      for (var k = before; k < state.panels.length; k++) {
        var spot = firstFreeArea(occ, 1, 1);
        if (!spot) continue;
        state.panels[k].area = spot;
        markArea(occ, spot);
      }
    }

    // 当前编辑的面板必须是有位置的那个，否则右侧控件在编辑一张看不见的图
    var placed = placedList();
    var okActive = false;
    for (var j = 0; j < placed.length; j++) {
      if (placed[j].index === state.activePanel) okActive = true;
    }
    if (!okActive) state.activePanel = placed.length ? placed[0].index : 0;
  }

  // 把当前 UI 的值写回激活面板
  function commitPanel() {
    ensurePanels();
    var p = state.panels[state.activePanel];
    if (!p) return;
    p.kind = state.kind;
    p.x = state.selectedCols.x || null;
    p.ys = (state.selectedCols.ys || []).slice();
    p.xerr = state.selectedCols.xerr || null;
    p.yerr = state.selectedCols.yerr || null;

    var tinp = el('inpTitle');
    if (tinp) { p.title = tinp.value; p.autoTitle = tinp.dataset.auto !== '0'; }
    var xinp = el('inpXlabel');
    if (xinp) { p.xlabel = xinp.value; p.autoXlabel = xinp.dataset.auto !== '0'; }
    var yinp = el('inpYlabel');
    if (yinp) { p.ylabel = yinp.value; p.autoYlabel = yinp.dataset.auto !== '0'; }

    var xs = el('selXScale');
    if (xs) p.xscale = xs.value === 'log' ? 'log' : 'linear';
    var ys = el('selYScale');
    if (ys) p.yscale = ys.value === 'log' ? 'log' : 'linear';
    // yAxis 不在这里收：左右指派在 chip 点击时就写进了面板（见 02 renderYChips），
    // 一个字段两条写路径迟早打架。
    var y2l = el('inpY2label');
    if (y2l) p.y2label = String(y2l.value || '');
    var y2s = el('selY2Scale');
    if (y2s) p.y2scale = y2s.value === 'log' ? 'log' : 'linear';
    var g = el('chkGrid');
    if (g) p.grid = !!g.checked;
    var l = el('chkLegend');
    if (l) p.legend = !!l.checked;
  }

  // 把面板配置载入 state 与右侧控件（不触发渲染）
  function applyPanel(idx) {
    ensurePanels();
    var placed = placedList();
    var i = -1;
    for (var k = 0; k < placed.length; k++) {
      if (placed[k].index === idx) i = idx;
    }
    if (i < 0) i = placed.length ? placed[0].index : 0;
    state.activePanel = i;
    var p = state.panels[i] || newPanel();

    state.kind = p.kind || 'line';
    state.selectedCols = {
      x: p.x || null,
      ys: (p.ys || []).slice(),
      xerr: p.xerr || null,
      yerr: p.yerr || null
    };

    var tinp = el('inpTitle');
    if (tinp) {
      tinp.dataset.auto = p.autoTitle ? '1' : '0';
      tinp.value = p.autoTitle ? titleFor(p) : (p.title || '');
    }
    var labels = axisLabelsFor(p);
    var xinp = el('inpXlabel');
    if (xinp) {
      xinp.dataset.auto = p.autoXlabel ? '1' : '0';
      xinp.value = p.autoXlabel ? labels.x : (p.xlabel || '');
    }
    var yinp = el('inpYlabel');
    if (yinp) {
      yinp.dataset.auto = p.autoYlabel ? '1' : '0';
      yinp.value = p.autoYlabel ? labels.y : (p.ylabel || '');
    }

    var xs = el('selXScale');
    if (xs) xs.value = p.xscale || 'linear';
    var ys = el('selYScale');
    if (ys) ys.value = p.yscale || 'linear';
    var y2l = el('inpY2label');
    if (y2l) y2l.value = p.y2label || '';
    var y2s = el('selY2Scale');
    if (y2s) y2s.value = p.y2scale || 'linear';
    var g = el('chkGrid');
    if (g) g.checked = !!p.grid;
    var l = el('chkLegend');
    if (l) l.checked = !!p.legend;

    renderTypeGrid();
    syncColumnSelects();
    syncMappingUI();
    renderPanelBar();
    renderSpanUI();
  }

  /**
   * 「坐标轴」组的界面同步，四件事一次性做完：
   *
   * ① 当前编辑的是哪个子图 —— 多子图时刻度是逐面板独立的，不说清楚用户会以为在改全部；
   * ② 共享坐标轴与逐面板刻度冲突时的告警 —— 勾了共享后 matplotlib 会把 scale
   *    传播到整组共享轴，逐面板设置会被统一（用户诉求 1 的根因）；
   * ③ 三维图禁用 X/Y 刻度下拉 —— Axes3D 没有对数轴，留着让用户改了不生效更糟；
   * ④ Y₂ 轴设置的显隐 —— 图型支持双轴、且真的有列指派到了右轴才出现。
   *
   * 必须在三个时机各刷一次：勾选共享、改任一面板的刻度、切换当前编辑的子图，
   * 所以这里做成幂等的纯刷新，由 renderPanelBar / 两套事件钩子分别调用。
   */
  function refreshAxisUI() {
    var p = Array.isArray(state.panels) ? state.panels[state.activePanel] : null;
    var is3d = kindIs3D(p ? p.kind : state.kind);
    var placed = placedList();

    var who = el('axisPanelHint');
    if (who) {
      var multi = placed.length > 1;
      who.textContent = multi ? ('子图 ' + (panelLabel(state.activePanel) || '(a)')) : '';
      who.hidden = !multi;
    }

    ['selXScale', 'selYScale'].forEach(function (id) {
      var node = el(id);
      if (node) node.disabled = is3d;
    });
    var tip3d = el('axis3dHint');
    if (tip3d) tip3d.hidden = !is3d;

    // 右轴序列数只看当前面板选中的列：被移出 Y 列表的旧指派不该让设置区一直挂着
    var map = panelYAxis();
    var rights = 0;
    (p ? (p.ys || []) : []).forEach(function (n) {
      if (map[n] === 'right') rights++;
    });
    var y2Row = el('y2Row');
    if (y2Row) y2Row.hidden = !((p && TWIN_AXIS_KINDS[p.kind]) && rights > 0);

    var warn = el('axisWarn');
    if (warn) {
      var bad = axesShareConflict();
      warn.hidden = !bad;
      warn.textContent = bad
        ? '共享坐标轴已开启：所有子图会强制用同一套刻度，逐子图单独设置当前不生效。'
          + '要单独设置请取消勾选「共享坐标轴」。'
        : '';
    }
  }

  function renderPanelBar() {
    var bar = el('panelBar');
    var placed = placedList();
    if (bar) {
      clear(bar);
      if (placed.length <= 1) {
        bar.hidden = true;
      } else {
        bar.hidden = false;
        placed.forEach(function (it, order) {
          var p = state.panels[it.index] || newPanel();
          var b = h('button', 'panel-tab' + (it.index === state.activePanel ? ' active' : ''));
          b.type = 'button';
          b.dataset.panel = String(it.index);
          b.dataset.order = String(order);
          b.title = '编辑面板 (' + panelLetter(order) + ')';
          b.appendChild(h('span', 'panel-tag', '(' + panelLetter(order) + ')'));
          b.appendChild(h('span', 'panel-name', kindName(p.kind)));
          var st = spanText(it.area);
          if (st) {
            var badge = h('span', 'panel-span', st);
            badge.title = '该面板占 ' + st;
            b.appendChild(badge);
          }
          bar.appendChild(b);
        });
      }
    }
    var hint = el('activePanelHint');
    if (hint) {
      var pos = panelPlacement(state.activePanel);
      hint.textContent = pos >= 0 ? ('面板 (' + panelLetter(pos) + ')') : '面板 (a)';
    }
    // 这两块文案/可用性挂在别的组里，但取值来源与切换条相同，趁这次重绘一起刷
    renderYColHint();
    refreshAxisUI();
  }

  // 「跨 2 列 / 跨 2 行」两个开关的激活态与可用性
  function renderSpanUI() {
    var rows = gridRows();
    var cols = gridCols();
    var p = state.panels[state.activePanel];
    var has = !!(p && p.area);
    var bar = el('spanBar');
    if (bar) bar.hidden = panelTotal() <= 1;

    var bc = el('btnSpanCols');
    if (bc) {
      var onC = has && p.area[3] > 1;
      bc.classList.toggle('is-active', onC);
      bc.setAttribute('aria-pressed', onC ? 'true' : 'false');
      bc.disabled = !has || cols < 2;
      bc.title = cols < 2 ? '网格只有 1 列，无法跨列'
        : (onC ? '取消跨列，恢复成 1 格' : '让当前面板占 2 列（右侧相邻面板会被收起）');
    }
    var br = el('btnSpanRows');
    if (br) {
      var onR = has && p.area[2] > 1;
      br.classList.toggle('is-active', onR);
      br.setAttribute('aria-pressed', onR ? 'true' : 'false');
      br.disabled = !has || rows < 2;
      br.title = rows < 2 ? '网格只有 1 行，无法跨行'
        : (onR ? '取消跨行，恢复成 1 格' : '让当前面板占 2 行（下方相邻面板会被收起）');
    }
  }

  function renderLayoutUI() {
    var picker = el('layoutPicker');
    if (picker) {
      Array.prototype.forEach.call(picker.querySelectorAll('.layout-btn'), function (b) {
        var parts = String(b.dataset.grid || '1,1').split(',');
        var active = Number(parts[0]) === gridRows() && Number(parts[1]) === gridCols();
        b.classList.toggle('is-active', active);
        b.setAttribute('aria-pressed', active ? 'true' : 'false');
      });
    }
    var ir = el('inpGridRows');
    if (ir && String(ir.value) !== String(gridRows())) ir.value = String(gridRows());
    var ic = el('inpGridCols');
    if (ic && String(ic.value) !== String(gridCols())) ic.value = String(gridCols());
    var gi = el('gridHint');
    if (gi) gi.textContent = gridRows() + '×' + gridCols();
    var chk = el('chkShareAxes');
    if (chk) chk.checked = !!state.shareAxes;
    var cg = el('chkCanvasGrow');
    if (cg) cg.checked = state.canvasGrow !== false;
    renderSpanUI();
    renderPanelBar();
    renderLayoutBoard();
    renderSizeWarn();
  }

  /**
   * 格子太小的时候后端会自动缩字号（`_panel_font_scale`），不告诉用户的话，
   * 他会以为是主题或字号设置失效了。这里按当前图幅和行列算出"每格多大"，
   * 太小就提示两条出路：加大图幅，或者少分几格。
   */
  function renderSizeWarn() {
    var box = el('layoutWarn');
    if (!box) return;
    var rows = gridRows();
    var cols = gridCols();
    if (rows * cols <= 1) {
      box.hidden = true;
      return;
    }
    // canvas_grow 开着时画布会按行列数放大，每格仍是用户设定的那一格图幅，
    // 字号不会被缩——这条提醒是给"图幅钉死"的人看的，此时不该出现。
    if (state.canvasGrow !== false) {
      box.hidden = true;
      return;
    }
    var fw = Number(state.figW) > 0 ? Number(state.figW) : 6.4;
    var fh = Number(state.figH) > 0 ? Number(state.figH) : 4.2;
    var pw = fw / cols;
    var ph = fh / rows;
    var shortSide = Math.min(pw, ph);
    var baseFs = Number(state.fontSize) > 0 ? Number(state.fontSize) : 11;
    // 跟后端 _panel_font_scale 同一套公式（参考边长 2.0in、下限 0.42）
    var scale = Math.min(1, Math.max(0.42, shortSide / 2.0));
    // 只差一点点就别刷存在感了，缩到八折以下才值得提醒
    if (scale >= 0.78) {
      box.hidden = true;
      return;
    }
    var eff = Math.round(Math.max(4.2, baseFs * scale) * 10) / 10;
    // 想恢复原字号，图幅按同一比例放大即可（保持现有宽高比，别改成正方形）
    var k = 2.0 / shortSide;
    var needW = Math.round(fw * k * 10) / 10;
    var needH = Math.round(fh * k * 10) / 10;
    box.hidden = false;
    box.innerHTML = '';
    box.appendChild(h('span', 'layout-warn-icon', '!'));
    var txt = h('span', 'layout-warn-text');
    txt.appendChild(document.createTextNode(
      '每格只有 ' + pw.toFixed(1) + '×' + ph.toFixed(1) + ' in，字号已自动从 '
      + baseFs + ' pt 缩到 ' + eff + ' pt。'
      + '想让字回到原大小，图幅要放大到约 ' + needW + '×' + needH + ' in；'
      + '或者少分几格、勾上「共享坐标轴」。'
    ));
    box.appendChild(txt);
  }

  /* ------------------------------------------------------------
   * 拼图板（布局缩略图）与子图设置弹窗
   * ---------------------------------------------------------- */

  /**
   * 宽高比念成人话：先试常见整数比（2:1、3:2、16:9…），差 2% 以上才退回两位小数。
   * 直接 gcd 约分没用 —— 3.2:2.1 会约成 "50 : 33"，看着像算错了。
   */
  function ratioText(w, h) {
    if (!(w > 0) || !(h > 0)) return '—';
    var v = w / h;
    var cands = [[1, 1], [4, 3], [3, 2], [16, 9], [2, 1], [5, 2], [3, 1], [7, 2],
      [4, 1], [5, 1], [1, 2], [2, 3], [3, 4], [9, 16], [1, 3], [2, 5], [1, 4]];
    for (var i = 0; i < cands.length; i++) {
      var t = cands[i][0] / cands[i][1];
      if (Math.abs(v - t) / t < 0.02) return cands[i][0] + ' : ' + cands[i][1];
    }
    return v.toFixed(2) + ' : 1';
  }

  function round1(v) {
    return Math.round(v * 10) / 10;
  }

  // 占整张图的比例（按格子数算，与 figsize 无关）
  function areaRatio(area) {
    if (!area || !areaValid(area)) return null;
    return {
      w: area[3] / gridCols(),
      h: area[2] / gridRows()
    };
  }

  // 导出后真正看到的尺寸与宽高比：格子占比 × 整图 figsize
  function areaPhysRatio(area) {
    var r = areaRatio(area);
    if (!r) return '—';
    var fw = Number(state.figW) > 0 ? Number(state.figW) : 6.4;
    var fh = Number(state.figH) > 0 ? Number(state.figH) : 4.2;
    var w = r.w * fw;
    var h = r.h * fh;
    return round1(w) + ' × ' + round1(h) + ' in（' + ratioText(w, h) + '）';
  }

  /* ---- 拼图板 ---- */

  function renderLayoutBoard() {
    var board = el('layoutBoard');
    if (!board) return;
    var rows = gridRows();
    var cols = gridCols();
    var total = rows * cols;
    var placed = placedList();
    clear(board);
    board.hidden = total <= 1;

    var hint = el('boardHint');
    if (hint) hint.textContent = total <= 1 ? '单图' : (placed.length + ' / ' + total + ' 格');
    var add = el('btnAddPanel');
    if (add) {
      // 「面板数 < 格数」不等于「还有空位」—— 一个跨 2 格的面板就能把数凑满。
      // 真正该看的是网格里还有没有 1×1 的空块。
      var freeSpot = total <= 1 ? null : firstFreeArea(buildOccupancy(-1), 1, 1);
      add.hidden = total <= 1;
      add.disabled = total <= 1 || !freeSpot;
      add.title = !freeSpot
        ? '没有空格子了：调大布局，或把某个跨格子图收回 1×1'
        : '在空位新增一个子图（复制当前子图的配置）';
    }
    if (total <= 1) { renderUnplaced(); return; }

    board.style.setProperty('--rows', String(rows));
    board.style.setProperty('--cols', String(cols));
    // 4 行 1 列的板子若按真实比例会高得离谱，限制在 1:2.4 ~ 2.4:1 之间
    board.style.aspectRatio = String(Math.max(0.42, Math.min(2.4, cols / rows)).toFixed(3));

    placed.forEach(function (it, order) {
      var p = state.panels[it.index];
      var a = it.area;
      var cell = h('button', 'board-cell' + (it.index === state.activePanel ? ' is-active' : ''));
      cell.type = 'button';
      cell.dataset.panel = String(it.index);
      cell.style.gridRow = (a[0] + 1) + ' / span ' + a[2];
      cell.style.gridColumn = (a[1] + 1) + ' / span ' + a[3];
      cell.appendChild(h('b', 'board-letter', '(' + panelLetter(order) + ')'));
      // 格子太密时只留角标：3×3 以上每格不到 30px，图型名会被裁成半截
      if (total <= 9) cell.appendChild(h('span', 'board-kind', kindName(p.kind)));
      var st = spanText(a);
      if (st) cell.appendChild(h('i', 'board-span', st));
      cell.title = '子图 (' + panelLetter(order) + ') · ' + kindName(p.kind)
        + ' · 占 ' + (st ? ('「' + st + '」') : '1 格')
        + '\n点击：调整大小 / 位置';
      board.appendChild(cell);
    });
    renderUnplaced();
  }

  // 被跨格子图挤掉、暂时没位置的面板：单列一行，点一下重新安置
  function renderUnplaced() {
    var box = el('boardUnplaced');
    if (!box) return;
    clear(box);
    var loose = [];
    state.panels.forEach(function (p, i) { if (!p.area) loose.push(i); });
    box.hidden = !loose.length || panelTotal() <= 1;
    if (box.hidden) return;
    box.appendChild(h('span', 'unplaced-label', '未放置 ' + loose.length));
    loose.forEach(function (i) {
      var p = state.panels[i];
      var chip = h('button', 'unplaced-chip');
      chip.type = 'button';
      chip.dataset.restore = String(i);
      chip.textContent = kindName(p.kind);
      chip.title = '这个子图被别的跨格子图盖住了。点击为它找一格空位';
      box.appendChild(chip);
    });
  }

  /* ---- 面积就地修改（弹窗里实时预览用，不动撤销栈） ---- */

  /**
   * 把 idx 面板的面积改成 want。挡住它的面板一律 area=null（拼图直觉：谁挡我谁让开）。
   * 返回被挤掉的面板数量（0 表示没人被挤）—— 调用方要提示用户，否则"图突然少了"很吓人。
   */
  function setAreaLive(idx, want) {
    var p = state.panels[idx];
    if (!p) return 0;
    var rows = gridRows();
    var cols = gridCols();
    var rs = Math.max(1, Math.min(rows, Math.round(Number(want[2]) || 1)));
    var cs = Math.max(1, Math.min(cols, Math.round(Number(want[3]) || 1)));
    var r = Math.max(0, Math.min(rows - rs, Math.round(Number(want[0]) || 0)));
    var c = Math.max(0, Math.min(cols - cs, Math.round(Number(want[1]) || 0)));
    var next = [r, c, rs, cs];
    var eaten = 0;
    state.panels.forEach(function (q, i) {
      if (i === idx || !q.area) return;
      if (areasOverlap(q.area, next)) {
        q.area = null;
        eaten++;
      }
    });
    p.area = next;
    return eaten;
  }

  // 跨格 / 挪位置会把挡路的面板收起来，必须让用户知道去哪儿找回来
  function notifyEaten(n) {
    if (!n) return;
    toast('挤掉了 ' + n + ' 个面板，在拼图板下方「未放置」里点一下就能放回', 'warn');
  }

  /* ---- 子图设置弹窗 ---- */

  /**
   * 打开单个子图的设置窗口。
   *
   * 改动**即时生效**（主窗口跟着重绘），所以撤销栈只在关窗时落一步：
   * 打开时先记一份全局面积极照，"取消"就整块还原 —— 跨格会吃掉别的面板，
   * 只还原自己那一块是不够的。
   */
  function openPanelDialog(idx) {
    commitPanel();
    var p = state.panels[idx];
    if (!p) return;
    if (!el('modalMask')) return;
    if (panelTotal() <= 1) {
      toast('单图模式没有可排布的格子，先在「子图布局」里选 1×2 或更大', 'warn');
      return;
    }

    var snapAreas = state.panels.map(function (q) { return q.area ? q.area.slice() : null; });
    var snapActive = state.activePanel;

    // 没位置的面板：先塞进第一个空位，不然弹窗里没东西可调
    if (!p.area) {
      var spot = firstFreeArea(buildOccupancy(idx), 1, 1);
      if (!spot) {
        toast('网格已排满，先收缩别的子图或调大布局', 'warn');
        return;
      }
      p.area = spot;
      pushHistorySoon('放置子图');
    }
    state.activePanel = idx;
    // 右栏跟着切到这张子图：弹窗只负责布局，图型/映射仍在右栏改
    applyPanel(idx);
    renderLayoutUI();

    var body = h('div', 'panel-dlg');
    var side = h('div', 'pdg-side');
    var mini = h('div', 'pdg-mini');
    var note = h('p', 'pdg-note', '');
    side.appendChild(mini);
    side.appendChild(note);
    body.appendChild(side);

    // 点缩略图的任意格子 = 把当前子图挪过去。比连点"第几行/第几列"快，
    // 也是拼图直觉：直接指着想去的位置点。
    mini.title = '点任意格子，把这张子图挪过去';
    mini.addEventListener('click', function (e) {
      var box = mini.getBoundingClientRect();
      if (!box.width || !box.height) return;
      var cols = gridCols();
      var rows = gridRows();
      var col = Math.floor((e.clientX - box.left) / (box.width / cols));
      var row = Math.floor((e.clientY - box.top) / (box.height / rows));
      if (col < 0) col = 0;
      if (row < 0) row = 0;
      if (col > cols - 1) col = cols - 1;
      if (row > rows - 1) row = rows - 1;
      applyPos(row, col);     // setAreaLive 会把跨格导致的越界收回到边界内
    });

    var ctrls = h('div', 'pdg-ctrls');
    body.appendChild(ctrls);

    var head = h('div', 'pdg-head');
    var headLetter = h('b', 'pdg-letter', '');
    head.appendChild(headLetter);
    head.appendChild(h('span', 'pdg-kind', kindName(p.kind)));
    ctrls.appendChild(head);

    /* -- 缩略预览 -- */
    function renderMini() {
      clear(mini);
      var rows = gridRows();
      var cols = gridCols();
      mini.style.setProperty('--rows', String(rows));
      mini.style.setProperty('--cols', String(cols));
      mini.style.aspectRatio = String(Math.max(0.6, Math.min(2.2, cols / rows)).toFixed(3));
      var cur = state.panels[idx] && state.panels[idx].area;
      placedList().forEach(function (it, order) {
        if (it.index === idx) return;
        var d = h('div', 'pdg-cell is-other');
        d.style.gridRow = (it.area[0] + 1) + ' / span ' + it.area[2];
        d.style.gridColumn = (it.area[1] + 1) + ' / span ' + it.area[3];
        d.appendChild(h('span', 'pdg-cell-letter', '(' + panelLetter(order) + ')'));
        // 3×3 以上的格子放不下图型名，只留角标
        if (rows * cols <= 9) {
          d.appendChild(h('span', 'pdg-cell-kind', kindName(state.panels[it.index].kind)));
        }
        mini.appendChild(d);
      });
      if (cur) {
        var me = h('div', 'pdg-cell is-me');
        me.style.gridRow = (cur[0] + 1) + ' / span ' + cur[2];
        me.style.gridColumn = (cur[1] + 1) + ' / span ' + cur[3];
        me.appendChild(h('b', 'pdg-cell-letter', panelLetter(panelPlacement(idx))));
        me.appendChild(h('span', 'pdg-cell-size', cur[2] + '×' + cur[3]));
        mini.appendChild(me);
      }
      var pos = panelPlacement(idx);
      if (headLetter) headLetter.textContent = pos >= 0 ? ('(' + panelLetter(pos) + ')') : '—';
      var ratio = areaRatio(cur);
      if (cur && ratio) {
        note.textContent = '占图面 ' + Math.round(ratio.w * 100) + '% 宽 × '
          + Math.round(ratio.h * 100) + '% 高，宽高比 ' + areaPhysRatio(cur);
      } else {
        note.textContent = '当前没有位置';
      }
    }

    /* -- 步进器 -- */
    function stepper(label, minFn, maxFn, getVal, setVal, unit) {
      var row = h('div', 'pdg-row');
      row.appendChild(h('span', 'pdg-label', label));
      var box = h('div', 'pdg-stepper');
      var minus = h('button', 'pdg-step', '−');
      minus.type = 'button';
      var val = h('b', 'pdg-val', '');
      var plus = h('button', 'pdg-step', '+');
      plus.type = 'button';
      box.appendChild(minus);
      box.appendChild(val);
      box.appendChild(plus);
      row.appendChild(box);
      row.appendChild(h('span', 'pdg-unit', unit || ''));
      function refresh() {
        var v = getVal();
        val.textContent = String(v);
        minus.disabled = v <= minFn();
        plus.disabled = v >= maxFn();
      }
      minus.addEventListener('click', function () {
        if (getVal() > minFn()) { setVal(getVal() - 1); refresh(); }
      });
      plus.addEventListener('click', function () {
        if (getVal() < maxFn()) { setVal(getVal() + 1); refresh(); }
      });
      return { node: row, refresh: refresh };
    }

    var rowsStep, colsStep, rowPos, colPos;

    // 返回副本：调用方怎么改都不会偷偷写进 state，写回只走 setAreaLive 一条路
    function curArea() {
      var a = state.panels[idx] && state.panels[idx].area;
      return a ? a.slice() : [0, 0, 1, 1];
    }

    // 改完尺寸：先贴边回收到网格内，再写回；被挡住的其它面板让位
    function applySize(rs, cs) {
      var a = curArea();
      var want = [a[0], a[1], rs || a[2], cs || a[3]];
      if (want[0] + want[2] > gridRows()) want[0] = Math.max(0, gridRows() - want[2]);
      if (want[1] + want[3] > gridCols()) want[1] = Math.max(0, gridCols() - want[3]);
      var eaten = setAreaLive(idx, want);
      renderLayoutUI();
      renderMini();
      refreshAll();
      scheduleRender(0);
      // 连续点步进器只落一步撤销（450ms 防抖）；这样 Esc / 点遮罩关窗也不会漏记
      pushHistorySoon('调整子图');
      if (eaten) notifyEaten(eaten);
    }

    function applyPos(r, c) {
      var a = curArea();
      var eaten = setAreaLive(idx, [r, c, a[2], a[3]]);   // 内部会收敛越界
      renderLayoutUI();
      renderMini();
      refreshAll();
      scheduleRender(0);
      pushHistorySoon('调整子图');
      if (eaten) notifyEaten(eaten);
    }

    /* -- 大小：行跨 × 列跨 -- */
    var sizeBlock = h('div', 'pdg-block');
    sizeBlock.appendChild(h('div', 'pdg-block-title', '大小'));
    rowsStep = stepper('行跨', function () { return 1; }, function () { return gridRows(); },
      function () { return curArea()[2]; },
      function (v) { applySize(v, curArea()[3]); }, '行');
    colsStep = stepper('列跨', function () { return 1; }, function () { return gridCols(); },
      function () { return curArea()[3]; },
      function (v) { applySize(curArea()[2], v); }, '列');
    sizeBlock.appendChild(rowsStep.node);
    sizeBlock.appendChild(colsStep.node);

    // 快捷：1×1 / 1×2 / 2×1 / 2×2（行 × 列）
    var quick = h('div', 'pdg-quick');
    [[1, 1], [1, 2], [2, 1], [2, 2]].forEach(function (pair) {
      var rs = pair[0];
      var cs = pair[1];
      var b = h('button', 'btn btn-sm pdg-quick-btn', rs + '×' + cs);
      b.type = 'button';
      b.dataset.rs = String(rs);
      b.dataset.cs = String(cs);
      if (rs > gridRows() || cs > gridCols()) { b.disabled = true; b.title = '当前网格放不下 ' + rs + '×' + cs; }
      b.addEventListener('click', function () {
        applySize(rs, cs);
      });
      quick.appendChild(b);
    });
    sizeBlock.appendChild(quick);
    ctrls.appendChild(sizeBlock);

    /* -- 位置 -- */
    var posBlock = h('div', 'pdg-block');
    posBlock.appendChild(h('div', 'pdg-block-title', '位置'));
    rowPos = stepper('第几行', function () { return 1; }, function () { return gridRows() - curArea()[2] + 1; },
      function () { return curArea()[0] + 1; },
      function (v) { applyPos(v - 1, curArea()[1]); }, '行');
    colPos = stepper('第几列', function () { return 1; }, function () { return gridCols() - curArea()[3] + 1; },
      function () { return curArea()[1] + 1; },
      function (v) { applyPos(curArea()[0], v - 1); }, '列');
    posBlock.appendChild(rowPos.node);
    posBlock.appendChild(colPos.node);
    ctrls.appendChild(posBlock);

    // 内容摘要：告诉用户在调哪张图（真正的改图型在右栏，这里不重复做）
    var bodyBlock = h('div', 'pdg-block');
    bodyBlock.appendChild(h('div', 'pdg-block-title', '内容'));
    var ys = (p.ys || []).join('、') || '未选 Y 列';
    var contentLine = h('p', 'pdg-content', '图型 ' + kindName(p.kind) + ' · Y ' + ys);
    bodyBlock.appendChild(contentLine);
    var gotoBtn = h('button', 'btn btn-sm', '去右栏改这张图');
    gotoBtn.type = 'button';
    gotoBtn.addEventListener('click', function () {
      applyPanel(idx);
      renderLayoutUI();
      closePanelDialog(false);
    });
    bodyBlock.appendChild(gotoBtn);
    ctrls.appendChild(bodyBlock);

    function refreshAll() {
      [rowsStep, colsStep, rowPos, colPos].forEach(function (s) { if (s) s.refresh(); });
      // 快捷按钮的高亮：当前面积等于哪个就点亮哪个
      var a = curArea();
      Array.prototype.forEach.call(quick.querySelectorAll('.pdg-quick-btn'), function (b) {
        var on = Number(b.dataset.rs) === a[2] && Number(b.dataset.cs) === a[3];
        b.classList.toggle('is-active', on);
      });
    }

    /* -- 底部按钮 -- */
    var delBtn = h('button', 'btn btn-sm btn-danger', '删除子图');
    delBtn.type = 'button';
    delBtn.disabled = state.panels.length <= 1;
    delBtn.addEventListener('click', function () {
      var m = el('modalMask');
      if (m) m.classList.remove('is-dock-right');
      closeModal();
      // 删除本身已经是一步独立操作，不需要再走"取消还原"
      removePanel(idx);
    });

    var cancelBtn = h('button', 'btn btn-sm', '取消');
    cancelBtn.type = 'button';
    cancelBtn.addEventListener('click', function () { closePanelDialog(true); });

    var okBtn = h('button', 'btn btn-sm btn-primary', '完成');
    okBtn.type = 'button';
    okBtn.addEventListener('click', function () { closePanelDialog(false); });

    openModal('子图设置', body, [delBtn, cancelBtn, okBtn]);
    var mask = el('modalMask');
    if (mask) mask.classList.add('is-dock-right');   // 靠右窄面板，左边画布保持可见

    // 关窗：revert=true 时整块还原（跨格吃掉的兄弟面板也回来）。
    // 非取消路径的改动已经在 applySize/applyPos 里用防抖落进撤销栈了，
    // 所以 Esc、点遮罩这两种"绕开按钮"的关闭方式也不会丢记录。
    function closePanelDialog(revert) {
      var m = el('modalMask');
      if (m) m.classList.remove('is-dock-right');
      closeModal();
      if (revert) {
        state.panels.forEach(function (q, i) {
          q.area = snapAreas[i] ? snapAreas[i].slice() : null;
        });
        state.activePanel = snapActive;
        log('子图设置：已取消');
        pushHistory('取消子图调整');
      }
      applyPanel(state.activePanel);
      renderLayoutUI();
      scheduleRender(0);
    }

    renderMini();
    refreshAll();
  }

  /* ---- 增删子图 ---- */

  function addPanel() {
    commitPanel();
    if (panelTotal() <= 1) {
      toast('先选 1×2 或更大的布局，才有空格子放新子图', 'warn');
      return;
    }
    if (state.panels.length >= 16) {
      toast('面板数量上限 16 个', 'warn');
      return;
    }
    var spot = firstFreeArea(buildOccupancy(-1), 1, 1);
    if (!spot) {
      toast('网格已排满：调大布局，或收缩某个跨格子图', 'warn');
      return;
    }
    var src = state.panels[state.activePanel] || newPanel();
    var p = clonePanel(src);
    p.area = spot;
    p.title = '';          // 复制过来的标题会跟源面板重名，清掉更安全
    p.autoTitle = false;
    state.panels.push(p);
    state.activePanel = state.panels.length - 1;
    applyPanel(state.activePanel);
    renderLayoutUI();
    var pos = panelPlacement(state.activePanel);
    log('新增子图 (' + panelLetter(pos) + ')，共 ' + placedList().length + ' 个面板');
    pushHistory('新增子图');
    scheduleRender(0);
  }

  function removePanel(idx) {
    commitPanel();
    if (state.panels.length <= 1) {
      toast('至少保留一个子图', 'warn');
      return;
    }
    if (!state.panels[idx]) return;
    var letter = panelLetter(panelPlacement(idx)) || '?';
    state.panels.splice(idx, 1);
    if (state.activePanel > idx) state.activePanel -= 1;
    else if (state.activePanel === idx) state.activePanel = Math.max(0, idx - 1);
    if (state.activePanel >= state.panels.length) state.activePanel = state.panels.length - 1;
    normalizeAreas();
    placePanels();          // 空出来的格子让"未放置"的面板补上
    applyPanel(state.activePanel);
    renderLayoutUI();
    log('删除子图 (' + letter + ')，剩 ' + placedList().length + ' 个面板');
    pushHistory('删除子图');
    scheduleRender(0);
  }

  // 未放置的面板：点一下给它找一格空位
  function restorePanel(idx) {
    var p = state.panels[idx];
    if (!p) return;
    var spot = firstFreeArea(buildOccupancy(idx), 1, 1);
    if (!spot) {
      toast('没有空格子了，先收缩某个跨格子图', 'warn');
      return;
    }
    p.area = spot;
    state.activePanel = idx;
    applyPanel(idx);
    renderLayoutUI();
    pushHistory('放回子图');
    scheduleRender(0);
    log('子图放回第 ' + (spot[0] + 1) + ' 行第 ' + (spot[1] + 1) + ' 列');
  }

  function setLayout(rows, cols) {
    commitPanel();
    var r = Math.max(1, Math.min(4, Math.round(Number(rows) || 1)));
    var c = Math.max(1, Math.min(4, Math.round(Number(cols) || 1)));
    if (gridRows() === r && gridCols() === c) return;
    state.gridShape = [r, c];
    // 多子图：自动生成的"y — x"标题太长，2×2 的窄格里会跟相邻面板互相挤压，
    // 所以切进多图时把仍处于"自动标题"状态的面板关掉（用户手改过的保留）。
    // 切回单图时，标题为空的面板重新启用自动标题。
    if (r * c > 1) {
      state.panels.forEach(function (p) {
        if (p.autoTitle) { p.autoTitle = false; p.title = ''; }
      });
    } else {
      state.panels.forEach(function (p) {
        if (!p.title) p.autoTitle = true;
      });
    }
    ensurePanels();
    // 网格变了：先前因放不下而 area=null 的面板重新找位置（放得下就回来）
    placePanels();
    applyPanel(state.activePanel);
    renderLayoutUI();
    log('子图布局：' + r + '×' + c + '（' + (r * c) + ' 格，' + placedList().length + ' 个面板）');
    pushHistory('布局 ' + r + '×' + c);
    scheduleRender(0);
  }

  /**
   * 跨格开关。axis = 'cols' | 'rows'。
   * 打开：span 变 2，被覆盖的面板 area=null（吃掉，但配置留在 state.panels）。
   * 关闭：span 收回 1，再给被吃掉的面板找空位放回去。
   */
  function toggleSpan(axis) {
    commitPanel();
    var idx = state.activePanel;
    var p = state.panels[idx];
    if (!p || !p.area) return;
    var rows = gridRows();
    var cols = gridCols();
    var want = p.area.slice();
    var grow;
    if (axis === 'rows') {
      grow = want[2] < 2;
      want[2] = grow ? 2 : 1;
    } else {
      grow = want[3] < 2;
      want[3] = grow ? 2 : 1;
    }
    // 贴着网格右/下边界时把起点往回收，保证整个 span 仍在网格内
    if (want[0] + want[2] > rows) want[0] = rows - want[2];
    if (want[1] + want[3] > cols) want[1] = cols - want[3];
    if (want[0] < 0 || want[1] < 0) {
      toast(rows < 2 || cols < 2 ? '网格太小，无法跨格' : '已经贴着网格边界，无法继续跨格', 'warn');
      return;
    }

    var eaten = [];
    state.panels.forEach(function (q, i) {
      if (i === idx || !q.area) return;
      if (areasOverlap(q.area, want)) {
        q.area = null;
        eaten.push(q);
      }
    });
    p.area = want;
    // 收回跨格：被吃掉的面板有空位就自动放回
    if (!grow) placePanels();

    var txt = spanText(want) || '1×1';
    var msg = '面板 (' + (panelLetter(panelPlacement(idx)) || 'a') + ') '
      + (grow ? '跨格：' : '取消跨格：') + txt;
    if (eaten.length) {
      msg += '，收起 ' + eaten.length + ' 个面板';
      notifyEaten(eaten.length);
    }
    log(msg);
    renderLayoutUI();
    pushHistory(grow ? '跨格' : '取消跨格');
    scheduleRender(0);
  }

  // 新数据载入后，把各面板里已不存在的列换成当前工作表的默认列
  function remapPanels() {
    ensurePanels();
    var names = columnNames().filter(function (n) { return n !== ''; });
    var nums = names.filter(isNumericColumn);
    var fallbackX = nums.length ? nums[0] : (names[0] || null);
    var fallbackYs = nums.filter(function (n) { return n !== fallbackX; }).slice(0, 2);
    if (!fallbackYs.length && fallbackX && isNumericColumn(fallbackX)) fallbackYs = [fallbackX];

    state.panels.forEach(function (p) {
      if (!p.x || colIndex(p.x) < 0) p.x = fallbackX;
      var ys = (p.ys || []).filter(function (n) { return colIndex(n) >= 0 && isNumericColumn(n); });
      if (!ys.length) ys = fallbackYs.slice();
      p.ys = ys;
      if (p.xerr && colIndex(p.xerr) < 0) p.xerr = null;
      if (p.yerr && colIndex(p.yerr) < 0) p.yerr = null;
    });
  }

  /* ---- 挂到全局，供后续文件互调（无打包器，靠全局作用域） ---- */
  G.newPanel = newPanel;
  G.clonePanel = clonePanel;
  G.normalizePanel = normalizePanel;
  G.gridRows = gridRows;
  G.gridCols = gridCols;
  G.panelTotal = panelTotal;
  G.panelLetter = panelLetter;
  G.panelLabel = panelLabel;
  G.panelPlacement = panelPlacement;
  G.areaValid = areaValid;
  G.areasOverlap = areasOverlap;
  G.areaFreeFor = areaFreeFor;
  G.buildOccupancy = buildOccupancy;
  G.firstFreeArea = firstFreeArea;
  G.normalizeAreas = normalizeAreas;
  G.placePanels = placePanels;
  G.placedList = placedList;
  G.spanText = spanText;
  G.ensurePanels = ensurePanels;
  G.commitPanel = commitPanel;
  G.applyPanel = applyPanel;
  G.renderPanelBar = renderPanelBar;
  G.refreshAxisUI = refreshAxisUI;
  G.renderSpanUI = renderSpanUI;
  G.renderLayoutUI = renderLayoutUI;
  G.renderSizeWarn = renderSizeWarn;
  G.setLayout = setLayout;
  G.toggleSpan = toggleSpan;
  G.remapPanels = remapPanels;
  G.renderLayoutBoard = renderLayoutBoard;
  G.renderUnplaced = renderUnplaced;
  G.openPanelDialog = openPanelDialog;
  G.setAreaLive = setAreaLive;
  G.notifyEaten = notifyEaten;
  G.addPanel = addPanel;
  G.removePanel = removePanel;
  G.restorePanel = restorePanel;
  G.areaRatio = areaRatio;
  G.areaPhysRatio = areaPhysRatio;
  G.ratioText = ratioText;
})(window);
