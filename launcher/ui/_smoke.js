// 拆分后的冒烟检查：页面能否正常引导 + 187 个跨文件符号是否都挂上了
// 用法: node launcher/ui/_smoke.js
const PORT = 9224;
const APP = 'http://127.0.0.1:8765/';
const fs = require('fs');
const path = require('path');

const FILES = ['01-base', '02-data', '03-panel', '04-spec', '05-interact', '06-analysis', '07-ui']
  .map((n) => path.join('web/js', n + '.js'));

const names = [];
for (const f of FILES) {
  const src = fs.readFileSync(f, 'utf8');
  const re = /^ {2}G\.([A-Za-z_$][\w$]*)\s*=/gm;
  let m;
  while ((m = re.exec(src))) names.push(m[1]);
}

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

  await send('Runtime.enable');
  await send('Log.enable');
  await send('Page.enable');
  await send('Page.navigate', { url: APP });
  await sleep(3500);

  console.log('符号总数：', names.length);

  const missing = await evalJs(`(${JSON.stringify(names)}).filter(function (n) {
    return typeof window[n] === 'undefined';
  })`);
  console.log(missing.length ? '✗ 缺失符号：' + missing.join(', ') : '✓ 187 个符号全部可用');

  const info = await evalJs(`(function () {
    var keys = Object.keys(window).filter(function (k) {
      return typeof window[k] === 'function' || typeof window[k] === 'object';
    });
    return {
      ready: !!document.getElementById('logList'),
      logText: (document.getElementById('logList') || {}).textContent || '',
      stateOk: !!(window.state && Array.isArray(window.state.gridShape)),
      sharedOk: !!(window.shared && window.shared.numericCache && window.shared.bkInfo),
      panelOk: !!(window.state && window.state.panels && window.state.panels.length),
      kindCount: (window.KINDS || []).length,
      themeBtns: document.querySelectorAll('#themeGrid .theme-card, #themeGrid .theme-item').length,
      typeBtns: document.querySelectorAll('#chartTypeGrid .type-btn').length,
      guides: !document.getElementById('guidePanel').hidden
    };
  })()`);
  console.log('引导页可见：', info.guides, '| 图型按钮', info.typeBtns, '| 主题卡', info.themeBtns);
  console.log('state 就绪：', info.stateOk, '| shared 就绪：', info.sharedOk,
    '| 面板数', info.panelOk, '| KINDS', info.kindCount);
  console.log('就绪日志：', (info.logText || '').replace(/\s+/g, ' ').slice(0, 160));

  await sleep(1200);
  console.log(errors.length ? '✗ 控制台错误 ' + errors.length + ' 条：\n  ' + errors.join('\n  ') : '✓ 控制台 0 错误');
  if (missing.length || errors.length || !info.stateOk || !info.sharedOk) process.exitCode = 2;
  ws.close();
})().catch((e) => { console.error('冒烟失败：', e.message); process.exit(1); });
