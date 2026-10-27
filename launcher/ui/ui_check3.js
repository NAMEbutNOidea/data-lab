// DataLab 本轮验收：多子图 / 时间列 / 数据变换 / 模型比较 / 缩放 / 撤销 / 会话恢复
// 用法: node ui_check3.js
const PORT = 9224;
const APP = 'http://127.0.0.1:8765/';
const OUT = 'output/ui2';
const fs = require('fs');
const path = require('path');

const SAMPLE = 'samples/示例数据_光电测量.xlsx';
const TIME = 'samples/时间序列.xlsx';
const BIG = 'output/ui2/大数据.csv';

const B64_SAMPLE = fs.readFileSync(SAMPLE).toString('base64');
const NAME_SAMPLE = path.basename(SAMPLE);
const B64_TIME = fs.readFileSync(TIME).toString('base64');
const NAME_TIME = path.basename(TIME);

let ws, msgId = 0;
const pending = new Map();
const consoleErrors = [];

function send(method, params = {}) {
  const id = ++msgId;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((res, rej) => {
    pending.set(id, { res, rej });
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); rej(new Error('CDP 超时: ' + method)); } }, 120000);
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function evalJs(expr) {
  const r = await send('Runtime.evaluate', {
    expression: expr, awaitPromise: true, returnByValue: true, allowUnsafeEvalBlockedByCSP: true,
  });
  if (r.exceptionDetails) {
    const d = r.exceptionDetails;
    throw new Error('页面异常: ' + ((d.exception && d.exception.description) || d.text));
  }
  return r.result && r.result.value;
}

async function shot(name) {
  const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  const p = path.join(OUT, name);
  fs.writeFileSync(p, Buffer.from(r.data, 'base64'));
  console.log('   截图 ->', name, Math.round(fs.statSync(p).size / 1024) + 'KB');
}

function ok(cond, label, extra) {
  console.log('   ' + (cond ? '✓' : '✗') + ' ' + label + (extra ? '  ' + extra : ''));
  if (!cond) process.exitCode = 2;
}

// 页面里的渲染请求计数 + 最后一次 render 请求体（用于校验 x_datetime 等字段）
const HOOK = `(() => {
  if (window.__renderCount !== undefined) return 1;
  window.__renderCount = 0;
  window.__lastRenderBody = null;
  const orig = window.fetch;
  window.fetch = function (u, o) {
    const url = String(u && u.url ? u.url : u);
    if (url.indexOf('/api/plot/render') >= 0 && o && o.body) {
      try { window.__lastRenderBody = JSON.parse(o.body); } catch (e) {}
    }
    return orig.apply(this, arguments).then((res) => {
      if (url.indexOf('/api/plot/render') >= 0) window.__renderCount++;
      return res;
    });
  };
  return 1;
})()`;

const WAIT = `async function __waitRender(n0, timeout) {
  const t0 = Date.now();
  const limit = timeout || 30000;
  const img = document.getElementById('chartImg');
  const ov = document.getElementById('renderOverlay');
  while (Date.now() - t0 < limit) {
    await new Promise((r) => setTimeout(r, 100));
    const n = window.__renderCount || 0;
    // 渲染失败会弹回引导页：直接返回 0，让断言暴露问题
    if (n > n0 && ov.hidden && !document.getElementById('guidePanel').hidden) return 0;
    if (n > n0 && ov.hidden && img && img.naturalWidth > 0
        && !document.getElementById('chartWrap').hidden) return img.naturalWidth;
  }
  // 超时返回 0：宁可让断言失败，也不要拿旧图的尺寸冒充"渲染成功"
  return 0;
}
window.__waitRender = __waitRender;`;

async function clickKind(kind) {
  return evalJs(`(async () => {
    const n0 = window.__renderCount;
    const btn = document.querySelector('#chartTypeGrid .type-btn[data-kind="${kind}"]');
    if (!btn) return { missing: true };
    btn.click();
    const w = await window.__waitRender(n0, 25000);
    const img = document.getElementById('chartImg');
    const wrap = document.getElementById('chartWrap');
    return {
      kind: '${kind}',
      w: img.naturalWidth, h: img.naturalHeight,
      visible: !wrap.hidden,
      active: (document.querySelector('#chartTypeGrid .type-btn.active') || {}).dataset,
      meta: document.getElementById('chartMeta').textContent
    };
  })()`);
}

async function main() {
  const created = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' })).json();
  ws = new WebSocket(created.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const { res, rej } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? rej(new Error(m.error.message)) : res(m.result);
      return;
    }
    if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails;
      consoleErrors.push('[exception] ' + ((d.exception && d.exception.description) || d.text));
    }
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
      consoleErrors.push('[console.error] ' + m.params.args.map((a) => a.value || a.description || '').join(' '));
    }
    if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') {
      consoleErrors.push('[log] ' + m.params.entry.text);
    }
  };

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Log.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1680, height: 1050, deviceScaleFactor: 1, mobile: false });

  // ---------------- 0. 干净启动 ----------------
  console.log('0) 干净启动：清掉 localStorage 会话，回到空状态');
  await send('Page.navigate', { url: APP });
  await sleep(2500);
  await evalJs(`(() => {
    try { localStorage.removeItem('datalab.session'); localStorage.removeItem('datalab.theme'); } catch (e) {}
    return 1;
  })()`);
  await send('Page.reload');
  await sleep(2600);
  await evalJs(HOOK);
  await evalJs(WAIT);
  const empty = await evalJs(`(() => ({
    guide: !document.getElementById('guidePanel').hidden,
    recent: !document.getElementById('recentWrap').hidden,
    recentCount: document.querySelectorAll('#recentList .recent-item').length,
    recentText: (document.querySelector('#recentList .recent-item') || {}).textContent || '',
    types: document.querySelectorAll('#chartTypeGrid .type-btn').length,
    panelTabs: document.querySelectorAll('#panelBar .panel-tab').length,
    theme: document.documentElement.dataset.theme
  }))()`);
  ok(empty.guide, '空状态引导页可见');
  ok(empty.recent && empty.recentCount > 0, '最近打开列表有内容', 'count=' + empty.recentCount);
  ok(empty.panelTabs === 0, '1×1 时无面板切换条', 'tabs=' + empty.panelTabs);
  console.log('    最近打开示例：' + empty.recentText.replace(/\s+/g, ' ').slice(0, 80));
  await shot('01_主界面.png');

  // ---------------- 1. 导入示例 ----------------
  console.log('1) 导入示例数据');
  const up = await evalJs(`(async () => {
    const bin = atob("${B64_SAMPLE}");
    const buf = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
    const file = new File([buf], ${JSON.stringify(NAME_SAMPLE)},
      { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const dt = new DataTransfer();
    dt.items.add(file);
    const input = document.getElementById('fileInput');
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 4500));
    return {
      sheets: document.querySelectorAll('.sheet-item').length,
      cols: document.querySelectorAll('.col-item').length,
      x: (document.getElementById('selX') || {}).value,
      ys: Array.from(document.querySelectorAll('#yList .chip .chip-name')).map((n) => n.textContent)
    };
  })()`);
  ok(up.sheets === 4 && up.cols > 0, '导入示例（4 个工作表）', `sheets=${up.sheets} cols=${up.cols}`);
  console.log('    X=' + up.x + '  Y=' + JSON.stringify(up.ys));

  // 先做一次拟合，残差图才可用
  await evalJs(`(async () => {
    document.querySelector('.tab[data-tab="fit"]').click();
    await new Promise((r) => setTimeout(r, 200));
    const sel = document.getElementById('selFitModel');
    sel.value = 'linear';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    document.getElementById('btnFit').click();
    await new Promise((r) => setTimeout(r, 3000));
    document.querySelector('.tab[data-tab="chart"]').click();
    return 1;
  })()`);

  // ---------------- 2. 14 种图型 ----------------
  console.log('2) 14 种图型逐个渲染');
  const kinds = await evalJs(`Array.from(document.querySelectorAll('#chartTypeGrid .type-btn')).map((b) => b.dataset.kind)`);
  const kindFail = [];
  for (const k of kinds) {
    const r = await clickKind(k);
    if (r.missing) { kindFail.push(k + '(按钮缺失)'); continue; }
    const pass = r.w > 0 && r.visible;
    if (!pass) kindFail.push(k);
    console.log('   ' + (pass ? '✓' : '✗') + ' ' + k.padEnd(13) + ' ' + r.w + '×' + r.h
      + '  ' + String(r.meta || '').replace(/\s+/g, ' ').slice(0, 60));
    if (!pass) process.exitCode = 2;
  }
  ok(kindFail.length === 0, '14 种图型全部出图', kinds.length + ' 种，失败 ' + kindFail.length);
  await evalJs(`(async () => {
    const n0 = window.__renderCount;
    document.querySelector('#chartTypeGrid .type-btn[data-kind="line_marker"]').click();
    await window.__waitRender(n0);
    return 1;
  })()`);
  await shot('02_单图渲染.png');

  // ---------------- 3. 多子图布局 ----------------
  console.log('3) 多子图布局 1×2 / 2×1 / 2×2');
  async function setLayout(g) {
    return evalJs(`(async () => {
      const n0 = window.__renderCount;
      const btn = document.querySelector('#layoutPicker .layout-btn[data-grid="${g}"]');
      btn.click();
      const w = await window.__waitRender(n0, 30000);
      const img = document.getElementById('chartImg');
      return {
        layout: '${g}',
        tabs: document.querySelectorAll('#panelBar .panel-tab').length,
        barHidden: document.getElementById('panelBar').hidden,
        w: img.naturalWidth, h: img.naturalHeight,
        meta: document.getElementById('chartMeta').textContent
      };
    })()`);
  }
  for (const g of ['1,2', '2,1', '1,1', '2,2']) {
    const r = await setLayout(g);
    const n = g.split(',').reduce((a, b) => a * Number(b), 1);
    // >1×1 时切换条数量 = 格数；1×1 时不显示切换条
    const pass = r.w > 0 && r.tabs === (n > 1 ? n : 0) && (n > 1 ? !r.barHidden : r.barHidden);
    ok(pass, '布局 ' + g + ' 出图，面板切换条 ' + (n > 1 ? '= ' + n : '隐藏'),
      'tabs=' + r.tabs + ' ' + r.w + '×' + r.h + '  ' + String(r.meta).replace(/\s+/g, ' ').slice(0, 60));
  }
  await evalJs(`(async () => {
    const n0 = window.__renderCount;
    document.querySelector('#layoutPicker .layout-btn[data-grid="2,2"]').click();
    await window.__waitRender(n0, 30000);
    return 1;
  })()`);
  await shot('03_多子图_2x2.png');

  // ---------------- 4. 双面板不同图型 ----------------
  console.log('4) 1×2 下两个面板配不同图型，比对左右半图是否不同');
  const diff = await evalJs(`(async () => {
    // 切到 1×2
    let n0 = window.__renderCount;
    document.querySelector('#layoutPicker .layout-btn[data-grid="1,2"]').click();
    await window.__waitRender(n0, 30000);

    // 面板 (a) = 散点
    n0 = window.__renderCount;
    document.querySelector('#panelBar .panel-tab[data-panel="0"]').click();
    await new Promise((r) => setTimeout(r, 150));
    document.querySelector('#chartTypeGrid .type-btn[data-kind="scatter"]').click();
    await window.__waitRender(n0, 30000);

    // 面板 (b) = 柱状
    n0 = window.__renderCount;
    document.querySelector('#panelBar .panel-tab[data-panel="1"]').click();
    await new Promise((r) => setTimeout(r, 150));
    const active0 = (document.querySelector('#chartTypeGrid .type-btn.active') || {}).dataset.kind;
    document.querySelector('#chartTypeGrid .type-btn[data-kind="bar"]').click();
    const w = await window.__waitRender(n0, 30000);

    const img = document.getElementById('chartImg');
    const c = document.createElement('canvas');
    c.width = img.naturalWidth; c.height = img.naturalHeight;
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const half = Math.floor(c.width / 2);
    const left = ctx.getImageData(0, 0, half, c.height).data;
    const right = ctx.getImageData(half, 0, c.width - half, c.height).data;
    let dl = 0, dr = 0, inkL = 0, inkR = 0;
    for (let i = 0; i < left.length; i += 4) {
      const pl = left[i] + left[i + 1] + left[i + 2];
      const pr = right[i] + right[i + 1] + right[i + 2];
      dl = (dl + pl * (i % 97 + 1)) % 100000007;
      dr = (dr + pr * (i % 97 + 1)) % 100000007;
      if (pl < 720) inkL++;
      if (pr < 720) inkR++;
    }
    return {
      w, activePanelKindBefore: active0,
      hashL: dl, hashR: dr, diff: dl !== dr,
      inkL, inkR,
      tabs: document.querySelectorAll('#panelBar .panel-tab').length,
      barText: document.getElementById('panelBar').textContent
    };
  })()`);
  ok(diff.tabs === 2, '1×2 面板切换条 = 2', 'tabs=' + diff.tabs + '  ' + diff.barText.replace(/\s+/g, ' '));
  ok(diff.activePanelKindBefore !== 'scatter',
    '切到面板 (b) 时读到的图型不是面板 (a) 的 scatter（配置互不串）', 'panelB.kind=' + diff.activePanelKindBefore);
  ok(diff.diff && diff.inkL > 50 && diff.inkR > 50, '两张子图内容不同', `hashL=${diff.hashL} hashR=${diff.hashR} ink=${diff.inkL}/${diff.inkR}`);
  await shot('04_双面板不同图型.png');

  // ---------------- 5. 时间列 ----------------
  console.log('5) 时间列作为 X');
  const dtinfo = await evalJs(`(async () => {
    const bin = atob("${B64_TIME}");
    const buf = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
    const file = new File([buf], ${JSON.stringify(NAME_TIME)},
      { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const dt = new DataTransfer();
    dt.items.add(file);
    const input = document.getElementById('fileInput');
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 4500));
    const clock = document.querySelectorAll('#columnList .col-item .dtype-time').length;
    const clockText = (document.querySelector('#columnList .col-item .dtype-time') || {}).textContent || '';
    const yCandidates = Array.from(document.getElementById('selYAdd').options).map((o) => o.value);
    // 回到 1×1，单面板下看 x_datetime 更直观
    const nL = window.__renderCount;
    document.querySelector('#layoutPicker .layout-btn[data-grid="1,1"]').click();
    await window.__waitRender(nL, 30000);
    // X 选时间列
    const n0 = window.__renderCount;
    const selX = document.getElementById('selX');
    selX.value = '时间';
    selX.dispatchEvent(new Event('change', { bubbles: true }));
    const w = await window.__waitRender(n0, 30000);
    const body = window.__lastRenderBody || {};
    return {
      clock, clockText,
      yHasTime: yCandidates.indexOf('时间') >= 0,
      w,
      x: selX.value,
      xDatetime: !!(body.spec && (body.spec.x_datetime
        || (body.spec.panels && body.spec.panels[0] && body.spec.panels[0].x_datetime))),
      xSample: body.spec && body.spec.series && body.spec.series[0] ? body.spec.series[0].x[0] : null,
      meta: document.getElementById('chartMeta').textContent,
      guide: !document.getElementById('guidePanel').hidden
    };
  })()`);
  ok(dtinfo.clock > 0, '时间列显示 ⏱ 标记', 'mark=' + dtinfo.clock + ' “' + dtinfo.clockText + '”');
  ok(!dtinfo.yHasTime, '时间列不出现在 Y 候选里');
  ok(dtinfo.w > 0 && !dtinfo.guide, '时间列作 X 渲染成功', dtinfo.w + 'px  meta=' + String(dtinfo.meta).replace(/\s+/g, ' '));
  ok(dtinfo.xDatetime, '请求体带 x_datetime=true', 'x[0]=' + String(dtinfo.xSample));
  await shot('05_时间列.png');

  // 5b) 回到示例数据（后面的变换/比较需要「光电响应」那几列）
  console.log('5b) 重新导入示例数据');
  const back = await evalJs(`(async () => {
    const bin = atob("${B64_SAMPLE}");
    const buf = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
    const file = new File([buf], ${JSON.stringify(NAME_SAMPLE)},
      { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const dt = new DataTransfer();
    dt.items.add(file);
    const input = document.getElementById('fileInput');
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 5000));
    const n0 = window.__renderCount;
    document.getElementById('btnRender').click();
    const w = await window.__waitRender(n0, 30000);
    return {
      sheets: document.querySelectorAll('.sheet-item').length,
      sheet: (document.querySelector('.sheet-item.active .sheet-name') || {}).textContent,
      x: document.getElementById('selX').value,
      ys: Array.from(document.querySelectorAll('#yList .chip .chip-name')).map((n) => n.textContent),
      w
    };
  })()`);
  ok(back.sheets === 4 && back.w > 0, '回到示例数据并出图', `sheet=${back.sheet} X=${back.x} Y=${JSON.stringify(back.ys)}`);

  // ---------------- 6. 数据变换 ----------------
  console.log('6) 数据变换：log10 生成新列');
  const tf = await evalJs(`(async () => {
    document.querySelector('.tab[data-tab="chart"]').click();
    await new Promise((r) => setTimeout(r, 150));
    // 回到 1×1，避免多面板干扰
    let n0 = window.__renderCount;
    document.querySelector('#layoutPicker .layout-btn[data-grid="1,1"]').click();
    await window.__waitRender(n0, 30000);

    const before = document.querySelectorAll('#columnList .col-item').length;
    document.getElementById('btnTransform').click();
    await new Promise((r) => setTimeout(r, 300));
    const modalOpen = !document.getElementById('modalMask').hidden;
    const opSel = document.getElementById('tfOp');
    const colSel = document.getElementById('tfCol');
    const opCount = opSel ? opSel.options.length : 0;
    opSel.value = 'log10';
    opSel.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 150));
    const paramInputs = document.querySelectorAll('#tfParams input').length;
    return {
      modalOpen, opCount, paramInputs,
      src: colSel ? colSel.value : null,
      footerBtns: document.querySelectorAll('#modalFoot .btn').length
    };
  })()`);
  ok(tf.modalOpen, '弹窗打开');
  ok(tf.opCount === 8, '变换下拉 8 项（来自 /api/themes.transforms）', 'count=' + tf.opCount);
  ok(tf.paramInputs === 0, 'log10 无参数输入', 'params=' + tf.paramInputs);
  await shot('06_数据变换弹窗.png');

  const tfDone = await evalJs(`(async () => {
    const before = document.querySelectorAll('#columnList .col-item').length;
    const n0 = window.__renderCount;
    document.querySelector('#modalFoot .btn-primary').click();
    // 等 columns 刷新 + 新列进入 Y
    const t0 = Date.now();
    let after = before;
    while (Date.now() - t0 < 25000) {
      await new Promise((r) => setTimeout(r, 200));
      after = document.querySelectorAll('#columnList .col-item').length;
      if (after > before) break;
    }
    const w = await window.__waitRender(n0, 30000);
    const chips = Array.from(document.querySelectorAll('#yList .chip .chip-name')).map((n) => n.textContent);
    return {
      before, after, w,
      modalClosed: document.getElementById('modalMask').hidden,
      chips,
      newCol: chips[0],
      meta: document.getElementById('chartMeta').textContent
    };
  })()`);
  ok(tfDone.after === tfDone.before + 1, '列数 +1', `${tfDone.before} -> ${tfDone.after}`);
  ok(tfDone.modalClosed, '弹窗已关闭');
  ok(tfDone.w > 0 && /常用对数/.test(String(tfDone.newCol)), '新列成为当前 Y 并渲染成功', 'Y=' + JSON.stringify(tfDone.chips));

  // ---------------- 7. 模型比较 ----------------
  console.log('7) 模型比较');
  const cmp = await evalJs(`(async () => {
    // 先切回原始数值列，log 列有负值可能影响拟合
    const selX = document.getElementById('selX');
    selX.value = '光强 I(lx)';
    selX.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 600));
    // Y 换成 光电流(mA)
    const add = document.getElementById('selYAdd');
    add.value = '光电流(mA)';
    document.getElementById('btnAddY').click();
    await new Promise((r) => setTimeout(r, 800));

    document.querySelector('.tab[data-tab="fit"]').click();
    await new Promise((r) => setTimeout(r, 200));
    document.getElementById('btnFitCompare').click();
    const t0 = Date.now();
    let rows = 0;
    while (Date.now() - t0 < 40000) {
      await new Promise((r) => setTimeout(r, 250));
      rows = document.querySelectorAll('#fitCompare .cmp-table tbody tr').length;
      if (rows > 0) break;
    }
    const trs = Array.from(document.querySelectorAll('#fitCompare .cmp-table tbody tr'));
    return {
      rows,
      models: trs.map((t) => t.dataset.model),
      bestRow: trs.findIndex((t) => t.classList.contains('is-best')),
      bestText: (document.querySelector('#fitCompare tr.is-best') || {}).textContent || '',
      notes: (document.querySelector('#fitCompare .res-conclusion') || {}).textContent || '',
      failCells: trs.filter((t) => t.classList.contains('is-fail')).length
    };
  })()`);
  ok(cmp.rows === 9, '比较表 9 行', 'rows=' + cmp.rows);
  ok(cmp.bestRow === 0, '最优行在第 1 行并高亮', 'bestRow=' + cmp.bestRow + ' ' + String(cmp.bestText).replace(/\s+/g, ' ').slice(0, 40));
  ok(!!cmp.notes, '顶部显示 notes', String(cmp.notes).slice(0, 70));
  // 把比较卡片滚到可视区中间再截图，否则只能看到表头
  await evalJs(`(() => {
    const card = document.querySelector('#fitCompare .res-card');
    if (card) card.scrollIntoView({ block: 'center' });
    return 1;
  })()`);
  await sleep(400);
  await shot('07_模型比较.png');

  const pick = await evalJs(`(async () => {
    const trs = Array.from(document.querySelectorAll('#fitCompare .cmp-table tbody tr'));
    const target = trs.find((t, i) => i > 0 && !t.classList.contains('is-fail'));
    const want = target.dataset.model;
    const n0 = window.__renderCount;
    target.click();
    await new Promise((r) => setTimeout(r, 2600));
    return {
      want,
      sel: document.getElementById('selFitModel').value,
      panel: document.querySelector('.tab.active').dataset.tab,
      fitTitle: (document.querySelector('#fitResult .res-title') || {}).textContent || '',
      w: document.getElementById('chartImg').naturalWidth
    };
  })()`);
  ok(pick.sel === pick.want, '点第 2 行 → 模型填进下拉并拟合', `want=${pick.want} sel=${pick.sel} ${pick.fitTitle}`);

  // ---------------- 8. 缩放 ----------------
  console.log('8) 滚轮缩放 / 双击复位');
  await evalJs(`(async () => {
    document.querySelector('.tab[data-tab="chart"]').click();
    await new Promise((r) => setTimeout(r, 200));
    return 1;
  })()`);
  const rect = await evalJs(`(() => {
    const img = document.getElementById('chartImg');
    const r = img.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2),
             w: Math.round(r.width), h: Math.round(r.height) };
  })()`);
  await send('Input.dispatchMouseEvent', {
    type: 'mouseWheel', x: rect.x, y: rect.y, deltaX: 0, deltaY: -260,
    modifiers: 0, pointerType: 'mouse'
  });
  await sleep(500);
  const zoomed = await evalJs(`(() => {
    const img = document.getElementById('chartImg');
    return { transform: img.style.transform, hud: !document.getElementById('zoomHud').hidden,
             label: document.getElementById('zoomLabel').textContent };
  })()`);
  ok(/scale\(/.test(zoomed.transform), '滚轮后 img 有 transform', zoomed.transform);
  ok(zoomed.hud, '右下角显示缩放比例', zoomed.label);
  await shot('08_缩放.png');

  // 拖拽平移
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: rect.x, y: rect.y, button: 'left', clickCount: 1, buttons: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rect.x + 40, y: rect.y + 25, button: 'left', buttons: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rect.x + 40, y: rect.y + 25, button: 'left', clickCount: 1, buttons: 0 });
  await sleep(300);
  const panned = await evalJs(`document.getElementById('chartImg').style.transform`);
  ok(/translate\(/.test(panned) && panned !== zoomed.transform, '拖拽后 transform 变化（平移）', String(panned).slice(0, 60));

  // 双击复位（真实输入事件）
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: rect.x, y: rect.y, button: 'left', clickCount: 1, buttons: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rect.x, y: rect.y, button: 'left', clickCount: 1, buttons: 0 });
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: rect.x, y: rect.y, button: 'left', clickCount: 2, buttons: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rect.x, y: rect.y, button: 'left', clickCount: 2, buttons: 0 });
  await sleep(400);
  const reset = await evalJs(`(() => ({
    transform: document.getElementById('chartImg').style.transform,
    hud: !document.getElementById('zoomHud').hidden
  }))()`);
  ok(reset.transform === '' && !reset.hud, '双击复位回到 1×', JSON.stringify(reset));

  // ---------------- 9. 撤销 / 重做 ----------------
  console.log('9) Ctrl+Z 撤销图型切换');
  const undoRes = await evalJs(`(async () => {
    const before = document.querySelector('#chartTypeGrid .type-btn.active').dataset.kind;
    const target = before === 'bar' ? 'line' : 'bar';
    const n0 = window.__renderCount;
    document.querySelector('#chartTypeGrid .type-btn[data-kind="' + target + '"]').click();
    await window.__waitRender(n0, 25000);
    return { before, target, after: document.querySelector('#chartTypeGrid .type-btn.active').dataset.kind };
  })()`);
  ok(undoRes.after === undoRes.target && undoRes.target !== undoRes.before,
    '切换图型 ' + undoRes.before + ' → ' + undoRes.target, 'kind=' + undoRes.after);
  await send('Input.dispatchKeyEvent', {
    type: 'rawKeyDown', modifiers: 2, key: 'z', code: 'KeyZ',
    windowsVirtualKeyCode: 90, nativeVirtualKeyCode: 90
  });
  await send('Input.dispatchKeyEvent', {
    type: 'keyUp', modifiers: 2, key: 'z', code: 'KeyZ',
    windowsVirtualKeyCode: 90, nativeVirtualKeyCode: 90
  });
  await sleep(1200);
  const undone = await evalJs(`(() => ({
    kind: document.querySelector('#chartTypeGrid .type-btn.active').dataset.kind,
    log: document.getElementById('logPane').textContent.slice(-160)
  }))()`);
  ok(undone.kind === undoRes.before, 'Ctrl+Z 撤销回上一个图型',
    undoRes.target + ' -> ' + undone.kind + '（期望 ' + undoRes.before + '）');
  console.log('    日志尾部：' + String(undone.log).replace(/\s+/g, ' ').slice(-90));

  // 重做
  await send('Input.dispatchKeyEvent', {
    type: 'rawKeyDown', modifiers: 10, key: 'Z', code: 'KeyZ',
    windowsVirtualKeyCode: 90, nativeVirtualKeyCode: 90
  });
  await send('Input.dispatchKeyEvent', {
    type: 'keyUp', modifiers: 10, key: 'Z', code: 'KeyZ',
    windowsVirtualKeyCode: 90, nativeVirtualKeyCode: 90
  });
  await sleep(1200);
  const redone = await evalJs(`document.querySelector('#chartTypeGrid .type-btn.active').dataset.kind`);
  ok(redone === undoRes.target, 'Ctrl+Shift+Z 重做', 'kind=' + redone);

  // ---------------- 10. 快捷键面板 ----------------
  console.log('10) ? 打开快捷键面板');
  await send('Input.dispatchKeyEvent', { type: 'keyDown', modifiers: 8, key: '?', code: 'Slash', text: '?', windowsVirtualKeyCode: 191, nativeVirtualKeyCode: 191 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', modifiers: 8, key: '?', code: 'Slash', windowsVirtualKeyCode: 191, nativeVirtualKeyCode: 191 });
  await sleep(400);
  const sc = await evalJs(`(() => ({
    open: !document.getElementById('modalMask').hidden,
    rows: document.querySelectorAll('#modalBody .sc-row').length,
    title: document.getElementById('modalTitle').textContent
  }))()`);
  ok(sc.open && sc.rows >= 8, '快捷键面板弹出', 'rows=' + sc.rows + ' title=' + sc.title);
  await shot('09_快捷键面板.png');
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
  await sleep(300);
  const escClosed = await evalJs(`document.getElementById('modalMask').hidden`);
  ok(escClosed, 'Esc 关闭弹窗');

  // ---------------- 11. 会话恢复 ----------------
  console.log('11) 改主题/DPI/图型 → 刷新 → 配置复原');
  const beforeReload = await evalJs(`(async () => {
    const n0 = window.__renderCount;
    document.querySelector('.tab[data-tab="style"]').click();
    await new Promise((r) => setTimeout(r, 150));
    document.querySelector('#themeGrid .theme-card:nth-child(3)').click();
    await window.__waitRender(n0 + 0, 25000);
    const dpiBtn = Array.from(document.querySelectorAll('.dpi-preset')).find((b) => b.dataset.dpi === '600');
    dpiBtn.click();
    await new Promise((r) => setTimeout(r, 900));
    document.querySelector('.tab[data-tab="chart"]').click();
    await new Promise((r) => setTimeout(r, 150));
    const n1 = window.__renderCount;
    document.querySelector('#chartTypeGrid .type-btn[data-kind="line_marker"]').click();
    await window.__waitRender(n1, 25000);
    await new Promise((r) => setTimeout(r, 1200));
    return {
      theme: window.__themeId ? window.__themeId : (document.querySelector('#themeGrid .theme-card.active .theme-name') || {}).textContent,
      dpi: document.getElementById('inpDpi').value,
      kind: document.querySelector('#chartTypeGrid .type-btn.active').dataset.kind,
      layout: (document.querySelector('#layoutPicker .layout-btn.is-active') || {}).textContent,
      session: (() => { try { return JSON.parse(localStorage.getItem('datalab.session') || 'null'); } catch (e) { return null; } })()
    };
  })()`);
  console.log('    刷新前：theme=' + beforeReload.theme + ' dpi=' + beforeReload.dpi + ' kind=' + beforeReload.kind + ' layout=' + beforeReload.layout);
  await send('Page.reload');
  await sleep(2500);
  await evalJs(HOOK);
  await evalJs(WAIT);
  await evalJs(`(async () => {
    const t0 = Date.now();
    const img = document.getElementById('chartImg');
    while (Date.now() - t0 < 25000) {
      await new Promise((r) => setTimeout(r, 250));
      if (img && img.naturalWidth > 0 && !document.getElementById('chartWrap').hidden) return 1;
    }
    return 0;
  })()`);
  const afterReload = await evalJs(`(() => ({
    theme: (document.querySelector('#themeGrid .theme-card.active .theme-name') || {}).textContent,
    dpi: document.getElementById('inpDpi').value,
    kind: (document.querySelector('#chartTypeGrid .type-btn.active') || {}).dataset.kind,
    layout: (document.querySelector('#layoutPicker .layout-btn.is-active') || {}).textContent,
    hasData: !!document.getElementById('datasetInfo').querySelector('.ds-name'),
    ds: (document.getElementById('datasetInfo').querySelector('.ds-name') || {}).textContent || '',
    imgW: document.getElementById('chartImg').naturalWidth,
    log: document.getElementById('logPane').textContent.slice(0, 200)
  }))()`);
  ok(afterReload.theme === beforeReload.theme, '刷新后主题复原', afterReload.theme);
  ok(afterReload.dpi === '600', '刷新后 DPI 复原', afterReload.dpi);
  ok(afterReload.kind === beforeReload.kind, '刷新后图型复原', afterReload.kind);
  ok(afterReload.layout === beforeReload.layout, '刷新后布局复原', afterReload.layout);
  ok(afterReload.hasData && afterReload.imgW > 0, '刷新后数据集与图自动恢复', 'ds=' + afterReload.ds + ' img=' + afterReload.imgW);
  await shot('10_刷新恢复.png');

  // 暗色主题
  await evalJs(`(async () => {
    document.getElementById('btnDark').click();
    await new Promise((r) => setTimeout(r, 900));
    return 1;
  })()`);
  await shot('11_暗色主题.png');
  const darkOk = await evalJs(`(() => {
    const cs = getComputedStyle(document.querySelector('.modal-mask'));
    return { theme: document.documentElement.dataset.theme,
             panelBg: getComputedStyle(document.querySelector('.config-panel')).backgroundColor };
  })()`);
  ok(darkOk.theme === 'dark', '暗色主题生效', darkOk.panelBg);
  await evalJs(`document.getElementById('btnDark').click()`);

  // ---------------- 12. 大数据降采样提示 ----------------
  console.log('12) 大数据降采样提示（50000 点 → 20000）');
  const bigRows = [];
  for (let i = 0; i < 50000; i++) {
    bigRows.push((i / 100).toFixed(3) + ',' + (Math.sin(i / 700) * 100 + Math.random() * 3).toFixed(4));
  }
  fs.writeFileSync(BIG, 'x,y\n' + bigRows.join('\n'), 'utf8');
  const b64big = fs.readFileSync(BIG).toString('base64');
  const big = await evalJs(`(async () => {
    const bin = atob("${b64big}");
    const buf = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
    const file = new File([buf], '大数据.csv', { type: 'text/csv' });
    const dt = new DataTransfer();
    dt.items.add(file);
    const input = document.getElementById('fileInput');
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 9000));
    const n0 = window.__renderCount;
    document.getElementById('btnRender').click();
    const w = await window.__waitRender(n0, 60000);
    return {
      w, rows: document.getElementById('bkRows').textContent,
      metaWarn: (document.querySelector('#chartMeta .meta-chip.meta-warn') || {}).textContent || '',
      metaTitle: (document.querySelector('#chartMeta .meta-chip.meta-warn') || {}).title || '',
      bkMsg: document.getElementById('bkMsg').textContent,
      body: (window.__lastRenderBody || {})
    };
  })()`);
  const dsInfo = big.body && big.body.spec && big.body.spec.series ? big.body.spec.series[0].x.length : 0;
  ok(!!big.metaWarn, '图表 meta 出现抽稀 chip', big.metaWarn + ' / ' + String(big.metaTitle).slice(0, 60));
  ok(/抽稀/.test(big.bkMsg), '后端状态窗给出抽稀说明', String(big.bkMsg).replace(/\s+/g, ' ').slice(0, 110));
  ok(dsInfo > 40000, '前端确实上传了全量点', 'points=' + dsInfo);
  await shot('12_降采样提示.png');

  // ---------------- 13. 导出统一下载 ----------------
  console.log('13) 导出 PNG / PDF：统一下载 + 提示服务端路径');
  const dlDir = path.resolve(OUT, 'dl');
  fs.mkdirSync(dlDir, { recursive: true });
  for (const f of fs.readdirSync(dlDir)) fs.unlinkSync(path.join(dlDir, f));
  await send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: dlDir });

  async function doExport(fmt) {
    const r = await evalJs(`(async () => {
      document.querySelector('.tab[data-tab="chart"]').click();
      await new Promise((r) => setTimeout(r, 150));
      const menu = document.getElementById('exportImgMenu');
      document.getElementById('btnExportImg').click();
      await new Promise((r) => setTimeout(r, 150));
      const item = menu.querySelector('.menu-item[data-fmt="${fmt}"]');
      item.click();
      await new Promise((r) => setTimeout(r, 6000));
      return {
        toasts: Array.from(document.querySelectorAll('#toastWrap .toast-text')).map((t) => t.textContent),
        bkMsg: document.getElementById('bkMsg').textContent
      };
    })()`);
    return r;
  }
  for (const fmt of ['png', 'pdf']) {
    const r = await doExport(fmt);
    await sleep(2500);
    const files = fs.readdirSync(dlDir).filter((f) => f.toLowerCase().endsWith('.' + fmt));
    ok(files.length > 0, '导出 ' + fmt.toUpperCase() + ' 走浏览器下载',
      files.join(',') + ' | ' + String(r.toasts.join(' / ')).slice(0, 90));
    ok(/同时已保存到/.test(String(r.bkMsg)) || /同时已保存到/.test(String(r.toasts.join(' '))),
      '导出后提示服务端保存路径', String(r.bkMsg).slice(0, 90));
  }

  // ---------------- 收尾 ----------------
  console.log('\n控制台错误数：', consoleErrors.length);
  consoleErrors.slice(0, 10).forEach((e) => console.log('  -', e.slice(0, 240)));
  if (consoleErrors.length) process.exitCode = 3;
  ws.close();
}

main().catch((e) => { console.error('验收失败:', e.message); process.exit(1); });
