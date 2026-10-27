/* 验证「格子太小」提示条：文案是否正确、放大图幅后是否自动消失（临时脚本） */
const PORT = 9224;
const APP = 'http://127.0.0.1:8765/';

let ws, msgId = 0;
const pending = new Map();
const errors = [];
let pass = 0, fail = 0;

function send(method, params) {
  const id = ++msgId;
  ws.send(JSON.stringify({ id, method, params: params || {} }));
  return new Promise((res, rej) => {
    pending.set(id, { res, rej });
    setTimeout(() => {
      if (pending.has(id)) { pending.delete(id); rej(new Error('timeout ' + method)); }
    }, 90000);
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function evalJs(expr) {
  const r = await send('Runtime.evaluate', {
    expression: expr, awaitPromise: true, returnByValue: true,
    allowUnsafeEvalBlockedByCSP: true,
  });
  if (r.exceptionDetails) {
    throw new Error((r.exceptionDetails.exception || {}).description || r.exceptionDetails.text);
  }
  return r.result && r.result.value;
}

function ok(cond, label, extra) {
  if (cond) { pass++; console.log('   ✓ ' + label + (extra ? '  ' + extra : '')); }
  else { fail++; console.log('   ✗ ' + label + (extra ? '  ' + extra : '')); }
}

async function setFig(w, h) {
  await evalJs(`(function () {
    var a = document.getElementById('inpFigW'), b = document.getElementById('inpFigH');
    a.value = '${w}'; a.dispatchEvent(new Event('input', { bubbles: true }));
    b.value = '${h}'; b.dispatchEvent(new Event('input', { bubbles: true }));
    return 1;
  })()`);
  await sleep(500);
}

async function warnState() {
  return await evalJs(`(function () {
    var b = document.getElementById('layoutWarn');
    if (!b) return { missing: true };
    return { hidden: b.hidden, text: b.textContent.replace(/\\s+/g, ' ').trim() };
  })()`);
}

(async () => {
  const t = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' })).json();
  ws = new WebSocket(t.webSocketDebuggerUrl);
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
      errors.push(((m.params.exceptionDetails.exception || {}).description) || m.params.exceptionDetails.text);
    }
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
      errors.push(m.params.args.map((a) => a.value || a.description || '').join(' '));
    }
  };
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1680, height: 1000, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: APP });
  await sleep(2600);
  await evalJs(`(function () { try { localStorage.removeItem('datalab.session'); } catch (e) {} return 1; })()`);
  await send('Page.reload');
  await sleep(2800);

  console.log('1) 1×1 不该提示');
  let w = await warnState();
  ok(w.hidden === true, '单图时提示隐藏', JSON.stringify(w));

  console.log('2) 4×4 + 默认 6.4×4.2in 应提示');
  await evalJs(`(function () {
    var r = document.getElementById('inpGridRows'), c = document.getElementById('inpGridCols');
    r.value = '4'; r.dispatchEvent(new Event('change', { bubbles: true }));
    c.value = '4'; c.dispatchEvent(new Event('change', { bubbles: true }));
    return 1;
  })()`);
  await sleep(900);
  w = await warnState();
  ok(w.hidden === false, '提示出现', JSON.stringify(w));
  ok(/1\.6×1\.1 in/.test(w.text || ''), '算出每格尺寸 1.6×1.1 in', w.text);
  ok(/5\.8 pt/.test(w.text || ''), '算出自动缩到 5.8pt', '');
  ok(/12\.2×8/.test(w.text || ''), '建议图幅按比例放大到 12.2×8 in', '');
  ok(/共享坐标轴/.test(w.text || ''), '附带「共享坐标轴」的替代方案', '');

  console.log('3) 把图幅放大到 12.2×8 后提示应消失');
  await setFig(12.2, 8);
  await sleep(3200);
  w = await warnState();
  ok(w.hidden === true, '放大图幅后提示自动隐藏', w.text || '');

  console.log('4) 2×2 + 默认图幅不该提示（保持原有观感）');
  await setFig(6.4, 4.2);
  await sleep(2200);
  await evalJs(`(function () {
    var r = document.getElementById('inpGridRows'), c = document.getElementById('inpGridCols');
    r.value = '2'; r.dispatchEvent(new Event('change', { bubbles: true }));
    c.value = '2'; c.dispatchEvent(new Event('change', { bubbles: true }));
    return 1;
  })()`);
  await sleep(900);
  w = await warnState();
  ok(w.hidden === true, '2×2 不提示', w.text || '');

  console.log('5) 3×3 边界');
  await evalJs(`(function () {
    var r = document.getElementById('inpGridRows'), c = document.getElementById('inpGridCols');
    r.value = '3'; r.dispatchEvent(new Event('change', { bubbles: true }));
    c.value = '3'; c.dispatchEvent(new Event('change', { bubbles: true }));
    return 1;
  })()`);
  await sleep(900);
  w = await warnState();
  console.log('   3×3 ->', w.hidden ? '不提示' : w.text);

  console.log(errors.length ? '✗ 控制台异常：' + errors.slice(0, 3).join(' | ') : '✓ 控制台 0 错误');
  console.log('断言：' + pass + '/' + (pass + fail));
  ws.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('失败：', e.message); process.exit(1); });
