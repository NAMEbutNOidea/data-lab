// 本轮验收：流程条移除 / DPI 档位与自定义 / LaTeX 公式块
// 用法: node ui_check2.js <cdpPort> <outDir> <xlsxPath>
const PORT = Number(process.argv[2] || 9223);
const OUT = process.argv[3] || '.';
const XLSX = process.argv[4];

const APP = 'http://127.0.0.1:8765/';
const fs = require('fs');
const path = require('path');

const B64 = fs.readFileSync(XLSX).toString('base64');
const FNAME = path.basename(XLSX);

let ws, msgId = 0;
const pending = new Map();
const consoleErrors = [];

function send(method, params = {}) {
  const id = ++msgId;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((res, rej) => {
    pending.set(id, { res, rej });
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); rej(new Error('CDP 超时: ' + method)); } }, 90000);
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

  console.log('1) 首页：确认流程条已移除');
  await send('Page.navigate', { url: APP });
  await sleep(2200);
  await evalJs(`(() => { try { localStorage.removeItem('datalab.theme'); } catch (e) {}
              document.documentElement.dataset.theme = 'light'; return 1; })()`);

  const layout = await evalJs(`(() => ({
    workflowNodes: document.querySelectorAll('.workflow, .workflow-step, #stepNav').length,
    stepBadges: document.querySelectorAll('.step-badge').length,
    panels: document.querySelectorAll('.panel').length,
    dpiPresets: document.querySelectorAll('.dpi-preset').length,
    dpiValue: (document.getElementById('inpDpi') || {}).value,
    dpiActive: (document.querySelector('.dpi-preset.is-active') || {}).textContent,
    dpiHint: (document.getElementById('dpiHint') || {}).textContent,
    appH: document.getElementById('app').clientHeight,
    mainH: document.querySelector('.main').clientHeight
  }))()`);
  ok(layout.workflowNodes === 0, '流程条节点已清空', 'count=' + layout.workflowNodes);
  ok(layout.stepBadges === 0, '序号角标已清空', 'count=' + layout.stepBadges);
  ok(layout.dpiPresets === 8, 'DPI 档位数量', 'count=' + layout.dpiPresets);
  ok(layout.dpiActive === '300', '默认高亮 300', 'active=' + layout.dpiActive);
  console.log('    面板数=' + layout.panels + '  app高=' + layout.appH + '  main高=' + layout.mainH);
  await shot('01_主界面.png');

  console.log('2) 注入示例文件');
  const up = await evalJs(`(async () => {
    const bin = atob("${B64}");
    const buf = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
    const file = new File([buf], ${JSON.stringify(FNAME)},
      { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const dt = new DataTransfer();
    dt.items.add(file);
    const input = document.getElementById('fileInput');
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise(r => setTimeout(r, 4500));
    return {
      sheets: document.querySelectorAll('.sheet-item').length,
      cols: document.querySelectorAll('.col-item').length
    };
  })()`);
  ok(up.sheets > 0 && up.cols > 0, '文件解析', 'sheets=' + up.sheets + ' cols=' + up.cols);

  console.log('3) 映射 X/Y 并渲染');
  const mapped = await evalJs(`(async () => {
    const items = document.querySelectorAll('#columnList .col-item');
    items[0].dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await new Promise(r => setTimeout(r, 300));
    items[1].querySelector('.col-add').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await new Promise(r => setTimeout(r, 3200));
    const img = document.getElementById('chartImg');
    return { imgW: img ? img.naturalWidth : 0, meta: (document.getElementById('chartMeta') || {}).textContent };
  })()`);
  ok(mapped.imgW > 0, '渲染出图', mapped.meta);

  console.log('4) 指数（含偏移）拟合 + LaTeX 块');
  const fit = await evalJs(`(async () => {
    document.querySelector('.tab[data-tab="fit"]').click();
    await new Promise(r => setTimeout(r, 200));
    const sel = document.getElementById('selFitModel');
    sel.value = 'exp_offset';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    document.getElementById('btnFit').click();
    await new Promise(r => setTimeout(r, 3500));
    const blk = document.querySelector('#fitResult .latex-block');
    return {
      plain: (document.querySelector('#fitResult .fit-eq') || {}).textContent,
      hasBlock: !!blk,
      code: blk ? blk.querySelector('.latex-code').textContent : null,
      buttons: blk ? Array.from(blk.querySelectorAll('.latex-actions .btn')).map(b => b.textContent) : [],
      copyAll: !!document.querySelector('#fitResult .res-head .btn')
    };
  })()`);
  ok(!!fit.hasBlock, 'LaTeX 块存在');
  ok(!!fit.code && fit.code.indexOf('\\cdot') >= 0, 'LaTeX 使用 \\cdot', fit.code);
  ok(fit.buttons.length === 3, '三种包裹格式按钮', JSON.stringify(fit.buttons));
  console.log('    纯文本：' + fit.plain);
  await shot('02_拟合公式LaTeX.png');

  console.log('5) DPI 档位点击');
  const preset = await evalJs(`(async () => {
    const btn = Array.from(document.querySelectorAll('.dpi-preset')).find(b => b.dataset.dpi === '600');
    btn.click();
    await new Promise(r => setTimeout(r, 3000));
    return {
      input: document.getElementById('inpDpi').value,
      badge: (document.getElementById('valDpi') || {}).textContent,
      hint: (document.getElementById('dpiHint') || {}).textContent,
      active: (document.querySelector('.dpi-preset.is-active') || {}).textContent,
      meta: (document.getElementById('chartMeta') || {}).textContent
    };
  })()`);
  ok(preset.input === '600' && preset.active === '600', '点击 600 档位', JSON.stringify(preset));

  console.log('6) 自定义 DPI：正常值 / 越界值');
  const custom = await evalJs(`(async () => {
    const inp = document.getElementById('inpDpi');
    function fill(v) { inp.value = String(v); inp.dispatchEvent(new Event('input', { bubbles: true })); }
    fill(450);
    await new Promise(r => setTimeout(r, 2600));
    const normal = { input: inp.value, active: (document.querySelector('.dpi-preset.is-active') || {}).textContent || null,
                     hint: document.getElementById('dpiHint').textContent };

    fill(9999);
    inp.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise(r => setTimeout(r, 2600));
    const high = { input: inp.value, hint: document.getElementById('dpiHint').textContent };

    inp.value = '30';
    inp.dispatchEvent(new Event('change', { bubbles: true }));
    inp.dispatchEvent(new Event('blur', { bubbles: true }));
    await new Promise(r => setTimeout(r, 2600));
    const low = { input: inp.value, hint: document.getElementById('dpiHint').textContent };
    return { normal, high, low };
  })()`);
  ok(custom.normal.input === '450' && custom.normal.active === null, '自定义 450 生效且无档位高亮', JSON.stringify(custom.normal));
  ok(custom.high.input === '1200', '9999 收敛到 1200', custom.high.hint);
  ok(custom.low.input === '50', '30 收敛到 50', custom.low.hint);

  console.log('7) 样式 Tab：DPI 控件外观（重置回 300）');
  await evalJs(`(async () => {
    const inp = document.getElementById('inpDpi');
    inp.value = '300';
    inp.dispatchEvent(new Event('change', { bubbles: true }));
    document.querySelector('.tab[data-tab="style"]').click();
    await new Promise(r => setTimeout(r, 2600));
    const g = Array.from(document.querySelectorAll('.group-title'))
      .find(t => t.textContent.indexOf('输出精度') >= 0);
    if (g) g.scrollIntoView({ block: 'center' });
    await new Promise(r => setTimeout(r, 400));
    return {
      input: inp.value,
      active: (document.querySelector('.dpi-preset.is-active') || {}).textContent,
      note: (document.getElementById('dpiNote') || {}).textContent
    };
  })()`).then((v) => ok(v.input === '300' && v.active === '300', '重置为 300', JSON.stringify(v)));
  await shot('03_DPI档位.png');

  console.log('8) 窄屏 900 布局（流程条去掉后主干高度是否重算）');
  await send('Emulation.setDeviceMetricsOverride', { width: 900, height: 900, deviceScaleFactor: 1, mobile: false });
  await sleep(900);
  const narrow = await evalJs(`(() => ({
    overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    panels: document.querySelectorAll('.panel').length,
    dpiVisible: !!document.getElementById('inpDpi').offsetParent
  }))()`);
  ok(narrow.overflowX <= 1, '窄屏无横向溢出', 'overflowX=' + narrow.overflowX);
  await shot('04_窄屏900.png');
  await send('Emulation.setDeviceMetricsOverride', { width: 1680, height: 1050, deviceScaleFactor: 1, mobile: false });
  await sleep(400);

  console.log('\n控制台错误数：', consoleErrors.length);
  consoleErrors.slice(0, 10).forEach((e) => console.log('  -', e.slice(0, 200)));
  if (consoleErrors.length) process.exitCode = 3;
  ws.close();
}

main().catch((e) => { console.error('验收失败:', e.message); process.exit(1); });
