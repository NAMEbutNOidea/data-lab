// 临时：确认包了 #chartStage 之后图片仍然按容器缩放（不会溢出画布）
const PORT = 9224;
const APP = 'http://127.0.0.1:8765/';
let ws, msgId = 0;
const pending = new Map();
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
  if (r.exceptionDetails) throw new Error('页面异常: ' + ((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text));
  return r.result && r.result.value;
}
const results = [];
function ok(c, label, extra) {
  results.push(!!c);
  console.log('   ' + (c ? '✓' : '✗') + ' ' + label + (extra ? '  ' + extra : ''));
  if (!c) process.exitCode = 2;
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
    }
  };
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1680, height: 1050, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: APP });
  await sleep(3800);

  const measure = async (tag) => {
    const d = await evalJs(`(() => {
      var w = document.getElementById('chartWrap').getBoundingClientRect();
      var i = document.getElementById('chartImg').getBoundingClientRect();
      var s = document.getElementById('chartStage').getBoundingClientRect();
      return { tag: '${tag}', wrapW: Math.round(w.width), wrapH: Math.round(w.height),
               imgW: Math.round(i.width), imgH: Math.round(i.height),
               stageW: Math.round(s.width), stageH: Math.round(s.height),
               fitW: i.width <= w.width + 1, fitH: i.height <= w.height + 1,
               centered: Math.abs((i.left + i.width / 2) - (w.left + w.width / 2)) < 2
                        && Math.abs((i.top + i.height / 2) - (w.top + w.height / 2)) < 2 };
    })()`);
    console.log(JSON.stringify(d));
    return d;
  };

  // 1×1 + 竖长图幅（4×8 英寸）：必须被容器限高
  await evalJs(`(async () => {
    document.querySelector('#layoutPicker .layout-btn[data-grid="1,1"]').click();
    await new Promise((r) => setTimeout(r, 2600));
    document.getElementById('inpFigW').value = '4';
    document.getElementById('inpFigW').dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('inpFigH').value = '8';
    document.getElementById('inpFigH').dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 3200));
    return 1;
  })()`);
  const tall = await measure('竖长 4x8');
  ok(tall.fitW && tall.fitH, '竖长图幅不溢出画布', tall.imgW + 'x' + tall.imgH + ' in ' + tall.wrapW + 'x' + tall.wrapH);
  ok(tall.centered, '图片在画布内居中');

  // 超宽的 12×2：必须被容器限宽
  await evalJs(`(async () => {
    document.getElementById('inpFigW').value = '12';
    document.getElementById('inpFigW').dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('inpFigH').value = '2';
    document.getElementById('inpFigH').dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 3200));
    return 1;
  })()`);
  const wide = await measure('超宽 12x2');
  ok(wide.fitW && wide.fitH, '超宽图幅不溢出画布', wide.imgW + 'x' + wide.imgH + ' in ' + wide.wrapW + 'x' + wide.wrapH);

  console.log('断言：' + results.filter(Boolean).length + '/' + results.length);
  ws.close();
})().catch((e) => { console.error('失败：', e.message); process.exit(1); });
