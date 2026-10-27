// 跨格占位的独立核对：2×2 里 (a) 跨两列，下面两张小图
// 用法: node launcher/ui/gen_span_check.js
const fs = require('fs');
const http = require('http');

const API = 'http://127.0.0.1:8765';
process.env.NO_PROXY = '127.0.0.1,localhost';

function post(p, body) {
  return new Promise((res, rej) => {
    const d = Buffer.from(JSON.stringify(body));
    const req = http.request(API + p, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': d.length },
    }, (r) => {
      let s = '';
      r.on('data', (c) => (s += c));
      r.on('end', () => { try { res(JSON.parse(s)); } catch (e) { rej(new Error(s.slice(0, 300))); } });
    });
    req.on('error', rej);
    req.end(d);
  });
}

const XL = '光强 I(lx)', Y1 = '光电流(mA)', Y2 = '理论值(mA)';

(async () => {
  const up = await post('/api/upload', {
    filename: '示例数据_光电测量.xlsx',
    data_b64: fs.readFileSync('samples/示例数据_光电测量.xlsx').toString('base64'),
  });
  const ds = up.ds;
  const pv = await post('/api/preview', { ds, sheet: '光电响应', limit: 1000 });
  const names = pv.columns.map((c) => c.name);
  const x = pv.rows.map((r) => r[names.indexOf(XL)]);
  const y1 = pv.rows.map((r) => r[names.indexOf(Y1)]);
  const y2 = pv.rows.map((r) => r[names.indexOf(Y2)]);
  const fit = await post('/api/stats/fit', {
    ds, sheet: '光电响应', x_col: XL, y_col: Y1, model: 'exp',
  });

  const base = { theme: 'paper_nature', palette: 'npg', dpi: 300, figsize: [6.4, 4.2],
    font_size: 11, line_width: 1.6, marker_size: 5, legend: true, legend_loc: 'upper left' };
  const S1 = { x, y: y1, name: Y1 };
  const S2 = { x, y: y2, name: Y2 };

  // ① 用户要的形态：2×2，上排一个大图跨两列，下排两张小图
  const span = await post('/api/plot/render', {
    spec: Object.assign({}, base, {
      grid: true,
      grid_shape: [2, 2],
      panels: [
        { area: [0, 0, 1, 2], kind: 'line', series: [S1, S2], fit, panel_label: '(a)',
          xlabel: XL, ylabel: Y1, legend: true, grid: true },
        { area: [1, 0, 1, 1], kind: 'line_marker', series: [S1], panel_label: '(b)',
          xlabel: XL, ylabel: Y1, legend: true, grid: true },
        { area: [1, 1, 1, 1], kind: 'scatter', series: [S2], panel_label: '(c)',
          xlabel: XL, ylabel: Y2, legend: true, grid: true },
      ],
    }),
  });
  console.log('① 跨两列：panels_geo =', span.panels_geo.length, '条, dropped =', span.panels_dropped);
  span.panels_geo.forEach((g) => {
    console.log('   ', g.label, 'area=', JSON.stringify(g.area),
      'rect=', g.rect.map((v) => v.toFixed(3)).join(', '),
      '宽/高=', (g.rect[2] * 100).toFixed(1) + '% / ' + (g.rect[3] * 100).toFixed(1) + '%');
  });
  fs.writeFileSync('output/ui2/20_跨格核对_上大下两小.png', Buffer.from(span.png_b64, 'base64'));

  // ② 冲突裁决：两个面板抢同一格 → 第二个必须被挪走或被丢弃，不能抛错
  const conflict = await post('/api/plot/render', {
    spec: Object.assign({}, base, {
      grid: true, grid_shape: [2, 2],
      panels: [
        { area: [0, 0, 1, 2], kind: 'line', series: [S1], panel_label: '(a)', legend: true, grid: true },
        { area: [0, 0, 1, 2], kind: 'line', series: [S2], panel_label: '(b)', legend: true, grid: true },
        { area: [1, 0, 1, 1], kind: 'line', series: [S1], panel_label: '(c)', legend: true, grid: true },
        { area: [1, 1, 1, 1], kind: 'line', series: [S2], panel_label: '(d)', legend: true, grid: true },
      ],
    }),
  });
  console.log('② 冲突：geo =', conflict.panels_geo.length, '条, dropped =', conflict.panels_dropped,
    '→', conflict.panels_geo.map((g) => g.label + JSON.stringify(g.area)).join(' '));

  // ③ 越界 area：rows=2 却要 row=1,rowSpan=2 → 收敛
  const bad = await post('/api/plot/render', {
    spec: Object.assign({}, base, {
      grid: true, grid_shape: [2, 2],
      panels: [
        { area: [1, 0, 2, 1], kind: 'line', series: [S1], panel_label: '(a)', legend: true, grid: true },
        { area: [9, 9, 3, 3], kind: 'line', series: [S2], panel_label: '(b)', legend: true, grid: true },
      ],
    }),
  });
  console.log('③ 越界：', bad.panels_geo.map((g) => g.label + JSON.stringify(g.area)).join(' '),
    'dropped =', bad.panels_dropped);

  // ④ 单图回归：不发 panels
  const single = await post('/api/plot/render', {
    spec: Object.assign({}, base, { kind: 'line', series: [S1, S2], xlabel: XL, ylabel: Y1 }),
  });
  console.log('④ 单图 panels_geo =', JSON.stringify(single.panels_geo));
})().catch((e) => { console.error('失败：', e.message); process.exit(1); });
