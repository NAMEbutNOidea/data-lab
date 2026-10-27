// 临时：跨格 / 拖拽的视觉验证 + 刷新后跨格是否保住（截图存 output/ui2）
const fs = require('fs');
const path = require('path');
const PORT = 9224;
const APP = 'http://127.0.0.1:8765/';
const OUT = __dirname;

let ws, msgId = 0;
const pending = new Map();
const errors = [];
const results = [];
function send(method, params = {}) {
  const id = ++msgId;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((res, rej) => {
    pending.set(id, { res, rej });
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); rej(new Error('CDP 超时: ' + method)); } }, 60000);
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function evalJs(expression) {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
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
async function waitRender(limit) {
  const t0 = Date.now();
  const lim = limit || 30000;
  while (Date.now() - t0 < lim) {
    const done = await evalJs(`(() => ({
      overlay: document.getElementById('renderOverlay').hidden,
      visible: !document.getElementById('chartWrap').hidden,
      w: document.getElementById('chartImg').naturalWidth,
      guide: !document.getElementById('guidePanel').hidden
    }))()`);
    if (done.overlay && done.visible && done.w > 0 && !done.guide) return true;
    await sleep(250);
  }
  return false;
}
function ok(cond, label, extra) {
  results.push(!!cond);
  console.log('   ' + (cond ? '✓' : '✗') + ' ' + label + (extra ? '  ' + extra : ''));
  if (!cond) process.exitCode = 2;
}
(async () => {
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
      errors.push('[exception] ' + ((d.exception && d.exception.description) || d.text));
    }
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
      errors.push('[console.error] ' + m.params.args.map((a) => a.value || a.description || '').join(' '));
    }
    if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') {
      errors.push('[log] ' + m.params.entry.text);
    }
  };
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Log.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1680, height: 1050, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: APP });
  await sleep(2600);
  // 清掉上一次测试残留的会话并重新加载，保证从 1×1 干净开始
  await evalJs(`(() => { try { localStorage.removeItem('datalab.session'); localStorage.removeItem('datalab.theme'); } catch (e) {} return 1; })()`);
  await send('Page.reload');
  await sleep(2600);

  // 导入示例数据，避免受上一次测试残留的 50000 行 CSV 影响
  const b64 = fs.readFileSync(path.join(__dirname, '..', '..', 'samples', '示例数据_光电测量.xlsx')).toString('base64');
  await evalJs(`(async () => {
    const bin = atob(${JSON.stringify(b64)});
    const buf = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
    const file = new File([buf], '示例数据_光电测量.xlsx',
      { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const dt = new DataTransfer();
    dt.items.add(file);
    const input = document.getElementById('fileInput');
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 5000));
    return 1;
  })()`);
  await waitRender(20000);

  console.log('1) 2×2 + (a) 跨两列，看视觉');
  await evalJs(`(async () => {
    document.querySelector('.tab[data-tab="chart"]').click();
    document.getElementById('inpGridRows').value = '2';
    document.getElementById('inpGridCols').value = '2';
    document.getElementById('inpGridCols').dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 3200));
    return 1;
  })()`);
  await waitRender(20000);
  const grid4 = await evalJs(`({ grid: state.gridShape.slice(), tabs: document.querySelectorAll('#panelBar .panel-tab').length })`);
  ok(grid4.grid.join('x') === '2x2' && grid4.tabs === 4, '切到 2×2：4 个面板', JSON.stringify(grid4));

  await evalJs(`(async () => {
    document.querySelector('#panelBar .panel-tab[data-panel="0"]').click();
    await new Promise((r) => setTimeout(r, 200));
    document.getElementById('btnSpanCols').click();
    await new Promise((r) => setTimeout(r, 3200));
    return 1;
  })()`);
  await waitRender(20000);
  await shot('15_跨格_2x2.png');
  const tabs = await evalJs(`document.querySelectorAll('#panelBar .panel-tab').length`);
  ok(tabs === 3, '截图时是 3 个面板', 'tabs=' + tabs);

  console.log('2) 刷新后跨格是否保住');
  await send('Page.reload');
  await sleep(3000);
  await waitRender(30000);
  const after = await evalJs(`(() => ({
    grid: state.gridShape.slice(),
    tabs: Array.prototype.map.call(document.querySelectorAll('#panelBar .panel-tab'), function (b) { return b.textContent; }),
    areas: state.panels.map(function (p) { return p.area ? p.area.join(',') : null; }),
    cells: document.querySelectorAll('#chartGeoLayer .geo-cell').length,
    spanOn: document.getElementById('btnSpanCols').classList.contains('is-active'),
    guide: !document.getElementById('guidePanel').hidden,
    debug: { overlay: document.getElementById('renderOverlay').hidden, w: document.getElementById('chartImg').naturalWidth,
             geo: (state.lastRender && state.lastRender.panels_geo || []).length }
  }))()`);
  ok(!after.guide && after.debug.w > 0, '刷新后自动恢复数据并出图', JSON.stringify(after.debug));
  ok(after.grid.join('x') === '2x2' && after.tabs.length === 3, '刷新后仍是 2×2 + 3 个面板',
    'tabs=' + JSON.stringify(after.tabs));
  ok(after.areas[0] === '0,0,1,2' && after.spanOn, '刷新后跨格 area 与按钮状态都复原',
    JSON.stringify(after.areas) + ' spanOn=' + after.spanOn);
  ok(after.cells === 3, '刷新后占位层重建', 'cells=' + after.cells);
  await shot('16_刷新后跨格.png');

  console.log('3) 暗色主题下的跨格 UI');
  await evalJs(`document.getElementById('btnDark').click()`);
  await sleep(700);
  await shot('17_跨格_暗色.png');
  await evalJs(`document.getElementById('btnDark').click()`);
  await sleep(500);

  console.log('4) 拖动中的目标高亮');
  const pts = await evalJs(`Array.prototype.map.call(document.querySelectorAll('#chartGeoLayer .geo-cell'), function (n) {
    var r = n.getBoundingClientRect();
    return { idx: Number(n.dataset.panel), x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })`);
  const a = pts.find((p) => p.idx === 0);
  const b = pts.filter((p) => p.idx !== 0).sort((x, y) => y.y - x.y)[0];
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: a.x, y: a.y, button: 'left', clickCount: 1, buttons: 1 });
  for (let i = 1; i <= 6; i++) {
    await send('Input.dispatchMouseEvent', {
      type: 'mouseMoved', x: Math.round(a.x + (b.x - a.x) * i / 6), y: Math.round(a.y + (b.y - a.y) * i / 6),
      button: 'left', buttons: 1
    });
    await sleep(50);
  }
  const mid = await evalJs(`(() => ({
    drop: !document.getElementById('geoDrop').hidden,
    dragging: document.querySelectorAll('#chartGeoLayer .geo-cell.is-dragging').length,
    opacity: getComputedStyle(document.querySelector('#chartGeoLayer .geo-cell.is-dragging')).opacity,
    dropClass: document.getElementById('geoDrop').className
  }))()`);
  ok(mid.drop && mid.dragging === 1, '拖动中：被拖面板半透明 + 目标虚线高亮',
    'opacity=' + mid.opacity + ' dropVisible=' + mid.drop);
  await shot('18_拖拽高亮.png');
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: b.x, y: b.y, button: 'left', clickCount: 1, buttons: 0 });
  await sleep(2800);
  const swapped = await evalJs(`state.panels.map(function (p) { return p.area ? p.area.join(',') : null; }).join(' | ')`);
  console.log('   交换后 areas: ' + swapped);

  console.log('\n控制台错误数：', errors.length);
  if (errors.length) console.log(errors.join('\n'));
  console.log('断言：' + results.filter(Boolean).length + '/' + results.length);
  if (errors.length) process.exitCode = 2;
  ws.close();
})().catch((e) => { console.error('失败：', e.message); process.exit(1); });
