// DataLab 界面验收：用 CDP 驱动无头 Edge，跑完整交互链路并截图
// 用法: node ui_check.js <port> <outDir>
const PORT = Number(process.argv[2] || 9223);
const OUT = process.argv[3] || '.';
const APP = 'http://127.0.0.1:8765/';
const fs = require('fs');
const path = require('path');

let ws, msgId = 0;
const pending = new Map();
const consoleErrors = [];

function send(method, params = {}, sessionId) {
  const id = ++msgId;
  const payload = { id, method, params };
  if (sessionId) payload.sessionId = sessionId;
  ws.send(JSON.stringify(payload));
  return new Promise((res, rej) => {
    pending.set(id, { res, rej });
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); rej(new Error('CDP 超时: ' + method)); } }, 90000);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function evalJs(expr, awaitPromise = true) {
  const r = await send('Runtime.evaluate', {
    expression: expr, awaitPromise, returnByValue: true, allowUnsafeEvalBlockedByCSP: true,
  });
  if (r.exceptionDetails) throw new Error('页面异常: ' + JSON.stringify(r.exceptionDetails.exception && r.exceptionDetails.exception.description || r.exceptionDetails.text));
  return r.result && r.result.value;
}

async function shot(name) {
  const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  const p = path.join(OUT, name);
  fs.writeFileSync(p, Buffer.from(r.data, 'base64'));
  console.log('  截图 ->', name, Math.round(fs.statSync(p).size / 1024) + 'KB');
}

async function main() {
  // 新建一个干净的标签页，避免落在扩展页面或欢迎页上
  const created = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' })).json();
  if (!created.webSocketDebuggerUrl) throw new Error('无法创建调试标签页');
  const page = created;
  ws = new WebSocket(page.webSocketDebuggerUrl);

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
      consoleErrors.push('[exception] ' + (d.exception && d.exception.description || d.text));
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
  await send('Emulation.setDeviceMetricsOverride', {
    width: 1680, height: 1050, deviceScaleFactor: 1, mobile: false,
  });

  console.log('1) 打开首页（空状态）');
  await send('Page.navigate', { url: APP });
  await sleep(2200);
  // 清掉上一轮残留的主题偏好，保证截图是默认浅色界面
  await evalJs(`(() => {
    try { localStorage.removeItem('datalab.theme'); } catch (e) {}
    document.documentElement.dataset.theme = 'light';
    return document.documentElement.dataset.theme;
  })()`);
  const guide = await evalJs(`(() => {
    const g = document.getElementById('guidePanel');
    return {
      guideVisible: !!g && !g.hidden,
      steps: document.querySelectorAll('.workflow-step').length,
      activeStep: (document.querySelector('.workflow-step.active') || {}).dataset?.step || null,
      pill: (document.getElementById('bkPill') || {}).textContent,
      env: (document.getElementById('envText') || {}).textContent,
      types: document.querySelectorAll('.type-btn').length,
      themes: document.querySelectorAll('.theme-card').length,
      palettes: document.querySelectorAll('.palette-card').length
    };
  })()`);
  console.log('   ', JSON.stringify(guide));
  await shot('ui_a_guide.png');

  console.log('2) 注入示例文件，走真实上传');
  const upload = await evalJs(`(async () => {
    const res = await fetch('./_test.xlsx');
    const buf = await res.arrayBuffer();
    const file = new File([buf], '示例数据_光电测量.xlsx',
      { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const dt = new DataTransfer();
    dt.items.add(file);
    const input = document.getElementById('fileInput');
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise(r => setTimeout(r, 4500));
    return {
      sheets: document.querySelectorAll('.sheet-item').length,
      cols: document.querySelectorAll('.col-item').length,
      rows: document.querySelectorAll('#previewTableWrap tbody tr').length,
      activeStep: (document.querySelector('.workflow-step.active') || {}).dataset?.step || null,
      msg: (document.getElementById('bkMsg') || {}).textContent
    };
  })()`);
  console.log('   ', JSON.stringify(upload));

  console.log('3) 选 X 列 + 加一个 Y 列，触发渲染');
  const mapped = await evalJs(`(async () => {
    const items = document.querySelectorAll('#columnList .col-item');
    items[0].dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await new Promise(r => setTimeout(r, 300));
    items[1].querySelector('.col-add').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await new Promise(r => setTimeout(r, 3200));
    const img = document.getElementById('chartImg');
    const area = document.querySelector('.canvas-area');
    return {
      x: (document.getElementById('selX') || {}).value,
      ys: document.querySelectorAll('#yList .chip').length,
      imgReady: !!(img && img.naturalWidth),
      imgW: img ? img.naturalWidth : 0,
      imgBox: img ? [img.clientWidth, img.clientHeight] : null,
      areaBox: area ? [area.clientWidth, area.clientHeight] : null,
      dlDisabled: ['btnDlPng', 'btnDlSvg', 'btnDlPdf', 'btnDlEps'].map(id => document.getElementById(id).disabled),
      meta: (document.getElementById('chartMeta') || {}).textContent,
      msg: (document.getElementById('bkMsg') || {}).textContent,
      activeStep: (document.querySelector('.workflow-step.active') || {}).dataset?.step || null
    };
  })()`);
  console.log('   ', JSON.stringify(mapped));
  await shot('ui_b_main.png');

  console.log('4) 指数拟合');
  const fit = await evalJs(`(async () => {
    document.querySelector('.tab[data-tab="fit"]').click();
    await new Promise(r => setTimeout(r, 200));
    const sel = document.getElementById('selFitModel');
    sel.value = 'exp';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    document.getElementById('btnFit').click();
    await new Promise(r => setTimeout(r, 3500));
    return {
      eq: (document.querySelector('.fit-eq') || {}).textContent,
      metrics: Array.from(document.querySelectorAll('#fitResult .metric')).map(m => m.textContent).slice(0, 4),
      activeStep: (document.querySelector('.workflow-step.active') || {}).dataset?.step || null,
      msg: (document.getElementById('bkMsg') || {}).textContent
    };
  })()`);
  console.log('   ', JSON.stringify(fit));
  await shot('ui_c_fit.png');

  console.log('5) 描述统计 / 不确定度 / 假设检验');
  const stats = await evalJs(`(async () => {
    document.querySelector('.tab[data-tab="stats"]').click();
    await new Promise(r => setTimeout(r, 150));
    document.getElementById('btnDescribe').click();
    await new Promise(r => setTimeout(r, 1500));
    const descOk = !!document.querySelector('#descResult .res-table');
    const sel = document.getElementById('selUncCol');
    sel.selectedIndex = 0;
    document.getElementById('inpDelta').value = '0.01';
    document.getElementById('btnUnc').click();
    await new Promise(r => setTimeout(r, 1500));
    const uncStr = (document.querySelector('#uncResult .result-str') || {}).textContent || '';
    document.getElementById('btnTest').click();
    await new Promise(r => setTimeout(r, 1500));
    const concl = (document.querySelector('#testResult .res-conclusion') || {}).textContent || '';
    return { descOk, uncStr, concl, activeStep: (document.querySelector('.workflow-step.active') || {}).dataset?.step };
  })()`);
  console.log('   ', JSON.stringify(stats));
  await shot('ui_d_stats.png');

  console.log('6) 样式 Tab：切主题与配色');
  const style = await evalJs(`(async () => {
    document.querySelector('.tab[data-tab="style"]').click();
    await new Promise(r => setTimeout(r, 150));
    const themes = document.querySelectorAll('.theme-card');
    themes[2].click();
    await new Promise(r => setTimeout(r, 400));
    const pals = document.querySelectorAll('.palette-card');
    pals[1].click();
    await new Promise(r => setTimeout(r, 2600));
    return {
      themeActive: (document.querySelector('.theme-card.active .theme-name') || {}).textContent,
      paletteActive: (document.querySelector('.palette-card.active .palette-name') || {}).textContent,
      imgReady: !!document.getElementById('chartImg').naturalWidth
    };
  })()`);
  console.log('   ', JSON.stringify(style));
  await shot('ui_e_style.png');

  console.log('7) 暗色界面 + 折叠表格');
  await evalJs(`(async () => {
    document.getElementById('btnDark').click();
    await new Promise(r => setTimeout(r, 500));
    return document.getElementById('app').className;
  })()`);
  await sleep(600);
  await shot('ui_f_dark.png');
  await evalJs(`document.getElementById('btnDark').click()`);
  await sleep(400);

  console.log('8) 全部 14 种图表类型逐个渲染');
  const kinds = await evalJs(`(async () => {
    document.querySelector('.tab[data-tab="chart"]').click();
    await new Promise(r => setTimeout(r, 150));
    const btns = Array.from(document.querySelectorAll('.type-btn'));
    const out = [];
    for (const b of btns) {
      b.click();
      await new Promise(r => setTimeout(r, 1500));
      const img = document.getElementById('chartImg');
      const msg = (document.getElementById('bkMsg') || {}).textContent || '';
      out.push(b.textContent.trim() + ':' + (msg.indexOf('渲染失败') >= 0 ? 'FAIL' : (img.naturalWidth ? 'ok' : 'empty')));
    }
    return out;
  })()`);
  console.log('   ', kinds.join(' | '));

  console.log('9) 宽屏 1280 与窄屏 900 布局');
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await sleep(600); await shot('ui_g_1280.png');
  await send('Emulation.setDeviceMetricsOverride', { width: 900, height: 900, deviceScaleFactor: 1, mobile: false });
  await sleep(600); await shot('ui_h_900.png');

  console.log('\n控制台错误数：', consoleErrors.length);
  consoleErrors.slice(0, 12).forEach((e) => console.log('  -', e.slice(0, 220)));
  ws.close();
}

main().catch((e) => { console.error('验收失败:', e.message); process.exit(1); });
