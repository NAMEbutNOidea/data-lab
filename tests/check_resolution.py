#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""分辨率回归：子图变多时，每格的清晰度不能变。

三条硬性要求（对应两个用户反馈）：
1. 多子图时画布按网格放大，每一格的物理英寸不变 → 每格像素不变 → 不再糊
2. 字号保持用户设定值，不随子图数量缩小
3. 图幅×dpi 超过浏览器解码上限时自动降 dpi，而不是产出一张打不开的白图
"""
import base64
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import server  # noqa: E402
import core.plot_engine as pe  # noqa: E402


def _series(n=40, seed=0):
    return [{"x": list(range(n)),
             "y": [((i + seed) % 9) + i * 0.2 for i in range(n)],
             "name": "s%d" % seed}]


def make_spec(rows, cols, figsize=(6.4, 4.2), dpi=300, grow=True):
    """注意：真实前端发的是 grid_shape（grid 键另有"画不画网格线"的布尔含义）。"""
    n = rows * cols
    return {
        "kind": "line",
        "theme": "paper_nature",
        "palette": "npg",
        "figsize": [figsize[0], figsize[1]],
        "dpi": dpi,
        "canvas_grow": grow,
        "grid_shape": [rows, cols],
        "panels": [{"series": _series(40, i)} for i in range(n)],
    }


def px_per_panel(figsize_used, dpi_used, cols, rows):
    """每格大约能分到多少像素（宽）。"""
    return (float(figsize_used[0]) / cols) * dpi_used


def main():
    fails = []

    def check(cond, msg):
        print(("  [OK]   " if cond else "  [FAIL] ") + msg)
        if not cond:
            fails.append(msg)

    # ---------------------------------------------------------------- 1
    print("1) 子图变多时，每格像素应基本不变")
    base_px = None
    for n in (1, 2, 3, 4):
        spec = make_spec(n, n, grow=True)
        data, meta = pe.render_bytes_meta(
            server._sanitize_spec(spec), "png", 300)
        geos = meta["panels_geo"]
        per = px_per_panel(meta["figsize_used"], meta["dpi_used"], n, n)
        expect_w, expect_h = 6.4 * n, 4.2 * n
        ok_size = (abs(meta["figsize_used"][0] - expect_w) < 0.05
                   and abs(meta["figsize_used"][1] - expect_h) < 0.05)
        check(ok_size, "%d×%d：画布 %.1f×%.1f in（期望 %.1f×%.1f）"
              % (n, n, meta["figsize_used"][0], meta["figsize_used"][1],
                 expect_w, expect_h))
        if base_px is None:
            base_px = per
        ok = per >= base_px * 0.85
        check(ok, "%d×%d：每格 %.0f px（基准 %.0f px，不再随子图数下降）"
              % (n, n, per, base_px))
        # 1 个面板 + 1×1 网格等价于单图，走单轴路径，panels_geo 约定为空列表
        check(len(geos) == (0 if n == 1 else n * n),
              "%d×%d：面板占位 %d 个" % (n, n, len(geos)))

    # ---------------------------------------------------------------- 2
    print("2) 字号保持设定值（canvas_grow 默认开）")
    for n in (2, 4):
        spec = make_spec(n, n, grow=True)
        _d, meta = pe.render_bytes_meta(server._sanitize_spec(spec), "png", 150)
        sizes = {round(g.get("font_size", 0), 2) for g in meta["panels_geo"]}
        check(all(s >= 10.9 for s in sizes),
              "%d×%d：字号 %s（应为 11.0，不缩）" % (n, n, sorted(sizes)))

    print("3) 关掉 canvas_grow 时才有资格缩字号（期刊限宽场景）")
    spec = make_spec(4, 4, grow=False)
    _d, meta = pe.render_bytes_meta(server._sanitize_spec(spec), "png", 150)
    sizes = [round(g.get("font_size", 0), 2) for g in meta["panels_geo"]]
    check(max(sizes) < 8.0, "图幅钉死时字号被压到 %.2f（< 8.0）" % max(sizes))
    check(min(sizes) >= 4.2, "仍有下限 %.2f（≥ 4.2）" % min(sizes))

    # ---------------------------------------------------------------- 4
    print("4) 超大图：20×20 in @1200 dpi（原来会产出浏览器打不开的白图）")
    t0 = time.time()
    res = server.act_render({"spec": make_spec(1, 1, figsize=(20, 20), dpi=1200)})
    ms = (time.time() - t0) * 1000
    png = base64.b64decode(res["png_b64"])
    w_used, h_used = res["figsize_used"]
    total_px = (w_used * res["dpi_used"]) * (h_used * res["dpi_used"])
    check(len(png) > 1024, "PNG 有内容：%.0f KB" % (len(png) / 1024))
    check(total_px <= 2.6e8, "总像素 %.1f MP ≤ 260 MP（浏览器上限 268 MP）"
          % (total_px / 1e6))
    check(max(w_used, h_used) * res["dpi_used"] <= 16384,
          "单边 %.0f px ≤ 16384" % (max(w_used, h_used) * res["dpi_used"]))
    check(res["dpi_capped"] and res["dpi_used"] < 1200,
          "dpi 已收敛：%d → %d" % (res.get("export_dpi", 1200), res["dpi_used"]))
    check(ms < 6000, "预览耗时 %.0f ms（原来 12144 ms）" % ms)

    # ---------------------------------------------------------------- 5
    print("5) 矢量格式不应被 dpi 上限干扰")
    spec = server._sanitize_spec(make_spec(1, 1, figsize=(20, 20), dpi=1200))
    svg = pe.render_bytes(spec, "svg", 1200)
    check(len(svg) > 2000 and not res["dpi_capped"] is None,
          "SVG 正常产出：%.0f KB" % (len(svg) / 1024))

    print()
    if fails:
        print("FAILED: %d 项" % len(fails))
        for m in fails:
            print("  - " + m)
        return 1
    print("全部通过")
    return 0


if __name__ == "__main__":
    sys.exit(main())
