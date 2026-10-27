# -*- coding: utf-8 -*-
"""双纵轴与三维图测试：纯函数/真实渲染，不需要启动 HTTP 服务。

覆盖：
    * 双轴（次要 Y 轴）在支持图型上生效、在不支持图型上静默忽略；
    * 左右序列配色不撞车、图例合并成一个、右轴按 y2label/y2scale 收敛；
    * 4 个三维图型的单图与多面板渲染；
    * 三维脏数据（z 长度不等、z 全空、values 不是矩阵）给中文 ValueError；
    * 服务端对 axis / z / y2scale / zlabel 的类型收敛。

独立运行：``python tests/test_twin3d.py``
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

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

import server  # noqa: E402
import core.plot_engine as plot_engine  # noqa: E402

THEME = plot_engine.THEMES["paper_nature"]
PALETTE = plot_engine.PALETTES["npg"]
DPI = 72


def _twin_spec(kind="line", n=6):
    """一左一右两条序列；缺省 kind 为折线（契约里的双轴支持图型）。"""
    xs = [float(i) for i in range(n)]
    return {
        "kind": kind,
        "theme": "paper_nature",
        "palette": "npg",
        "xlabel": "x",
        "ylabel": "左轴",
        "y2label": "右轴",
        "figsize": [6.4, 4.2],
        "series": [
            {"name": "左序列", "x": xs, "y": [1.0 + 0.2 * i for i in range(n)],
             "axis": "left"},
            {"name": "右序列", "x": xs, "y": [100.0 + 5.0 * i for i in range(n)],
             "axis": "right"},
        ],
    }


def _xyz_spec(kind="scatter3d", n=8):
    """X/Y/Z 三列等长的三维序列。"""
    xs = [float(i) for i in range(n)]
    return {
        "kind": kind,
        "theme": "paper_nature",
        "palette": "npg",
        "xlabel": "X",
        "ylabel": "Y",
        "zlabel": "Z",
        "figsize": [6.4, 4.2],
        "series": [{"name": "轨迹", "x": xs,
                    "y": [float((i - 3) ** 2) for i in range(n)],
                    "z": [float(i % 4) for i in range(n)]}],
    }


def _matrix_spec(kind="surface3d"):
    """3×4 的矩阵数据，带行列标签。"""
    return {
        "kind": kind,
        "theme": "paper_nature",
        "palette": "npg",
        "xlabel": "X",
        "ylabel": "Y",
        "zlabel": "高度",
        "figsize": [6.4, 4.2],
        "matrix": {
            "values": [[1.0, 2.0, 3.0, 4.0],
                       [2.0, 3.0, 4.0, 5.0],
                       [3.0, 4.0, 5.0, 6.0]],
            "xlabels": ["c1", "c2", "c3", "c4"],
            "ylabels": ["r1", "r2", "r3"],
        },
    }


def _render(spec, dpi=DPI):
    """跑一次真实渲染，返回 (png 字节, meta)。"""
    return plot_engine.render_bytes_meta(spec, "png", dpi)


def _draw(spec, figure=None):
    """直接调内部绘制路径，返回 (ax, ax2)，方便断言轴与颜色。"""
    fig = figure or plt.figure(figsize=(6.4, 4.2), dpi=DPI)
    ax = fig.add_subplot(1, 1, 1)
    ax2 = plot_engine._draw_with_twin(ax, spec, THEME, PALETTE)
    return ax, ax2


class TestTwinAxis(unittest.TestCase):
    """双纵轴的创建条件、配色与图例合并。"""

    def test_twin_renders_two_axes(self):
        """line + axis=right：渲染出图，且引擎内部真的建了第二个轴。"""
        spec = _twin_spec()
        data, meta = _render(spec)
        self.assertTrue(data.startswith(b"\x89PNG"), "双轴图必须出 PNG")
        self.assertEqual(meta["panels_geo"], [], "单图不带 panels_geo")

        fig = plt.figure(figsize=(6.4, 4.2), dpi=DPI)
        try:
            _ax, ax2 = _draw(spec, fig)
            self.assertIsNotNone(ax2, "有右轴序列时应建立次要 Y 轴")
            self.assertEqual(len(fig.axes), 2,
                             "双轴图中 Figure 应含 2 个 Axes，实际 %d" % len(fig.axes))
        finally:
            plt.close(fig)

    def test_left_right_colors_differ(self):
        """左右两条序列的最终颜色必须不同（调色板整体旋转 nLeft 位）。"""
        fig = plt.figure(figsize=(6.4, 4.2), dpi=DPI)
        try:
            ax, ax2 = _draw(_twin_spec(), fig)
            left_color = ax.lines[0].get_color()
            right_color = ax2.lines[0].get_color()
            self.assertNotEqual(left_color, right_color,
                                "左右序列撞色了：%r / %r" % (left_color, right_color))
            self.assertEqual(right_color, PALETTE[1],
                             "右侧第 1 条应拿到旋转后的 palette[1]：%r" % (right_color,))
        finally:
            plt.close(fig)

    def test_y2_color_and_label_applied(self):
        """y2_color 生效于右轴脊柱/刻度，y2label 成为右轴标签。"""
        spec = _twin_spec()
        spec["y2_color"] = "#123456"
        fig = plt.figure(figsize=(6.4, 4.2), dpi=DPI)
        try:
            _ax, ax2 = _draw(spec, fig)
            self.assertEqual(ax2.get_ylabel(), "右轴", "右轴标签应取 y2label")
            spine = ax2.spines["right"]
            self.assertEqual(tuple(spine.get_edgecolor())[:3],
                             tuple(matplotlib.colors.to_rgb("#123456")),
                             "右轴脊柱应使用 y2_color：%r" % (spine.get_edgecolor(),))
        finally:
            plt.close(fig)

    def test_single_legend_on_left_axis(self):
        """左右序列的图例合并画在左轴，右轴自己不带图例框。"""
        fig = plt.figure(figsize=(6.4, 4.2), dpi=DPI)
        try:
            ax, ax2 = _draw(_twin_spec(), fig)
            self.assertIsNotNone(ax.get_legend(), "左轴应有合并后的图例")
            self.assertIsNone(ax2.get_legend(), "右轴不应单独出图例框")
            labels = [t.get_text() for t in ax.get_legend().get_texts()]
            self.assertEqual(sorted(labels), sorted(["左序列", "右序列"]),
                             "图例条目应为左右两条：%r" % (labels,))
        finally:
            plt.close(fig)

    def test_twin_without_right_series(self):
        """没有 axis=right 的序列时不得偷偷建右轴。"""
        spec = _twin_spec()
        spec["series"][1]["axis"] = "left"
        fig = plt.figure(figsize=(6.4, 4.2), dpi=DPI)
        try:
            _ax, ax2 = _draw(spec, fig)
            self.assertIsNone(ax2, "全是左轴序列时不建双轴")
            self.assertEqual(len(fig.axes), 1)
        finally:
            plt.close(fig)


class TestTwinIgnored(unittest.TestCase):
    """不支持双轴的图型必须静默忽略 axis，全画左轴。"""

    def test_hist_pie_heatmap_ignore_axis(self):
        """hist / pie / heatmap 传 axis=right 不报错，仍返回正常 PNG。"""
        cases = [
            ("hist", {"kind": "hist",
                      "series": [{"name": "a", "x": [1.0, 2.0, 3.0, 3.5],
                                  "y": [1.0, 2.0, 3.0, 3.5], "axis": "right"}]}),
            ("pie", {"kind": "pie",
                     "series": [{"name": "a", "x": ["甲", "乙"],
                                 "y": [3.0, 5.0], "axis": "right"}]}),
            ("heatmap", {"kind": "heatmap",
                         "matrix": {"values": [[1.0, 2.0], [3.0, 4.0]]},
                         "series": [{"name": "a", "y": [[1.0, 2.0], [3.0, 4.0]],
                                     "axis": "right"}]}),
        ]
        for name, spec in cases:
            spec.setdefault("theme", "paper_nature")
            spec.setdefault("palette", "npg")
            spec.setdefault("figsize", [5.6, 4.2])
            data, _meta = _render(spec)
            self.assertTrue(data.startswith(b"\x89PNG"),
                            "%s 忽略 axis 后仍应出图" % name)

    def test_box_qq_3d_ignore_axis(self):
        """box / qq / 三维图同样忽略 axis（三维还不得因 axis 崩掉）。"""
        box = {"kind": "box", "theme": "paper_nature", "figsize": [5.6, 4.2],
               "series": [{"name": "a", "y": [1.0, 2.0, 3.0, 4.0], "axis": "right"}]}
        qq = {"kind": "qq", "theme": "paper_nature", "figsize": [5.6, 4.2],
              "series": [{"name": "a", "y": [1.0, 2.0, 3.0, 4.0, 5.0, 6.0],
                          "axis": "right"}]}
        three = _xyz_spec("scatter3d")
        three["series"][0]["axis"] = "right"
        for name, spec in (("box", box), ("qq", qq), ("scatter3d", three)):
            data, _meta = _render(spec)
            self.assertTrue(data.startswith(b"\x89PNG"),
                            "%s 忽略 axis 后仍应出图" % name)


class TestThreeDKinds(unittest.TestCase):
    """4 个三维图型的单图与多面板渲染。"""

    def test_single_figure_each_kind(self):
        """单图分支：4 个三维图型各自渲染出 PNG。"""
        for kind in ("scatter3d", "line3d", "surface3d", "bar3d"):
            spec = (_matrix_spec(kind) if kind in ("surface3d", "bar3d")
                    else _xyz_spec(kind))
            data, meta = _render(spec)
            self.assertTrue(data.startswith(b"\x89PNG"),
                            "%s 单图应渲染成功" % kind)
            self.assertEqual(meta["panels_geo"], [], "单图不带 panels_geo")

    def test_panel_figure_with_3d_panel(self):
        """2×2 里放一个三维面板：面板数量与 geo 数量都不变（一个面板一个矩形）。"""
        panels = [
            {"kind": "line", "title": "二维面板", "xlabel": "x", "ylabel": "y",
             "series": [{"name": "a", "x": [0.0, 1.0, 2.0], "y": [1.0, 2.0, 3.0]}]},
            _xyz_spec("scatter3d"),
            _matrix_spec("surface3d"),
            _matrix_spec("bar3d"),
        ]
        spec = {"kind": "line", "theme": "paper_nature", "palette": "npg",
                "grid": [2, 2], "figsize": [6.4, 4.2], "panels": panels}
        data, meta = _render(spec)
        self.assertTrue(data.startswith(b"\x89PNG"), "含三维面板的多子图应出图")
        self.assertEqual(len(meta["panels_geo"]), 4,
                         "四个面板应有四条 geo，实际 %d" % len(meta["panels_geo"]))
        for item in meta["panels_geo"]:
            self.assertEqual(len(item["rect"]), 4)
            self.assertGreater(item["rect"][2], 0.0, "geo 宽度必须大于 0")
            self.assertGreater(item["rect"][3], 0.0, "geo 高度必须大于 0")

    def test_panel_3d_axis_is_3d(self):
        """多面板分支必须先解析 kind 再建轴，否则三维面板会退化成二维。"""
        spec = {"kind": "line", "theme": "paper_nature", "grid": [1, 2],
                "figsize": [6.4, 4.2],
                "panels": [
                    {"kind": "line", "series": [{"name": "a", "x": [0.0, 1.0],
                                                 "y": [1.0, 2.0]}]},
                    _xyz_spec("line3d"),
                ]}
        fig, _geo, _dropped = plot_engine._build_panel_figure(
            spec, spec["panels"], THEME, PALETTE, 12.8, 4.2, DPI)
        try:
            self.assertEqual(len(fig.axes), 2)
            self.assertTrue(hasattr(fig.axes[1], "set_zlabel"),
                            "第二个面板应是三维轴（有 set_zlabel）")
            self.assertFalse(hasattr(fig.axes[0], "set_zlabel"),
                             "第一个面板应仍是二维轴")
        finally:
            plt.close(fig)

    def test_kinds_metadata(self):
        """KINDS 元数据：三维组、need_fit=False，并带中文说明。"""
        for kind in ("scatter3d", "line3d", "surface3d", "bar3d"):
            self.assertIn(kind, plot_engine.SUPPORTED_KINDS)
            meta = plot_engine.KINDS[kind]
            self.assertEqual(meta["group"], "三维", "%s 的分组应为三维" % kind)
            self.assertFalse(meta["need_fit"], "%s 不依赖拟合" % kind)
            self.assertTrue(str(meta.get("desc") or "").strip(),
                            "%s 缺中文说明" % kind)
        self.assertTrue(plot_engine.KINDS["scatter3d"]["need_z"])
        self.assertTrue(plot_engine.KINDS["line3d"]["need_z"])
        self.assertTrue(plot_engine.KINDS["surface3d"]["need_matrix"])
        self.assertTrue(plot_engine.KINDS["bar3d"]["need_matrix"])


class TestThreeDBadData(unittest.TestCase):
    """三维脏数据必须给中文 ValueError，而不是 traceback。"""

    def test_z_length_mismatch(self):
        """z 与 x/y 不等长：中文 ValueError。"""
        spec = _xyz_spec("scatter3d")
        spec["series"][0]["z"] = [1.0, 2.0]
        with self.assertRaises(ValueError) as ctx:
            plot_engine.render_bytes(spec, "png", DPI)
        self.assertTrue(str(ctx.exception).strip(), "错误信息不能为空")
        self.assertIn("长度", str(ctx.exception),
                      "应给出长度相关的中文提示：%s" % ctx.exception)

    def test_z_missing_or_empty(self):
        """z 缺失 / 全空：中文 ValueError。"""
        for bad in (None, []):
            spec = _xyz_spec("line3d")
            if bad is None:
                spec["series"][0].pop("z")
            else:
                spec["series"][0]["z"] = bad
            with self.assertRaises(ValueError) as ctx:
                plot_engine.render_bytes(spec, "png", DPI)
            self.assertTrue(str(ctx.exception).strip())

    def test_matrix_not_2d(self):
        """values 不是矩阵（一维 / 非二维结构）：中文 ValueError。"""
        for bad in ([1.0, 2.0, 3.0], "not-a-matrix", []):
            spec = _matrix_spec("surface3d")
            spec["matrix"] = {"values": bad}
            with self.assertRaises(ValueError) as ctx:
                plot_engine.render_bytes(spec, "png", DPI)
            self.assertTrue(str(ctx.exception).strip(),
                            "values=%r 应给出中文错误" % (bad,))

    def test_matrix_all_nan(self):
        """矩阵全是非数值：中文 ValueError（不能让 numpy 在 C 层炸掉）。"""
        spec = _matrix_spec("bar3d")
        spec["matrix"] = {"values": [["a", "b"], ["c", "d"]]}
        with self.assertRaises(ValueError) as ctx:
            plot_engine.render_bytes(spec, "png", DPI)
        self.assertTrue(str(ctx.exception).strip())

    def test_finalize_3d_skips_spines_and_log(self):
        """三维收尾不做 log、不动 spine：渲染不抛异常且轴仍是三维。"""
        spec = _xyz_spec("scatter3d")
        spec["yscale"] = "log"
        spec["grid"] = True
        fig = plt.figure(figsize=(6.4, 4.2), dpi=DPI)
        try:
            ax = fig.add_subplot(1, 1, 1, projection="3d")
            plot_engine._draw_with_twin(ax, spec, THEME, PALETTE)
            self.assertEqual(ax.get_zlabel(), "Z", "Z 轴标签应取 zlabel")
            self.assertNotEqual(ax.get_yscale(), "log",
                                "三维轴不应被套用对数刻度")
        finally:
            plt.close(fig)


class TestTwin3dSanitize(unittest.TestCase):
    """服务端对新增字段的类型收敛（后端是唯一事实来源）。"""

    def test_axis_normalized_and_z_truncated(self):
        """axis 大小写归一、非法值落 left；z 按最短长度截断且不占位。"""
        clean = server._sanitize_spec({
            "kind": "line",
            "series": [
                {"name": "a", "x": [0.0, 1.0, 2.0], "y": [1.0, 2.0, 3.0],
                 "z": [4.0, 5.0], "axis": "RIGHT"},
                {"name": "b", "x": [0.0, 1.0], "y": [1.0, 2.0], "axis": "斜轴"},
            ],
        })
        first, second = clean["series"]
        self.assertEqual(first["axis"], "right")
        self.assertEqual(second["axis"], "left", "非法 axis 一律落 left")
        self.assertEqual(first["z"], [4.0, 5.0], "z 应按最短长度截断")
        self.assertNotIn("z", second, "没有 z 时不得塞空列表占位")

    def test_y2_and_zlabel_fields(self):
        """y2label / y2scale / y2lim / zlabel 在顶层与面板级都被收敛。"""
        clean = server._sanitize_spec({
            "kind": "line", "y2label": "温度", "y2scale": "LOG",
            "y2lim": [9.0, 1.0], "zlabel": "高度",
            "series": [{"name": "a", "x": [0.0, 1.0], "y": [1.0, 2.0]}],
        })
        self.assertEqual(clean["zlabel"], "高度")
        self.assertEqual(clean.get("y2label"), "温度")
        self.assertEqual(clean["y2scale"], "log")
        self.assertEqual(clean.get("y2lim"), [1.0, 9.0], "y2lim 应排序收敛")

        clean = server._sanitize_spec({
            "kind": "line",
            "grid_shape": [1, 2],
            "panels": [
                {"kind": "line", "y2scale": "symlog", "zlabel": "Z1",
                 "series": [{"name": "a", "x": [0.0, 1.0], "y": [1.0, 2.0]}]},
                {"kind": "line", "y2scale": "wat", "zlabel": None,
                 "series": [{"name": "b", "x": [0.0, 1.0], "y": [2.0, 1.0]}]},
            ],
        })
        self.assertEqual(clean["panels"][0]["y2scale"], "symlog",
                         "面板级允许逐子图不同，且不进 _PANEL_LOCKED")
        self.assertEqual(clean["panels"][1]["y2scale"], "linear",
                         "非法值退 linear")
        self.assertEqual(clean["panels"][0]["zlabel"], "Z1")

    def test_themes_sends_3d_kinds(self):
        """/api/themes 下发的 kinds / kind_groups 自动包含四个三维图型。"""
        info = server.act_themes()
        for kind in ("scatter3d", "line3d", "surface3d", "bar3d"):
            self.assertIn(kind, info["kinds"], "kinds 缺 %s" % kind)
        self.assertIn("三维", info["kind_groups"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
