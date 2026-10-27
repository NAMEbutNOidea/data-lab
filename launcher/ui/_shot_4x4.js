/* 4×4 布局下拼图板与面板条的可读性截图（临时脚本） */
const PORT = 9224;
const APP = 'http://127.0.0.1:8765/';
const fs = require('fs');

let ws, msgId = 0;
const pending = new Map();
const errors = [];

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

async function shot(name) {
  const r = await send('Page.captureScreenshot', { format: 'png' });
  const buf = Buffer.from(r.data, 'base64');
  fs.writeFileSync('output/ui2/' + name, buf);
  console.log('   截图 ->', name, Math.round(buf.length / 1024) + 'KB');
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

  // 清掉旧会话，从干净状态起
  await evalJs(`(() => { try { localStorage.removeItem('datalab.session'); } catch (e) {} return 1; })()`);
  await send('Page.reload');
  await sleep(2800);

  const b64 = fs.readFileSync('samples/示例数据_光电测量.xlsx').toString('base64');
  await evalJs(`(async () => {
    const bin = atob(${JSON.stringify(b64)});
    const buf = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
    const dt = new DataTransfer();
    dt.items.add(new File([buf], '示例数据_光电测量.xlsx'));
    const inp = document.getElementById('fileInput');
    inp.files = dt.files;
    inp.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 5000));
    return 1;
  })()`);

  // 切到 4×4
  await evalJs(`(() => {
    var rows = document.getElementById('inpGridRows');
    var cols = document.getElementById('inpGridCols');
    rows.value = '4'; rows.dispatchEvent(new Event('change', { bubbles: true }));
    cols.value = '4'; cols.dispatchEvent(new Event('change', { bubbles: true }));
    return state.gridShape;
  })()`);
  await sleep(4000);

  const info = await evalJs(`(() => {
    var cells = [...document.querySelectorAll('#layoutBoard .board-cell')];
    var sample = cells.slice(0, 3).map(function (c) {
      var k = c.querySelector('.board-kind');
      return {
        text: c.textContent.replace(/\\s+/g, ' ').trim(),
        kindShown: k ? getComputedStyle(k).display !== 'none' : false,
        w: Math.round(c.getBoundingClientRect().width),
        h: Math.round(c.getBoundingClientRect().height),
        scrollW: k ? k.scrollWidth : 0,
        clientW: k ? k.clientWidth : 0,
        overflow: k ? (k.scrollWidth > k.clientWidth + 1) : false
      };
    });
    return {
      grid: state.gridShape,
      placed: state.panels.filter(function (p) { return !!p.area; }).length,
      cells: cells.length,
      cellW: cells.length ? Math.round(cells[0].getBoundingClientRect().width) : 0,
      cellH: cells.length ? Math.round(cells[0].getBoundingClientRect().height) : 0,
      sample: sample,
      boardW: document.getElementById('layoutBoard') ? Math.round(document.getElementById('layoutBoard').getBoundingClientRect().width) : 0
    };
  })()`);
  console.log('4×4 结果：', JSON.stringify(info, null, 1));

  await shot('29_布局板_4x4.png');

  // 再截一张点开某一格的设置弹窗，看小格里文字是否还挤
  await evalJs(`document.querySelector('#layoutBoard .board-cell[data-panel="0"]').click()`);
  await sleep(1200);
  await shot('30_子图弹窗_4x4小格.png');
  await evalJs(`(() => { var m = document.getElementById('modalMask'); if (m) { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); } return 1; })()`);
  await sleep(600);

  // 面板条在 4×4 下会不会横向溢出
  const barInfo = await evalJs(`(() => {
    var bar = document.getElementById('panelBar');
    if (!bar) return null;
    return { tabs: bar.querySelectorAll('.panel-tab').length, scrollW: bar.scrollWidth, clientW: bar.clientWidth, overflow: bar.scrollWidth > bar.clientWidth + 1 };
  })()`);
  console.log('面板条：', JSON.stringify(barInfo));

  console.log(errors.length ? '✗ 控制台异常 ' + errors.length + ' 条：' + errors.slice(0, 3).join(' | ') : '✓ 控制台 0 错误');
  ws.close();
})().catch((e) => { console.error('失败：', e.message); process.exit(1); });
