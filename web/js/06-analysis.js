/* =============================================================
 * DataLab 前端 · 06-analysis.js
 * 弹窗与数据变换 / 结果卡片 / 拟合 / 统计 / 数据表格
 * 源区间：原 app.js 第 2263–3224 行（按分节切分，未改动任何函数体）
 * 加载顺序由 index.html 决定：必须先加载它前面的脚本，不能单独引用。
 * ============================================================= */
(function (G) {
  'use strict';

  /* ------------------------------------------------------------
   * 十·五、通用弹窗 / 数据变换 / 快捷键说明
   * ---------------------------------------------------------- */

  function openModal(title, bodyNode, footNodes) {
    var mask = el('modalMask');
    if (!mask) return;
    var t = el('modalTitle');
    if (t) t.textContent = title || '';
    var body = el('modalBody');
    if (body) {
      clear(body);
      if (bodyNode) body.appendChild(bodyNode);
    }
    var foot = el('modalFoot');
    if (foot) {
      clear(foot);
      (footNodes || []).forEach(function (n) { if (n) foot.appendChild(n); });
    }
    mask.hidden = false;
  }

  function closeModal() {
    var mask = el('modalMask');
    if (mask) {
      mask.hidden = true;
      // 子图设置弹窗会临时把遮罩改成"靠右窄面板"，关掉时恢复默认居中样式
      mask.classList.remove('is-dock-right');
    }
  }

  function modalOpen() {
    var mask = el('modalMask');
    return !!(mask && !mask.hidden);
  }

  function fieldRow(label, control, hint) {
    var wrap = h('label', 'field');
    var span = h('span', null, label);
    if (hint) span.appendChild(h('em', null, hint));
    wrap.appendChild(span);
    wrap.appendChild(control);
    return wrap;
  }

  // 变换清单来自 /api/themes 的 transforms（后端是唯一事实来源）
  function transformEntries() {
    var src = state.transforms && typeof state.transforms === 'object' ? state.transforms : {};
    var ids = Object.keys(src);
    return ids.map(function (id) {
      var v = src[id] || {};
      return {
        id: id,
        name: String(v.name || id),
        params: Array.isArray(v.params) ? v.params : []
      };
    });
  }

  function transformMeta(id) {
    var list = transformEntries();
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }

  function openTransformDialog() {
    if (!state.ds || !state.sheet) { toast('请先导入数据', 'error'); return; }
    var nums = numericColumns();
    if (!nums.length) { toast('当前工作表没有数值列，无法做变换', 'error'); return; }
    var entries = transformEntries();
    if (!entries.length) { toast('变换清单未加载，请刷新页面', 'error'); return; }

    var body = h('div', 'modal-form');
    body.appendChild(h('p', 'tf-note', '变换结果会作为「新列」写回当前工作表，原始列保持不变。'));

    var colSel = h('select', 'input');
    colSel.id = 'tfCol';
    nums.forEach(function (n) { colSel.appendChild(new Option(n, n)); });
    var prefer = state.selectedCols.ys[0];
    if (prefer && nums.indexOf(prefer) >= 0) colSel.value = prefer;
    body.appendChild(fieldRow('源列', colSel));

    var opSel = h('select', 'input');
    opSel.id = 'tfOp';
    entries.forEach(function (t) { opSel.appendChild(new Option(t.name, t.id)); });
    body.appendChild(fieldRow('变换', opSel));

    var paramsBox = h('div', 'tf-params');
    paramsBox.id = 'tfParams';
    body.appendChild(paramsBox);

    var nameInp = h('input', 'input');
    nameInp.id = 'tfName';
    nameInp.type = 'text';
    nameInp.placeholder = '留空自动命名';
    body.appendChild(fieldRow('新列名', nameInp, '可空'));

    function renderParams() {
      clear(paramsBox);
      var meta = transformMeta(opSel.value);
      if (!meta || !meta.params.length) return;
      meta.params.forEach(function (p) {
        var inp = h('input', 'input input-sm');
        inp.type = (p.type === 'int' || p.type === 'float' || p.type === 'number') ? 'number' : 'text';
        if (inp.type === 'number') inp.step = (p.type === 'int') ? '1' : 'any';
        inp.dataset.param = String(p.key);
        inp.dataset.ptype = String(p.type || 'text');
        inp.value = (p.default === undefined || p.default === null) ? '' : String(p.default);
        paramsBox.appendChild(fieldRow(String(p.label || p.key), inp));
      });
    }
    opSel.addEventListener('change', renderParams);
    renderParams();

    var submit = h('button', 'btn btn-primary', '生成新列');
    submit.type = 'button';
    var cancel = h('button', 'btn', '取消');
    cancel.type = 'button';
    cancel.addEventListener('click', closeModal);

    submit.addEventListener('click', function () {
      var op = opSel.value;
      var params = {};
      Array.prototype.forEach.call(paramsBox.querySelectorAll('input'), function (inp) {
        var key = inp.dataset.param;
        var type = inp.dataset.ptype;
        if (type === 'int') {
          var n = numOrNull(inp.value);
          params[key] = n === null ? null : Math.round(n);
        } else if (type === 'float' || type === 'number') {
          params[key] = numOrNull(inp.value);
        } else {
          params[key] = inp.value;
        }
        if (params[key] === null) delete params[key];
      });

      var payload = {
        ds: state.ds,
        sheet: state.sheet,
        col: colSel.value,
        op: op,
        params: params
      };
      if (op === 'derivative' && state.selectedCols.x && isNumericColumn(state.selectedCols.x)) {
        payload.x_col = state.selectedCols.x;
      }
      var custom = String(nameInp.value || '').trim();
      if (custom) payload.name = custom;

      submit.disabled = true;
      api('/api/data/transform', payload).then(function (data) {
        closeModal();
        var newName = String(data.name || '');
        var info = data.info || {};
        log('生成新列：' + newName + (info.note ? '（' + info.note + '）' : ''));
        if (Array.isArray(data.columns) && data.columns.length) {
          state.columns = normalizeColumns(data.columns);
          shared.numericCache = Object.create(null);
        }
        if (Number(info.dropped) > 0 && info.note) toast(String(info.note), 'warn');
        return refreshAfterTransform(newName);
      }).catch(function (err) {
        var msg = err && err.message ? err.message : String(err);
        toast('生成新列失败：' + msg, 'error');
        log('生成新列失败：' + msg, 'error');
      }).then(function () {
        submit.disabled = false;
      });
    });

    openModal('生成新列（数据变换）', body, [cancel, submit]);
  }

  // 变换在服务端改了数据，必须重新拉一次行数据，否则新列在本地是空的
  function refreshAfterTransform(newName) {
    showOverlay(true, '刷新数据…');
    return loadRows().then(function () {
      showOverlay(false);
      if (!state.columns.length) state.columns = normalizeColumns(state.previewColumns);
      syncColumnSelects();
      var ys = state.selectedCols.ys.filter(function (n) { return colIndex(n) >= 0; });
      if (newName && colIndex(newName) >= 0) {
        ys = [newName].concat(ys.filter(function (n) { return n !== newName; }));
      }
      state.selectedCols.ys = ys;
      syncMappingUI();
      renderColumns();
      updateDatasetInfo();
      renderTable();
      syncBackend();
      commitPanel();
      pushHistory('生成新列');
      scheduleRender(0);
      if (newName) {
        toast('已生成新列「' + newName + '」并加入 Y 列', 'success');
        markAnalysis('数据变换完成：' + newName + ' → 已加入 Y 列');
      }
    }).catch(function (err) {
      showOverlay(false);
      var msg = err && err.message ? err.message : String(err);
      toast('刷新数据失败：' + msg, 'error');
      log('刷新数据失败：' + msg, 'error');
    });
  }

  function openShortcuts() {
    var rows = [
      ['Ctrl / ⌘ + O', '打开文件（也可直接按 O）'],
      ['Enter / Ctrl + Enter', '执行拟合'],
      ['R', '按当前配置重新渲染'],
      ['Ctrl / ⌘ + S', '导出 PNG（浏览器下载）'],
      ['Ctrl / ⌘ + Z', '撤销一步配置变更'],
      ['Ctrl + Shift + Z / Ctrl + Y', '重做'],
      ['Esc', '关闭菜单 / 弹窗 / 浮层'],
      ['?', '显示这个快捷键面板'],
      ['滚轮 / 拖拽 / 双击', '缩放 / 平移 / 复位图表']
    ];
    var body = h('div', 'sc-list');
    rows.forEach(function (r) {
      var row = h('div', 'sc-row');
      row.appendChild(h('kbd', null, r[0]));
      row.appendChild(h('span', null, r[1]));
      body.appendChild(row);
    });
    var ok = h('button', 'btn btn-primary', '知道了');
    ok.type = 'button';
    ok.addEventListener('click', closeModal);
    openModal('快捷键', body, [ok]);
  }

  /* ------------------------------------------------------------
   * 十一、结果卡片 / 表格
   * ---------------------------------------------------------- */

  function dataTable(headers, rows) {
    var table = h('table', 'res-table');
    var thead = h('thead');
    var htr = h('tr');
    headers.forEach(function (x) { htr.appendChild(h('th', null, x)); });
    thead.appendChild(htr);
    table.appendChild(thead);

    var tbody = h('tbody');
    var tsv = [headers.map(function (x) { return String(x); }).join('\t')];
    rows.forEach(function (row) {
      var tr = h('tr');
      var cells = row.map(function (c) {
        return (c && typeof c === 'object') ? c : { v: c, cls: '' };
      });
      cells.forEach(function (c) {
        var text = (c.v === null || c.v === undefined || c.v === '') ? '—' : String(c.v);
        var td = h('td', c.cls || null, text);
        tr.appendChild(td);
      });
      tsv.push(cells.map(function (c) {
        return (c.v === null || c.v === undefined) ? '' : String(c.v);
      }).join('\t'));
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    return { table: table, tsv: tsv.join('\n') };
  }

  function resultCard(opts) {
    var card = h('div', 'res-card');
    var head = h('div', 'res-head');
    head.appendChild(h('span', 'res-title', opts.title || '结果'));
    if (opts.copyText) {
      var copyBtn = h('button', 'btn btn-sm', '复制结果');
      copyBtn.type = 'button';
      copyBtn.addEventListener('click', function () {
        copyText(opts.copyText || '').then(function (ok) {
          toast(ok ? '结果已复制到剪贴板' : '复制失败，请手动选择', ok ? 'success' : 'error');
        });
      });
      head.appendChild(copyBtn);
    }
    card.appendChild(head);
    (opts.blocks || []).forEach(function (b) { if (b) card.appendChild(b); });
    if (opts.conclusion) {
      var p = h('p', 'res-conclusion' + (opts.conclusionClass ? ' ' + opts.conclusionClass : ''), opts.conclusion);
      card.appendChild(p);
    }
    return card;
  }

  /**
   * LaTeX 公式块：显示原始 TeX，并提供三种常用包裹形式的复制按钮。
   * 论文里 equation 环境 / $$…$$ / 行内 \(…\) 各有用处，让用户直接拿走不用改。
   */
  function latexBlock(tex) {
    var s = String(tex === null || tex === undefined ? '' : tex).trim();
    // 后端偶尔会带 $ 定界符，统一去掉，避免复制出来变成 $y = ...$
    s = s.replace(/^\$+/, '').replace(/\$+$/, '').trim();
    if (!s) return null;

    var variants = [
      { label: '纯公式', value: s },
      { label: '$$ … $$', value: '$$\n' + s + '\n$$' },
      { label: 'equation', value: '\\begin{equation}\n  ' + s + '\n\\end{equation}' }
    ];

    var wrap = h('div', 'latex-block');

    var head = h('div', 'latex-head');
    head.appendChild(h('span', 'latex-label', 'LaTeX'));
    head.appendChild(h('span', 'latex-hint', '点公式整行复制'));
    wrap.appendChild(head);

    var code = h('code', 'latex-code', s);
    code.title = '点击复制纯公式';
    code.addEventListener('click', function () {
      copyText(s).then(function (ok) {
        toast(ok ? 'LaTeX 公式已复制' : '复制失败，请手动选择', ok ? 'success' : 'error');
      });
    });
    wrap.appendChild(code);

    var acts = h('div', 'latex-actions');
    variants.forEach(function (v) {
      var b = h('button', 'btn btn-sm', v.label);
      b.type = 'button';
      b.addEventListener('click', function () {
        copyText(v.value).then(function (ok) {
          toast(ok ? '已复制（' + v.label + '）' : '复制失败，请手动选择', ok ? 'success' : 'error');
        });
      });
      acts.appendChild(b);
    });
    wrap.appendChild(acts);

    return wrap;
  }

  function reportError(host, title, err) {
    var msg = err && err.message ? err.message : String(err || '未知错误');
    if (host) {
      clear(host);
      host.appendChild(resultCard({
        title: title,
        blocks: [h('p', 'res-error', msg)],
        copyText: ''
      }));
    }
    toast(title + '：' + msg, 'error');
    log(title + '：' + msg, 'error');
  }

  function clearSelectionResults() {
    ['descResult', 'uncResult', 'testResult'].forEach(function (id) {
      var host = el(id);
      if (host) clear(host);
    });
  }

  /* ------------------------------------------------------------
   * 十二、拟合
   * ---------------------------------------------------------- */

  function clearFitResult() {
    var host = el('fitResult');
    if (!host) return;
    clear(host);
    host.appendChild(h('p', 'hint', '尚未拟合。选择模型后点击「执行拟合」。'));
  }

  function toggleDegRow() {
    var model = el('selFitModel') ? el('selFitModel').value : '';
    var row = el('degRow');
    if (row) row.hidden = model !== 'poly';
  }

  function runFit() {
    if (!state.ds || !state.sheet) { toast('请先导入数据', 'error'); return; }
    var x = state.selectedCols.x;
    var y = state.selectedCols.ys[0];
    if (!x || !y) {
      toast('请先在「图表」页选择 X 列与至少一个 Y 列', 'error');
      switchTab('chart');
      return;
    }
    var model = el('selFitModel').value || 'linear';
    var useYerr = !!(el('chkUseYerr') && el('chkUseYerr').checked);
    var yerrCol = state.selectedCols.yerr;
    if (useYerr && !yerrCol) {
      toast('未选择 Y 误差列，将按等权拟合', 'warn');
      useYerr = false;
    }
    var deg = numOrNull(el('inpDeg').value);
    var body = {
      ds: state.ds,
      sheet: state.sheet,
      x_col: x,
      y_col: y,
      model: model,
      deg: deg === null ? 2 : Math.round(deg),
      use_yerr: useYerr,
      yerr_col: useYerr ? yerrCol : null
    };
    var btn = el('btnFit');
    if (btn) btn.disabled = true;
    state.fit = null;
    state.fitKey = '';
    log('拟合：' + model + '，' + y + ' ~ ' + x + (model === 'poly' ? '（' + body.deg + ' 阶）' : ''));

    api('/api/stats/fit', body).then(function (data) {
      var fit = {};
      Object.keys(data).forEach(function (k) { if (k !== 'ok') fit[k] = data[k]; });
      state.fit = fit;
      state.fitKey = currentFitKey();
      renderFitResult(fit);
      scheduleRender(0);
      toast('拟合完成' + (fit.r2 !== null && fit.r2 !== undefined ? '，R² = ' + fmtNum(fit.r2, 5) : ''), 'success');
      log('拟合完成：' + (fit.equation_plain || fit.equation_latex || '') );
      markAnalysis('拟合完成' + (fit.equation_plain ? '：' + fit.equation_plain : ''));
    }).catch(function (err) {
      var msg = err && err.message ? err.message : String(err);
      toast('拟合失败：' + msg, 'error');
      log('拟合失败：' + msg, 'error');
      var host = el('fitResult');
      if (host) {
        clear(host);
        host.appendChild(resultCard({ title: '拟合失败', blocks: [h('p', 'res-error', msg)] }));
      }
      scheduleRender(0);
    }).then(function () {
      if (btn) btn.disabled = false;
    });
  }

  function renderFitResult(fit) {
    var host = el('fitResult');
    if (!host) return;
    clear(host);

    var eq = String(fit.equation_plain || fit.equation_latex || '（无方程）');
    var eqBox = h('div', 'fit-eq', eq);
    eqBox.title = '点击复制公式文本';
    eqBox.addEventListener('click', function () {
      copyText(eq).then(function (ok) {
        toast(ok ? '公式已复制' : '复制失败，请手动选择', ok ? 'success' : 'error');
      });
    });

    var metrics = h('div', 'metric-grid');
    function metric(label, value) {
      var box = h('div', 'metric');
      box.appendChild(h('b', null, value));
      box.appendChild(h('span', null, label));
      metrics.appendChild(box);
    }
    metric('R²', fmtNum(fit.r2, 5));
    metric('调整 R²', fmtNum(fit.adj_r2, 5));
    metric('RMSE', fmtNum(fit.rmse, 5));
    metric('χ²/ν', fmtNum(fit.chi2_red, 5));
    metric('样本数 n', fmtInt(fit.n));
    metric('自由度 ν', fmtInt(fit.dof));

    var blocks = [eqBox];

    // LaTeX 块紧跟公式框，避免被参数表挤到面板底部还要滚一下才看得见
    if (fit.equation_latex) {
      var texBlock = latexBlock(fit.equation_latex);
      if (texBlock) blocks.push(texBlock);
    }

    blocks.push(metrics);

    var params = Array.isArray(fit.params) ? fit.params : [];
    if (params.length) {
      var rows = params.map(function (p) {
        return [p.name !== undefined ? p.name : '—', fmtNum(p.value, 6), fmtNum(p.stderr, 6)];
      });
      var t = dataTable(['参数', '估计值', '标准误'], rows);
      blocks.push(t.table);
    }

    var conclusion = '拟合完成';
    if (fit.r2 !== null && fit.r2 !== undefined) conclusion += '，R² = ' + fmtNum(fit.r2, 5);
    if (fit.rmse !== null && fit.rmse !== undefined) conclusion += '，RMSE = ' + fmtNum(fit.rmse, 5);
    conclusion += '。曲线已并入图表。';

    var copyLines = ['模型：' + String(fit.model_name || fit.model || ''), '方程：' + eq];
    if (fit.equation_latex) {
      var texRaw = String(fit.equation_latex).replace(/^\$+/, '').replace(/\$+$/, '').trim();
      if (texRaw) copyLines.push('LaTeX：$' + texRaw + '$');
    }
    params.forEach(function (p) {
      var pn = (p.name !== undefined && p.name !== null) ? String(p.name) : '参数';
      copyLines.push(pn + ' = ' + fmtNum(p.value, 8) + ' ± ' + fmtNum(p.stderr, 8));
    });
    copyLines.push('R² = ' + fmtNum(fit.r2, 6) + '，RMSE = ' + fmtNum(fit.rmse, 6));
    copyLines.push(conclusion);

    host.appendChild(resultCard({
      title: '拟合结果' + (fit.model_name ? ' · ' + fit.model_name : ''),
      blocks: blocks,
      conclusion: conclusion,
      copyText: copyLines.join('\n')
    }));
  }

  /* ---------------- 模型比较 ---------------- */

  function runFitCompare() {
    if (!state.ds || !state.sheet) { toast('请先导入数据', 'error'); return; }
    var x = state.selectedCols.x;
    var y = state.selectedCols.ys[0];
    if (!x || !y) {
      toast('请先在「图表」页选择 X 列与至少一个 Y 列', 'error');
      switchTab('chart');
      return;
    }
    var useYerr = !!(el('chkUseYerr') && el('chkUseYerr').checked);
    var yerrCol = state.selectedCols.yerr;
    if (useYerr && !yerrCol) {
      toast('未选择 Y 误差列，将按等权比较', 'warn');
      useYerr = false;
    }
    var deg = numOrNull(el('inpDeg').value);
    var body = {
      ds: state.ds,
      sheet: state.sheet,
      x_col: x,
      y_col: y,
      deg: deg === null ? 2 : Math.round(deg),
      use_yerr: useYerr,
      yerr_col: useYerr ? yerrCol : null
    };
    var btn = el('btnFitCompare');
    if (btn) btn.disabled = true;
    var host = el('fitCompare');
    if (host) {
      clear(host);
      host.appendChild(h('p', 'hint', '正在比较 9 个模型…'));
    }
    log('模型比较：' + y + ' ~ ' + x);
    setBackendState('busy', '计算中');
    setBackendMsg('正在比较全部拟合模型…');

    api('/api/fit/compare', body).then(function (data) {
      renderFitCompare(data);
      var best = null;
      (data.results || []).forEach(function (r) { if (!best && r.ok) best = r; });
      markAnalysis('模型比较完成' + (best ? '：最优为「' + (best.model_name || best.model) + '」' : ''));
      if (data.notes) log('模型比较：' + data.notes);
    }).catch(function (err) {
      reportError(host, '模型比较失败', err);
    }).then(function () {
      if (btn) btn.disabled = false;
    });
  }

  function renderFitCompare(data) {
    var host = el('fitCompare');
    if (!host) return;
    clear(host);

    var results = Array.isArray(data.results) ? data.results : [];
    if (!results.length) {
      host.appendChild(h('p', 'hint', '未返回任何模型结果'));
      return;
    }
    var bestAic = null;
    results.forEach(function (r) {
      if (r.ok && r.aic !== null && r.aic !== undefined) {
        var v = Number(r.aic);
        if (Number.isFinite(v) && (bestAic === null || v < bestAic)) bestAic = v;
      }
    });

    var table = h('table', 'res-table cmp-table');
    var thead = h('thead');
    var htr = h('tr');
    ['#', '模型', 'AIC', 'ΔAIC', 'R²', 'RMSE', '状态'].forEach(function (t) {
      htr.appendChild(h('th', null, t));
    });
    thead.appendChild(htr);
    table.appendChild(thead);

    var tbody = h('tbody');
    var bestRow = -1;
    results.forEach(function (r, i) {
      if (bestRow < 0 && r.ok) bestRow = i;
      var aic = (r.ok && r.aic !== null && r.aic !== undefined) ? Number(r.aic) : null;
      var delta = (aic !== null && bestAic !== null) ? (aic - bestAic) : null;
      var tr = h('tr', (i === bestRow ? 'is-best' : '') + (r.ok ? '' : ' is-fail'));
      tr.dataset.model = String(r.model || '');
      tr.dataset.index = String(i);
      tr.title = r.ok
        ? ('点击用「' + (r.model_name || r.model) + '」重新拟合')
        : ('未收敛' + (r.error ? '：' + r.error : ''));

      tr.appendChild(h('td', 'rank-cell', r.ok ? String(i + 1) : '—'));
      var nameCell = h('td', 'cmp-name');
      nameCell.appendChild(h('span', null, String(r.model_name || r.model || '')));
      if (i === bestRow) nameCell.appendChild(h('span', 'best-tag', '最优'));
      tr.appendChild(nameCell);
      // 窄侧栏里 7 列要挤得下：AIC 1 位小数、R²/RMSE 4 位足够分辨优劣
      tr.appendChild(h('td', 'num', aic === null ? '—' : fmtNum(aic, 1)));
      tr.appendChild(h('td', 'num', delta === null ? '—' : fmtNum(delta, 2)));
      tr.appendChild(h('td', 'num', r.ok ? fmtNum(r.r2, 4) : '—'));
      tr.appendChild(h('td', 'num', r.ok ? fmtNum(r.rmse, 4) : '—'));
      var st = h('td', r.ok ? 'cmp-ok' : 'cmp-bad', r.ok ? '✓' : '未收敛');
      if (!r.ok && r.error) st.title = String(r.error);
      tr.appendChild(st);

      tr.addEventListener('click', function () { useCompareModel(r); });
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);

    var blocks = [];
    if (data.notes) blocks.push(h('p', 'res-conclusion', String(data.notes)));
    var scroller = h('div', 'cmp-scroll');
    scroller.appendChild(table);
    blocks.push(scroller);

    var lines = [String(data.notes || '模型比较')];
    results.forEach(function (r, i) {
      lines.push((i + 1) + '. ' + (r.model_name || r.model)
        + '  AIC=' + (r.ok ? fmtNum(r.aic, 2) : '—')
        + '  R²=' + (r.ok ? fmtNum(r.r2, 5) : '—')
        + '  ' + (r.ok ? '收敛' : '未收敛'));
    });

    host.appendChild(resultCard({
      title: '模型比较',
      blocks: blocks,
      copyText: lines.join('\n')
    }));
  }

  // 点比较表某一行：模型填回下拉，并立刻用该模型拟合一次
  function useCompareModel(r) {
    if (!r || !r.model) return;
    if (!r.ok) {
      toast('「' + (r.model_name || r.model) + '」未收敛，无法用于拟合', 'warn');
      return;
    }
    var sel = el('selFitModel');
    if (sel) {
      var found = false;
      for (var i = 0; i < sel.options.length; i++) {
        if (sel.options[i].value === r.model) { found = true; break; }
      }
      if (!found) sel.appendChild(new Option(String(r.model_name || r.model), String(r.model)));
      sel.value = String(r.model);
    }
    toggleDegRow();
    state.fit = null;
    state.fitKey = '';
    switchTab('fit');
    log('按比较结果切换模型：' + (r.model_name || r.model));
    runFit();
  }

  /* ------------------------------------------------------------
   * 十三、统计
   * ---------------------------------------------------------- */

  function runDescribe() {
    var sel = el('selDescCols');
    var cols = sel ? Array.prototype.slice.call(sel.selectedOptions).map(function (o) { return o.value; }).filter(Boolean) : [];
    if (!cols.length) { toast('请选择至少一列', 'error'); return; }
    var btn = el('btnDescribe');
    if (btn) btn.disabled = true;
    log('描述统计：' + cols.join('、'));

    api('/api/stats/describe', { ds: state.ds, sheet: state.sheet, cols: cols }).then(function (data) {
      var results = [];
      if (Array.isArray(data.results)) {
        results = data.results;
      } else if (data.results && typeof data.results === 'object') {
        results = Object.keys(data.results).map(function (k) {
          var item = data.results[k];
          if (item && typeof item === 'object') {
            if (item.col === undefined) item.col = k;
            return item;
          }
          return { col: k };
        });
      }
      if (!results.length) throw new Error('未返回统计结果');

      var names = results.map(function (r, i) {
        var n = r && r.col !== undefined && r.col !== null ? String(r.col) : '';
        return n || ('第 ' + (i + 1) + ' 列');
      });

      var rows = [];
      METRICS.forEach(function (m) {
        var key = m[0], label = m[1];
        var present = results.some(function (r) { return r && r[key] !== undefined && r[key] !== null; });
        if (!present) return;
        rows.push([label].concat(results.map(function (r) { return fmtNum(r[key], 6); })));
      });

      var t = dataTable(['指标'].concat(names), rows);

      var ns = results.map(function (r) { return toNum(r.n); }).filter(function (v) { return v !== null; });
      var means = results.map(function (r) { return toNum(r.mean); }).filter(function (v) { return v !== null; });
      var conclusion = '已完成 ' + results.length + ' 列的描述统计';
      if (ns.length) {
        var nmin = Math.min.apply(null, ns);
        var nmax = Math.max.apply(null, ns);
        conclusion += '，样本量 n = ' + fmtNum(nmin, 0) + (nmin !== nmax ? '–' + fmtNum(nmax, 0) : '');
      }
      if (means.length) {
        conclusion += '，均值范围 ' + fmtNum(Math.min.apply(null, means), 4) + ' ~ ' + fmtNum(Math.max.apply(null, means), 4);
      }
      conclusion += '。';

      var host = el('descResult');
      if (host) {
        clear(host);
        host.appendChild(resultCard({
          title: '描述统计',
          blocks: [t.table],
          conclusion: conclusion,
          copyText: t.tsv + '\n' + conclusion
        }));
      }
      log('描述统计完成：' + results.length + ' 列');
      markAnalysis('描述统计完成：' + results.length + ' 列');
    }).catch(function (err) {
      reportError(el('descResult'), '描述统计失败', err);
    }).then(function () {
      if (btn) btn.disabled = false;
    });
  }

  function runUncertainty() {
    var col = el('selUncCol') ? el('selUncCol').value : '';
    if (!col) { toast('请选择测量列', 'error'); return; }
    var delta = numOrNull(el('inpDelta').value);
    if (delta === null) { toast('请填写仪器最大允差 a', 'error'); return; }
    var coverage = numOrNull(el('inpCoverageK').value);
    var body = {
      ds: state.ds,
      sheet: state.sheet,
      col: col,
      delta: delta,
      distribution: el('selDist').value || 'uniform',
      confidence: Number(el('selConf').value) || 0.683,
      custom_k: numOrNull(el('inpCustomK').value),
      coverage_k: coverage === null ? 2 : coverage
    };
    var btn = el('btnUnc');
    if (btn) btn.disabled = true;
    log('不确定度：' + col + '，a = ' + delta + '，分布 ' + body.distribution);

    api('/api/stats/uncertainty', body).then(function (data) {
      var rows = [
        ['测量次数 n', fmtInt(data.n)],
        ['平均值 x̄', fmtNum(data.mean, 6)],
        ['样本标准差 s', fmtNum(data.s, 6)],
        ['A 类标准不确定度 u_A', fmtNum(data.u_a, 6)],
        ['仪器最大允差 a', fmtNum(data.delta, 6)],
        ['B 类标准不确定度 u_B', fmtNum(data.u_b, 6)],
        ['合成标准不确定度 u_C', fmtNum(data.u_c, 6)],
        ['包含因子 k', fmtNum(data.coverage_k, 4)],
        ['扩展不确定度 U', fmtNum(data.U, 6)],
        ['相对扩展不确定度', fmtNum(data.relative_U, 6)]
      ];
      var t = dataTable(['项目', '数值'], rows);
      var blocks = [t.table];

      var strBox = h('div', 'result-str', data.result_str ? String(data.result_str) : '—');
      blocks.push(strBox);

      var notes = [];
      if (data.formula) notes.push('公式：' + String(data.formula));
      if (data.k_source) notes.push('k 来源：' + String(data.k_source));
      if (notes.length) blocks.push(h('p', 'latex-note', notes.join('；')));

      var conclusion = '测量结果：' + (data.result_str ? String(data.result_str) : ('u_C = ' + fmtNum(data.u_c, 6)));
      var host = el('uncResult');
      if (host) {
        clear(host);
        host.appendChild(resultCard({
          title: '不确定度评定 · ' + col,
          blocks: blocks,
          conclusion: conclusion,
          copyText: t.tsv + '\n' + conclusion
        }));
      }
      log('不确定度完成：u_C = ' + fmtNum(data.u_c, 6) + '，U = ' + fmtNum(data.U, 6));
      markAnalysis('不确定度评定完成：U = ' + fmtNum(data.U, 6) + (data.result_str ? '（' + data.result_str + '）' : ''));
    }).catch(function (err) {
      reportError(el('uncResult'), '不确定度计算失败', err);
    }).then(function () {
      if (btn) btn.disabled = false;
    });
  }

  function testMeta(id) {
    for (var i = 0; i < TESTS.length; i++) if (TESTS[i].id === id) return TESTS[i];
    return null;
  }

  function runTest() {
    var test = el('selTest') ? el('selTest').value : '';
    var meta = testMeta(test);
    var x = el('selTestX') ? el('selTestX').value : '';
    var y = el('selTestY') ? el('selTestY').value : '';
    if (!x) { toast('请选择数据列', 'error'); return; }
    if (meta && meta.needY && !y) { toast('该检验需要选择第二列', 'error'); return; }

    var mu = numOrNull(el('inpMu').value);
    var body = {
      ds: state.ds,
      sheet: state.sheet,
      test: test,
      col_x: x,
      col_y: y || null,
      mu: mu === null ? 0 : mu,
      alpha: Number(el('selAlpha').value) || 0.05,
      alternative: el('selAlt').value || 'two-sided',
      equal_var: !!(el('chkEqualVar') && el('chkEqualVar').checked)
    };
    var btn = el('btnTest');
    if (btn) btn.disabled = true;
    log('假设检验：' + (meta ? meta.name : test) + '（' + x + (y ? ' vs ' + y : '') + '）');

    api('/api/stats/test', body).then(function (data) {
      var rows = [];
      rows.push(['检验方法', data.test_name ? String(data.test_name) : (meta ? meta.name : test)]);
      rows.push(['原假设 H₀', data.h0 ? String(data.h0) : '—']);
      rows.push(['备择假设 H₁', data.h1 ? String(data.h1) : '—']);
      rows.push(['统计量', fmtNum(data.statistic, 6)]);
      if (data.dof !== null && data.dof !== undefined) rows.push(['自由度', fmtNum(data.dof, 4)]);
      rows.push(['p 值', { v: fmtNum(data.p_value, 6), cls: data.significant ? 'sig-cell' : '' }]);
      rows.push(['显著性水平 α', fmtNum(data.alpha, 3)]);
      if (data.effect_size !== null && data.effect_size !== undefined) {
        rows.push(['效应量' + (data.effect_size_name ? '（' + data.effect_size_name + '）' : ''), fmtNum(data.effect_size, 4)]);
      }
      var t = dataTable(['项目', '结果'], rows);
      var blocks = [t.table];

      if (Array.isArray(data.groups) && data.groups.length) {
        var grows = data.groups.map(function (g, i) {
          return [
            g.name !== undefined ? g.name : ('组 ' + (i + 1)),
            fmtInt(g.n),
            fmtNum(g.mean, 6),
            fmtNum(g.std, 6)
          ];
        });
        var gt = dataTable(['分组', 'n', '均值', '标准差'], grows);
        blocks.push(h('p', 'table-caption', '分组概况'));
        blocks.push(gt.table);
        if (data.ss_between !== undefined || data.ss_within !== undefined || data.eta_squared !== undefined) {
          blocks.push(h('p', 'latex-note',
            'SS组间 = ' + fmtNum(data.ss_between, 6) +
            '，SS组内 = ' + fmtNum(data.ss_within, 6) +
            '，η² = ' + fmtNum(data.eta_squared, 4)));
        }
      }

      var conclusion = data.conclusion ? String(data.conclusion) : ('p = ' + fmtNum(data.p_value, 6) + '，α = ' + fmtNum(data.alpha, 3) + '，' + (data.significant ? '差异显著，拒绝原假设。' : '差异不显著，不能拒绝原假设。'));
      var host = el('testResult');
      if (host) {
        clear(host);
        host.appendChild(resultCard({
          title: '假设检验结果',
          blocks: blocks,
          conclusion: conclusion,
          conclusionClass: data.significant ? 'sig-text' : '',
          copyText: t.tsv + '\n' + conclusion
        }));
      }
      log('检验完成：p = ' + fmtNum(data.p_value, 6) + (data.significant ? '（显著）' : '（不显著）'));
      markAnalysis('假设检验完成：p = ' + fmtNum(data.p_value, 6) + (data.significant ? '（显著）' : '（不显著）'));
    }).catch(function (err) {
      reportError(el('testResult'), '假设检验失败', err);
    }).then(function () {
      if (btn) btn.disabled = false;
    });
  }

  /* ------------------------------------------------------------
   * 十四、数据表格
   * ---------------------------------------------------------- */

  function renderTable() {
    var wrap = el('previewTableWrap');
    if (!wrap) return;
    clear(wrap);

    if (!state.rows.length) {
      wrap.appendChild(h('div', 'empty-state', state.ds ? '当前工作表没有可显示的数据' : '导入数据后在这里查看原始表格'));
      updatePager();
      var meta0 = el('tableMeta');
      if (meta0) meta0.textContent = '';
      return;
    }

    var cols = state.columns.map(function (c) { return c.name; });
    var table = h('table', 'data-table');
    var thead = h('thead');
    var htr = h('tr');
    state.columns.forEach(function (c) {
      var th = h('th');
      th.appendChild(h('span', 'th-name', c.name));
      var thUnit = unitTag(c.name, c.unit);
      if (thUnit) th.appendChild(h('span', 'th-unit', thUnit));
      th.title = c.name + (c.dtype ? ' · ' + dtypeLabel(c.dtype) : '');
      htr.appendChild(th);
    });
    thead.appendChild(htr);
    table.appendChild(thead);

    var tbody = h('tbody');
    var start = state.page * state.pageSize;
    var slice = state.rows.slice(start, start + state.pageSize);
    var numericFlags = state.columns.map(function (c) { return isNumericColumn(c.name); });

    slice.forEach(function (row) {
      var tr = h('tr');
      cols.forEach(function (name, i) {
        var v = row[i];
        var td = h('td');
        if (v === null || v === undefined || v === '') {
          td.className = 'cell-null';
          td.textContent = '—';
        } else if (typeof v === 'number') {
          td.className = 'cell-num';
          td.textContent = fmtNum(v, 6);
        } else if (numericFlags[i] && toNum(v) !== null) {
          td.className = 'cell-num';
          td.textContent = fmtNum(v, 6);
        } else {
          td.textContent = String(v);
          td.title = String(v);
        }
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    wrap.appendChild(table);

    updatePager();

    var meta = el('tableMeta');
    if (meta) {
      var countText = '共 ' + fmtInt(state.total || state.rows.length) + ' 行 · ' + cols.length + ' 列';
      if (state.truncated) countText += '（已截断）';
      meta.textContent = countText;
    }
  }

  function updatePager() {
    var pages = Math.max(1, Math.ceil(state.rows.length / state.pageSize));
    if (state.page >= pages) state.page = pages - 1;
    if (state.page < 0) state.page = 0;
    var info = el('pageInfo');
    if (info) info.textContent = state.rows.length ? ('第 ' + (state.page + 1) + ' / ' + pages + ' 页') : '—';
    var prev = el('pagePrev');
    var next = el('pageNext');
    if (prev) prev.disabled = state.page <= 0;
    if (next) next.disabled = state.page >= pages - 1;
  }

  /* ---- 挂到全局，供后续文件互调（无打包器，靠全局作用域） ---- */
  G.openModal = openModal;
  G.closeModal = closeModal;
  G.modalOpen = modalOpen;
  G.fieldRow = fieldRow;
  G.transformEntries = transformEntries;
  G.transformMeta = transformMeta;
  G.openTransformDialog = openTransformDialog;
  G.refreshAfterTransform = refreshAfterTransform;
  G.openShortcuts = openShortcuts;
  G.dataTable = dataTable;
  G.resultCard = resultCard;
  G.latexBlock = latexBlock;
  G.reportError = reportError;
  G.clearSelectionResults = clearSelectionResults;
  G.clearFitResult = clearFitResult;
  G.toggleDegRow = toggleDegRow;
  G.runFit = runFit;
  G.renderFitResult = renderFitResult;
  G.runFitCompare = runFitCompare;
  G.renderFitCompare = renderFitCompare;
  G.useCompareModel = useCompareModel;
  G.runDescribe = runDescribe;
  G.runUncertainty = runUncertainty;
  G.testMeta = testMeta;
  G.runTest = runTest;
  G.renderTable = renderTable;
  G.updatePager = updatePager;
})(window);
