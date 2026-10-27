/* =============================================================
 * DataLab 前端 · 02-data.js
 * 导入与工作表 / 左侧栏 / 右侧映射控件
 * 源区间：原 app.js 第 606–1083 行（按分节切分，未改动任何函数体）
 * 加载顺序由 index.html 决定：必须先加载它前面的脚本，不能单独引用。
 * ============================================================= */
(function (G) {
  'use strict';

  /* ------------------------------------------------------------
   * 六、导入与工作表
   * ---------------------------------------------------------- */

  function readFileB64(file) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () {
        var s = String(reader.result || '');
        var i = s.indexOf(',');
        resolve(i >= 0 ? s.slice(i + 1) : s);
      };
      reader.onerror = function () { reject(new Error('文件读取失败')); };
      reader.readAsDataURL(file);
    });
  }

  // 把服务端返回的 ds 统一成字符串标识
  function dsId(v) {
    if (v === null || v === undefined) return '';
    if (typeof v === 'string' || typeof v === 'number') return String(v);
    if (typeof v === 'object') {
      if (v.id !== undefined) return String(v.id);
      if (v.name !== undefined) return String(v.name);
      if (v.key !== undefined) return String(v.key);
    }
    return '';
  }

  function showOverlay(on, text) {
    var ov = el('renderOverlay');
    if (!ov) return;
    if (on) {
      if (text) el('overlayText').textContent = text;
      ov.hidden = false;
      setBackendState('busy', '计算中');
      setBackendMsg(text || '服务端正在计算…');
    } else {
      ov.hidden = true;
    }
  }

  function handleFile(file) {
    if (!file) return;
    var name = file.name ? String(file.name) : 'data.xlsx';
    if (!/\.(xlsx|xls|csv)$/i.test(name)) {
      toast('仅支持 .xlsx / .xls / .csv 格式', 'error');
      return;
    }
    var btn = el('btnImport');
    if (btn) btn.disabled = true;
    showOverlay(true, '正在解析文件…');
    log('读取文件 ' + name + '（' + (file.size / 1024).toFixed(1) + ' KB）');

    readFileB64(file).then(function (b64) {
      return api('/api/upload', { filename: name, data_b64: b64 });
    }).then(function (data) {
      var id = dsId(data.ds);
      if (!id) id = dsId(data.dataset);
      if (!id) id = name;
      state.ds = id;
      state.filename = name;
      state.sheets = normalizeSheets(data.sheets);
      state.uploadColumns = normalizeColumns(data.columns);
      if (!state.sheets.length) throw new Error('未识别到任何工作表');
      log('导入成功：' + state.sheets.length + ' 个工作表，数据集 ' + state.ds);
      toast('已导入 ' + name, 'success');
      return selectSheet(state.sheets[0].name).then(function () {
        refreshRecent();
      });
    }).catch(function (err) {
      var msg = err && err.message ? err.message : String(err);
      toast('导入失败：' + msg, 'error');
      log('导入失败：' + msg, 'error');
      showGuide('导入失败，请检查文件', msg, true, false);
    }).then(function () {
      if (btn) btn.disabled = false;
    });
  }

  function selectSheet(name) {
    if (!state.ds) return Promise.resolve();
    state.sheet = name;
    state.page = 0;
    shared.numericCache = Object.create(null);

    var sh = null;
    for (var i = 0; i < state.sheets.length; i++) {
      if (state.sheets[i].name === name) { sh = state.sheets[i]; break; }
    }
    state.columns = (sh && sh.columns && sh.columns.length) ? sh.columns.slice() : state.uploadColumns.slice();

    state.selectedCols = { x: null, ys: [], xerr: null, yerr: null };
    state.fit = null;
    state.fitKey = '';
    state.rows = [];
    state.total = 0;
    state.truncated = false;
    clearFitResult();
    clearSelectionResults();
    renderSheetList();

    showOverlay(true, '加载数据…');
    return loadRows().then(function () {
      showOverlay(false);
      if (!state.columns.length) state.columns = normalizeColumns(state.previewColumns);
      autoPickColumns();
      remapPanels();                 // 面板里失效的列换成当前工作表的列
      applyPanel(state.activePanel); // 载入面板 → 同步下拉、chips、标题
      renderColumns();
      updateDatasetInfo();
      resetRowRange();
      renderTable();
      syncBackend();
      setBackendState('ready', '就绪');
      setBackendMsg('已载入工作表「' + name + '」：' + state.rows.length + ' 行 × '
        + state.columns.length + ' 列', 'ok');
      saveSession();
      scheduleRender(0);
    }).catch(function (err) {
      showOverlay(false);
      var msg = err && err.message ? err.message : String(err);
      toast('读取数据失败：' + msg, 'error');
      log('读取数据失败：' + msg, 'error');
      renderTable();
    });
  }

  function loadRows() {
    state.previewColumns = [];
    return api('/api/preview', {
      ds: state.ds,
      sheet: state.sheet,
      offset: 0,
      limit: 100000
    }).then(function (first) {
      state.previewColumns = Array.isArray(first.columns) ? first.columns : [];
      var rows = normalizeRows(first.rows);
      var total = Number(first.total);
      state.total = Number.isFinite(total) ? total : rows.length;
      state.truncated = false;

      if (!state.columns.length) state.columns = normalizeColumns(state.previewColumns);

      var guard = 0;
      function next() {
        if (rows.length >= state.total || rows.length >= MAX_ROWS || guard >= 20) return Promise.resolve();
        guard++;
        var limit = Math.min(100000, state.total - rows.length);
        return api('/api/preview', {
          ds: state.ds,
          sheet: state.sheet,
          offset: rows.length,
          limit: limit
        }).then(function (page) {
          var chunk = normalizeRows(page.rows);
          if (!chunk.length) return;
          rows = rows.concat(chunk);
          return next();
        });
      }

      return next().then(function () {
        if (rows.length >= MAX_ROWS && state.total > rows.length) {
          state.truncated = true;
          log('数据超过 ' + MAX_ROWS + ' 行，仅载入前 ' + MAX_ROWS + ' 行', 'warn');
          toast('数据量较大，仅载入前 ' + MAX_ROWS + ' 行参与绘图', 'warn');
        }
        state.rows = rows;
        if (state.total < rows.length) state.total = rows.length;
        log('已载入「' + state.sheet + '」' + rows.length + ' 行 × ' + state.columns.length + ' 列');
      });
    });
  }

  function autoPickColumns() {
    var names = columnNames().filter(function (n) { return n !== ''; });
    if (!names.length) return;
    var nums = names.filter(isNumericColumn);
    // 优先用第一个数值列作 X，避免首列是文本标签时默认渲染失败
    var x = nums.length ? nums[0] : names[0];
    var ys = nums.filter(function (n) { return n !== x; }).slice(0, 2);
    if (!ys.length && isNumericColumn(x)) ys = [x];
    if (!ys.length && nums.length) ys = [nums[0]];
    state.selectedCols.x = x;
    state.selectedCols.ys = ys;
  }

  function resetRowRange() {
    var s = el('inpRowStart');
    var e = el('inpRowEnd');
    if (s) s.value = state.rows.length ? '1' : '';
    if (e) e.value = state.rows.length ? String(state.rows.length) : '';
  }

  /* ------------------------------------------------------------
   * 七、左侧栏渲染
   * ---------------------------------------------------------- */

  function updateDatasetInfo() {
    var box = el('datasetInfo');
    if (!box) return;
    clear(box);
    if (!state.ds) {
      box.appendChild(h('span', 'muted', '尚未导入数据'));
      return;
    }
    box.appendChild(h('div', 'ds-name', state.filename || state.ds));
    var sh = null;
    for (var i = 0; i < state.sheets.length; i++) {
      if (state.sheets[i].name === state.sheet) { sh = state.sheets[i]; break; }
    }
    var rows = state.rows.length;
    var cols = state.columns.length;
    var line = rows + ' 行 × ' + cols + ' 列';
    if (sh && sh.row_count !== null && sh.row_count !== undefined && Number(sh.row_count) !== rows) {
      line += '（原始 ' + fmtInt(sh.row_count) + ' 行）';
    }
    box.appendChild(h('div', 'muted small', line));
    box.appendChild(h('div', 'muted small', '数据集：' + state.ds));
  }

  function renderSheetList() {
    var wrap = el('sheetList');
    if (!wrap) return;
    clear(wrap);
    if (!state.sheets.length) {
      wrap.appendChild(h('div', 'muted small pad6', '导入后显示工作表'));
      return;
    }
    state.sheets.forEach(function (s) {
      var b = h('button', 'sheet-item' + (s.name === state.sheet ? ' active' : ''));
      b.type = 'button';
      b.appendChild(h('span', 'sheet-name', s.name));
      if (s.row_count !== null && s.row_count !== undefined) {
        b.appendChild(h('span', 'sheet-rows', fmtInt(s.row_count) + ' 行'));
      }
      b.addEventListener('click', function () {
        if (s.name === state.sheet) return;
        log('切换工作表：' + s.name);
        selectSheet(s.name);
      });
      wrap.appendChild(b);
    });
  }

  function renderColumns() {
    var wrap = el('columnList');
    if (!wrap) return;
    clear(wrap);
    var filterEl = el('colFilter');
    var filter = filterEl ? String(filterEl.value || '').trim().toLowerCase() : '';
    var count = el('colCount');
    if (count) count.textContent = state.columns.length ? '共 ' + state.columns.length + ' 列' : '';

    if (!state.columns.length) {
      wrap.appendChild(h('div', 'muted small pad6', state.ds ? '该工作表没有列信息' : '导入后显示列'));
      return;
    }

    var shown = 0;
    state.columns.forEach(function (c) {
      if (filter && c.name.toLowerCase().indexOf(filter) < 0) return;
      shown++;
      var item = h('div', 'col-item');
      item.draggable = true;
      item.dataset.col = c.name;

      var numeric = isNumericColumn(c.name);
      var dt = isDatetimeColumn(c.name);
      var title = c.name + (c.dtype ? '（' + dtypeLabel(c.dtype) + '）' : '');
      if (dt) title += ' · 可作 X 轴（时间）';
      item.title = title;

      var icon;
      if (dt) icon = h('span', 'dtype dtype-time', '⏱');
      else icon = h('span', 'dtype ' + (numeric ? 'dtype-num' : 'dtype-txt'), numeric ? '123' : 'Ab');
      item.appendChild(icon);
      item.appendChild(h('span', 'col-name', c.name));
      var unitTxt = unitTag(c.name, c.unit);
      if (unitTxt) item.appendChild(h('span', 'col-unit', unitTxt.replace(/[()（）]/g, '')));
      if (c.n_missing !== null && c.n_missing !== undefined && Number(c.n_missing) > 0) {
        item.appendChild(h('span', 'col-miss', '缺 ' + fmtInt(c.n_missing)));
      }
      // 时间列只能当 X，不给 +Y 按钮，省得点了才报错
      if (!dt) {
        var add = h('button', 'col-add', '+Y');
        add.type = 'button';
        add.title = '添加到 Y 列';
        item.appendChild(add);
      }
      wrap.appendChild(item);
    });

    if (!shown) wrap.appendChild(h('div', 'muted small pad6', '没有匹配的列'));
  }

  /* ------------------------------------------------------------
   * 八、右侧映射控件
   * ---------------------------------------------------------- */

  function fillSelect(sel, items, opts) {
    if (!sel) return;
    var o = opts || {};
    var prev = o.selected !== undefined ? o.selected : sel.value;
    clear(sel);
    if (o.allowEmpty) sel.appendChild(new Option(o.emptyLabel || '（无）', ''));
    items.forEach(function (it) {
      if (typeof it === 'string') sel.appendChild(new Option(it, it));
      else sel.appendChild(new Option(it.label, it.value));
    });
    if (!o.multiple && prev !== null && prev !== undefined && prev !== '') {
      var found = false;
      for (var i = 0; i < sel.options.length; i++) {
        if (sel.options[i].value === String(prev)) { found = true; break; }
      }
      if (found) sel.value = String(prev);
    }
  }

  function syncColumnSelects() {
    var names = columnNames().filter(function (n) { return n !== ''; });
    var nums = names.filter(isNumericColumn);

    fillSelect(el('selX'), names, { allowEmpty: true, emptyLabel: '（请选择）', selected: state.selectedCols.x });
    fillSelect(el('selXErr'), names, { allowEmpty: true, emptyLabel: '（无）', selected: state.selectedCols.xerr });
    fillSelect(el('selYErr'), names, { allowEmpty: true, emptyLabel: '（无）', selected: state.selectedCols.yerr });

    var defaultY = state.selectedCols.ys[0] || nums[0] || '';
    fillSelect(el('selDescCols'), nums, { multiple: true, selected: defaultY });
    fillSelect(el('selUncCol'), nums, { selected: defaultY });
    fillSelect(el('selTestX'), nums, { selected: defaultY });
    fillSelect(el('selTestY'), nums, { allowEmpty: true, emptyLabel: '（无 / 单样本）', selected: state.selectedCols.ys[1] || '' });

    var descSel = el('selDescCols');
    if (descSel && descSel.options.length && descSel.selectedIndex < 0) descSel.selectedIndex = 0;

    refreshYAdd();
  }

  function refreshYAdd() {
    var sel = el('selYAdd');
    if (!sel) return;
    var nums = numericColumns().filter(function (n) {
      return state.selectedCols.ys.indexOf(n) < 0;
    });
    fillSelect(sel, nums, { allowEmpty: true, emptyLabel: nums.length ? '（选择要添加的列）' : '（没有可添加的数值列）' });
  }

  function syncMappingUI() {
    var selX = el('selX');
    if (selX) selX.value = state.selectedCols.x || '';
    var xe = el('selXErr');
    if (xe) xe.value = state.selectedCols.xerr || '';
    var ye = el('selYErr');
    if (ye) ye.value = state.selectedCols.yerr || '';
    renderYChips();
    refreshYAdd();
  }

  function renderYChips() {
    var wrap = el('yList');
    if (!wrap) return;
    clear(wrap);
    var ys = state.selectedCols.ys;
    if (!ys.length) {
      wrap.appendChild(h('span', 'chip-empty', '尚未选择 Y 列'));
      return;
    }
    ys.forEach(function (name) {
      var chip = h('div', 'chip');
      chip.draggable = true;
      chip.dataset.col = name;
      chip.appendChild(h('span', 'grip'));
      chip.appendChild(h('span', 'chip-name', name));
      // 左右轴指派（只对支持双纵轴的图型显示）：
      // 值直接落在 state.panels[active].yAxis —— 这是它唯一的持久化位置，
      // commitPanel 不写这个字段，所以不会出现"UI 写一份、面板再写一份"打架。
      if (TWIN_AXIS_KINDS[state.kind]) {
        var side = panelYAxis()[name] === 'right' ? 'right' : 'left';
        var ab = h('button', 'chip-axis' + (side === 'right' ? ' is-right' : ''), side === 'right' ? '右' : '左');
        ab.type = 'button';
        ab.title = side === 'right'
          ? '这一列画在右侧 Y₂ 轴，点击改回左轴'
          : '这一列画在左侧 Y 轴，点击改到右侧 Y₂ 轴';
        ab.addEventListener('click', function (ev) {
          ev.stopPropagation();
          var map = panelYAxis();
          map[name] = (map[name] === 'right') ? 'left' : 'right';
          afterMappingChange('Y 列坐标轴');
        });
        chip.appendChild(ab);
      }
      var rm = h('button', 'chip-x', '×');
      rm.type = 'button';
      rm.title = '移除';
      rm.addEventListener('click', function (ev) {
        ev.stopPropagation();
        var i = state.selectedCols.ys.indexOf(name);
        if (i >= 0) state.selectedCols.ys.splice(i, 1);
        afterMappingChange();
      });
      chip.appendChild(rm);
      chip.addEventListener('dragstart', function (ev) {
        shared.dragPayload = { type: 'y', name: name };
        ev.dataTransfer.effectAllowed = 'move';
        try { ev.dataTransfer.setData('text/plain', 'y:' + name); } catch (e) { /* 忽略 */ }
        chip.classList.add('dragging');
      });
      chip.addEventListener('dragend', function () {
        shared.dragPayload = null;
        chip.classList.remove('dragging');
      });
      wrap.appendChild(chip);
    });
  }

  // Y 列表的副标题要跟着图型变：三维图对 Y 列的用法跟二维完全不一样，
  // 写死一句"多选"的话用户不知道第 2 列其实去了 Z 轴。
  function renderYColHint() {
    var tip = el('yColHint');
    if (!tip) return;
    var meta = kindMeta(state.kind);
    if (meta && meta.needZ) tip.textContent = '第 1 列作 Y，第 2 列作 Z，可继续成对添加';
    else if (meta && meta.needMatrix) tip.textContent = '每列一条高度曲线，X 列作为曲面/柱列的横轴';
    else tip.textContent = '多选，可拖拽排序';
  }

  function addY(name) {
    if (!name) return;
    if (state.selectedCols.ys.indexOf(name) >= 0) {
      toast('该列已在 Y 列表中', 'warn');
      return;
    }
    if (!isNumericColumn(name)) {
      toast('Y 列必须是数值列', 'warn');
      return;
    }
    state.selectedCols.ys.push(name);
    afterMappingChange();
  }

  function afterMappingChange(label) {
    syncMappingUI();
    autoLabels(false);
    commitPanel();
    renderPanelBar();
    pushHistory(label || '数据映射');
    scheduleRender(0);
  }

  // 不同图表类型的默认轴标签：直方图的值在 X 轴，箱线图/小提琴的 X 轴是分类
  function axisLabelsFor(cfg) {
    var kind = cfg.kind;
    var x = cfg.x || '';
    var ys = cfg.ys || [];
    var yaxis = (cfg.yAxis && typeof cfg.yAxis === 'object') ? cfg.yAxis : {};

    // 指派到右轴的列不能再出现在左轴标签里 —— 否则开了双轴之后左轴标签会
    // 把两边列名一起拼出来，看上去像左轴承担了全部数据。
    var left = [], right = [];
    ys.forEach(function (n) {
      if (yaxis[n] === 'right') right.push(n);
      else left.push(n);
    });
    var ytxt = left.join(', ');
    var y2txt = right.join(', ');
    var none = { x: x, y: ytxt, y2: y2txt, z: '' };

    if (kind === 'hist') return { x: ytxt, y: '频数', y2: y2txt, z: '' };
    if (kind === 'box' || kind === 'violin') return { x: '', y: ytxt, y2: y2txt, z: '' };
    if (kind === 'qq') return { x: '理论分位数', y: '样本分位数', y2: y2txt, z: '' };
    if (kind === 'heatmap' || kind === 'pie') return { x: '', y: '', y2: '', z: '' };

    var meta = (typeof G.kindMeta === 'function') ? G.kindMeta(kind) : null;
    if (meta && meta.needZ) {
      // Y/Z 两两配对：Y 轴标签用配对里的第 1 列，Z 轴标签用第 2 列，
      // 拼在一起会让人以为两根轴画的是同一批数据。
      return { x: x, y: ys[0] || '', y2: y2txt, z: ys[1] || '' };
    }
    if (meta && meta.needMatrix) {
      // 矩阵类三维图：Y 轴刻度已经是各列的名字（见 _set_matrix_ticks），
      // 不需要再给一个重复作用的 ylabel，只有 Z 需要说明"高度是什么"。
      return { x: x, y: '', y2: '', z: ytxt };
    }
    return none;
  }

  function titleFor(cfg) {
    var kind = cfg.kind;
    var x = cfg.x || '';
    var ys = cfg.ys || [];
    var ytxt = ys.join(' / ');
    if (!ytxt) return '';
    if (kind === 'heatmap') return '相关系数矩阵';
    if (kind === 'pie' || kind === 'hist' || kind === 'box' ||
      kind === 'violin' || kind === 'qq') return ytxt;
    return x ? (ytxt + ' — ' + x) : ytxt;
  }

  function autoAxisLabels() {
    return axisLabelsFor({ kind: state.kind, x: state.selectedCols.x, ys: state.selectedCols.ys });
  }

  function autoTitle() {
    var g = state.gridShape || [1, 1];
    // 多子图时标题留给用户自己填：自动生成的"y — x"太长，在 2×2 的窄格里
    // 会跟相邻面板的标题、(a) 角标挤在一起，反而看不清。
    if ((g[0] || 1) * (g[1] || 1) > 1) return '';
    return titleFor({ kind: state.kind, x: state.selectedCols.x, ys: state.selectedCols.ys });
  }

  function autoLabels(force) {
    var auto = autoAxisLabels();
    var xinp = el('inpXlabel');
    var yinp = el('inpYlabel');
    var tinp = el('inpTitle');
    if (xinp && (force || xinp.dataset.auto !== '0')) {
      xinp.value = auto.x;
      xinp.dataset.auto = '1';
    }
    if (yinp && (force || yinp.dataset.auto !== '0')) {
      yinp.value = auto.y;
      yinp.dataset.auto = '1';
    }
    if (tinp && (force || tinp.dataset.auto !== '0')) {
      tinp.value = autoTitle();
      tinp.dataset.auto = '1';
    }
  }

  /* ---- 挂到全局，供后续文件互调（无打包器，靠全局作用域） ---- */
  G.readFileB64 = readFileB64;
  G.dsId = dsId;
  G.showOverlay = showOverlay;
  G.handleFile = handleFile;
  G.selectSheet = selectSheet;
  G.loadRows = loadRows;
  G.autoPickColumns = autoPickColumns;
  G.resetRowRange = resetRowRange;
  G.updateDatasetInfo = updateDatasetInfo;
  G.renderSheetList = renderSheetList;
  G.renderColumns = renderColumns;
  G.fillSelect = fillSelect;
  G.syncColumnSelects = syncColumnSelects;
  G.refreshYAdd = refreshYAdd;
  G.syncMappingUI = syncMappingUI;
  G.renderYChips = renderYChips;
  G.renderYColHint = renderYColHint;
  G.addY = addY;
  G.afterMappingChange = afterMappingChange;
  G.axisLabelsFor = axisLabelsFor;
  G.titleFor = titleFor;
  G.autoAxisLabels = autoAxisLabels;
  G.autoTitle = autoTitle;
  G.autoLabels = autoLabels;
})(window);
