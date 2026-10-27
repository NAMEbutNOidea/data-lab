/* =============================================================
 * DataLab 前端 · 07-ui.js
 * 样式 Tab / 主题与环境 / 事件绑定 / 初始化
 * 源区间：原 app.js 第 3225–4107 行（按分节切分，未改动任何函数体）
 * 加载顺序由 index.html 决定：必须先加载它前面的脚本，不能单独引用。
 * ============================================================= */
(function (G) {
  'use strict';

  /* ------------------------------------------------------------
   * 十五、样式 Tab
   * ---------------------------------------------------------- */

  function themeEntries() {
    var src = state.themes && typeof state.themes === 'object' ? state.themes : {};
    var keys = Object.keys(src);
    if (!keys.length) keys = THEME_ORDER.slice();
    keys.sort(function (a, b) {
      var ia = THEME_ORDER.indexOf(a), ib = THEME_ORDER.indexOf(b);
      if (ia < 0) ia = 999;
      if (ib < 0) ib = 999;
      return ia - ib;
    });
    return keys.map(function (id) {
      var v = src[id];
      var fb = FALLBACK_THEMES[id];
      var name;
      if (typeof v === 'string' && v) name = v;
      else if (v && typeof v === 'object' && v.name) name = String(v.name);
      else name = (fb ? fb.name : id);
      var desc = (v && typeof v === 'object' && v.description) ? String(v.description) : (fb ? fb.description : '');
      return { id: id, name: name, description: desc };
    });
  }

  function paletteEntries() {
    var src = state.palettes && typeof state.palettes === 'object' ? state.palettes : {};
    var keys = Object.keys(src);
    if (!keys.length) keys = PALETTE_ORDER.slice();
    keys.sort(function (a, b) {
      var ia = PALETTE_ORDER.indexOf(a), ib = PALETTE_ORDER.indexOf(b);
      if (ia < 0) ia = 999;
      if (ib < 0) ib = 999;
      return ia - ib;
    });
    return keys.map(function (id) {
      var v = src[id];
      var fb = FALLBACK_PALETTES[id];
      var colors = [];
      if (Array.isArray(v)) colors = v.slice();
      else if (v && Array.isArray(v.colors)) colors = v.colors.slice();
      else if (fb) colors = fb.colors.slice();
      var name = (v && typeof v === 'object' && !Array.isArray(v) && v.name) ? String(v.name) : (fb ? fb.name : id);
      return { id: id, name: name, colors: colors };
    });
  }

  function renderThemeGrid() {
    var wrap = el('themeGrid');
    if (!wrap) return;
    clear(wrap);
    themeEntries().forEach(function (t) {
      var card = h('button', 'theme-card' + (state.theme === t.id ? ' active' : ''));
      card.type = 'button';
      card.appendChild(h('span', 'theme-name', t.name));
      card.appendChild(h('span', 'theme-desc', t.description || ''));
      card.addEventListener('click', function () {
        state.theme = t.id;
        renderThemeGrid();
        log('主题切换：' + t.name);
        pushHistory('主题 ' + t.name);
        scheduleRender(0);
      });
      wrap.appendChild(card);
    });
  }

  function renderPaletteGrid() {
    var wrap = el('paletteGrid');
    if (!wrap) return;
    clear(wrap);
    paletteEntries().forEach(function (p) {
      var card = h('button', 'palette-card' + (state.palette === p.id ? ' active' : ''));
      card.type = 'button';
      var dots = h('span', 'palette-dots');
      var colors = p.colors.length ? p.colors : ['#c8d0dc'];
      colors.slice(0, 8).forEach(function (c) {
        var dot = h('span', 'dot');
        dot.style.background = String(c);
        dots.appendChild(dot);
      });
      card.appendChild(dots);
      card.appendChild(h('span', 'palette-name', p.name));
      card.addEventListener('click', function () {
        state.palette = p.id;
        renderPaletteGrid();
        log('配色切换：' + p.name);
        pushHistory('配色 ' + p.name);
        scheduleRender(0);
      });
      wrap.appendChild(card);
    });
  }

  function fillModelSelect() {
    var sel = el('selFitModel');
    if (!sel) return;
    var src = state.models && typeof state.models === 'object' ? state.models : {};
    var ids = Object.keys(src).length ? Object.keys(src) : MODEL_ORDER.slice();
    ids.sort(function (a, b) {
      var ia = MODEL_ORDER.indexOf(a), ib = MODEL_ORDER.indexOf(b);
      if (ia < 0) ia = 999;
      if (ib < 0) ib = 999;
      return ia - ib;
    });
    var prev = sel.value;
    clear(sel);
    ids.forEach(function (id) {
      var v = src[id];
      var fb = FALLBACK_MODELS[id];
      var name;
      if (typeof v === 'string' && v) name = v;
      else if (v && typeof v === 'object' && v.name) name = String(v.name);
      else name = (fb ? fb.name : id);
      sel.appendChild(new Option(name, id));
    });
    if (prev) {
      for (var i = 0; i < sel.options.length; i++) {
        if (sel.options[i].value === prev) { sel.value = prev; break; }
      }
    }
    if (!sel.value && sel.options.length) sel.selectedIndex = 0;
    toggleDegRow();
  }

  function fillTestOptions() {
    var sel = el('selTest');
    if (!sel) return;
    var prev = sel.value;
    clear(sel);
    TESTS.forEach(function (t) { sel.appendChild(new Option(t.name, t.id)); });
    if (prev) {
      for (var i = 0; i < sel.options.length; i++) {
        if (sel.options[i].value === prev) { sel.value = prev; break; }
      }
    }
    if (!sel.value) sel.value = 'ttest_1samp';
    updateTestHint();
  }

  function updateTestHint() {
    var sel = el('selTest');
    if (!sel) return;
    var meta = testMeta(sel.value);
    var hint = el('testHint');
    if (!hint) return;
    if (!meta) { hint.textContent = ''; return; }
    if (meta.optionalY) hint.textContent = '组 2 列填写期望频数，可留空表示等概率。';
    else if (!meta.needY) hint.textContent = '该检验只需「组 1」一列数据。';
    else hint.textContent = '需要「组 1」与「组 2」两列数值数据。';
  }

  function switchTab(name) {
    var tabs = document.querySelectorAll('.tab');
    Array.prototype.forEach.call(tabs, function (t) {
      t.classList.toggle('active', t.dataset.tab === name);
    });
    ['chart', 'fit', 'stats', 'style'].forEach(function (k) {
      var p = el('panel-' + k);
      if (p) p.hidden = (k !== name);
    });
  }

  /* ------------------------------------------------------------
   * 十六、主题 / 环境
   * ---------------------------------------------------------- */

  function updateDarkButton() {
    var btn = el('btnDark');
    if (!btn) return;
    var dark = document.documentElement.dataset.theme === 'dark';
    btn.textContent = dark ? '亮' : '暗';
    btn.title = dark ? '切换到浅色界面' : '切换到暗色界面';
  }

  function toggleDark() {
    var root = document.documentElement;
    var next = root.dataset.theme === 'dark' ? 'light' : 'dark';
    root.dataset.theme = next;
    try { localStorage.setItem('datalab.theme', next); } catch (e) { /* 忽略 */ }
    updateDarkButton();
    log(next === 'dark' ? '界面切换到暗色模式' : '界面切换到浅色模式');
  }

  function setEnvStatus(data) {
    var text = el('envText');
    var box = el('envStatus');
    if (!text || !box) return;
    shared.bkInfo.python = '';
    if (data && data.python) {
      var py = typeof data.python === 'object' ? (data.python.version || data.python.name || '') : data.python;
      shared.bkInfo.python = py ? String(py) : '';
    }
    shared.bkInfo.exe = (data && data.executable) ? String(data.executable) : '';
    shared.bkInfo.patched = data ? data.blas_patched : null;
    shared.bkInfo.port = (data && data.port) ? Number(data.port) : 0;
    shared.bkInfo.uptime = (data && data.uptime_s) ? Number(data.uptime_s) : 0;

    var dsCount = 0;
    if (data && Array.isArray(data.datasets)) dsCount = data.datasets.length;
    else if (data && typeof data.datasets === 'number') dsCount = data.datasets;
    else if (data && data.datasets && typeof data.datasets === 'object') dsCount = Object.keys(data.datasets).length;

    text.textContent = (shared.bkInfo.python ? 'Python ' + shared.bkInfo.python : '服务在线') + ' · ' + dsCount + ' 个数据集';
    box.classList.add('ok');
    box.classList.remove('bad');

    syncBackend();
    setBackendState('ready', '就绪');
    setBackendMsg('本地服务已连接 · numpy BLAS 顺序线程层'
      + (shared.bkInfo.patched ? '已启用' : '未启用（存在崩溃风险）'), 'ok');
  }

  function loadMeta() {
    return apiGet('/api/themes').then(function (data) {
      state.themes = (data.themes && typeof data.themes === 'object') ? data.themes : {};
      state.palettes = (data.palettes && typeof data.palettes === 'object') ? data.palettes : {};
      state.models = (data.models && typeof data.models === 'object') ? data.models : {};
      state.transforms = (data.transforms && typeof data.transforms === 'object') ? data.transforms : {};
      applyServerKinds(data);
      renderThemeGrid();
      renderPaletteGrid();
      fillModelSelect();
      log('已加载图形能力、主题与配色预设（后端下发）');
    }).catch(function (err) {
      log('主题接口不可用，使用内置预设（' + (err && err.message ? err.message : '未知原因') + '）', 'warn');
    }).then(function () {
      return apiGet('/api/connection').then(function (data) {
        setEnvStatus(data);
      }).catch(function () {
        var box = el('envStatus');
        var text = el('envText');
        if (box) { box.classList.add('bad'); box.classList.remove('ok'); }
        if (text) text.textContent = '服务未连接';
        setBackendState('error', '离线');
        setBackendMsg('无法读取服务信息，请确认本地服务仍在运行', 'error');
      });
    });
  }

  // 后端 /api/themes 返回的 kinds 是图形能力的唯一事实来源：
  // 有能力清单就按它重建按钮，接口不可用时退回内置 KINDS。
  function applyServerKinds(data) {
    var src = data && data.kinds;
    if (!src || typeof src !== 'object') return;
    var groups = Array.isArray(data.kind_groups) ? data.kind_groups : [];
    var ids = Object.keys(src);
    if (!ids.length) return;
    var order = function (id) {
      var i = groups.indexOf(src[id] && src[id].group);
      return i < 0 ? 999 : i;
    };
    ids.sort(function (a, b) {
      var d = order(a) - order(b);
      return d !== 0 ? d : 0;
    });
    var list = [];
    ids.forEach(function (id) {
      var meta = src[id] || {};
      list.push({
        id: id,
        name: String(meta.name || id),
        group: String(meta.group || '其他'),
        desc: String(meta.desc || ''),
        // needZ / needMatrix 必须透传：03 用它们禁用对数刻度、04 用它们切 3D 的数据构造，
        // 丢掉的后果是三维图被当成普通二维图处理（构造出的 series 没有 z、没有 matrix）。
        needZ: !!meta.need_z,
        needMatrix: !!meta.need_matrix,
        needX: meta.need_x !== false,
        needFit: !!meta.need_fit
      });
    });
    if (list.length) {
      // 就地改写而不是 KINDS = list：KINDS 是 01-base 的模块私有数组，
      // 这里只是拿到它的引用（全局同名变量指向同一个数组对象）。
      // 重新赋值只会换掉本文件的绑定，01 的 kindName / 04 的 buildSpec 仍读旧数组。
      KINDS.length = 0;
      list.forEach(function (k) { KINDS.push(k); });
      if (!kindName(state.kind) || state.kind !== list[0].id) {
        // 当前类型仍在清单里就保持，否则回落到第一个
        var stillOk = false;
        for (var i = 0; i < list.length; i++) if (list[i].id === state.kind) stillOk = true;
        if (!stillOk) state.kind = list[0].id;
      }
      renderTypeGrid();
    }
  }

  /* ------------------------------------------------------------
   * 十七、事件绑定
   * ---------------------------------------------------------- */

  function on(id, evt, fn) {
    var node = el(id);
    if (node) node.addEventListener(evt, fn);
  }

  function closeMenus(except) {
    ['exportImgMenu', 'exportDataMenu'].forEach(function (id) {
      var m = el(id);
      if (m && m !== except) m.hidden = true;
    });
  }

  function bindEvents() {
    // 顶栏
    on('btnImport', 'click', function () { el('fileInput').click(); });
    on('btnImport2', 'click', function () { el('fileInput').click(); });
    on('fileInput', 'change', function (e) {
      var f = e.target.files && e.target.files[0];
      if (f) handleFile(f);
      e.target.value = '';
    });
    on('btnDark', 'click', toggleDark);

    on('btnExportImg', 'click', function (e) {
      e.stopPropagation();
      var m = el('exportImgMenu');
      if (!m) return;
      var willShow = m.hidden;
      closeMenus();
      m.hidden = !willShow;
    });
    on('btnExportData', 'click', function (e) {
      e.stopPropagation();
      var m = el('exportDataMenu');
      if (!m) return;
      var willShow = m.hidden;
      closeMenus();
      m.hidden = !willShow;
    });
    Array.prototype.forEach.call(document.querySelectorAll('.menu-item'), function (btn) {
      btn.addEventListener('click', function () {
        var fmt = btn.dataset.fmt;
        var menu = btn.parentNode;
        if (menu && menu.id === 'exportDataMenu') exportData(fmt);
        else exportFigure(fmt);
        closeMenus();
      });
    });
    document.addEventListener('click', function () { closeMenus(); });

    // 子图布局 / 面板切换 / 共享坐标轴
    var layoutPicker = el('layoutPicker');
    if (layoutPicker) {
      layoutPicker.addEventListener('click', function (e) {
        var btn = e.target.closest ? e.target.closest('.layout-btn') : null;
        if (!btn) return;
        var parts = String(btn.dataset.grid || '1,1').split(',');
        setLayout(Number(parts[0]) || 1, Number(parts[1]) || 1);
      });
    }
    var panelBar = el('panelBar');
    if (panelBar) {
      panelBar.addEventListener('click', function (e) {
        var btn = e.target.closest ? e.target.closest('.panel-tab') : null;
        if (!btn) return;
        var idx = Number(btn.dataset.panel);
        if (!Number.isFinite(idx) || idx === state.activePanel) return;
        commitPanel();
        applyPanel(idx);
        renderLayoutUI();
        log('切换到面板 ' + (panelLabel(idx) || ''));
      });
      // 双击切换条 = 打开该子图的设置窗口（相当于"点方块"）
      panelBar.addEventListener('dblclick', function (e) {
        var btn = e.target.closest ? e.target.closest('.panel-tab') : null;
        if (!btn) return;
        var idx = Number(btn.dataset.panel);
        if (Number.isFinite(idx)) openPanelDialog(idx);
      });
    }

    // 拼图板：点方块打开子图设置；点"未放置"的 chip 放回一格
    var board = el('layoutBoard');
    if (board) {
      board.addEventListener('click', function (e) {
        var cell = e.target.closest ? e.target.closest('.board-cell') : null;
        if (!cell) return;
        var idx = Number(cell.dataset.panel);
        if (!Number.isFinite(idx)) return;
        openPanelDialog(idx);
      });
    }
    var unplaced = el('boardUnplaced');
    if (unplaced) {
      unplaced.addEventListener('click', function (e) {
        var chip = e.target.closest ? e.target.closest('.unplaced-chip') : null;
        if (!chip) return;
        var idx = Number(chip.dataset.restore);
        if (Number.isFinite(idx)) restorePanel(idx);
      });
    }
    on('btnAddPanel', 'click', addPanel);
    // 自定义行列：改完立即重排（change 在失焦 / 回车 / 点步进箭头时触发）
    ['inpGridRows', 'inpGridCols'].forEach(function (id) {
      var node = el(id);
      if (!node) return;
      node.addEventListener('change', function () {
        var r = numOrNull(el('inpGridRows') ? el('inpGridRows').value : 1);
        var c = numOrNull(el('inpGridCols') ? el('inpGridCols').value : 1);
        var rr = (r === null) ? 1 : Math.max(1, Math.min(4, Math.round(r)));
        var cc = (c === null) ? 1 : Math.max(1, Math.min(4, Math.round(c)));
        // 输入框先回填收敛后的值，再切布局（避免留下 "9" 这种非法数字）
        if (el('inpGridRows')) el('inpGridRows').value = String(rr);
        if (el('inpGridCols')) el('inpGridCols').value = String(cc);
        setLayout(rr, cc);
      });
    });
    // 跨格开关：作用在当前面板上，可同时开（= 2×2 大图）
    on('btnSpanCols', 'click', function () { toggleSpan('cols'); });
    on('btnSpanRows', 'click', function () { toggleSpan('rows'); });
    on('chkShareAxes', 'change', function () {
      state.shareAxes = !!el('chkShareAxes').checked;
      // 共享轴会把 scale 传播到整组子图：动了它就要重算冲突提示
      // （只提示，不去改用户设好的 yscale —— 那等于悄悄丢数据）
      refreshAxisUI();
      pushHistory(state.shareAxes ? '共享坐标轴' : '取消共享坐标轴');
      scheduleRender(0);
    });
    on('chkCanvasGrow', 'change', function () {
      state.canvasGrow = !!el('chkCanvasGrow').checked;
      pushHistory(state.canvasGrow ? '画布随子图放大' : '画布固定不放大');
      renderSizeWarn();
      scheduleRender(0);
    });

    // 数据变换 / 模型比较 / 弹窗
    on('btnTransform', 'click', openTransformDialog);
    on('btnFitCompare', 'click', runFitCompare);
    on('modalClose', 'click', closeModal);
    on('modalMask', 'click', function (e) {
      if (e.target === el('modalMask')) closeModal();
    });

    // 左侧列过滤 / 点击 / 拖拽
    on('colFilter', 'input', renderColumns);
    var colList = el('columnList');
    if (colList) {
      colList.addEventListener('click', function (e) {
        var item = e.target.closest ? e.target.closest('.col-item') : null;
        if (!item) return;
        var name = item.dataset.col;
        if (e.target.closest('.col-add')) { addY(name); return; }
        state.selectedCols.x = name;
        syncMappingUI();
        autoLabels(false);
        scheduleRender();
        log('X 列设为：' + name);
      });
      colList.addEventListener('dragstart', function (e) {
        var item = e.target.closest ? e.target.closest('.col-item') : null;
        if (!item) return;
        shared.dragPayload = { type: 'col', name: item.dataset.col };
        e.dataTransfer.effectAllowed = 'copy';
        try { e.dataTransfer.setData('text/plain', 'col:' + item.dataset.col); } catch (err) { /* 忽略 */ }
      });
      colList.addEventListener('dragend', function () { shared.dragPayload = null; });
    }

    // Tab
    Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (t) {
      t.addEventListener('click', function () { switchTab(t.dataset.tab); });
    });

    // 图表类型（只作用于当前选中的面板）
    var grid = el('chartTypeGrid');
    if (grid) {
      grid.addEventListener('click', function (e) {
        var btn = e.target.closest ? e.target.closest('.type-btn') : null;
        if (!btn) return;
        var prev = state.kind;
        state.kind = btn.dataset.kind;
        Array.prototype.forEach.call(grid.querySelectorAll('.type-btn'), function (b) {
          b.classList.toggle('active', b.dataset.kind === state.kind);
        });
        log('图表类型：' + kindName(state.kind)
          + (panelTotal() > 1 ? '（面板 ' + (panelLabel(state.activePanel) || '') + '）' : ''));
        autoLabels(false);
        commitPanel();
        renderPanelBar();
        if (prev !== state.kind) pushHistory('图型 ' + kindName(state.kind));
        scheduleRender(0);
      });
    }

    // 映射（同样只改当前面板）
    on('selX', 'change', function () {
      state.selectedCols.x = el('selX').value || null;
      afterMappingChange('X 列');
    });
    on('selXErr', 'change', function () {
      state.selectedCols.xerr = el('selXErr').value || null;
      afterMappingChange('X 误差列');
    });
    on('selYErr', 'change', function () {
      state.selectedCols.yerr = el('selYErr').value || null;
      afterMappingChange('Y 误差列');
    });
    on('btnAddY', 'click', function () { addY(el('selYAdd').value); });
    on('selYAdd', 'dblclick', function () { addY(el('selYAdd').value); });

    // Y 列表拖放排序
    var yList = el('yList');
    if (yList) {
      yList.addEventListener('dragover', function (e) {
        e.preventDefault();
        e.dataTransfer.dropEffect = shared.dragPayload && shared.dragPayload.type === 'col' ? 'copy' : 'move';
        var chip = e.target.closest ? e.target.closest('.chip') : null;
        Array.prototype.forEach.call(yList.querySelectorAll('.chip'), function (c) { c.classList.remove('drop-target'); });
        if (chip) chip.classList.add('drop-target');
      });
      yList.addEventListener('dragleave', function (e) {
        if (e.target === yList) {
          Array.prototype.forEach.call(yList.querySelectorAll('.chip'), function (c) { c.classList.remove('drop-target'); });
        }
      });
      yList.addEventListener('drop', function (e) {
        e.preventDefault();
        Array.prototype.forEach.call(yList.querySelectorAll('.chip'), function (c) { c.classList.remove('drop-target'); });
        var payload = shared.dragPayload;
        if (!payload) {
          var raw = '';
          try { raw = e.dataTransfer.getData('text/plain') || ''; } catch (err) { raw = ''; }
          if (raw.indexOf('col:') === 0) payload = { type: 'col', name: raw.slice(4) };
          else if (raw.indexOf('y:') === 0) payload = { type: 'y', name: raw.slice(2) };
        }
        if (!payload || !payload.name) return;

        var chip = e.target.closest ? e.target.closest('.chip') : null;
        var targetName = chip ? chip.dataset.col : null;
        if (payload.type === 'y' && targetName === payload.name) return;
        var arr = state.selectedCols.ys.slice();

        if (payload.type === 'col') {
          if (!isNumericColumn(payload.name)) { toast('Y 列必须是数值列', 'warn'); return; }
          if (arr.indexOf(payload.name) >= 0) return;
          var idx = targetName ? arr.indexOf(targetName) : -1;
          if (idx < 0) arr.push(payload.name);
          else arr.splice(idx, 0, payload.name);
          state.selectedCols.ys = arr;
          afterMappingChange();
          log('添加 Y 列：' + payload.name);
        } else {
          var from = arr.indexOf(payload.name);
          if (from < 0) return;
          arr.splice(from, 1);
          var to = targetName ? arr.indexOf(targetName) : -1;
          if (to < 0) arr.push(payload.name);
          else arr.splice(to, 0, payload.name);
          state.selectedCols.ys = arr;
          afterMappingChange();
        }
        shared.dragPayload = null;
      });
    }

    // 坐标轴 / 标题 / 图例（都写进当前面板）
    function panelCfgChange(label) {
      commitPanel();
      // 刻度变了就可能让"共享轴 vs 逐面板刻度"的冲突状态翻转
      refreshAxisUI();
      renderPanelBar();
      pushHistory(label);
      scheduleRender(0);
    }
    on('selXScale', 'change', function () { panelCfgChange('X 轴刻度'); });
    on('selYScale', 'change', function () { panelCfgChange('Y 轴刻度'); });
    on('selLegendLoc', 'change', function () {
      pushHistory('图例位置');
      scheduleRender(0);
    });
    on('chkGrid', 'change', function () { panelCfgChange('网格'); });
    on('chkLegend', 'change', function () { panelCfgChange('图例'); });
    // Y₂ 轴只在"有列指派到右轴"时可见，但它的值也要随面板一起存 / 一起改
    on('selY2Scale', 'change', function () { panelCfgChange('Y₂ 轴刻度'); });
    on('inpY2label', 'input', function () {
      commitPanel();
      scheduleRender();
      pushHistorySoon('Y₂ 轴标签');
    });
    ['inpTitle', 'inpXlabel', 'inpYlabel'].forEach(function (id) {
      var node = el(id);
      if (!node) return;
      node.addEventListener('input', function () {
        node.dataset.auto = '0';
        scheduleRender();
        commitPanel();
        pushHistorySoon('标题 / 轴标签');
      });
    });

    ['inpRowStart', 'inpRowEnd'].forEach(function (id) {
      var node = el(id);
      if (!node) return;
      node.addEventListener('change', function () {
        var total = state.rows.length;
        var v = numOrNull(node.value);
        if (v === null) { node.value = ''; }
        else {
          var n = Math.floor(v);
          if (n < 1) n = 1;
          if (total && n > total) n = total;
          node.value = String(n);
        }
        scheduleRender(0);
      });
    });
    on('inpBins', 'change', function () {
      var v = numOrNull(el('inpBins').value);
      if (v === null || v < 3) el('inpBins').value = '20';
      scheduleRender(0);
    });
    on('chkKde', 'change', function () { scheduleRender(0); });

    // 拟合
    on('selFitModel', 'change', function () {
      toggleDegRow();
      state.fit = null;
      state.fitKey = '';
      clearFitResult();
      scheduleRender(0);
    });
    on('inpDeg', 'change', function () {
      state.fit = null;
      state.fitKey = '';
      clearFitResult();
      scheduleRender(0);
    });
    on('chkUseYerr', 'change', function () { scheduleRender(0); });
    on('chkPredBand', 'change', function () { scheduleRender(0); });
    on('chkResidual', 'change', function () { scheduleRender(0); });
    on('btnFit', 'click', runFit);

    // 统计
    on('btnDescribe', 'click', runDescribe);
    on('btnDescAll', 'click', function () {
      var sel = el('selDescCols');
      if (!sel) return;
      var nums = numericColumns();
      Array.prototype.forEach.call(sel.options, function (o) {
        o.selected = nums.indexOf(o.value) >= 0;
      });
    });
    on('btnDescNone', 'click', function () {
      var sel = el('selDescCols');
      if (!sel) return;
      Array.prototype.forEach.call(sel.options, function (o) { o.selected = false; });
    });
    on('btnUnc', 'click', runUncertainty);
    on('selTest', 'change', updateTestHint);
    on('btnTest', 'click', runTest);

    // 样式
    on('inpFigW', 'input', function (e) {
      var v = numOrNull(e.target.value);
      if (v !== null && v > 0) state.figW = v;
      renderSizeWarn();          // 图幅变了，格子大小跟着变
      scheduleRender();
      pushHistorySoon('图幅宽度');
    });
    on('inpFigH', 'input', function (e) {
      var v = numOrNull(e.target.value);
      if (v !== null && v > 0) state.figH = v;
      renderSizeWarn();
      scheduleRender();
      pushHistorySoon('图幅高度');
    });
    Array.prototype.forEach.call(document.querySelectorAll('.preset-btn'), function (btn) {
      btn.addEventListener('click', function () {
        var w = numOrNull(btn.dataset.w);
        var hh = numOrNull(btn.dataset.h);
        if (w !== null && hh !== null) {
          state.figW = w;
          state.figH = hh;
          if (el('inpFigW')) el('inpFigW').value = String(w);
          if (el('inpFigH')) el('inpFigH').value = String(hh);
          log('图幅预设：' + w + ' × ' + hh + ' 英寸');
          renderSizeWarn();
          pushHistory('图幅 ' + w + '×' + hh);
          scheduleRender(0);
        }
      });
    });
    // DPI：数字输入框 + 档位按钮双向同步
    on('inpDpi', 'input', function (e) {
      var raw = String(e.target.value || '').trim();
      if (raw === '') return;                 // 允许清空重填，不打断输入
      var v = Number(raw);
      if (!isFinite(v)) return;
      if (v < DPI_MIN || v > DPI_MAX) return; // 超范围先不提交，等 change 时再纠正
      applyDpi(v, false);
      scheduleRender();
      pushHistorySoon('DPI');
    });
    on('inpDpi', 'change', function (e) {
      applyDpi(e.target.value, true);
      pushHistory('DPI ' + state.dpi);
    });
    on('inpDpi', 'blur', function (e) {
      applyDpi(e.target.value, true);         // 失焦时把越界值纠正回合法区间
    });
    var dpiBox = el('dpiPresets');
    if (dpiBox) {
      dpiBox.addEventListener('click', function (e) {
        var btn = e.target && e.target.closest ? e.target.closest('.dpi-preset') : null;
        if (!btn) return;
        applyDpi(btn.getAttribute('data-dpi'), true);
        pushHistory('DPI ' + state.dpi);
      });
    }
    applyDpi(state.dpi, false);   // 初始化：让 300 档位与 aria-pressed 对上
    on('inpFont', 'input', function (e) {
      state.fontSize = Number(e.target.value) || 11;
      var v = el('valFont');
      if (v) v.textContent = String(state.fontSize);
      scheduleRender();
      pushHistorySoon('字号');
    });
    on('inpLine', 'input', function (e) {
      state.lineWidth = Number(e.target.value) || 1.6;
      var v = el('valLine');
      if (v) v.textContent = String(state.lineWidth);
      scheduleRender();
      pushHistorySoon('线宽');
    });
    on('inpMarker', 'input', function (e) {
      state.markerSize = Number(e.target.value) || 5;
      var v = el('valMarker');
      if (v) v.textContent = String(state.markerSize);
      scheduleRender();
      pushHistorySoon('标记大小');
    });

    // 下载
    on('btnRender', 'click', renderNow);
    on('btnDlPng', 'click', downloadPng);
    on('btnDlSvg', 'click', downloadSvg);
    on('btnDlPdf', 'click', function () { exportFigure('pdf'); });
    on('btnDlEps', 'click', function () { exportFigure('eps'); });
    on('btnGuideRetry', 'click', renderNow);

    // 底部分页 / 折叠 / 日志
    on('pagePrev', 'click', function () {
      state.page = Math.max(0, state.page - 1);
      renderTable();
    });
    on('pageNext', 'click', function () {
      var pages = Math.max(1, Math.ceil(state.rows.length / state.pageSize));
      state.page = Math.min(pages - 1, state.page + 1);
      renderTable();
    });
    on('btnToggleBottom', 'click', function () {
      var app = el('app');
      var btn = el('btnToggleBottom');
      if (!app) return;
      var collapsed = app.classList.toggle('collapsed');
      if (btn) btn.textContent = collapsed ? '展开' : '收起';
    });
    on('btnClearLog', 'click', function () {
      var pane = el('logPane');
      if (pane) clear(pane);
    });

    // 拖拽文件到页面任意位置
    function hasFiles(e) {
      if (!e.dataTransfer || !e.dataTransfer.types) return false;
      return Array.prototype.indexOf.call(e.dataTransfer.types, 'Files') >= 0;
    }
    window.addEventListener('dragenter', function (e) {
      if (!hasFiles(e)) return;
      e.preventDefault();
      var mask = el('dropMask');
      if (mask) mask.hidden = false;
    });
    window.addEventListener('dragover', function (e) {
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    });
    window.addEventListener('dragleave', function (e) {
      // relatedTarget 为 null 表示真正离开窗口，此时才隐藏遮罩
      if (e.relatedTarget !== null) return;
      var mask = el('dropMask');
      if (mask) mask.hidden = true;
    });
    window.addEventListener('dragend', function () {
      var mask = el('dropMask');
      if (mask) mask.hidden = true;
    });
    window.addEventListener('drop', function (e) {
      var mask = el('dropMask');
      if (mask) mask.hidden = true;
      if (!hasFiles(e)) return;
      e.preventDefault();
      var f = e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) handleFile(f);
    });

    // 快捷键
    document.addEventListener('keydown', function (e) {
      var t = e.target || {};
      var tag = String(t.tagName || '').toLowerCase();
      var typing = tag === 'input' || tag === 'select' || tag === 'textarea' || t.isContentEditable === true;
      var ctrl = e.ctrlKey || e.metaKey;

      // Esc 优先：关菜单 / 弹窗 / 拖拽遮罩，输入框里也生效
      if (e.key === 'Escape') {
        var closed = false;
        if (modalOpen()) { closeModal(); closed = true; }
        ['exportImgMenu', 'exportDataMenu'].forEach(function (id) {
          var m = el(id);
          if (m && !m.hidden) { m.hidden = true; closed = true; }
        });
        var mask = el('dropMask');
        if (mask && !mask.hidden) { mask.hidden = true; closed = true; }
        if (closed) e.preventDefault();
        return;
      }

      if (ctrl && !e.altKey) {
        var k = String(e.key || '').toLowerCase();
        if (k === 'z') {
          e.preventDefault();
          if (e.shiftKey) redo();
          else undo();
          return;
        }
        if (k === 'y') { e.preventDefault(); redo(); return; }
        if (k === 'o') { e.preventDefault(); el('fileInput').click(); return; }
        if (k === 's') { e.preventDefault(); downloadPng(); return; }
        if (e.key === 'Enter') { e.preventDefault(); runFit(); return; }
        return;
      }

      if (typing || e.altKey) return;

      if (e.key === '?') { e.preventDefault(); openShortcuts(); return; }
      if (e.key === 'Enter') { e.preventDefault(); runFit(); return; }
      if (e.key === 'r' || e.key === 'R') { e.preventDefault(); renderNow(); return; }
      if (e.key === 'o' || e.key === 'O') { e.preventDefault(); el('fileInput').click(); return; }
    });

    bindZoom();
  }

  /* ------------------------------------------------------------
   * 十八、初始化
   * ---------------------------------------------------------- */

  function renderTypeGrid() {
    var wrap = el('chartTypeGrid');
    if (!wrap) return;
    clear(wrap);
    KINDS.forEach(function (k) {
      var btn = h('button', 'type-btn' + (state.kind === k.id ? ' active' : ''));
      btn.type = 'button';
      btn.dataset.kind = k.id;
      btn.title = k.name;
      btn.innerHTML = '<span class="type-ico"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round">' + (KIND_ICONS[k.id] || '') + '</svg></span><span class="type-lbl">' + esc(k.name) + '</span>';
      wrap.appendChild(btn);
    });
  }

  function init() {
    ensurePanels();
    bindEvents();
    try {
      var saved = localStorage.getItem('datalab.theme');
      if (saved === 'dark' || saved === 'light') document.documentElement.dataset.theme = saved;
    } catch (e) { /* 忽略 */ }
    updateDarkButton();

    renderTypeGrid();
    renderThemeGrid();
    renderPaletteGrid();
    fillModelSelect();
    fillTestOptions();
    toggleDegRow();
    clearFitResult();
    renderSheetList();
    renderColumns();
    updateDatasetInfo();
    renderTable();
    updatePager();
    renderLayoutUI();
    showGuide();
    syncBackend();
    setBackendState('', '待命');
    log('DataLab 已就绪，等待导入数据');

    // 复原上次会话的配置（此时还没有数据，只动界面）
    var session = readSession();
    var restored = false;
    if (session) {
      restored = applySessionConfig(session);
      if (restored) log('已恢复上次的绘图配置');
    }
    if (restored) applyPanel(state.activePanel);
    else applyPanel(0);
    resetHistory();

    loadMeta().then(function () {
      refreshRecent();
      if (session && session.ds) restoreDataset(session);
    });
  }

  // 刷新后确认 ds 还在内存里，在就自动复原，不在就清掉会话并提示
  function restoreDataset(session) {
    return apiGet('/api/datasets').then(function (data) {
      var list = Array.isArray(data.datasets) ? data.datasets : [];
      var hit = null;
      for (var i = 0; i < list.length; i++) {
        if (String(list[i].ds) === String(session.ds)) { hit = list[i]; break; }
      }
      if (!hit) {
        clearSession();
        toast('上次的数据集已失效，请重新导入', 'warn');
        log('上次的数据集（' + session.ds + '）已不在服务端，会话已清除', 'warn');
        refreshRecent();
        return;
      }
      var sheets = sheetsFromList(hit.sheets);
      if (!sheets.length) {
        clearSession();
        toast('上次的数据集已失效，请重新导入', 'warn');
        return;
      }
      state.ds = String(hit.ds);
      state.filename = String(hit.filename || session.filename || hit.ds);
      state.sheets = sheets;
      var target = session.sheet;
      var exists = false;
      for (var j = 0; j < sheets.length; j++) {
        if (sheets[j].name === target) { exists = true; break; }
      }
      renderSheetList();
      updateDatasetInfo();
      log('自动恢复数据集：' + state.filename + ' · ' + (exists ? target : sheets[0].name));
      return selectSheet(exists ? target : sheets[0].name).then(function () {
        applyPanel(Number(session.activePanel) || 0);
        renderLayoutUI();
        toast('已恢复上次的数据与配置', 'success');
        scheduleRender(0);
      });
    }).catch(function () {
      // /api/datasets 不可用时保持空状态，不打扰用户
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  /* ---- 挂到全局，供后续文件互调（无打包器，靠全局作用域） ---- */
  G.themeEntries = themeEntries;
  G.paletteEntries = paletteEntries;
  G.renderThemeGrid = renderThemeGrid;
  G.renderPaletteGrid = renderPaletteGrid;
  G.fillModelSelect = fillModelSelect;
  G.fillTestOptions = fillTestOptions;
  G.updateTestHint = updateTestHint;
  G.switchTab = switchTab;
  G.updateDarkButton = updateDarkButton;
  G.toggleDark = toggleDark;
  G.setEnvStatus = setEnvStatus;
  G.loadMeta = loadMeta;
  G.applyServerKinds = applyServerKinds;
  G.on = on;
  G.closeMenus = closeMenus;
  G.bindEvents = bindEvents;
  G.renderTypeGrid = renderTypeGrid;
  G.init = init;
  G.restoreDataset = restoreDataset;
})(window);
