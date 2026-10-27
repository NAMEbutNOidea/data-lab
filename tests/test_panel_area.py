# -*- coding: utf-8 -*-
"""多子图占位（area 跨格）测试：纯函数调用，不需要启动 HTTP 服务。

覆盖：合法 area 占位、重叠 area 裁决、越界收敛、跨列 (a) 的几何宽度、
网格塞满时的 dropped 计数、panels_geo 与 panels_dropped 的响应字段。

独立运行：``python tests/test_panel_area.py``
"""

from __future__ import annotations

import os
import sys

os.environ.setdefault("MKL_THREADING_LAYER", "SEQUENTIAL")
os.environ.setdefault("KMP_DUPLICATE_LIB_OK", "TRUE")

import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
for _p in (str(ROOT), str(ROOT / "tests")):
    if _p not in sys.path:
        sys.path.insert(0, _p)

import server  # noqa: E402
import core.plot_engine as plot_engine  # noqa: E402

EPS = 1e-9


def _panel(area=None, kind="line", title="面板"):
    """一个最小的合法面板；area=None 表示老前端（不带占位）。"""
    p = {
        "kind": kind,
        "title": title,
        "xlabel": "x",
        "ylabel": "y",
        "series": [{"name": title, "x": [0.0, 1.0, 2.0, 3.0],
                    "y": [1.0, 2.0, 1.5, 3.0]}],
    }
    if area is not None:
        p["area"] = area
    return p


def _spec(panels, shape):
    return {"kind": "line", "theme": "paper_nature", "palette": "npg",
            "grid_shape": list(shape), "figsize": [6.4, 4.8],
            "panels": panels}


def _sanitize(panels, shape):
    return server._sanitize_spec(_spec(panels, shape))


def _render(clean, dpi=80):
    """跑一次真实渲染，返回 (png 字节, panels_geo, panels_dropped)。"""
    data, meta = plot_engine.render_bytes_meta(clean, "png", dpi)
    return data, meta["panels_geo"], meta["panels_dropped"]


def _overlap(a, b) -> bool:
    """两个 rect=[x0,y0,w0,h0] 是否有面积重叠（贴边不算）。"""
    ax, ay, aw, ah = a
    bx, by, bw, bh = b
    return (ax < bx + bw - EPS and bx < ax + aw - EPS
            and ay < by + bh - EPS and by < ay + ah - EPS)


class TestPanelArea(unittest.TestCase):
    """占位裁决（server）与 GridSpec 几何（引擎）的联合校验。"""

    # ---------------- 合法 area ----------------
    def test_valid_area_renders_with_geo(self):
        """2×2 里 (a) 跨两列 + 两个 1×1：3 条 geo，rect 均大于 0 且互不重叠。"""
        clean = _sanitize([
            _panel([0, 0, 1, 2], "line", "A"),
            _panel([1, 0, 1, 1], "scatter", "B"),
            _panel([1, 1, 1, 1], "bar", "C"),
        ], [2, 2])

        self.assertEqual(len(clean["panels"]), 3, "三个面板都应保留")
        self.assertEqual(clean["panels_dropped"], 0)
        self.assertEqual([p["area"] for p in clean["panels"]],
                         [[0, 0, 1, 2], [1, 0, 1, 1], [1, 1, 1, 1]],
                         "合法 area 应原样保留")

        data, geo, dropped = _render(clean)
        self.assertTrue(data.startswith(b"\x89PNG"), "应返回合法 PNG")
        self.assertEqual(dropped, 0)
        self.assertEqual(len(geo), len(clean["panels"]),
                         "panels_geo 数量应等于面板数")

        for item in geo:
            # font_size 是后加的（按格子物理尺寸自动缩字号用），契约里允许存在
            self.assertEqual(sorted(item),
                             ["area", "font_size", "index", "label", "rect"],
                             "geo 字段应为 index/area/label/rect/font_size，实际 %r"
                             % (sorted(item),))
            self.assertGreater(item["font_size"], 0.0, "字号必须为正")
            self.assertEqual(len(item["rect"]), 4)
            x0, y0, w0, h0 = item["rect"]
            self.assertGreater(w0, 0.0, "rect 宽度必须大于 0：%r" % (item["rect"],))
            self.assertGreater(h0, 0.0, "rect 高度必须大于 0：%r" % (item["rect"],))
            for v in item["rect"]:
                self.assertGreaterEqual(v, 0.0, "rect 分量应在 0~1：%r" % (item["rect"],))
                self.assertLessEqual(v, 1.0, "rect 分量应在 0~1：%r" % (item["rect"],))
            self.assertEqual(item["label"], "(%s)" % "abc"[item["index"]],
                             "标签应按数组下标给 (a)(b)(c)")

        for i in range(len(geo)):
            for j in range(i + 1, len(geo)):
                self.assertFalse(_overlap(geo[i]["rect"], geo[j]["rect"]),
                                 "第 %d、%d 个面板的 rect 重叠：%r / %r"
                                 % (i, j, geo[i]["rect"], geo[j]["rect"]))

    # ---------------- 重叠 area ----------------
    def test_overlap_area_relocated_or_dropped(self):
        """两个面板都声明 [0,0,1,2]：第二个被挪走或丢弃，不抛异常、不覆盖。"""
        clean = _sanitize([
            _panel([0, 0, 1, 2], "line", "A"),
            _panel([0, 0, 1, 2], "line", "B"),
        ], [2, 2])

        kept = clean["panels"]
        dropped = clean["panels_dropped"]
        self.assertEqual(len(kept) + dropped, 2, "面板只能被保留或被丢弃")
        self.assertEqual(kept[0]["area"], [0, 0, 1, 2], "第一个面板的 area 不应被抢")
        self.assertTrue(kept[0]["area"] == [0, 0, 1, 2])

        occupied = set()
        for p in kept:
            r, c, rs, cs = p["area"]
            cells = {(rr, cc) for rr in range(r, r + rs) for cc in range(c, c + cs)}
            self.assertFalse(cells & occupied,
                             "保留的面板占位仍重叠：%r" % ([q["area"] for q in kept],))
            occupied |= cells

        data, geo, _n = _render(clean)
        self.assertTrue(data.startswith(b"\x89PNG"), "冲突场景也必须出图")
        self.assertEqual(len(geo), len(kept))

    def test_overlap_relocation_keeps_span(self):
        """2×2 里第二个跨两列的面板被挪到下一行，span 保持不变。"""
        clean = _sanitize([
            _panel([0, 0, 1, 2], "line", "A"),
            _panel([0, 0, 1, 2], "line", "B"),
        ], [2, 2])
        self.assertEqual(clean["panels_dropped"], 0, "2×2 还有空位，不该丢面板")
        self.assertEqual(clean["panels"][1]["area"], [1, 0, 1, 2],
                         "原 span 能放下时应保持 1×2，实际 %r"
                         % (clean["panels"][1]["area"],))

    def test_overlap_span_not_fit_falls_back_to_1x1(self):
        """整行空位都没有时，退成 1×1 塞进剩下的空格。"""
        clean = _sanitize([
            _panel([0, 0, 1, 1], "line", "A"),      # 占 (0,0)
            _panel([1, 1, 1, 1], "line", "B"),      # 占 (1,1)
            _panel([0, 0, 1, 2], "line", "C"),      # 想跨两列但整行都没空
        ], [2, 2])
        self.assertEqual(len(clean["panels"]), 3)
        self.assertEqual(clean["panels_dropped"], 0)
        self.assertEqual(clean["panels"][2]["area"], [0, 1, 1, 1],
                         "1×2 放不下时应退成 1×1，实际 %r"
                         % (clean["panels"][2]["area"],))

    # ---------------- 越界收敛 ----------------
    def test_area_out_of_grid_clamped(self):
        """rows=2 却给 row=1,rowSpan=2：收敛成 [0,0,2,1]（不越界）。"""
        clean = _sanitize([_panel([1, 0, 2, 1], "line", "A")], [2, 2])
        self.assertEqual(clean["panels"][0]["area"], [0, 0, 2, 1],
                         "越界 area 应收敛到网格内，实际 %r"
                         % (clean["panels"][0]["area"],))
        self.assertEqual(clean["panels_dropped"], 0)

    def test_area_negative_and_oversized_clamped(self):
        """负坐标 + 超大 span：坐标归零、span 截到网格尺寸。"""
        clean = _sanitize([_panel([-3, -2, 99, 99], "line", "A")], [2, 3])
        self.assertEqual(clean["panels"][0]["area"], [0, 0, 2, 3],
                         "负坐标/超大 span 应收敛，实际 %r"
                         % (clean["panels"][0]["area"],))

    def test_area_structurally_invalid_becomes_auto(self):
        """结构非法（只有 3 个数 / 含布尔）按缺省 area 自动放 1×1。"""
        for bad in ([0, 0, 1], [0, 0, True, 1], "0,0,1,1", None):
            p = _panel(kind="line", title="A")
            p["area"] = bad
            clean = _sanitize([p], [2, 2])
            self.assertEqual(clean["panels"][0]["area"], [0, 0, 1, 1],
                             "非法 area %r 应退回自动 1×1，实际 %r"
                             % (bad, clean["panels"][0]["area"]))

    # ---------------- 跨列几何 ----------------
    def test_span_two_cols_is_wider(self):
        """跨两列的 rect 宽明显大于同图 1×1 面板的宽（约 2 倍）。"""
        clean = _sanitize([
            _panel([0, 0, 1, 2], "line", "宽"),
            _panel([1, 0, 1, 1], "line", "窄"),
        ], [2, 2])
        _data, geo, _n = _render(clean)
        self.assertEqual(len(geo), 2)
        wide = geo[0]["rect"][2]
        narrow = geo[1]["rect"][2]
        self.assertGreater(wide, narrow * 1.5,
                           "跨列面板应明显更宽（宽 %r vs 窄 %r）" % (wide, narrow))

    # ---------------- dropped ----------------
    def test_dropped_count_when_grid_full(self):
        """2×2 已被 2×2 大图占满：后续 3 个无 area 面板全部丢弃。"""
        clean = _sanitize([
            _panel([0, 0, 2, 2], "line", "大图"),
            _panel(None, "line", "B"),
            _panel(None, "line", "C"),
            _panel(None, "line", "D"),
        ], [2, 2])
        self.assertEqual(len(clean["panels"]), 1, "只剩大图能放下")
        self.assertEqual(clean["panels_dropped"], 3,
                         "dropped 应为 3，实际 %r" % (clean["panels_dropped"],))

        data, geo, dropped = _render(clean)
        self.assertTrue(data.startswith(b"\x89PNG"))
        self.assertEqual(dropped, 3)
        self.assertEqual(len(geo), 1)

    def test_grid_expands_for_extra_panels(self):
        """1×1 网格塞两个无 area 面板：沿用老行为自动扩成 2×1，不丢面板。"""
        clean = _sanitize([
            _panel([0, 0, 1, 1], "line", "A"),
            _panel(None, "line", "B"),
        ], [1, 1])
        self.assertEqual(clean["panels_dropped"], 0,
                         "网格应自动扩容，不该丢面板")
        self.assertEqual(len(clean["panels"]), 2)
        self.assertGreaterEqual(clean["grid"][0] * clean["grid"][1], 2,
                                "扩容后的网格装得下两个面板，实际 %r"
                                % (clean["grid"],))

    # ---------------- 向后兼容 ----------------
    def test_backward_compat_no_area_fills_in_order(self):
        """老前端不发 area：按数组顺序从左到右、从上到下铺满。"""
        clean = _sanitize([_panel(None, "line", "A"),
                           _panel(None, "line", "B"),
                           _panel(None, "line", "C")], [1, 3])
        self.assertEqual([p["area"] for p in clean["panels"]],
                         [[0, 0, 1, 1], [0, 1, 1, 1], [0, 2, 1, 1]],
                         "无 area 时应按阅读顺序铺满，实际 %r"
                         % ([p["area"] for p in clean["panels"]],))
        self.assertEqual(clean["panels_dropped"], 0)

        data, geo, _n = _render(clean)
        self.assertTrue(data.startswith(b"\x89PNG"))
        self.assertEqual(len(geo), 3)
        self.assertEqual([g["area"] for g in geo],
                         [[0, 0, 1, 1], [0, 1, 1, 1], [0, 2, 1, 1]])

    def test_backward_compat_two_panel_1x2(self):
        """老用例 grid_shape=[1,2] 两块并排：左右顺序、高度一致。"""
        clean = _sanitize([_panel(None, "line", "A"),
                           _panel(None, "scatter", "B")], [1, 2])
        self.assertEqual(clean["grid"], [1, 2])
        _data, geo, _n = _render(clean)
        self.assertEqual(len(geo), 2)
        left, right = geo[0]["rect"], geo[1]["rect"]
        self.assertLess(left[0], right[0], "第一个面板应在左")
        self.assertAlmostEqual(left[1], right[1], places=6, msg="同一行应同底")
        self.assertAlmostEqual(left[3], right[3], places=6, msg="同一行应等高")

    def test_single_figure_geo_is_empty(self):
        """单图（无 panels）panels_geo 为 []，panels_dropped 为 0。"""
        clean = server._sanitize_spec({
            "kind": "line",
            "series": [{"name": "s", "x": [0.0, 1.0, 2.0], "y": [1.0, 2.0, 3.0]}],
        })
        _data, geo, dropped = _render(clean)
        self.assertEqual(geo, [], "单图不应返回 panels_geo")
        self.assertEqual(dropped, 0)

    # ---------------- 接口返回体 ----------------
    def test_act_render_response_has_geo(self):
        """/api/plot/render 的返回体带 panels_geo 与 panels_dropped。"""
        spec = _spec([
            _panel([0, 0, 1, 2], "line", "A"),
            _panel([1, 0, 1, 1], "line", "B"),
            _panel([1, 1, 1, 1], "line", "C"),
        ], [2, 2])
        spec["with_svg"] = False
        out = server.act_render({"spec": spec})
        self.assertTrue(out.get("png_b64"), "应返回图片")
        self.assertIn("panels_geo", out, "返回体缺 panels_geo")
        self.assertIn("panels_dropped", out, "返回体缺 panels_dropped")
        self.assertEqual(len(out["panels_geo"]), 3)
        self.assertEqual(out["panels_dropped"], 0)
        self.assertEqual(out["spec"]["panels"], 3)

    def test_act_export_fig_response_has_geo(self):
        """/api/plot/export 的返回体同样带 panels_geo 与 panels_dropped。"""
        spec = _spec([
            _panel([0, 0, 1, 2], "line", "A"),
            _panel([1, 0, 1, 1], "line", "B"),
        ], [2, 2])
        out = server.act_export_fig({"spec": spec, "fmt": "png", "dpi": 72})
        self.assertIn("panels_geo", out, "导出返回体缺 panels_geo")
        self.assertIn("panels_dropped", out, "导出返回体缺 panels_dropped")
        self.assertEqual(len(out["panels_geo"]), 2)
        self.assertEqual(out["panels_dropped"], 0)
        for item in out["panels_geo"]:
            self.assertGreater(item["rect"][2], 0.0)
            self.assertGreater(item["rect"][3], 0.0)


class TestPanelFontScale(unittest.TestCase):
    """多子图按格子物理尺寸自动缩字号。

    背景：font_size 是全局的，11pt 塞进 4×4 的 1.6in×1.05in 小格子里，
    轴标题/刻度/角标会叠成一团。缩得对不对直接决定这张图能不能用。
    """

    @staticmethod
    def _grid(rows, cols, figsize):
        panels = [_panel([r, c, 1, 1], "line", "p%d%d" % (r, c))
                  for r in range(rows) for c in range(cols)]
        spec = _spec(panels, [rows, cols])
        spec["figsize"] = list(figsize)
        spec["font_size"] = 11
        return server._sanitize_spec(spec)

    def test_scale_helper_monotonic(self):
        """格子越小系数越小，且不超过 1、不低于下限。"""
        self.assertEqual(plot_engine._panel_font_scale(6.4, 4.2), 1.0,
                         "单图不该缩")
        self.assertEqual(plot_engine._panel_font_scale(3.2, 2.1), 1.0,
                         "2×2 的 3.2×2.1 in 格子仍算宽裕，行为应与以前一致")
        mid = plot_engine._panel_font_scale(1.6, 4.2)
        tiny = plot_engine._panel_font_scale(1.6, 1.05)
        self.assertLess(mid, 1.0)
        self.assertLess(tiny, mid, "格子更小，系数必须更小")
        self.assertGreaterEqual(tiny, plot_engine._PANEL_FONT_FLOOR)

    def test_4x4_shrinks_font_only_when_grow_off(self):
        """「图幅钉死」(canvas_grow=False) 时 4×4 才缩字号。

        默认 canvas_grow=True 会先把画布按行列数放大，每格回到用户设定的
        6.4×4.2in，字号应当原样保留——否则就会出现"子图越多字越小"。
        """
        spec = self._grid(4, 4, (6.4, 4.2))
        spec["canvas_grow"] = False
        _data, geo, dropped = _render(spec)
        self.assertEqual(dropped, 0)
        self.assertEqual(len(geo), 16)
        for item in geo:
            self.assertLess(item["font_size"], 8.0,
                            "图幅不扩容时 4×4 必须缩字号，实际 %.2f" % item["font_size"])
            self.assertGreaterEqual(item["font_size"], 4.2,
                                    "字号有下限，不能缩成蚂蚁字")

    def test_canvas_grows_with_grid(self):
        """canvas_grow=True：画布按网格放大，每格保持设定的图幅，字号不变。"""
        spec = self._grid(4, 4, (6.4, 4.2))
        spec["canvas_grow"] = True
        _data, geo, dropped = _render(spec)
        self.assertEqual(dropped, 0)
        self.assertEqual(spec["canvas_grow"], True)
        # 整幅被放大到 25.6×16.8in，每格仍是 6.4×4.2in，所以字号保持 11pt
        w, h, grew = plot_engine._canvas_inches(spec, 6.4, 4.2, 4, 4)
        self.assertTrue(grew)
        self.assertAlmostEqual(w, 25.6, places=3)
        self.assertAlmostEqual(h, 16.8, places=3)
        for item in geo:
            self.assertAlmostEqual(item["font_size"], 11.0, places=2,
                                   msg="画布已扩容，字号不该被缩")

    def test_figsize_and_dpi_reported_in_meta(self):
        """meta 要回传实际生效的图幅与 dpi（可能被像素上限压过）。"""
        spec = self._grid(2, 2, (6.4, 4.2))
        _data, meta = plot_engine.render_bytes_meta(spec, "png", 1200)
        self.assertIn("figsize_used", meta)
        self.assertIn("dpi_used", meta)
        self.assertIn("canvas_grown", meta)
        self.assertTrue(meta["canvas_grown"])
        self.assertAlmostEqual(meta["figsize_used"][0], 12.8, places=2)

    def test_2x2_keeps_font(self):
        """2×2 + 默认图幅：字号保持 11pt，与改造前一致（不破坏既有观感）。"""
        spec = self._grid(2, 2, (6.4, 4.2))
        _data, geo, _dropped = _render(spec)
        for item in geo:
            self.assertAlmostEqual(item["font_size"], 11.0, places=2,
                                   msg="2×2 不该缩字号")

    def test_bigger_figure_restores_font(self):
        """把图幅放大到 10×7in 后，4×4 的字号应回到接近全局值。"""
        spec = self._grid(4, 4, (10.0, 7.0))
        _data, geo, _dropped = _render(spec)
        self.assertGreater(geo[0]["font_size"], 9.0,
                           "图幅够大就不该再缩，实际 %.2f" % geo[0]["font_size"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
