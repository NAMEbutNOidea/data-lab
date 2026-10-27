/* =============================================================
 * DataLab 前端 · 05-interact.js
 * 缩放平移 / 撤销重做 / 会话恢复 / 最近打开
 * 源区间：原 app.js 第 1921–2262 行（按分节切分，未改动任何函数体）
 * 加载顺序由 index.html 决定：必须先加载它前面的脚本，不能单独引用。
 * ============================================================= */
(function (G) {
  'use strict';

  /* ------------------------------------------------------------
   * 十·一、画布缩放 / 平移（纯 CSS transform，不重新请求后端）
   *
   * 变换目标有两个：
   * - 单图（没有占位层）：沿用旧做法，transform 直接给 #chartImg。
   * - 多子图（有占位层）：transform 给外层 #chartStage，img 与占位层一起缩放平移，
   *   否则两层各自算坐标，一缩放就错位。
   * ---------------------------------------------------------- */

  // 占位层是否生效。为 true 时左键拖动归"移动面板"，平移必须按 Shift。
  var geoOn = false;
  var geoCells = [];        // [{node, frac:[x0,y0,w0,h0]}]，图片尺寸变化时按 frac 重排
  var geoSeq = 0;           // 防止上一张图的 load 回调把新图的占位层重算掉
  var panelDrag = null;     // 拖动中的面板：{idx, node, moved}
  var panDrag = null;       // 平移画布

  function chartStage() { return el('chartStage'); }

  function geoLayer() { return el('chartGeoLayer'); }

  function applyZoom() {
    var img = el('chartImg');
    var stage = chartStage();
    // 占位层跟 stage 一起变换，img 自己的 transform 必须清空，否则会缩放两次
    var host = (geoOn && stage) ? stage : img;
    var other = host === stage ? img : stage;
    if (other && other.style.transform) other.style.transform = '';
    var z = state.zoom;
    if (host) {
      if (z.scale === 1 && z.x === 0 && z.y === 0) {
        host.style.transform = '';
      } else {
        host.style.transform = 'translate(' + z.x.toFixed(2) + 'px,'
          + z.y.toFixed(2) + 'px) scale(' + z.scale.toFixed(3) + ')';
      }
    }
    var hud = el('zoomHud');
    if (hud) hud.hidden = !(z.scale !== 1 || z.x !== 0 || z.y !== 0);
    var lab = el('zoomLabel');
    if (lab) lab.textContent = (z.scale < 2 ? z.scale.toFixed(2) : z.scale.toFixed(1)) + '×';
    var wrap = el('chartWrap');
    if (wrap) wrap.classList.toggle('is-zoomed', z.scale !== 1);
  }

  function resetZoom() {
    state.zoom = { scale: 1, x: 0, y: 0 };
    applyZoom();
  }

  /* ---- 占位层：把后端的 panels_geo 换算成透明 div ---- */

  function clearGeo() {
    var layer = geoLayer();
    if (layer) clear(layer);
    geoCells = [];
    geoOn = false;
    geoSeq++;
    panelDrag = null;
    var drop = el('geoDrop');
    if (drop) drop.hidden = true;
    var stage = chartStage();
    if (stage) stage.style.transform = '';
    var wrap = el('chartWrap');
    if (wrap) {
      wrap.classList.remove('geo-mode');
      wrap.classList.remove('is-panel-dragging');
    }
  }

  function whenImageReady(fn) {
    var img = el('chartImg');
    if (!img) return;
    if (img.complete && img.naturalWidth) { fn(); return; }
    var seq = geoSeq;
    var onLoad = function () {
      img.removeEventListener('load', onLoad);
      if (seq !== geoSeq) return;
      fn();
    };
    img.addEventListener('load', onLoad);
  }

  // 按图片的**显示尺寸**（不含 transform）摆放占位层与每个格子
  function layoutGeo() {
    var img = el('chartImg');
    var layer = geoLayer();
    if (!img || !layer) return;
    var W = img.clientWidth;
    var H = img.clientHeight;
    if (!W || !H) return;              // 图还没解码完，等 load 回调再来一次
    var ox = img.offsetLeft + img.clientLeft;
    var oy = img.offsetTop + img.clientTop;
    layer.style.left = ox + 'px';
    layer.style.top = oy + 'px';
    layer.style.width = W + 'px';
    layer.style.height = H + 'px';
    geoCells.forEach(function (c) {
      var f = c.frac;
      // figure 比例（原点左下）→ CSS 像素（原点左上）
      c.node.style.left = (f[0] * W).toFixed(2) + 'px';
      c.node.style.top = ((1 - f[1] - f[3]) * H).toFixed(2) + 'px';
      c.node.style.width = (f[2] * W).toFixed(2) + 'px';
      c.node.style.height = (f[3] * H).toFixed(2) + 'px';
    });
    var drop = el('geoDrop');
    if (drop) drop.hidden = true;      // 尺寸变了，旧的落点框先收起来
  }

  /**
   * 用后端返回的 panels_geo 叠一层透明占位 div。
   * 后端还没实现（返回体里没有 panels_geo）时清空并返回，行为退回旧的"只平移"，
   * 不建占位层也不报错。
   *
   * @param {Array} geo      panels_geo：[{index, area, label, rect}]
   * @param {Array} order    spec 下标 -> state.panels 下标（buildSpec 的 panelOrder）
   */
  function applyGeoLayer(geo, order) {
    clearGeo();
    if (!Array.isArray(geo) || !geo.length) { applyZoom(); return; }
    var layer = geoLayer();
    if (!layer) { applyZoom(); return; }
    var map = Array.isArray(order) ? order : [];
    var n = 0;
    geo.forEach(function (g) {
      if (!g || typeof g !== 'object') return;
      var rect = g.rect;
      if (!Array.isArray(rect) || rect.length !== 4) return;
      var x0 = Number(rect[0]);
      var y0 = Number(rect[1]);
      var w0 = Number(rect[2]);
      var h0 = Number(rect[3]);
      if (!isFinite(x0) || !isFinite(y0) || !(w0 > 0) || !(h0 > 0)) return;
      var si = Number(g.index);
      var idx = (isFinite(si) && map[si] !== undefined) ? Number(map[si]) : si;
      if (!(idx >= 0 && idx < state.panels.length)) return;
      var node = h('div', 'geo-cell');
      node.dataset.panel = String(idx);
      node.title = '拖动这个面板：落到另一个面板上＝交换位置，落到空格子＝移过去';
      layer.appendChild(node);
      geoCells.push({ node: node, frac: [x0, y0, w0, h0], index: idx });
      n++;
    });
    if (!n) { clearGeo(); applyZoom(); return; }

    geoOn = true;
    geoSeq++;
    var wrap = el('chartWrap');
    if (wrap) wrap.classList.add('geo-mode');
    layoutGeo();
    whenImageReady(layoutGeo);
    applyZoom();
  }

  /**
   * 从各面板框的并集反推网格单元。
   * tight_layout 会留出刻度与轴标签的边距，单格边界只能算个近似值；
   * 但拖拽只需要判断"落点属于哪一格"，这个近似足够稳。
   */
  function gridBox() {
    if (!geoCells.length) return null;
    var x0 = 2, y0 = 2, x1 = -1, y1 = -1;
    geoCells.forEach(function (c) {
      var f = c.frac;
      var left = f[0];
      var top = 1 - f[1] - f[3];
      x0 = Math.min(x0, left);
      y0 = Math.min(y0, top);
      x1 = Math.max(x1, left + f[2]);
      y1 = Math.max(y1, top + f[3]);
    });
    if (!(x1 > x0) || !(y1 > y0)) return null;
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }

  // 鼠标位置 -> 网格格（含 gridBox，落点框要靠它算像素位置）
  function cellAtPoint(clientX, clientY) {
    var img = el('chartImg');
    var box = gridBox();
    if (!img || !box) return null;
    var r = img.getBoundingClientRect();       // 已包含 stage 上的缩放/平移
    if (!r.width || !r.height) return null;
    var fx = (clientX - r.left) / r.width;
    var fy = (clientY - r.top) / r.height;
    if (fx < 0 || fx > 1 || fy < 0 || fy > 1) return null;
    var rows = gridRows();
    var cols = gridCols();
    var col = Math.floor((fx - box.x) / (box.w / cols));
    var row = Math.floor((fy - box.y) / (box.h / rows));
    if (col < 0) col = 0;
    if (col > cols - 1) col = cols - 1;
    if (row < 0) row = 0;
    if (row > rows - 1) row = rows - 1;
    return { row: row, col: col, box: box };
  }

  function cellBox(row, col, box) {
    var rows = gridRows();
    var cols = gridCols();
    return {
      x: box.x + col * box.w / cols,
      y: box.y + row * box.h / rows,
      w: box.w / cols,
      h: box.h / rows
    };
  }

  // 拖动中的目标高亮：虚线框，跟着落点走
  function showDropTarget(cell) {
    var drop = el('geoDrop');
    var img = el('chartImg');
    if (!drop || !img || !cell) {
      if (drop) drop.hidden = true;
      return;
    }
    var W = img.clientWidth;
    var H = img.clientHeight;
    if (!W || !H) { drop.hidden = true; return; }
    var f = cellBox(cell.row, cell.col, cell.box);
    var ox = img.offsetLeft + img.clientLeft;
    var oy = img.offsetTop + img.clientTop;
    drop.style.left = (ox + f.x * W).toFixed(2) + 'px';
    drop.style.top = (oy + f.y * H).toFixed(2) + 'px';
    drop.style.width = (f.w * W).toFixed(2) + 'px';
    drop.style.height = (f.h * H).toFixed(2) + 'px';
    drop.hidden = false;
  }

  function panelAtCell(row, col) {
    var list = placedList();
    for (var i = 0; i < list.length; i++) {
      var a = list[i].area;
      if (row >= a[0] && row < a[0] + a[2] && col >= a[1] && col < a[1] + a[3]) return list[i];
    }
    return null;
  }

  /**
   * 松手结算：落在别的面板上 → 交换 area（位置和大小一起换，内容跟着面板走）；
   * 落在空格子 → 移过去（span 保持，放不下退成 1×1）。
   */
  function dropPanelTo(srcIdx, cell) {
    var src = state.panels[srcIdx];
    if (!src || !src.area || !cell) return;
    var target = panelAtCell(cell.row, cell.col);

    if (target) {
      if (target.index === srcIdx) return;      // 落回自己身上，什么都不做
      var a = src.area.slice();
      var b = target.area.slice();
      src.area = b;
      state.panels[target.index].area = a;
      log('交换面板：' + areaText(a) + ' ⇄ ' + areaText(b));
      // 位置变了，切换条的顺序与 (a)(b)(c) 编号都要跟着重排
      renderLayoutUI();
      pushHistory('移动面板');
      scheduleRender(0);
      return;
    }

    var want = [cell.row, cell.col, src.area[2], src.area[3]];
    if (!areaValid(want) || !areaFreeFor(want, srcIdx)) {
      want = [cell.row, cell.col, 1, 1];        // 跨格放不下就按 1×1
    }
    if (!areaValid(want) || !areaFreeFor(want, srcIdx)) {
      toast('这一格放不下，已忽略', 'warn');
      return;
    }
    log('面板移到第 ' + (cell.row + 1) + ' 行第 ' + (cell.col + 1) + ' 列');
    src.area = want;
    renderLayoutUI();
    pushHistory('移动面板');
    scheduleRender(0);
  }

  function areaText(a) {
    if (!a) return '';
    return '[' + (a[0] + 1) + ',' + (a[1] + 1) + ' ' + a[2] + '×' + a[3] + ']';
  }

  function startPan(e) {
    panDrag = { sx: e.clientX, sy: e.clientY, ox: state.zoom.x, oy: state.zoom.y };
    var img = el('chartImg');
    if (img) img.classList.add('is-panning');
    var wrap = el('chartWrap');
    if (wrap) wrap.classList.add('is-panning');
  }

  function stopPan() {
    if (!panDrag) return;
    panDrag = null;
    var img = el('chartImg');
    if (img) img.classList.remove('is-panning');
    var wrap = el('chartWrap');
    if (wrap) wrap.classList.remove('is-panning');
  }

  function bindPanelDrag() {
    var layer = geoLayer();
    if (!layer) return;

    // 占位格在图层里，事件会冒泡到这里：按住 Shift 时改走平移
    layer.addEventListener('mousedown', function (e) {
      if (e.button !== 0) return;
      if (e.shiftKey || !geoOn) { startPan(e); e.preventDefault(); return; }
      var cell = e.target.closest ? e.target.closest('.geo-cell') : null;
      if (!cell) return;
      var idx = Number(cell.dataset.panel);
      if (!Number.isFinite(idx)) return;
      panelDrag = { idx: idx, node: cell, moved: false };
      cell.classList.add('is-dragging');
      var wrap = el('chartWrap');
      if (wrap) wrap.classList.add('is-panel-dragging');
      e.preventDefault();
      e.stopPropagation();
    });

    document.addEventListener('mousemove', function (e) {
      if (!panelDrag) return;
      panelDrag.moved = true;
      var hit = cellAtPoint(e.clientX, e.clientY);
      // 落点还在自己身上（或拖到图外）就不画目标框，免得看起来像能放
      if (!hit) { showDropTarget(null); return; }
      var t = panelAtCell(hit.row, hit.col);
      if (t && t.index === panelDrag.idx) { showDropTarget(null); return; }
      showDropTarget(hit);
    });

    document.addEventListener('mouseup', function (e) {
      if (!panelDrag) return;
      var drag = panelDrag;
      panelDrag = null;
      if (drag.node) drag.node.classList.remove('is-dragging');
      var wrap = el('chartWrap');
      if (wrap) wrap.classList.remove('is-panel-dragging');
      showDropTarget(null);
      if (!drag.moved) {
        // 单击没拖动 = 选中这一格，右栏跟着切过去，接着就能改图型 / 映射
        if (drag.idx !== state.activePanel) {
          applyPanel(drag.idx);
          renderLayoutUI();
          log('选中子图 ' + (panelLabel(drag.idx) || ''));
        }
        return;
      }
      var hit = cellAtPoint(e.clientX, e.clientY);
      if (hit) dropPanelTo(drag.idx, hit);
    });

    // 双击子图 = 打开它的设置窗口（左键已被拖拽占用，双击是不冲突的补充入口）
    layer.addEventListener('dblclick', function (e) {
      var cell = e.target.closest ? e.target.closest('.geo-cell') : null;
      if (!cell) return;
      var idx = Number(cell.dataset.panel);
      if (!Number.isFinite(idx)) return;
      e.preventDefault();
      e.stopPropagation();
      openPanelDialog(idx);
    });

    // 占位层空白处的双击回落成"复位缩放"，跟单图时 img 上的双击一致
    layer.addEventListener('dblclick', function (e) {
      if (e.target.closest && e.target.closest('.geo-cell')) return;
      resetZoom();
    });

    // 双击复位（多子图时 img 被占位层盖住，事件落不到 img 上）
    layer.addEventListener('dblclick', function () {
      if (geoOn) resetZoom();
    });
  }

  function bindZoom() {
    var wrap = el('chartWrap');
    var img = el('chartImg');
    if (!wrap || !img) return;

    // 滚轮缩放：以鼠标位置为锚点，缩放范围 0.5×–8×
    wrap.addEventListener('wheel', function (e) {
      if (wrap.hidden) return;
      e.preventDefault();
      var z = state.zoom;
      var factor = Math.exp(-e.deltaY * 0.0016);
      var next = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z.scale * factor));
      if (Math.abs(next - z.scale) < 1e-4) return;

      var r = wrap.getBoundingClientRect();
      var cx = r.left + r.width / 2;
      var cy = r.top + r.height / 2;
      var k = next / z.scale;
      // 保持鼠标下的像素点不动：t1 = t0 + (1-k)*(P-C-t0)
      z.x += (1 - k) * (e.clientX - cx - z.x);
      z.y += (1 - k) * (e.clientY - cy - z.y);
      z.scale = next;
      if (Math.abs(z.scale - 1) < 1e-3) {
        z.scale = 1;
        z.x = 0;
        z.y = 0;
      }
      applyZoom();
    }, { passive: false });

    // 拖拽平移：多子图时左键归"移动面板"，必须按住 Shift 才是平移（滚轮不变）
    img.addEventListener('mousedown', function (e) {
      if (e.button !== 0) return;
      if (geoOn && panelTotal() > 1 && !e.shiftKey) return;
      startPan(e);
      e.preventDefault();
    });
    document.addEventListener('mousemove', function (e) {
      if (!panDrag) return;
      state.zoom.x = panDrag.ox + (e.clientX - panDrag.sx);
      state.zoom.y = panDrag.oy + (e.clientY - panDrag.sy);
      applyZoom();
    });
    document.addEventListener('mouseup', function () { stopPan(); });
    img.addEventListener('dblclick', function () { resetZoom(); });
    on('btnZoomReset', 'click', resetZoom);

    bindPanelDrag();

    // 窗口尺寸变了图片显示尺寸也会变，占位层按新尺寸重排
    window.addEventListener('resize', function () {
      if (geoOn) layoutGeo();
    });
  }

  /* ------------------------------------------------------------
   * 十·二、撤销 / 重做（只对配置类操作做快照）
   * ---------------------------------------------------------- */

  var historyStack = [];
  var histIndex = -1;
  var histTimer = null;

  function snapshotConfig() {
    commitPanel();
    return JSON.stringify({
      gridShape: state.gridShape.slice(),
      shareAxes: !!state.shareAxes,
      canvasGrow: state.canvasGrow !== false,
      activePanel: state.activePanel,
      panels: state.panels,
      theme: state.theme,
      palette: state.palette,
      dpi: state.dpi,
      figW: state.figW,
      figH: state.figH,
      fontSize: state.fontSize,
      lineWidth: state.lineWidth,
      markerSize: state.markerSize,
      legendLoc: el('selLegendLoc') ? el('selLegendLoc').value : 'upper right'
    });
  }

  function pushHistory(label) {
    var snap;
    try { snap = snapshotConfig(); } catch (e) { return; }
    if (histIndex >= 0 && historyStack[histIndex] && historyStack[histIndex].snap === snap) { saveSession(); return; }
    historyStack = historyStack.slice(0, histIndex + 1);
    historyStack.push({ snap: snap, label: label || '配置变更' });
    while (historyStack.length > HIST_MAX) historyStack.shift();
    histIndex = historyStack.length - 1;
    saveSession();
  }

  // 拖动滑块 / 连续输入用防抖，避免一次拖动塞满 50 步
  function pushHistorySoon(label) {
    clearTimeout(histTimer);
    histTimer = setTimeout(function () { pushHistory(label); }, 450);
  }

  // 初始化收尾：把历史栈收敛成"只有初始状态"一条。
  // 历史栈是本文件的私有变量，由本文件改写，别的文件不要直接赋值。
  function resetHistory() {
    pushHistory('初始状态');
    histIndex = 0;
    historyStack = historyStack.slice(0, 1);
  }

  function applySnapshot(snapStr) {
    var d;
    try { d = JSON.parse(snapStr); } catch (e) { return; }
    if (Array.isArray(d.gridShape) && d.gridShape.length >= 2) {
      state.gridShape = [Number(d.gridShape[0]) || 1, Number(d.gridShape[1]) || 1];
    }
    state.shareAxes = !!d.shareAxes;
    if (d.canvasGrow !== undefined) state.canvasGrow = !!d.canvasGrow;
    if (Array.isArray(d.panels) && d.panels.length) state.panels = d.panels.map(normalizePanel);
    state.activePanel = Number(d.activePanel) || 0;
    ensurePanels();

    if (d.theme) state.theme = d.theme;
    if (d.palette) state.palette = d.palette;
    state.dpi = Number(d.dpi) || state.dpi;
    state.figW = Number(d.figW) || state.figW;
    state.figH = Number(d.figH) || state.figH;
    state.fontSize = Number(d.fontSize) || state.fontSize;
    state.lineWidth = Number(d.lineWidth) || state.lineWidth;
    state.markerSize = Number(d.markerSize) || state.markerSize;
    if (d.legendLoc && el('selLegendLoc')) el('selLegendLoc').value = d.legendLoc;

    syncStyleControls();
    renderThemeGrid();
    renderPaletteGrid();
    renderLayoutUI();
    applyPanel(state.activePanel);
    scheduleRender(0);
  }

  function undo() {
    if (histIndex <= 0) { toast('没有可撤销的操作', 'warn'); return; }
    var undone = historyStack[histIndex];
    histIndex--;
    applySnapshot(historyStack[histIndex].snap);
    var msg = '已撤销：' + ((undone && undone.label) || '上一步');
    toast(msg, 'info');
    log(msg);
    setBackendMsg(msg, 'ok');
  }

  function redo() {
    if (histIndex >= historyStack.length - 1) { toast('没有可重做的操作', 'warn'); return; }
    histIndex++;
    applySnapshot(historyStack[histIndex].snap);
    var msg = '已重做：' + ((historyStack[histIndex] && historyStack[histIndex].label) || '下一步');
    toast(msg, 'info');
    log(msg);
    setBackendMsg(msg, 'ok');
  }

  // 把样式 Tab 的控件同步成 state 里的值（撤消/会话恢复共用）
  function syncStyleControls() {
    if (el('inpFigW')) el('inpFigW').value = String(state.figW);
    if (el('inpFigH')) el('inpFigH').value = String(state.figH);
    if (el('inpFont')) el('inpFont').value = String(state.fontSize);
    if (el('valFont')) el('valFont').textContent = String(state.fontSize);
    if (el('inpLine')) el('inpLine').value = String(state.lineWidth);
    if (el('valLine')) el('valLine').textContent = String(state.lineWidth);
    if (el('inpMarker')) el('inpMarker').value = String(state.markerSize);
    if (el('valMarker')) el('valMarker').textContent = String(state.markerSize);
    applyDpi(state.dpi, false);
  }

  /* ------------------------------------------------------------
   * 十·三、会话恢复（localStorage: datalab.session）
   * ---------------------------------------------------------- */

  function saveSession() {
    if (!state.ds) return;   // 没数据时不写，避免把空配置盖掉上次的会话
    try {
      localStorage.setItem(SESSION_KEY, JSON.stringify({
        v: 1,
        ds: state.ds,
        sheet: state.sheet,
        filename: state.filename,
        gridShape: state.gridShape,
        shareAxes: state.shareAxes,
        canvasGrow: state.canvasGrow !== false,
        activePanel: state.activePanel,
        panels: state.panels,
        theme: state.theme,
        palette: state.palette,
        dpi: state.dpi,
        figW: state.figW,
        figH: state.figH,
        fontSize: state.fontSize,
        lineWidth: state.lineWidth,
        markerSize: state.markerSize,
        legendLoc: el('selLegendLoc') ? el('selLegendLoc').value : 'upper right'
      }));
    } catch (e) { /* 隐私模式下 localStorage 可能不可写 */ }
  }

  var saveSessionTimer = null;
  function saveSessionSoon() {
    clearTimeout(saveSessionTimer);
    saveSessionTimer = setTimeout(saveSession, 400);
  }

  function readSession() {
    try {
      var raw = localStorage.getItem(SESSION_KEY);
      if (!raw) return null;
      var d = JSON.parse(raw);
      return (d && typeof d === 'object') ? d : null;
    } catch (e) { return null; }
  }

  function clearSession() {
    try { localStorage.removeItem(SESSION_KEY); } catch (e) { /* 忽略 */ }
  }

  // 只恢复配置（不碰数据），init 阶段先跑这一步把界面复原
  function applySessionConfig(d) {
    if (!d || typeof d !== 'object') return false;
    if (Array.isArray(d.panels) && d.panels.length) state.panels = d.panels.map(normalizePanel);
    if (Array.isArray(d.gridShape) && d.gridShape.length >= 2) {
      state.gridShape = [Number(d.gridShape[0]) || 1, Number(d.gridShape[1]) || 1];
    }
    state.shareAxes = !!d.shareAxes;
    if (d.canvasGrow !== undefined) state.canvasGrow = !!d.canvasGrow;
    state.activePanel = Number(d.activePanel) || 0;
    ensurePanels();

    if (d.theme) state.theme = String(d.theme);
    if (d.palette) state.palette = String(d.palette);
    if (d.dpi) state.dpi = Number(d.dpi) || state.dpi;
    if (d.figW) state.figW = Number(d.figW) || state.figW;
    if (d.figH) state.figH = Number(d.figH) || state.figH;
    if (d.fontSize) state.fontSize = Number(d.fontSize) || state.fontSize;
    if (d.lineWidth) state.lineWidth = Number(d.lineWidth) || state.lineWidth;
    if (d.markerSize) state.markerSize = Number(d.markerSize) || state.markerSize;
    if (d.legendLoc && el('selLegendLoc')) {
      var ok = false;
      for (var i = 0; i < el('selLegendLoc').options.length; i++) {
        if (el('selLegendLoc').options[i].value === d.legendLoc) { ok = true; break; }
      }
      if (ok) el('selLegendLoc').value = d.legendLoc;
    }

    syncStyleControls();
    renderThemeGrid();
    renderPaletteGrid();
    renderLayoutUI();
    applyPanel(state.activePanel);
    return true;
  }

  /* ------------------------------------------------------------
   * 十·四、最近打开
   * ---------------------------------------------------------- */

  function relAge(sec) {
    var s = Number(sec) || 0;
    if (s < 45) return '刚刚';
    if (s < 3600) return Math.max(1, Math.floor(s / 60)) + ' 分钟前';
    if (s < 86400) return Math.floor(s / 3600) + ' 小时前';
    return Math.floor(s / 86400) + ' 天前';
  }

  function renderRecent() {
    var wrap = el('recentWrap');
    var list = el('recentList');
    if (!wrap || !list) return;
    clear(list);
    if (state.ds || !state.recent.length) { wrap.hidden = true; return; }
    wrap.hidden = false;
    state.recent.slice(0, 5).forEach(function (it) {
      var sheets = Array.isArray(it.sheets) ? it.sheets : [];
      var b = h('button', 'recent-item');
      b.type = 'button';
      b.title = '点击直接恢复该数据集';
      b.appendChild(h('span', 'recent-name', it.filename || it.ds));
      b.appendChild(h('span', 'recent-meta', sheets.length + ' 个工作表 · '
        + fmtInt(it.rows) + ' 行 · ' + relAge(it.age_s)));
      b.addEventListener('click', function () { openRecentDataset(it); });
      list.appendChild(b);
    });
  }

  function refreshRecent() {
    return apiGet('/api/datasets').then(function (data) {
      state.recent = Array.isArray(data.datasets) ? data.datasets : [];
      renderRecent();
      return state.recent;
    }).catch(function () {
      state.recent = [];
      renderRecent();
      return [];
    });
  }

  // 把 /api/datasets 的 sheets（{name,rows,cols}）转成本地 sheets 结构
  function sheetsFromList(list) {
    return (Array.isArray(list) ? list : []).map(function (s) {
      return {
        name: String(s.name === undefined ? '' : s.name),
        row_count: (s.rows === undefined ? null : s.rows),
        columns: []
      };
    }).filter(function (s) { return s.name !== ''; });
  }

  function openRecentDataset(item) {
    if (!item || !item.ds) return;
    var sheets = sheetsFromList(item.sheets);
    if (!sheets.length) { toast('该数据集没有可用的工作表', 'error'); return; }
    state.ds = String(item.ds);
    state.filename = String(item.filename || item.ds);
    state.sheets = sheets;
    renderSheetList();
    updateDatasetInfo();
    log('恢复数据集：' + state.filename);
    selectSheet(sheets[0].name).then(function () {
      toast('已恢复 ' + state.filename, 'success');
      renderRecent();
    });
  }

  /* ---- 挂到全局，供后续文件互调（无打包器，靠全局作用域） ---- */
  G.applyZoom = applyZoom;
  G.resetZoom = resetZoom;
  G.bindZoom = bindZoom;
  G.applyGeoLayer = applyGeoLayer;
  G.clearGeo = clearGeo;
  G.layoutGeo = layoutGeo;
  // historyStack / histIndex / histTimer / saveSessionTimer 是本文件私有的可变状态，
  // 不做导出：导出出去的是某一刻的副本，别的文件一写就跟这里脱钩。
  G.snapshotConfig = snapshotConfig;
  G.pushHistory = pushHistory;
  G.pushHistorySoon = pushHistorySoon;
  G.resetHistory = resetHistory;
  G.applySnapshot = applySnapshot;
  G.undo = undo;
  G.redo = redo;
  G.syncStyleControls = syncStyleControls;
  G.saveSession = saveSession;
  G.saveSessionSoon = saveSessionSoon;
  G.readSession = readSession;
  G.clearSession = clearSession;
  G.applySessionConfig = applySessionConfig;
  G.relAge = relAge;
  G.renderRecent = renderRecent;
  G.refreshRecent = refreshRecent;
  G.sheetsFromList = sheetsFromList;
  G.openRecentDataset = openRecentDataset;
})(window);
