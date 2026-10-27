/* =============================================================
 * DataLab 前端 · 04-spec.js
 * spec 构建 / 渲染 / 导出
 * 源区间：原 app.js 第 1335–1920 行（按分节切分，未改动任何函数体）
 * 加载顺序由 index.html 决定：必须先加载它前面的脚本，不能单独引用。
 * ============================================================= */
(function (G) {
  'use strict';

  // 渲染序号 + 防抖定时器：只有本文件用（响应回来时丢掉过期的渲染结果）。
  // 放在这里而不是 01-base，是为了不依赖跨文件的隐式全局引用。
  var renderSeq = 0;
  var renderTimer = null;

  /* ------------------------------------------------------------
   * 九、spec 构建（严格按 contract 第 6 节）
   * ---------------------------------------------------------- */

  function currentFitKey() {
    var model = el('selFitModel') ? el('selFitModel').value : 'linear';
    var deg = el('inpDeg') ? el('inpDeg').value : '2';
    var useYerr = el('chkUseYerr') && el('chkUseYerr').checked ? '1' : '0';
    return [state.selectedCols.x || '', state.selectedCols.ys[0] || '', model, deg, useYerr, state.selectedCols.yerr || ''].join('|');
  }

  function figSize() {
    var w = numOrNull(el('inpFigW').value);
    var hh = numOrNull(el('inpFigH').value);
    var fw = (w !== null && w > 0) ? w : state.figW;
    var fh = (hh !== null && hh > 0) ? hh : state.figH;
    return [Math.round(fw * 100) / 100, Math.round(fh * 100) / 100];
  }

  function paletteColors() {
    var p = state.palettes[state.palette];
    if (Array.isArray(p)) return p;
    if (p && Array.isArray(p.colors)) return p.colors;
    var fb = FALLBACK_PALETTES[state.palette];
    if (fb && Array.isArray(fb.colors)) return fb.colors;
    return DEFAULT_COLORS;
  }

  function rowRange() {
    var total = state.rows.length;
    var s = numOrNull(el('inpRowStart').value);
    var e = numOrNull(el('inpRowEnd').value);
    var start = (s !== null && s >= 1) ? Math.floor(s) : 1;
    var end = (e !== null && e >= 1) ? Math.floor(e) : total;
    if (start > total) start = total;
    if (end > total) end = total;
    if (end < start) { var t = start; start = end; end = t; }
    if (start < 1) start = 1;
    return { start: start, end: end, rows: state.rows.slice(start - 1, end) };
  }

  function corr(a, b) {
    var n = Math.min(a.length, b.length);
    var xs = [], ys = [];
    for (var i = 0; i < n; i++) {
      if (a[i] === null || a[i] === undefined || b[i] === null || b[i] === undefined) continue;
      xs.push(a[i]);
      ys.push(b[i]);
    }
    if (xs.length < 2) return null;
    var mx = 0, my = 0;
    for (var j = 0; j < xs.length; j++) { mx += xs[j]; my += ys[j]; }
    mx /= xs.length; my /= xs.length;
    var sxy = 0, sxx = 0, syy = 0;
    for (var k = 0; k < xs.length; k++) {
      var dx = xs[k] - mx, dy = ys[k] - my;
      sxy += dx * dy; sxx += dx * dx; syy += dy * dy;
    }
    if (sxx <= 0 || syy <= 0) return null;
    return Math.round((sxy / Math.sqrt(sxx * syy)) * 10000) / 10000;
  }

  /**
   * 按一份面板配置（{kind,x,ys,xerr,yerr}）构造 series / matrix。
   * 单图与多子图共用这段逻辑，保证两种模式画出来的东西一致。
   */
  function buildPanelSeries(cfg) {
    var kind = cfg.kind;
    var info = null;
    for (var i = 0; i < KINDS.length; i++) {
      if (KINDS[i].id === kind) { info = KINDS[i]; break; }
    }
    if (!info) info = KINDS[0];
    if (info.needFit && !state.fit) return { error: '残差图需要先拟合：请到「拟合」页执行拟合' };

    var ys = (cfg.ys || []).filter(function (n) { return colIndex(n) >= 0; });
    if (!ys.length) return { error: '请在右侧「图表」中选择至少一个 Y 列' };

    var xName = cfg.x;
    var xi = xName ? colIndex(xName) : -1;
    if (info.needX && xi < 0) return { error: '请选择 X 列' };

    // X 是时间列时不做数值转换，ISO 字符串原样送到后端（x_datetime=true）
    var xDatetime = !!(info.needX && xi >= 0 && isDatetimeColumn(xName));

    var range = rowRange();
    var rows = range.rows;
    if (!rows.length) return { error: '过滤后没有数据行，请检查起止行号' };

    var colors = paletteColors();
    function pickColor(idx) {
      if (!colors.length) return undefined;
      return colors[idx % colors.length];
    }

    var xerrI = cfg.xerr ? colIndex(cfg.xerr) : -1;
    var yerrI = cfg.yerr ? colIndex(cfg.yerr) : -1;

    var series = [];
    var matrix = null;

    if (info.needZ) {
      // 三维点/线：Y 列**两两配对**，第 (2k, 2k+1) 两条分别是第 k 条曲线的 Y 与 Z。
      // 列数为奇数时多出来的那一列没有 Z 配对，没法猜也不该猜，直接丢（下面会 log 一句）。
      if (ys.length < 2) {
        return { error: '三维图需要 X 列 + 至少两个 Y 列（第 1 个作 Y 轴，第 2 个作 Z 轴）' };
      }
      if (ys.length % 2 !== 0) {
        log('三维图 Y 列数为奇数，末尾「' + ys[ys.length - 1] + '」没有配对的 Z 列，已忽略', 'warn');
      }
      var nPair = Math.floor(ys.length / 2);
      for (var q = 0; q < nPair; q++) {
        var yName3 = ys[q * 2];
        var zName3 = ys[q * 2 + 1];
        var yi3 = colIndex(yName3);
        var zi3 = colIndex(zName3);
        var xs3 = [], yv3 = [], zv3 = [];
        for (var r3 = 0; r3 < rows.length; r3++) {
          var xv3 = xi >= 0 ? toNum(rows[r3][xi]) : null;
          var y3v = yi3 >= 0 ? toNum(rows[r3][yi3]) : null;
          var z3v = zi3 >= 0 ? toNum(rows[r3][zi3]) : null;
          // 后端要求 x/y/z 三条等长，缺一个都必须整行丢掉
          if (xv3 === null || y3v === null || z3v === null) continue;
          xs3.push(xv3);
          yv3.push(y3v);
          zv3.push(z3v);
        }
        if (!xs3.length) continue;
        series.push({
          // 图例只用 Y 列名；Z 列名走 Z 轴标签（单对时后端会拿 ylabel 顶上）
          name: yName3, x: xs3, y: yv3, z: zv3, kind: kind,
          color: pickColor(q), alpha: 1, label: yName3
        });
      }
    } else if (info.needMatrix) {
      // 三维曲面/柱状：矩阵按「序列为主」，一行一条 Y 序列、一列一个 X 采样点
      // （values[m][n] = 第 m 个 Y 列在第 n 个数据行的高度），与后端 _matrix_array /
      // _matrix_axes 的 arr[i][j] → (ylabels[i], xlabels[j]) 对齐，别搞反。
      if (ys.length < 2) {
        return { error: '三维曲面/柱状需要 X 列 + 至少两个 Y 列（每列一个高度面）' };
      }
      var keepRows = [];
      var xlabM = [];
      for (var rM = 0; rM < rows.length; rM++) {
        var xvM = xi >= 0 ? toNum(rows[rM][xi]) : null;
        if (xvM === null) continue;
        keepRows.push(rM);
        xlabM.push(xvM);
      }
      if (!keepRows.length) return { error: 'X 列没有有效数值，无法构成曲面网格' };
      var yIdxM = ys.map(function (n) { return colIndex(n); });
      var valuesM = ys.map(function (_, mi) {
        var ci = yIdxM[mi];
        return keepRows.map(function (rowAt) {
          return ci >= 0 ? toNum(rows[rowAt][ci]) : null;
        });
      });
      matrix = { values: valuesM, xlabels: xlabM, ylabels: ys.slice() };
      // 占位 series：外围逻辑（以及图例假设）需要有东西，真正的高度在 matrix 里
      series.push({
        name: '高度', x: xlabM.slice(), y: ys.slice(), kind: kind,
        color: pickColor(0), alpha: 1, label: '高度'
      });
    } else if (kind === 'heatmap') {
      var names = [];
      if (xName && isNumericColumn(xName)) names.push(xName);
      ys.forEach(function (n) {
        if (isNumericColumn(n) && names.indexOf(n) < 0) names.push(n);
      });
      if (names.length < 2) return { error: '热力图至少需要两列数值（X 列 + Y 列）' };
      var columnsData = names.map(function (n) {
        var idx = colIndex(n);
        return rows.map(function (r) { return idx >= 0 ? toNum(r[idx]) : null; });
      });
      var values = names.map(function (_, ri) {
        return names.map(function (__, ci) {
          var c = corr(columnsData[ri], columnsData[ci]);
          // 常数列/样本不足时相关系数无定义，用 0 占位避免后端收到 null
          return c === null ? 0 : c;
        });
      });
      matrix = { labels: names.slice(), values: values };
      series.push({
        name: '相关系数', x: names.slice(), y: names.slice(), kind: 'heatmap',
        color: pickColor(0), alpha: 1, label: '相关系数'
      });
    } else if (kind === 'hist' || kind === 'box' || kind === 'violin' || kind === 'qq') {
      ys.forEach(function (name, i) {
        var idx = colIndex(name);
        var vals = [];
        for (var r = 0; r < rows.length; r++) {
          var v = toNum(rows[r][idx]);
          if (v !== null) vals.push(v);
        }
        if (!vals.length) return;
        series.push({
          name: name, x: vals.slice(), y: vals, kind: kind,
          color: pickColor(i), alpha: 1, label: name
        });
      });
    } else {
      var labelize = (kind === 'bar' || kind === 'bar_grouped' || kind === 'bar_stacked' || kind === 'pie');
      var used = (kind === 'bar' || kind === 'pie' || kind === 'residual') ? ys.slice(0, 1) : ys;
      used.forEach(function (name, i) {
        var yi = colIndex(name);
        var xs = [], yv = [], xe = [], ye = [];
        for (var r = 0; r < rows.length; r++) {
          var y = toNum(rows[r][yi]);
          if (y === null) continue;
          var xraw = rows[r][xi];
          var x;
          if (labelize || xDatetime) {
            x = (xraw === null || xraw === undefined || xraw === '') ? '' : String(xraw);
            if (x === '') continue;
          } else {
            x = toNum(xraw);
            if (x === null) continue;
          }
          var e1 = null, e2 = null;
          if (xerrI >= 0) {
            e1 = toNum(rows[r][xerrI]);
            if (e1 === null || e1 < 0) continue;
          }
          if (yerrI >= 0) {
            e2 = toNum(rows[r][yerrI]);
            if (e2 === null || e2 < 0) continue;
          }
          xs.push(x);
          yv.push(y);
          if (xerrI >= 0) xe.push(e1);
          if (yerrI >= 0) ye.push(e2);
        }
        if (!xs.length) return;

        var s = {
          name: name, x: xs, y: yv, kind: kind,
          color: pickColor(i), alpha: 1, label: name
        };
        if (kind === 'line') { s.linestyle = '-'; s.marker = 'none'; }
        else if (kind === 'scatter') { s.linestyle = 'none'; s.marker = 'o'; }
        else if (kind === 'line_marker') { s.linestyle = '-'; s.marker = 'o'; }
        else if (kind === 'errorbar') { s.linestyle = 'none'; s.marker = 'o'; }
        else { s.linestyle = '-'; s.marker = 'none'; }
        if (xerrI >= 0) s.xerr = xe;
        if (yerrI >= 0) s.yerr = ye;
        series.push(s);
      });
    }

    if (!series.length) return { error: '所选列在过滤范围内没有有效数值' };

    // 左右轴指派在这里就合进每条 series：buildSpec 的两个分支都直接拿 b.series，
    // 合在这里比在分支里各补一次更不容易漏（多面板分支尤其容易忘）。
    // 后端只对 _TWIN_OK_KINDS 认这个字段，其余图型会被静默忽略，不会报错。
    var yAxisMap = (cfg.yAxis && typeof cfg.yAxis === 'object') ? cfg.yAxis : {};
    series.forEach(function (s) {
      s.axis = (yAxisMap[s.name] === 'right') ? 'right' : 'left';
    });
    return { series: series, matrix: matrix, kind: kind, xDatetime: xDatetime };
  }

  function buildSpec() {
    if (!state.ds || !state.sheet) return { error: '尚未导入数据，请先拖入 Excel 或 CSV 文件' };

    // 拟合是否过期
    if (state.fit && state.fitKey !== currentFitKey()) {
      state.fit = null;
      clearFitResult();
    }

    ensurePanels();
    commitPanel();

    var total = panelTotal();
    // 只构造"有位置"的面板：area=null 的暂时不渲染，它的配置错误不该挡住别人出图。
    // placed 已按阅读顺序排好，编号 (a)(b)(c) 直接用它的下标。
    var placed = placedList();
    if (!placed.length) placed = [{ index: 0, area: null }];
    var builtMap = {};
    for (var i = 0; i < placed.length; i++) {
      var pi = placed[i].index;
      var one = buildPanelSeries(state.panels[pi]);
      if (one.error) {
        return { error: (placed.length > 1 ? '面板 (' + panelLetter(i) + ')：' : '') + one.error };
      }
      builtMap[pi] = one;
    }

    var binsRaw = numOrNull(el('inpBins').value);
    var bins = (binsRaw !== null && binsRaw >= 3) ? Math.round(binsRaw) : 20;
    var extraBase = {
      show_ci: !!(el('chkPredBand') && el('chkPredBand').checked),
      hist_bins: bins,
      kde: !!(el('chkKde') && el('chkKde').checked),
      residual: !!(el('chkResidual') && el('chkResidual').checked)
    };
    function extraFor(k) {
      return {
        show_ci: extraBase.show_ci,
        hist_bins: extraBase.hist_bins,
        kde: extraBase.kde,
        residual: extraBase.residual,
        qq: k === 'qq'
      };
    }

    var legendLoc = el('selLegendLoc') ? (el('selLegendLoc').value || 'upper right') : 'upper right';

    // 继承字段：主题/配色/图幅/DPI/字号/线宽/标记大小等，多子图时由父 spec 下发
    var base = {
      theme: state.theme,
      palette: state.palette,
      figsize: figSize(),
      dpi: state.dpi,
      font_size: state.fontSize,
      line_width: state.lineWidth,
      marker_size: state.markerSize,
      legend_loc: legendLoc,
      xlim: null,
      ylim: null,
      annotations: [],
      table: null
    };

    function specTitle(p) { return p.autoTitle ? titleFor(p) : (p.title || ''); }
    function specX(p) { return p.autoXlabel ? axisLabelsFor(p).x : (p.xlabel || ''); }
    function specY(p) { return p.autoYlabel ? axisLabelsFor(p).y : (p.ylabel || ''); }
    // Y₂ 标签：用户手写的优先，否则用指派到右轴的那几列自动拼（没有指派就是空串）
    function specY2(p) { return p.y2label || (p.autoYlabel ? axisLabelsFor(p).y2 : ''); }
    // Z 轴标签只对三维图有意义，非三维时返回空串，不要往 spec 里塞无用字段
    function specZ(p) {
      if (!kindIs3D(p.kind)) return '';
      if (!p.autoYlabel) return '';
      return axisLabelsFor(p).z || '';
    }

    if (total === 1) {
      // 1×1：沿用旧版单面板 spec（不发 panels），行为与旧版完全一致
      var p0 = state.panels[placed[0].index] || state.panels[0];
      var b0 = builtMap[placed[0].index];
      var spec = {};
      Object.keys(base).forEach(function (k) { spec[k] = base[k]; });
      spec.kind = p0.kind;
      spec.title = specTitle(p0);
      spec.xlabel = specX(p0);
      spec.ylabel = specY(p0);
      spec.xscale = p0.xscale || 'linear';
      spec.yscale = p0.yscale || 'linear';
      spec.y2label = specY2(p0);
      spec.y2scale = p0.y2scale || 'linear';
      var z0 = specZ(p0);
      if (z0) spec.zlabel = z0;
      spec.grid = !!p0.grid;
      spec.legend = !!p0.legend;
      spec.series = b0.series;
      spec.fit = (state.fit && FIT_KINDS[p0.kind]) ? state.fit : null;
      spec.extra = extraFor(p0.kind);
      if (b0.matrix) spec.matrix = b0.matrix;
      if (b0.xDatetime) spec.x_datetime = true;

      // 分类坐标轴的图表不传 xscale/yscale：后端 _finalize 里调 set_xscale('linear')
      // 会把面板设置好的分类刻度重置成数值刻度（箱线图/热力图的类别名会消失）。
      if (CATEGORICAL_AXIS[p0.kind]) {
        delete spec.xscale;
        if (p0.kind === 'heatmap' || p0.kind === 'pie') delete spec.yscale;
      }
      // 三维同理且更彻底：Axes3D 没有对数轴，传了也要被丢掉
      if (kindIs3D(p0.kind)) {
        delete spec.xscale;
        delete spec.yscale;
      }
      return { spec: spec };
    }

    var panelsOut = [];
    // panelOrder 记下"spec 里的第 i 个面板 = state.panels 的第几个"。
    // 后端返回的 panels_geo.index 是 spec 数组下标，前端靠它反查要改哪个面板的 area。
    var panelOrder = [];
    placed.forEach(function (it, k) {
      var p = state.panels[it.index];
      var b = builtMap[it.index];
      var po = {
        kind: p.kind,
        series: b.series,
        title: specTitle(p),
        xlabel: specX(p),
        ylabel: specY(p),
        xscale: p.xscale || 'linear',
        yscale: p.yscale || 'linear',
        // 双轴按面板各自生效（后端故意不进 _PANEL_LOCKED）
        y2label: specY2(p),
        y2scale: p.y2scale || 'linear',
        grid: !!p.grid,
        legend: !!p.legend,
        // 编号按放置顺序（阅读顺序）分配，不是数组下标
        panel_label: '(' + panelLetter(k) + ')',
        area: it.area ? it.area.slice() : null,
        x_datetime: !!b.xDatetime,
        fit: (it.index === state.activePanel && state.fit && FIT_KINDS[p.kind]) ? state.fit : null,
        annotations: null,
        extra: extraFor(p.kind)
      };
      if (b.matrix) po.matrix = b.matrix;
      var zlab = specZ(p);
      if (zlab) po.zlabel = zlab;
      if (CATEGORICAL_AXIS[p.kind]) {
        delete po.xscale;
        if (p.kind === 'heatmap' || p.kind === 'pie') delete po.yscale;
      }
      if (kindIs3D(p.kind)) {
        delete po.xscale;
        delete po.yscale;
      }
      panelsOut.push(po);
      panelOrder.push(it.index);
    });

    var multi = {};
    Object.keys(base).forEach(function (k) { multi[k] = base[k]; });
    var active = state.panels[state.activePanel] || state.panels[placed[0].index];
    multi.kind = active.kind;
    multi.title = '';
    multi.xlabel = '';
    multi.ylabel = '';
    multi.grid = true;                       // 后端会把 bool 换回 [rows, cols] 形状
    multi.grid_shape = [gridRows(), gridCols()];
    multi.panels = panelsOut;
    multi.share_axes = !!state.shareAxes;
    multi.canvas_grow = state.canvasGrow !== false;
    multi.x_datetime = false;
    multi.series = [];
    multi.extra = extraFor(undefined);
    return { spec: multi, panelOrder: panelOrder };
  }

  /* ------------------------------------------------------------
   * 十、渲染
   * ---------------------------------------------------------- */

  function scheduleRender(delay) {
    clearTimeout(renderTimer);
    var d = (delay === undefined) ? 250 : delay;
    renderTimer = setTimeout(renderNow, d);
    saveSessionSoon();
  }

  /**
   * 设置输出 DPI，并同步输入框 / 档位按钮 / 顶栏提示三处显示。
   *
   * @param {*} raw        来源值：数字框文本或档位按钮的 data-dpi
   * @param {boolean} commit  true = 提交（纠正越界并重绘）；false = 输入过程中的实时同步
   */
  function applyDpi(raw, commit) {
    var v = Number(String(raw === null || raw === undefined ? '' : raw).trim());
    if (!isFinite(v) || v <= 0) {
      if (commit) applyDpi(state.dpi, true);   // 清空/乱填 -> 退回上次合法值
      return;
    }
    v = Math.round(v);
    var clamped = Math.min(DPI_MAX, Math.max(DPI_MIN, v));
    var changed = clamped !== state.dpi;
    state.dpi = clamped;

    var inp = el('inpDpi');
    if (inp && String(inp.value) !== String(clamped)) inp.value = String(clamped);
    var badge = el('valDpi');
    if (badge) badge.textContent = String(clamped);
    var hint = el('dpiHint');
    if (hint) hint.textContent = clamped + ' dpi';

    var box = el('dpiPresets');
    if (box) {
      Array.prototype.forEach.call(box.querySelectorAll('.dpi-preset'), function (b) {
        var active = Number(b.getAttribute('data-dpi')) === clamped;
        b.classList.toggle('is-active', active);
        b.setAttribute('aria-pressed', active ? 'true' : 'false');
      });
    }

    if (clamped !== v) {
      log('DPI ' + v + ' 超出 ' + DPI_MIN + '–' + DPI_MAX + '，已收敛为 ' + clamped);
      scheduleRender(0);
    } else if (commit && changed) {
      scheduleRender(0);
    }
  }

  function setDownloadsEnabled(on) {
    ['btnDlPng', 'btnDlSvg', 'btnDlPdf', 'btnDlEps'].forEach(function (id) {
      var b = el(id);
      if (b) b.disabled = !on;
    });
    var top = el('btnExportImg');
    if (top) top.disabled = !on;
  }

  // 降采样说明：一条序列一句，多条合并成一句（避免状态栏被刷屏）
  function downsampleMessage(list) {
    if (!Array.isArray(list) || !list.length) return '';
    var method = function (m) { return String(m || 'lttb').toUpperCase(); };
    if (list.length === 1) {
      var one = list[0];
      return '原始 ' + fmtInt(one.original) + ' 点 → 保形抽稀为 ' + fmtInt(one.kept)
        + ' 点（' + method(one.method) + '）';
    }
    var maxOrig = 0, maxKept = 0, segs = 0;
    list.forEach(function (d) {
      maxOrig = Math.max(maxOrig, Number(d.original) || 0);
      maxKept = Math.max(maxKept, Number(d.kept) || 0);
      segs += Number(d.segments) || 0;
    });
    return list.length + ' 条序列超出点数上限，已用 ' + method(list[0].method)
      + ' 保形抽稀（最长 ' + fmtInt(maxOrig) + ' → ' + fmtInt(maxKept) + ' 点'
      + (segs > 1 ? '，共 ' + segs + ' 段' : '') + '）';
  }

  function setMeta(ms, spec, extra) {
    var meta = el('chartMeta');
    if (!meta) return;
    clear(meta);
    var ex = extra || {};
    var kindLabel = ex.kind || (spec && spec.kind ? kindName(spec.kind) : '');
    if (kindLabel) meta.appendChild(h('span', 'meta-chip kind', kindLabel));
    if (ms !== null && ms !== undefined) meta.appendChild(h('span', 'meta-chip', ms + ' ms'));
    if (spec) {
      // 一律显示服务端实际生效的值：图幅可能被网格放大过、dpi 可能被像素上限压过，
      // 拿请求值显示等于给用户看一个没兑现的承诺（20×20in @1200dpi 实际出不来）。
      var fw = Number(ex.figsize_used && ex.figsize_used[0]);
      var fh = Number(ex.figsize_used && ex.figsize_used[1]);
      var sizeLabel;
      if (fw > 0 && fh > 0) sizeLabel = fw + '×' + fh + ' in';
      else if (spec.figsize) sizeLabel = spec.figsize[0] + '×' + spec.figsize[1] + ' in';
      if (sizeLabel) {
        var sizeChip = h('span', 'meta-chip', sizeLabel);
        // 画布被网格放大过就标出来，否则用户会以为自己把图幅设错了
        if (ex.canvas_grown) {
          sizeChip.title = '多子图：画布已按行列数放大，每个子图仍是你设定的那一格图幅';
          sizeChip.className = 'meta-chip meta-auto';
          sizeChip.appendChild(h('em', '', '已放大'));
        }
        meta.appendChild(sizeChip);
      }
      var usedDpi = Number(ex.dpi_used) || Number(spec.dpi) || 0;
      if (usedDpi > 0) {
        var dpiChip = h('span', 'meta-chip', usedDpi + ' dpi');
        if (ex.dpi_capped && Number(spec.dpi) > usedDpi) {
          dpiChip.className = 'meta-chip meta-warn';
          dpiChip.title = '预览已自动降到 ' + usedDpi + ' dpi：'
            + spec.figsize[0] + '×' + spec.figsize[1] + ' in 配 ' + spec.dpi
            + ' dpi 会超过浏览器能解码的图片尺寸。导出时仍按 ' + spec.dpi + ' dpi 输出。';
          dpiChip.appendChild(h('em', '', '预览降样'));
        }
        meta.appendChild(dpiChip);
      }
      var count = ex.series;
      if (count === undefined || count === null) {
        count = Array.isArray(spec.series) ? spec.series.length : 0;
      }
      if (ex.panels && ex.panels > 1) {
        meta.appendChild(h('span', 'meta-chip', ex.panels + ' 面板 · ' + count + ' 序列'));
      } else if (count) {
        meta.appendChild(h('span', 'meta-chip', count + ' 序列'));
      }
    }
    if (ex.downsample && ex.downsample.length) {
      var chip = h('span', 'meta-chip meta-warn', '已抽稀 ' + ex.downsample.length + ' 条');
      chip.title = downsampleMessage(ex.downsample);
      meta.appendChild(chip);
    }
  }

  function showGuide(title, msg, isError, allowRetry) {
    var g = el('guidePanel');
    if (!g) return;
    g.hidden = false;
    var wrap = el('chartWrap');
    if (wrap) wrap.hidden = true;
    setMeta(null, null);
    var t = el('guideTitle');
    var m = el('guideMsg');
    if (t) t.textContent = title || '拖拽 Excel / CSV 文件到这里';
    if (m) m.textContent = msg || '支持 .xlsx / .xls / .csv，自动识别多工作表；所有解析、统计与绘图都在本机完成。';
    g.classList.toggle('guide-error', !!isError);
    var retry = el('btnGuideRetry');
    if (retry) retry.hidden = !(isError && allowRetry);
    setDownloadsEnabled(false);
    resetZoom();
    renderRecent();
  }

  function renderNow() {
    clearTimeout(renderTimer);
    var seq = ++renderSeq;
    var built = buildSpec();
    if (built.error) {
      showOverlay(false);
      showGuide(state.ds ? '请完善图表配置' : undefined, built.error, false, false);
      return;
    }
    var spec = built.spec;
    showOverlay(true, '正在渲染…');
    var t0 = (window.performance && performance.now) ? performance.now() : Date.now();

    api('/api/plot/render', { ds: state.ds, sheet: state.sheet, spec: spec }).then(function (data) {
      if (seq !== renderSeq) return;
      var b64 = data.png_b64 || data.png || '';
      if (!b64) throw new Error('服务端未返回图片数据');
      var img = el('chartImg');
      if (img) img.src = /^data:/i.test(String(b64)) ? String(b64) : 'data:image/png;base64,' + stripDataUri(b64);
      var g = el('guidePanel');
      if (g) g.hidden = true;
      var wrap = el('chartWrap');
      if (wrap) wrap.hidden = false;
      // 换图后回到 1×，避免平移残留指到空白处。
      // 占位层要在这之后重建：它按图片的显示尺寸换算，缩放为 1 时算出来的偏移才是干净的。
      resetZoom();
      applyGeoLayer(data.panels_geo, built.panelOrder);
      var msRaw = Number(data.elapsed_ms);
      var ms = Number.isFinite(msRaw) ? Math.round(msRaw) : Math.round(((window.performance && performance.now) ? performance.now() : Date.now()) - t0);

      var multi = Array.isArray(spec.panels) && spec.panels.length > 0;
      var panelN = multi ? spec.panels.length : 1;
      var seriesN;
      if (multi) {
        seriesN = 0;
        spec.panels.forEach(function (p) { seriesN += (p.series || []).length; });
      } else {
        seriesN = (spec.series || []).length;
      }
      var kindLabel = multi
        ? (state.gridShape[0] + '×' + state.gridShape[1] + ' 多子图')
        : kindName(spec.kind);
      var dsList = Array.isArray(data.downsample) ? data.downsample : [];
      var dsMsg = downsampleMessage(dsList);

      state.lastRender = data;
      state.lastSpec = spec;
      state.lastElapsed = ms;
      setMeta(ms, spec, { kind: kindLabel, panels: panelN, series: seriesN,
                          downsample: dsList,
                          figsize_used: data.figsize_used, dpi_used: data.dpi_used,
                          dpi_capped: data.dpi_capped,
                          canvas_grown: data.canvas_grown });
      setDownloadsEnabled(true);
      syncBackend(ms);
      setBackendState('ready', '就绪');
      setBackendMsg('渲染完成：' + kindLabel + '，' + seriesN + ' 条序列，'
        + ms + ' ms · 输出 ' + Math.round((data.bytes || 0) / 1024) + ' KB'
        + (dsMsg ? ' · ' + dsMsg : ''), 'ok');
      log('渲染完成：' + kindLabel + '，' + seriesN + ' 条序列，' + ms + ' ms');
      if (dsMsg) log('降采样：' + dsMsg, 'warn');
    }).catch(function (err) {
      if (seq !== renderSeq) return;
      var msg = err && err.message ? err.message : String(err);
      toast('渲染失败：' + msg, 'error');
      log('渲染失败：' + msg, 'error');
      setBackendState('error', '异常');
      setBackendMsg('渲染失败：' + msg, 'error');
      showGuide('渲染失败', msg, true, true);
    }).then(function () {
      if (seq === renderSeq) showOverlay(false);
    });
  }

  // 四种格式统一走 /api/plot/export：后端落盘一份，同时把字节流回传，
  // 前端建 Blob 触发浏览器下载，用户不用再去 output 目录翻文件。
  var FIG_MIME = {
    png: 'image/png',
    svg: 'image/svg+xml',
    pdf: 'application/pdf',
    eps: 'application/postscript'
  };

  function downloadPng() { exportFigure('png'); }

  function downloadSvg() { exportFigure('svg'); }

  function currentSpecOrBuild() {
    var built = buildSpec();
    if (!built.error) return built;
    if (state.lastSpec) return { spec: state.lastSpec };
    return built;
  }

  function exportFigure(fmt) {
    if (!state.ds || !state.sheet) { toast('请先导入数据', 'error'); return; }
    var built = currentSpecOrBuild();
    if (built.error) { toast(built.error, 'error'); return; }
    var upper = String(fmt || 'png').toUpperCase();
    toast('正在导出 ' + upper + '…', 'info');
    api('/api/plot/export', {
      ds: state.ds, sheet: state.sheet, spec: built.spec, fmt: fmt, dpi: state.dpi
    }).then(function (data) {
      var path = data.path || data.file || '';
      var name = data.filename || baseName(path) || ('datalab-' + fmt + '-' + Date.now() + '.' + fmt);
      var mime = data.mime || FIG_MIME[fmt] || 'application/octet-stream';
      if (data.data_b64) {
        downloadBlob(b64ToBlob(data.data_b64, mime), name);
        toast('已下载 ' + name, 'success');
        if (path) toast('同时已保存到 ' + path, 'info');
        markExported('已导出 ' + upper + '：' + name + (path ? '（同时已保存到 ' + path + '）' : ''));
        log('导出 ' + upper + '：已下载 ' + name + (path ? '，同时已保存到 ' + path : ''));
      } else {
        // 老接口/异常情况下没有字节流，退回"告诉你文件在哪"
        markExported('已导出 ' + upper + '：' + (path || '完成'));
        toast(path ? ('已保存：' + baseName(path)) : '导出完成', 'success');
        log('导出 ' + upper + '：' + (path || '完成'));
      }
    }).catch(function (err) {
      var msg = err && err.message ? err.message : String(err);
      toast('导出失败：' + msg, 'error');
      log('导出失败：' + msg, 'error');
    });
  }

  function exportData(fmt) {
    if (!state.ds || !state.sheet) { toast('请先导入数据', 'error'); return; }
    api('/api/data/export', { ds: state.ds, sheet: state.sheet, fmt: fmt }).then(function (data) {
      var path = data.path || data.file || '';
      markExported('已导出数据（' + fmt + '）：' + (path || '完成'));
      toast(path ? ('已保存：' + baseName(path)) : '数据导出完成', 'success');
      log('导出数据（' + fmt + '）：' + (path || '完成'));
    }).catch(function (err) {
      var msg = err && err.message ? err.message : String(err);
      toast('导出失败：' + msg, 'error');
      log('导出失败：' + msg, 'error');
    });
  }

  /* ---- 挂到全局，供后续文件互调（无打包器，靠全局作用域） ---- */
  G.currentFitKey = currentFitKey;
  G.figSize = figSize;
  G.paletteColors = paletteColors;
  G.rowRange = rowRange;
  G.corr = corr;
  G.buildPanelSeries = buildPanelSeries;
  G.buildSpec = buildSpec;
  G.scheduleRender = scheduleRender;
  G.applyDpi = applyDpi;
  G.setDownloadsEnabled = setDownloadsEnabled;
  G.downsampleMessage = downsampleMessage;
  G.setMeta = setMeta;
  G.showGuide = showGuide;
  G.renderNow = renderNow;
  G.FIG_MIME = FIG_MIME;
  G.downloadPng = downloadPng;
  G.downloadSvg = downloadSvg;
  G.currentSpecOrBuild = currentSpecOrBuild;
  G.exportFigure = exportFigure;
  G.exportData = exportData;
})(window);
