// 我在真实界面里复核一次：2×2 → 选中 (a) → 跨 2 列 → 截图
// 用法: node launcher/ui/_shot_span_final.js
const PORT = 9224;
const APP = 'http://127.0.0.1:8765/';
const fs = require('fs');
const path = require('path');
const SAMPLE = 'samples/示例数据_光电测量.xlsx';

let ws, msgId = 0;
const pending = new Map();
const errors = [];

function send(method, params = {}) {
  const id = ++msgId;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((res, rej) => {
    pending.set(id, { res, rej });
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); rej(new Error('CDP 超时: ' + method)); } }, 60000);
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
  const p = path.join('output/ui2', name);
  fs.writeFileSync(p, Buffer.from(r.data, 'base64'));
  console.log('截图 ->', name, Math.round(fs.statSync(p).size / 1024) + 'KB');
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
  };
  await send('Runtime.enable');
  await send('Log.enable');
  await send('Page.enable');
  await send('Page.navigate', { url: APP });
  await sleep(2600);
  await evalJs(`(() => { try { localStorage.removeItem('datalab.session'); } catch (e) {} return 1; })()`);
  await send('Page.reload');
  await sleep(2600);

  const b64 = fs.readFileSync(path.join(SAMPLE)).toString('base64');
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
    await new Promise((r) => setTimeout(r, 4500));
    return 1;
  })()`);

  // 2×2
  await evalJs(`(async () => {
    document.getElementById('inpGridRows').value = '2';
    document.getElementById('inpGridCols').value = '2';
    document.getElementById('inpGridCols').dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 2800));
    return 1;
  })()`);

  const before = await evalJs(`(() => ({
    tabs: [...document.querySelectorAll('#panelBar .panel-tab')].map((t) => t.textContent.trim()),
    cells: document.querySelectorAll('#chartGeoLayer .geo-cell').length,
    geo: (window.state.lastRender || {}).panels_geo || []
  }))()`);
  console.log('跨格前：tabs =', JSON.stringify(before.tabs), '| 占位框', before.cells);

  // 选中第一格，点「跨 2 列」
  await evalJs(`(async () => {
    const tab = document.querySelector('#panelBar .panel-tab');
    if (tab) tab.click();
    await new Promise((r) => setTimeout(r, 300));
    document.getElementById('btnSpanCols').click();
    await new Promise((r) => setTimeout(r, 3000));
    return 1;
  })()`);

  const after = await evalJs(`(() => ({
    tabs: [...document.querySelectorAll('#panelBar .panel-tab')].map((t) => t.textContent.trim()),
    cells: document.querySelectorAll('#chartGeoLayer .geo-cell').length,
    geo: (window.state.lastRender || {}).panels_geo || [],
    areas: window.state.panels.map((p) => p.area ? p.area.join(',') : null),
    spanActive: document.getElementById('btnSpanCols').classList.contains('is-active'),
    img: { w: document.getElementById('chartImg').naturalWidth, h: document.getElementById('chartImg').naturalHeight },
    wrapRect: document.getElementById('chartImg').getBoundingClientRect().toJSON()
  }))()`);
  console.log('跨格后：tabs =', JSON.stringify(after.tabs), '| 占位框', after.cells, '| 跨列按钮激活', after.spanActive);
  console.log('areas =', JSON.stringify(after.areas));
  console.log('panels_geo =', JSON.stringify(after.geo.map((g) => ({ i: g.index, a: g.area, r: g.rect.map((v) => +v.toFixed(3)) }))));

  await shot('23_跨格_复核.png');
  console.log(errors.length ? '✗ 控制台错误：\n  ' + errors.join('\n  ') : '✓ 控制台 0 错误');
  ws.close();
})().catch((e) => { console.error('失败：', e.message); process.exit(1); });
