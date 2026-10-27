// 临时验证：跨格（span）+ 画布拖拽换位 + 无 panels_geo 时的降级
// 后端 panels_geo 还没实现，这里用 fetch 拦截注入一份"几何"来驱动前端占位层，
// 其余全部走真实交互（CDP 鼠标事件）。
// 用法：node launcher/ui/ui_check_area.js
const fs = require('fs');
const path = require('path');
const PORT = 9224;
const APP = 'http://127.0.0.1:8765/';
const SAMPLE = 'samples/示例数据_光电测量.xlsx';

let ws, msgId = 0;
const pending = new Map();
const consoleErrors = [];
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
function ok(cond, label, extra) {
  results.push(!!cond);
  console.log('   ' + (cond ? '✓' : '✗') + ' ' + label + (extra ? '  ' + extra : ''));
  if (!cond) process.exitCode = 2;
}

// 注入：记录每次渲染请求体；可用 window.__geoMode 模拟"后端还没返回 panels_geo"。
const MOCK = `(() => {
  if (window.__geoMock) return 1;
  window.__geoMock = 1;
  window.__lastRenderBody = null;
  window.__geoMode = 'real';
  var orig = window.fetch;
  window.fetch = function (u, o) {
    var url = String(u && u.url ? u.url : u);
    var p = orig.apply(this, arguments);
    if (url.indexOf('/api/plot/render') < 0) return p;
    return p.then(function (res) {
      return res.text().then(function (txt) {
        var data = null;
        try { data = JSON.parse(txt); } catch (e) { data = null; }
        if (!data) return new Response(txt, { status: res.status, headers: { 'Content-Type': 'application/json' } });
        try { window.__lastRenderBody = JSON.parse(o.body); } catch (e) {}
        if (window.__geoMode === 'strip') delete data.panels_geo;
        return new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });
      });
    });
  };
  return 1;
})()`;

async function mouseDrag(from, to, modifiers) {
  await send('Input.dispatchMouseEvent', {
    type: 'mousePressed', x: from.x, y: from.y, button: 'left', clickCount: 1, buttons: 1, modifiers: modifiers || 0
  });
  const steps = 6;
  for (let i = 1; i <= steps; i++) {
    await send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: Math.round(from.x + (to.x - from.x) * i / steps),
      y: Math.round(from.y + (to.y - from.y) * i / steps),
      button: 'left', buttons: 1, modifiers: modifiers || 0
    });
    await sleep(40);
  }
  await send('Input.dispatchMouseEvent', {
    type: 'mouseReleased', x: to.x, y: to.y, button: 'left', clickCount: 1, buttons: 0, modifiers: modifiers || 0
  });
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
  await send('Page.navigate', { url: APP });
  await sleep(2600);
  await evalJs(`(() => { try { localStorage.removeItem('datalab.session'); localStorage.removeItem('datalab.theme'); } catch (e) {} return 1; })()`);
  await send('Page.reload');
  await sleep(2600);
  await evalJs(MOCK);
  await evalJs(`window.__geoMode = 'strip'; 1`);   // 先模拟"后端还没返回 panels_geo"

  // 导入示例数据
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

  const layout = async (r, c) => {
    await evalJs(`(async () => {
      document.getElementById('inpGridRows').value = '${r}';
      document.getElementById('inpGridCols').value = '${c}';
      document.getElementById('inpGridCols').dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise((res) => setTimeout(res, 2600));
      return 1;
    })()`);
  };

  // ================= 0. 后端还没返回 panels_geo 时的降级 =================
  console.log('0) 降级：后端没有 panels_geo 时不建占位层、左键仍是平移');
  await layout(2, 2);
  const degraded = await evalJs(`(() => ({
    cells: document.querySelectorAll('#chartGeoLayer .geo-cell').length,
    geoMode: document.getElementById('chartWrap').classList.contains('geo-mode'),
    tabs: document.querySelectorAll('#panelBar .panel-tab').length,
    hasGeoProp: !!(window.state.lastRender && Object.prototype.hasOwnProperty.call(window.state.lastRender, 'panels_geo'))
  }))()`);
  ok(degraded.cells === 0 && !degraded.geoMode, '没有 panels_geo → 不建占位层',
    'cells=' + degraded.cells + ' geo-mode=' + degraded.geoMode);
  ok(degraded.tabs === 4, '多子图本身照常渲染', 'tabs=' + degraded.tabs);
  const imgPt = await evalJs(`(() => {
    var r = document.getElementById('chartImg').getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  })()`);
  await mouseDrag(imgPt, { x: imgPt.x + 36, y: imgPt.y + 22 });
  await sleep(300);
  const degPan = await evalJs(`({
    img: document.getElementById('chartImg').style.transform,
    stage: document.getElementById('chartStage').style.transform
  })`);
  ok(/translate\(/.test(degPan.img) && !degPan.stage, '降级时左键拖动仍是平移图片（与旧版一致）',
    'img=' + degPan.img + ' stage="' + degPan.stage + '"');
  await evalJs('resetZoom()');

  // 切回真实响应后重新渲染，后续用后端真实的 panels_geo
  await evalJs(`window.__geoMode = 'real'; 1`);
  await evalJs(`(async () => {
    document.getElementById('btnRender').click();
    await new Promise((r) => setTimeout(r, 2800));
    return 1;
  })()`);
  const live = await evalJs(`(() => ({
    cells: document.querySelectorAll('#chartGeoLayer .geo-cell').length,
    geoMode: document.getElementById('chartWrap').classList.contains('geo-mode'),
    geo: (state.lastRender && state.lastRender.panels_geo) || null
  }))()`);
  ok(live.cells === 4 && live.geoMode, '后端真的返回 panels_geo 时建出 4 个占位格', 'cells=' + live.cells);
  console.log('   panels_geo: ' + JSON.stringify((live.geo || []).map((g) => ({
    i: g.index, area: g.area, label: g.label, rect: g.rect.map((v) => Math.round(v * 100) / 100)
  }))));

  // ================= 1. 跨格 =================
  console.log('1) 跨格：2×2 里 (a) 跨两列');
  const before = await evalJs(`(() => ({
    grid: state.gridShape.slice(),
    tabs: document.querySelectorAll('#panelBar .panel-tab').length,
    cells: document.querySelectorAll('#chartGeoLayer .geo-cell').length,
    hint: document.getElementById('gridHint').textContent,
    spanBar: !document.getElementById('spanBar').hidden
  }))()`);
  ok(before.grid.join('x') === '2x2' && before.tabs === 4, '自定义行列生效：2×2 + 4 个面板',
    'tabs=' + before.tabs + ' hint=' + before.hint);
  ok(before.spanBar && before.cells === 4, '多子图时有跨格开关，占位层 4 个格',
    'cells=' + before.cells);

  await evalJs(`(async () => {
    document.querySelector('#panelBar .panel-tab[data-panel="0"]').click();
    await new Promise((r) => setTimeout(r, 200));
    document.getElementById('btnSpanCols').click();
    await new Promise((r) => setTimeout(r, 2800));
    return 1;
  })()`);
  const spanned = await evalJs(`(() => {
    var spec = (window.__lastRenderBody || {}).spec || {};
    var tabs = Array.prototype.map.call(document.querySelectorAll('#panelBar .panel-tab'), function (b) {
      return b.textContent + (b.classList.contains('active') ? '*' : '');
    });
    return {
      areas: state.panels.map(function (p) { return p.area ? p.area.join(',') : null; }),
      tabs: tabs,
      tabCount: tabs.length,
      btnActive: document.getElementById('btnSpanCols').classList.contains('is-active'),
      ariaPressed: document.getElementById('btnSpanCols').getAttribute('aria-pressed'),
      specAreas: (spec.panels || []).map(function (p) { return p.area.join(','); }),
      specLabels: (spec.panels || []).map(function (p) { return p.panel_label; }),
      gridShape: spec.grid_shape,
      geo: document.querySelectorAll('#chartGeoLayer .geo-cell').length
    };
  })()`);
  ok(spanned.tabCount === 3, '跨两列后只剩 3 个面板', 'tabs=' + JSON.stringify(spanned.tabs));
  ok(spanned.tabs.join('|').indexOf('2列') >= 0, '切换条标记跨格', spanned.tabs.join(' | '));
  ok(spanned.btnActive && spanned.ariaPressed === 'true', '跨 2 列按钮是激活态（is-active / aria-pressed）');
  ok(spanned.specAreas.join(' ') === '0,0,1,2 1,0,1,1 1,1,1,1',
    '下发 area = [0,0,1,2] + 两个 1×1（两张小图在下面）', spanned.specAreas.join(' '));
  ok(spanned.specLabels.join('') === '(a)(b)(c)', '编号按阅读顺序 (a)(b)(c)', spanned.specLabels.join(''));
  ok(spanned.gridShape.join(',') === '2,2', 'grid_shape 照旧下发', spanned.gridShape.join(','));
  ok(spanned.geo === 3, '占位层格数 = 面板数', 'cells=' + spanned.geo);
  ok(spanned.areas.filter((a) => a === null).length === 1,
    '被吃掉的第 4 个面板 area=null 但仍留在 state.panels', JSON.stringify(spanned.areas));

  // 撤销 / 重做也要还原 area
  await evalJs('undo()');
  await sleep(2800);
  const undone = await evalJs(`(() => ({
    tabs: document.querySelectorAll('#panelBar .panel-tab').length,
    areas: state.panels.map(function (p) { return p.area ? p.area.join(',') : null; }).join(' ')
  }))()`);
  ok(undone.tabs === 4 && undone.areas.indexOf('null') < 0, '撤销把跨格一起还原（4 个面板都回来了）',
    'tabs=' + undone.tabs + ' ' + undone.areas);
  await evalJs('redo()');
  await sleep(2800);
  const redone = await evalJs(`(() => ({
    tabs: document.querySelectorAll('#panelBar .panel-tab').length,
    area0: state.panels[0].area.join(',')
  }))()`);
  ok(redone.tabs === 3 && redone.area0 === '0,0,1,2', '重做恢复跨格', 'tabs=' + redone.tabs + ' area0=' + redone.area0);

  // 会话里要带 area（刷新后跨格才不会丢）
  await sleep(900);
  const sess = await evalJs(`(() => {
    var raw = localStorage.getItem('datalab.session');
    if (!raw) return null;
    var d = JSON.parse(raw);
    return { areas: (d.panels || []).map(function (p) { return p.area ? p.area.join(',') : null; }) };
  })()`);
  ok(sess && sess.areas[0] === '0,0,1,2', 'saveSession 里带了每个面板的 area', sess ? JSON.stringify(sess.areas) : 'null');

  // 占位框对齐
  const geom = await evalJs(`(() => {
    var img = document.getElementById('chartImg').getBoundingClientRect();
    var cells = Array.prototype.map.call(document.querySelectorAll('#chartGeoLayer .geo-cell'), function (n) {
      var r = n.getBoundingClientRect();
      return { idx: n.dataset.panel, l: r.left - img.left, t: r.top - img.top, w: r.width, h: r.height };
    });
    return { imgW: img.width, imgH: img.height, cells: cells };
  })()`);
  const inside = geom.cells.every((c) => c.l >= -1 && c.t >= -1 && c.l + c.w <= geom.imgW + 1 && c.t + c.h <= geom.imgH + 1);
  ok(inside, '占位框全在图片范围内', geom.cells.map((c) => Math.round(c.w) + 'x' + Math.round(c.h)).join(' '));
  const wide = geom.cells.slice().sort((a, b) => b.w - a.w)[0];
  const narrow = geom.cells.slice().sort((a, b) => a.w - b.w)[0];
  ok(wide.w > narrow.w * 1.6, '跨列面板的占位框明显更宽', Math.round(wide.w) + ' vs ' + Math.round(narrow.w));

  // ================= 2. 拖拽交换 =================
  console.log('2) 画布拖拽：把 (a) 拖到 (b) 上 → 交换 area');
  // 先把两个面板设成不同图型，交换后能从 spec 里看出"内容跟着面板走"
  await evalJs(`(async () => {
    document.querySelector('#panelBar .panel-tab[data-panel="0"]').click();
    await new Promise((r) => setTimeout(r, 200));
    document.querySelector('#chartTypeGrid .type-btn[data-kind="bar"]').click();
    await new Promise((r) => setTimeout(r, 2400));
    document.querySelector('#panelBar .panel-tab[data-panel="2"]').click();
    await new Promise((r) => setTimeout(r, 200));
    document.querySelector('#chartTypeGrid .type-btn[data-kind="scatter"]').click();
    await new Promise((r) => setTimeout(r, 2400));
    return 1;
  })()`);
  const kinds0 = await evalJs(`state.panels.map(function (p) { return p.kind; }).join(',')`);
  console.log('   图型：' + kinds0);

  const centers = await evalJs(`Array.prototype.map.call(document.querySelectorAll('#chartGeoLayer .geo-cell'), function (n) {
    var r = n.getBoundingClientRect();
    return { idx: Number(n.dataset.panel), x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })`);
  const cellA = centers.find((c) => c.idx === 0);
  const cellB = centers.filter((c) => c.idx !== 0).sort((x, y) => y.y - x.y)[0];
  console.log('   A=', JSON.stringify(cellA), ' B=', JSON.stringify(cellB));

  const areaBeforeSwap = await evalJs(`state.panels[0].area.join(',') + ' | ' + state.panels[${cellB.idx}].area.join(',')`);
  await mouseDrag(cellA, cellB);
  await sleep(2600);
  const swapped = await evalJs(`(() => {
    var spec = (window.__lastRenderBody || {}).spec || {};
    return {
      a0: state.panels[0].area ? state.panels[0].area.join(',') : null,
      a1: state.panels[${cellB.idx}].area ? state.panels[${cellB.idx}].area.join(',') : null,
      specKinds: (spec.panels || []).map(function (p) { return p.area.join(',') + ':' + p.kind; }),
      specLabels: (spec.panels || []).map(function (p) { return p.panel_label; }),
      tabs: Array.prototype.map.call(document.querySelectorAll('#panelBar .panel-tab'), function (b) { return b.dataset.panel; }),
      log: document.getElementById('logPane').textContent.slice(-90)
    };
  })()`);
  const srcArea = areaBeforeSwap.split(' | ')[0];
  const dstArea = areaBeforeSwap.split(' | ')[1];
  ok(swapped.a0 === dstArea && swapped.a1 === srcArea,
    '两个面板的 area 互换了', areaBeforeSwap + '  →  ' + swapped.a0 + ' | ' + swapped.a1);
  ok(swapped.specKinds.join(' ') === '0,0,1,2:scatter 1,0,1,1:bar 1,1,1,1:line',
    '重新渲染的 spec 里图型跟着面板走到新位置（内容随面板走）',
    swapped.specKinds.join(' ') + ' → ' + swapped.specLabels.join(''));
  ok(swapped.tabs.join(',') === '2,0,3', '切换条按新的阅读顺序重排', swapped.tabs.join(','));
  ok(swapped.log.indexOf('交换面板') >= 0, '日志记录了交换', swapped.log.replace(/\s+/g, ' ').trim());

  // ================= 3. 缩放时占位层不错位 =================
  console.log('3) 缩放：transform 落在 #chartStage，占位层跟着一起缩');
  const ratio0 = await evalJs(`(() => {
    var img = document.getElementById('chartImg').getBoundingClientRect();
    var c = document.querySelector('#chartGeoLayer .geo-cell').getBoundingClientRect();
    return c.width / img.width;
  })()`);
  await send('Input.dispatchMouseEvent', {
    type: 'mouseWheel', x: imgPt.x, y: imgPt.y, deltaX: 0, deltaY: -260, modifiers: 0, pointerType: 'mouse'
  });
  await sleep(600);
  const zoomed = await evalJs(`(() => {
    var img = document.getElementById('chartImg').getBoundingClientRect();
    var c = document.querySelector('#chartGeoLayer .geo-cell').getBoundingClientRect();
    return {
      stage: document.getElementById('chartStage').style.transform,
      img: document.getElementById('chartImg').style.transform,
      ratio: c.width / img.width
    };
  })()`);
  ok(/scale\(/.test(String(zoomed.stage)), '缩放后 transform 在 #chartStage 上', zoomed.stage);
  ok(!zoomed.img, '此时 #chartImg 自身不再重复缩放', 'img.transform="' + zoomed.img + '"');
  ok(Math.abs(zoomed.ratio - ratio0) < 0.01,
    '缩放前后占位框相对图片的宽度比例不变（不错位）',
    ratio0.toFixed(3) + ' → ' + zoomed.ratio.toFixed(3));

  const t0 = await evalJs(`document.getElementById('chartStage').style.transform`);
  await mouseDrag(imgPt, { x: imgPt.x + 40, y: imgPt.y + 25 }, 8); // 8 = Shift
  await sleep(400);
  const t1 = await evalJs(`document.getElementById('chartStage').style.transform`);
  ok(t1 !== t0 && /translate\(/.test(t1), '按住 Shift 拖动 = 平移画布', String(t1).slice(0, 48));
  await evalJs(`document.getElementById('btnZoomReset').click()`);
  await sleep(300);

  // ================= 4. 落到空格子 =================
  console.log('4) 落到空格子：清掉一个面板的占位，再把另一个拖进这一格');
  const cleared = await evalJs(`(async () => {
    // 制造一个空格子（等价于跨格把面板挤掉后的状态），然后重新渲染一次
    state.panels[3].area = null;
    renderLayoutUI();
    scheduleRender(0);
    await new Promise((r) => setTimeout(r, 2800));
    return Array.prototype.map.call(document.querySelectorAll('#chartGeoLayer .geo-cell'), function (n) {
      var r = n.getBoundingClientRect();
      return { idx: Number(n.dataset.panel), x: r.left + r.width / 2, y: r.top + r.height / 2 };
    });
  })()`);
  ok(cleared.length === 2, '清掉一格后占位层只剩 2 个格', 'cells=' + cleared.length);
  const srcCell = cleared.slice().sort((a, b) => b.y - a.y)[0];
  const emptyPt = await evalJs(`(() => {
    var img = document.getElementById('chartImg').getBoundingClientRect();
    return { x: img.left + img.width * 0.78, y: img.top + img.height * 0.78 };
  })()`);
  await mouseDrag(srcCell, emptyPt);
  await sleep(2600);
  const afterMove = await evalJs(`(() => ({
    areas: state.panels.map(function (p) { return p.area ? p.area.join(',') : null; }),
    tabs: Array.prototype.map.call(document.querySelectorAll('#panelBar .panel-tab'), function (b) { return b.dataset.panel; }),
    log: document.getElementById('logPane').textContent.slice(-70)
  }))()`);
  ok(afterMove.areas[srcCell.idx] === '1,1,1,1', '面板' + srcCell.idx + ' 移到了空格子 (1,1)',
    JSON.stringify(afterMove.areas));
  ok(afterMove.tabs.length === 2, '移动后仍是 2 个可见面板', afterMove.tabs.join(','));
  ok(afterMove.log.indexOf('面板移到') >= 0, '日志记录了移动', afterMove.log.replace(/\s+/g, ' ').trim());

  // ================= 5. 两个跨格开关同时开 = 2×2 大图 =================
  console.log('5) 同时开「跨 2 列 + 跨 2 行」= 一个大面板');
  await layout(2, 2);
  const both = await evalJs(`(async () => {
    document.querySelector('#panelBar .panel-tab[data-panel="0"]').click();
    await new Promise((r) => setTimeout(r, 200));
    if (!document.getElementById('btnSpanCols').classList.contains('is-active')) {
      document.getElementById('btnSpanCols').click();
      await new Promise((r) => setTimeout(r, 2200));
    }
    document.getElementById('btnSpanRows').click();
    await new Promise((r) => setTimeout(r, 2800));
    return {
      area: state.panels[0].area.join(','),
      rowsActive: document.getElementById('btnSpanRows').classList.contains('is-active'),
      colsActive: document.getElementById('btnSpanCols').classList.contains('is-active'),
      tabs: document.querySelectorAll('#panelBar .panel-tab').length,
      barHidden: document.getElementById('panelBar').hidden,
      cells: document.querySelectorAll('#chartGeoLayer .geo-cell').length
    };
  })()`);
  ok(both.area === '0,0,2,2' && both.rowsActive && both.colsActive, '两个开关同时激活 → area [0,0,2,2]',
    JSON.stringify(both));
  ok(both.tabs === 0 && both.barHidden && both.cells === 1, '只剩 1 个面板，切换条隐藏',
    'tabs=' + both.tabs + ' cells=' + both.cells);

  console.log('\n控制台错误数：', consoleErrors.length);
  if (consoleErrors.length) console.log(consoleErrors.join('\n'));
  const pass = results.filter(Boolean).length;
  console.log('断言：' + pass + '/' + results.length);
  if (consoleErrors.length) process.exitCode = 2;
  ws.close();
})().catch((e) => { console.error('验证失败：', e.message); process.exit(1); });
