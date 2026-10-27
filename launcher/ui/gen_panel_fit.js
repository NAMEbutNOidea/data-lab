// 多子图里的拟合公式标注：改动后出图对照
// 用法: node launcher/ui/gen_panel_fit.js
const fs = require('fs');
const http = require('http');

const API = 'http://127.0.0.1:8765';
process.env.NO_PROXY = '127.0.0.1,localhost';

function post(p, body) {
  return new Promise((res, rej) => {
    const data = Buffer.from(JSON.stringify(body));
    const req = http.request(API + p, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': data.length },
    }, (r) => {
      let buf = '';
      r.on('data', (c) => (buf += c));
      r.on('end', () => {
        try {
          const j = JSON.parse(buf);
          j.ok === false ? rej(new Error(p + ': ' + j.error)) : res(j);
        } catch (e) { rej(new Error(p + ': ' + buf.slice(0, 200))); }
      });
    });
    req.on('error', rej);
    req.end(data);
  });
}

const b64 = fs.readFileSync('samples/示例数据_光电测量.xlsx').toString('base64');
const XL = '光强 I(lx)';
const Y1 = '光电流(mA)';
const Y2 = '理论值(mA)';

(async () => {
  const up = await post('/api/upload', { filename: '示例数据_光电测量.xlsx', data_b64: b64 });
  const ds = up.ds;
  const pv = await post('/api/preview', { ds, sheet: '光电响应', limit: 1000 });
  const names = pv.columns.map((c) => c.name);
  const ix = names.indexOf(XL), iy1 = names.indexOf(Y1), iy2 = names.indexOf(Y2);
  console.log('ds =', ds, '| 列 =', names.join(', '), '| 行 =', pv.rows.length);

  const x = pv.rows.map((r) => r[ix]);
  const y1 = pv.rows.map((r) => r[iy1]);
  const y2 = pv.rows.map((r) => r[iy2]);

  const fit = await post('/api/stats/fit', {
    ds, sheet: '光电响应', x_col: XL, y_col: Y1, model: 'linear',
  });
  console.log('拟合:', fit.equation_plain, '| R² =', Number(fit.r2).toFixed(4));

  const base = {
    theme: 'paper_nature', palette: 'npg', dpi: 300, figsize: [6.4, 4.2],
    font_size: 11, line_width: 1.6, marker_size: 5, legend: true, legend_loc: 'upper left',
  };

  function panel(kind, series, withFit) {
    const p = Object.assign({}, base, { kind, series });
    if (withFit) p.fit = fit;
    return p;
  }
  const s1 = { x, y: y1, name: Y1 };
  const s2 = { x, y: y2, name: Y2 };

  const multi = await post('/api/plot/render', {
    spec: Object.assign({}, base, {
      grid: true, grid_shape: [2, 2],
      panels: [
        panel('line', [s1, s2], true),
        panel('line_marker', [s1, s2], false),
        panel('scatter', [s1], false),
        panel('line', [s2], false),
      ],
    }),
  });
  fs.writeFileSync('output/ui2/13_多子图_拟合标注.png', Buffer.from(multi.png_b64, 'base64'));
  console.log('多子图 2×2 ->', multi.elapsed_ms, 'ms,', Math.round(multi.bytes / 1024) + 'KB');

  const single = await post('/api/plot/render', {
    spec: Object.assign({}, base, {
      kind: 'line', series: [s1, s2], fit, grid: true,
      title: '单图对照：公式标注字号不变', xlabel: XL, ylabel: Y1,
    }),
  });
  fs.writeFileSync('output/ui2/14_单图_拟合标注.png', Buffer.from(single.png_b64, 'base64'));
  console.log('单图对照 ->', single.elapsed_ms, 'ms,', Math.round(single.bytes / 1024) + 'KB');
})().catch((e) => { console.error('失败：', e.message); process.exit(1); });
