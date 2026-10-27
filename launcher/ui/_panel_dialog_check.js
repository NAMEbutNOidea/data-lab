// 临时验收：拼图板 + 子图设置弹窗（点方块改大小/位置，主窗口即时重绘）
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

const SNAP = `(() => ({
  grid: state.gridShape.slice(),
  areas: state.panels.map(function (p) { return p.area ? p.area.join(',') : null; }),
  placed: state.panels.filter(function (p) { return !!p.area; }).length,
  unplaced: state.panels.filter(function (p) { return !p.area; }).length,
  boardHidden: document.getElementById('layoutBoard').hidden,
  boardCells: document.querySelectorAll('#layoutBoard .board-cell').length,
  chips: document.querySelectorAll('#boardUnplaced .unplaced-chip').length,
  chipsHidden: document.getElementById('boardUnplaced').hidden,
  dialog: !document.getElementById('modalMask').hidden,
  docked: document.getElementById('modalMask').classList.contains('is-dock-right'),
  miniCells: document.querySelectorAll('#modalBody .pdg-cell').length,
  miniMe: document.querySelectorAll('#modalBody .pdg-cell.is-me').length
}))()`;

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
  await evalJs(`(() => { try { localStorage.removeItem('datalab.session'); localStorage.removeItem('datalab.theme'); } catch (e) {} return 1; })()`);
  await send('Page.reload');
  await sleep(2600);

  // 导入示例数据
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

  console.log('1) 切 2×2：拼图板应出现 4 个方块');
  await evalJs(`(async () => {
    document.querySelector('.tab[data-tab="chart"]').click();
    document.getElementById('inpGridRows').value = '2';
    document.getElementById('inpGridCols').value = '2';
    document.getElementById('inpGridCols').dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 3200));
    return 1;
  })()`);
  await waitRender(20000);
  let st = await evalJs(SNAP);
  ok(!st.boardHidden && st.boardCells === 4, '拼图板出现 4 个方块', 'cells=' + st.boardCells);
  ok(st.placed === 4 && st.unplaced === 0 && st.chipsHidden, '4 个面板各占 1 格，无未放置', JSON.stringify(st.areas));
  ok(/^\d+ \/ 4 格$/.test(await evalJs(`document.getElementById('boardHint').textContent`)),
    '板子角标显示占格数', await evalJs(`document.getElementById('boardHint').textContent`));

  console.log('2) 点方块 (a) → 打开子图设置弹窗');
  await evalJs(`document.querySelector('#layoutBoard .board-cell[data-panel="0"]').click()`);
  await sleep(500);
  st = await evalJs(SNAP);
  ok(st.dialog && st.docked, '弹窗打开且靠右停靠', 'docked=' + st.docked);
  ok(st.miniCells === 4 && st.miniMe === 1, '缩略预览：4 格、其中 1 格是当前子图',
    'cells=' + st.miniCells + ' me=' + st.miniMe);
  const title = await evalJs(`document.getElementById('modalTitle').textContent`);
  ok(title === '子图设置', '标题正确', title);
  const ratioTxt = await evalJs(`document.querySelector('#modalBody .pdg-note').textContent`);
  ok(/占图面 50% 宽/.test(ratioTxt), '显示占图面比例与宽高比', ratioTxt);
  await shot('24_子图设置弹窗.png');

  console.log('3) 弹窗里点 1×2（上大下两小）→ 主窗口即时变化');
  await evalJs(`document.querySelector('#modalBody .pdg-quick-btn[data-rs="1"][data-cs="2"]').click()`);
  await sleep(3600);
  await waitRender(20000);
  st = await evalJs(SNAP);
  ok(st.areas[0] === '0,0,1,2', '面板 (a) 变成跨 2 列', st.areas[0]);
  ok(st.placed === 3 && st.unplaced === 1, '吃掉 1 个面板：3 个已放置 + 1 个未放置',
    'placed=' + st.placed + ' unplaced=' + st.unplaced);
  ok(st.boardCells === 3 && st.chips === 1 && !st.chipsHidden, '拼图板 3 块 + 1 个"未放置"chip',
    'board=' + st.boardCells + ' chips=' + st.chips);
  const geo = await evalJs(`(state.lastRender && state.lastRender.panels_geo || []).map(function (g) {
    return { label: g.label, a: g.area, rect: g.rect.map(function (v) { return Math.round(v * 1000) / 1000; }) };
  })`);
  const big = geo[0];
  const small = geo[1];
  ok(geo.length === 3, '后端回传 3 条 panels_geo', JSON.stringify(geo.map((g) => g.label)));
  ok(big && small && big.rect[2] > small.rect[2] * 1.8, '大图宽度约为小图的 2 倍',
    'w=' + (big && big.rect[2]) + ' vs ' + (small && small.rect[2]));
  ok(big && small && big.rect[1] > small.rect[1], '大图在上排（origin 左下，y 更大）',
    'y=' + (big && big.rect[1]) + ' vs ' + (small && small.rect[1]));
  await shot('25_上大下两小_弹窗实时.png');

  console.log('4) 取消 → 整块还原');
  await evalJs(`Array.prototype.find.call(document.querySelectorAll('#modalFoot .btn'), function (b) { return b.textContent === '取消'; }).click()`);
  await sleep(3400);
  await waitRender(20000);
  st = await evalJs(SNAP);
  ok(!st.dialog, '弹窗已关闭');
  ok(st.placed === 4 && st.unplaced === 0, '取消后 4 个面板全部回到 1×1', JSON.stringify(st.areas));
  ok(st.areas.every((a) => a === '0,0,1,1' || /,1,1$/.test(a)), '每个 area 都是 1×1', JSON.stringify(st.areas));

  console.log('5) 重新做一遍并"完成"，再验证刷新后保住');
  await evalJs(`document.querySelector('#layoutBoard .board-cell[data-panel="0"]').click()`);
  await sleep(400);
  await evalJs(`document.querySelector('#modalBody .pdg-quick-btn[data-rs="1"][data-cs="2"]').click()`);
  await sleep(3200);
  await waitRender(20000);
  await evalJs(`Array.prototype.find.call(document.querySelectorAll('#modalFoot .btn'), function (b) { return b.textContent === '完成'; }).click()`);
  await sleep(2600);
  await waitRender(20000);
  await send('Page.reload');
  await sleep(3200);
  await waitRender(30000);
  st = await evalJs(SNAP);
  ok(st.grid.join('x') === '2x2' && st.areas[0] === '0,0,1,2', '刷新后跨格保住', JSON.stringify(st.areas));
  ok(st.boardCells === 3 && st.chips === 1, '刷新后拼图板与未放置 chip 都复原',
    'board=' + st.boardCells + ' chips=' + st.chips);
  await shot('26_上大下两小_主窗口.png');

  console.log('6) 满格时「+ 新子图」应禁用；腾出空位后能把被吃掉的面板放回');
  const fullState = await evalJs(`({
    dis: document.getElementById('btnAddPanel').disabled,
    tip: document.getElementById('btnAddPanel').title,
    placed: state.panels.filter(function (p) { return !!p.area; }).length
  })`);
  ok(fullState.dis === true, '3 个面板占满 4 格时「+ 新子图」自动禁用', fullState.tip);
  ok(fullState.placed === 3, '确实是 3 个面板占 4 格', 'placed=' + fullState.placed);

  // 把大图收回 1×1，腾出 [0,1]
  await evalJs(`document.querySelector('#layoutBoard .board-cell[data-panel="0"]').click()`);
  await sleep(450);
  await evalJs(`document.querySelector('#modalBody .pdg-quick-btn[data-rs="1"][data-cs="1"]').click()`);
  await sleep(3200);
  await waitRender(20000);
  const freed = await evalJs(`({
    dis: document.getElementById('btnAddPanel').disabled,
    chips: document.querySelectorAll('#boardUnplaced .unplaced-chip').length
  })`);
  ok(freed.dis === false && freed.chips === 1, '腾出空位：按钮恢复可用，仍有 1 个未放置', JSON.stringify(freed));

  await evalJs(`Array.prototype.find.call(document.querySelectorAll('#modalFoot .btn'), function (b) { return b.textContent === '完成'; }).click()`);
  await sleep(700);
  const nBefore = await evalJs(`state.panels.length`);
  await evalJs(`document.querySelector('#boardUnplaced .unplaced-chip').click()`);
  await sleep(3000);
  await waitRender(20000);
  const restored = await evalJs(`({
    n: state.panels.length,
    placed: state.panels.filter(function (p) { return !!p.area; }).length,
    unplaced: state.panels.filter(function (p) { return !p.area; }).length,
    board: document.querySelectorAll('#layoutBoard .board-cell').length,
    chipsHidden: document.getElementById('boardUnplaced').hidden,
    tabs: document.querySelectorAll('#panelBar .panel-tab').length
  })`);
  ok(restored.n === nBefore && restored.placed === 4 && restored.unplaced === 0,
    '点「未放置」chip 把面板放回空格', JSON.stringify(restored));
  ok(restored.board === 4 && restored.chipsHidden && restored.tabs === 4,
    '拼图板回到 4 块、chip 收起、切换条 4 个', JSON.stringify(restored));

  console.log('7) 双击画布上的子图 → 打开同一个设置弹窗');
  const pts = await evalJs(`Array.prototype.map.call(document.querySelectorAll('#chartGeoLayer .geo-cell'), function (n) {
    var r = n.getBoundingClientRect();
    return { idx: Number(n.dataset.panel), x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })`);
  const target = pts[0];
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: target.x, y: target.y, button: 'left', clickCount: 1, buttons: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: target.x, y: target.y, button: 'left', clickCount: 1, buttons: 0 });
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: target.x, y: target.y, button: 'left', clickCount: 2, buttons: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: target.x, y: target.y, button: 'left', clickCount: 2, buttons: 0 });
  await sleep(700);
  const dlg = await evalJs(SNAP);
  ok(dlg.dialog && dlg.docked, '双击画布子图打开了设置弹窗');
  // Esc 关掉（这条路径走的是 closeModal，验证不会残留 dock 样式）
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await sleep(900);
  const esc = await evalJs(`({ open: !document.getElementById('modalMask').hidden, docked: document.getElementById('modalMask').classList.contains('is-dock-right') })`);
  ok(!esc.open && !esc.docked, 'Esc 关闭后不残留靠右停靠样式', JSON.stringify(esc));

  console.log('8) 位置步进器 + 大小回 1×1');
  await evalJs(`document.querySelector('#layoutBoard .board-cell[data-panel="0"]').click()`);
  await sleep(450);
  const minis = await evalJs(`document.querySelectorAll('#modalBody .pdg-mini').length`);
  ok(minis === 1, '缩略图存在', 'minis=' + minis);
  // 先跨两列，再看「第几列 +」是否自动禁用（2×2 里跨 2 列后已经贴右边，挪不动）
  await evalJs(`document.querySelector('#modalBody .pdg-quick-btn[data-rs="1"][data-cs="2"]').click()`);
  await sleep(3000);
  await waitRender(20000);
  const disabledPlus = await evalJs(`(() => {
    var rows = document.querySelectorAll('#modalBody .pdg-row');
    var last = rows[rows.length - 1];
    return last.querySelector('.pdg-step:last-child').disabled;
  })()`);
  ok(disabledPlus === true, '跨满两列时"第几列 +"自动禁用（放不下）');
  await evalJs(`document.querySelector('#modalBody .pdg-quick-btn[data-rs="1"][data-cs="1"]').click()`);
  await sleep(3200);
  await waitRender(20000);
  const back = await evalJs(`({ a: state.panels[0].area.join(','), placed: state.panels.filter(function (p) { return !!p.area; }).length })`);
  ok(back.a === '0,0,1,1', '快捷 1×1 收回成单格', back.a);
  await evalJs(`Array.prototype.find.call(document.querySelectorAll('#modalFoot .btn'), function (b) { return b.textContent === '完成'; }).click()`);
  await sleep(2600);
  await waitRender(20000);

  console.log('8b) 直接点缩略图右下格 → 子图挪过去');
  await evalJs(`document.querySelector('#layoutBoard .board-cell[data-panel="0"]').click()`);
  await sleep(500);
  const miniBox = await evalJs(`(() => {
    var r = document.querySelector('#modalBody .pdg-mini').getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height };
  })()`);
  const tx = Math.round(miniBox.x + miniBox.w * 0.78);
  const ty = Math.round(miniBox.y + miniBox.h * 0.78);
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: tx, y: ty, button: 'left', clickCount: 1, buttons: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: tx, y: ty, button: 'left', clickCount: 1, buttons: 0 });
  await sleep(3200);
  await waitRender(20000);
  const moved = await evalJs(`({ a: state.panels[0].area.join(','), note: document.querySelector('#modalBody .pdg-note').textContent })`);
  ok(moved.a === '1,1,1,1', '点缩略图右下格，子图挪到第 2 行第 2 列', moved.a);
  ok(/占图面 50% 宽/.test(moved.note), '缩略图说明同步刷新', moved.note);
  await shot('28_缩略图点选定位.png');

  console.log('9) 暗色主题下的弹窗');
  await evalJs(`document.getElementById('btnDark').click()`);
  await sleep(600);
  await evalJs(`document.querySelector('#layoutBoard .board-cell[data-panel="0"]').click()`);
  await sleep(500);
  await shot('27_子图弹窗_暗色.png');
  await evalJs(`Array.prototype.find.call(document.querySelectorAll('#modalFoot .btn'), function (b) { return b.textContent === '取消'; }).click()`);
  await sleep(800);
  await evalJs(`document.getElementById('btnDark').click()`);
  await sleep(400);

  console.log('\n控制台错误数：', errors.length);
  if (errors.length) console.log(errors.join('\n'));
  console.log('断言：' + results.filter(Boolean).length + '/' + results.length);
  if (errors.length) process.exitCode = 2;
  ws.close();
})().catch((e) => { console.error('失败：', e.message); process.exit(1); });
