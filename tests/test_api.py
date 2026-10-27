# -*- coding: utf-8 -*-
"""HTTP 接口层测试：直接打真实服务（http.client，天然绕过 HTTP_PROXY）。

独立运行：``python tests/test_api.py``（需要先启动 DataLab 服务）
"""

from __future__ import annotations

import os
import sys

os.environ.setdefault("MKL_THREADING_LAYER", "SEQUENTIAL")
os.environ.setdefault("KMP_DUPLICATE_LIB_OK", "TRUE")

import base64
import http.client
import json
import math
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

SAMPLE = ROOT / "samples" / "示例数据_光电测量.xlsx"
HOST, PORT = "127.0.0.1", 8765
# 直接建 TCP 连接，不走 HTTP_PROXY / HTTPS_PROXY（环境里设了代理，urllib 会走歪）
TIMEOUT = 240


def api(path: str, payload: dict | None = None, method: str = "POST"):
    """发一个请求，返回 (status, body)。body 一律按 JSON 解析。"""
    conn = http.client.HTTPConnection(HOST, PORT, timeout=TIMEOUT)
    try:
        if method == "GET":
            conn.request("GET", path)
        else:
            raw = json.dumps(payload if payload is not None else {}).encode("utf-8")
            conn.request("POST", path, body=raw,
                         headers={"Content-Type": "application/json"})
        resp = conn.getresponse()
        data = resp.read()
        try:
            body = json.loads(data.decode("utf-8"))
        except ValueError:
            raise AssertionError("%s 返回的不是 JSON（status=%d，前 200 字节：%r）"
                                 % (path, resp.status, data[:200]))
        return resp.status, body
    finally:
        conn.close()


def _b64_of_sample() -> str:
    return base64.b64encode(SAMPLE.read_bytes()).decode("ascii")


def _line_spec(n: int = 4):
    return {
        "kind": "line", "theme": "paper_nature", "palette": "npg",
        "title": "回归用例", "xlabel": "x", "ylabel": "y",
        "series": [{"name": "s1", "x": [float(i) for i in range(n)],
                    "y": [float(i * i) for i in range(n)]}],
    }


class TestApi(unittest.TestCase):
    """覆盖 themes / upload / fit / transform / datasets / render / export。"""

    @classmethod
    def setUpClass(cls):
        try:
            status, conn = api("/api/connection", method="GET")
        except OSError as e:
            raise AssertionError(
                "连不上 http://%s:%d/（%s）——请先启动 DataLab 服务"
                % (HOST, PORT, e))
        if status != 200 or not conn.get("ok"):
            raise AssertionError("/api/connection 异常：%s %r" % (status, conn))

        status, cls.themes = api("/api/themes", method="GET")
        if status != 200 or not cls.themes.get("ok"):
            raise AssertionError("/api/themes 异常：%s %r" % (status, cls.themes))

        status, up = api("/api/upload", {"filename": SAMPLE.name,
                                         "data_b64": _b64_of_sample()})
        if status != 200 or not up.get("ok"):
            raise AssertionError("上传示例文件失败：%s %r" % (status, up))
        cls.ds = up["ds"]

    # ---------------- 元信息 ----------------
    def test_themes_counts(self):
        """themes 8 / palettes 8 / transforms 8，kinds 与 SUPPORTED_KINDS 对齐。

        kinds 的条数不再写死：图型清单本来就会随功能增长（三维就一次加了 4 个），
        写死一个数字的结果是每加一种图型都要来改测试，而且改漏了才发现。
        """
        from core import plot_engine

        d = self.themes
        self.assertEqual(len(d["kinds"]), len(plot_engine.SUPPORTED_KINDS),
                         "kinds 应与 SUPPORTED_KINDS 一致（%d），实际 %d"
                         % (len(plot_engine.SUPPORTED_KINDS), len(d["kinds"])))
        for kid in plot_engine.SUPPORTED_KINDS:
            self.assertIn(kid, d["kinds"], "kinds 里缺少图型 %s" % kid)
        self.assertEqual(len(d["themes"]), 8,
                         "themes 应为 8，实际 %d" % len(d["themes"]))
        self.assertEqual(len(d["palettes"]), 8,
                         "palettes 应为 8，实际 %d" % len(d["palettes"]))
        self.assertEqual(len(d["transforms"]), 8,
                         "transforms 应为 8，实际 %d" % len(d["transforms"]))
        self.assertIn("log10", d["transforms"])

    # ---------------- 上传 ----------------
    def test_upload_four_sheets(self):
        """上传示例 xlsx，返回 4 个工作表且带列信息。"""
        status, up = api("/api/upload", {"filename": SAMPLE.name,
                                         "data_b64": _b64_of_sample()})
        self.assertEqual(status, 200)
        self.assertTrue(up.get("ok"), "上传失败：%r" % (up.get("error"),))
        self.assertEqual(len(up["sheets"]), 4,
                         "应有 4 个工作表，实际 %d 个：%r"
                         % (len(up["sheets"]), [s["name"] for s in up["sheets"]]))
        names = [s["name"] for s in up["sheets"]]
        self.assertEqual(names, ["光电响应", "重复测量", "多组对比", "环境参数"],
                         "工作表名不符：%r" % (names,))
        for sheet in up["sheets"]:
            self.assertGreater(sheet["row_count"], 0, "%s 行数为 0" % sheet["name"])
            self.assertTrue(sheet["columns"], "%s 没有列信息" % sheet["name"])

    # ---------------- 拟合 ----------------
    def test_fit_compare_nine(self):
        """模型比较返回 9 条结果，含 best 与中文 notes。"""
        status, d = api("/api/fit/compare", {
            "ds": self.ds, "sheet": "光电响应",
            "x_col": "光强 I(lx)", "y_col": "光电流(mA)"})
        self.assertEqual(status, 200, "接口返回 %d：%r" % (status, d.get("error")))
        self.assertTrue(d.get("ok"), "接口失败：%r" % (d.get("error"),))
        self.assertEqual(len(d["results"]), 9,
                         "应有 9 条模型结果，实际 %d 条" % len(d["results"]))
        self.assertTrue(d["best"], "best 不应为空")
        self.assertTrue(str(d["notes"]).strip(), "notes 不应为空")
        self.assertTrue(d["results"][0]["ok"], "第一条结果应收敛")

    # ---------------- 变换 ----------------
    def test_transform_adds_column(self):
        """log10 变换后列数 +1，新列名含变换名。"""
        status, pre = api("/api/preview", {"ds": self.ds, "sheet": "光电响应",
                                           "offset": 0, "limit": 5})
        self.assertEqual(status, 200)
        before = len(pre["columns"])
        rows = pre["total"]

        status, d = api("/api/data/transform", {
            "ds": self.ds, "sheet": "光电响应",
            "col": "光电流(mA)", "op": "log10"})
        self.assertEqual(status, 200, "接口返回 %d：%r" % (status, d.get("error")))
        self.assertTrue(d.get("ok"), "变换失败：%r" % (d.get("error"),))

        self.assertEqual(len(d["columns"]), before + 1,
                         "列数应 +1（%d → %d），实际 %d"
                         % (before, before + 1, len(d["columns"])))
        self.assertEqual(d["row_count"], rows, "行数不应改变")

        op_name = self.themes["transforms"]["log10"]["name"]
        new_name = d["name"]
        self.assertIn(op_name, new_name,
                      "新列名应含变换名「%s」，实际 %r" % (op_name, new_name))
        self.assertIn(new_name, [c["name"] for c in d["columns"]],
                      "新列没有出现在 columns 里")

        vals = d["values"]
        self.assertTrue(vals, "values 不应为空")
        for v in vals:
            if v is not None:
                self.assertTrue(math.isfinite(v), "变换结果出现非有限值：%r" % (v,))

    # ---------------- 数据集列表 ----------------
    def test_datasets_lists_uploaded(self):
        """GET /api/datasets 能列出刚才上传的数据集。"""
        status, d = api("/api/datasets", method="GET")
        self.assertEqual(status, 200)
        self.assertTrue(d.get("ok"))
        ids = [it["ds"] for it in d["datasets"]]
        self.assertIn(self.ds, ids,
                      "刚上传的数据集 %s 不在列表里：%r" % (self.ds, ids))
        rec = next(it for it in d["datasets"] if it["ds"] == self.ds)
        self.assertEqual(rec["filename"], SAMPLE.name)
        self.assertEqual(len(rec["sheets"]), 4)
        self.assertGreater(rec["rows"], 0)

    # ---------------- 渲染 ----------------
    def test_render_single_png(self):
        """单面板正常返回 png_b64。"""
        status, d = api("/api/plot/render", {"spec": _line_spec()})
        self.assertEqual(status, 200, "接口返回 %d：%r" % (status, d.get("error")))
        self.assertTrue(d.get("ok"), "渲染失败：%r" % (d.get("error"),))
        png = base64.b64decode(d["png_b64"])
        self.assertTrue(png.startswith(b"\x89PNG"),
                        "png_b64 不是合法 PNG（前 8 字节 %r）" % (png[:8],))
        self.assertGreater(d["bytes"], 1000, "图片过小，可能没画出内容")

    def test_render_multi_panel(self):
        """1×2 多子图：能出图，返回的 spec.panels == 2。"""
        spec = {
            "kind": "line", "theme": "paper_nature", "palette": "npg",
            "grid_shape": [1, 2],
            "panels": [
                {"kind": "line", "title": "面板A", "xlabel": "x", "ylabel": "y",
                 "series": [{"name": "a", "x": [0.0, 1.0, 2.0],
                             "y": [1.0, 2.0, 3.0]}]},
                {"kind": "scatter", "title": "面板B", "xlabel": "x", "ylabel": "y",
                 "series": [{"name": "b", "x": [0.0, 1.0, 2.0],
                             "y": [3.0, 2.0, 1.0]}]},
            ],
        }
        status, d = api("/api/plot/render", {"spec": spec})
        self.assertEqual(status, 200, "接口返回 %d：%r" % (status, d.get("error")))
        self.assertTrue(d.get("ok"), "多子图渲染失败：%r" % (d.get("error"),))
        self.assertTrue(d.get("png_b64"), "多子图没有返回 png_b64")
        base64.b64decode(d["png_b64"])

        out = d["spec"]
        if "panels" not in out:
            self.fail("返回的 spec 里没有 panels 字段（实际字段：%r）" % (sorted(out),))
        self.assertEqual(out["panels"], 2,
                         "返回的 spec.panels 应为 2，实际 %r（spec=%r）"
                         % (out.get("panels"), out))
        self.assertEqual(out.get("grid"), [1, 2],
                         "返回的 spec.grid 应为 [1, 2]，实际 %r" % (out.get("grid"),))

    def test_render_downsample_250k(self):
        """25 万点：downsample 非空、points 为 20000。"""
        n = 250000
        xs = [float(i) for i in range(n)]
        ys = [math.sin(i / 1000.0) for i in range(n)]
        ys[180000] = 6.0
        spec = {"kind": "line", "theme": "paper_nature",
                "series": [{"name": "big", "x": xs, "y": ys}]}
        status, d = api("/api/plot/render", {"spec": spec})
        self.assertEqual(status, 200, "接口返回 %d：%r" % (status, d.get("error")))
        self.assertTrue(d.get("ok"), "渲染失败：%r" % (d.get("error"),))

        ds = d["downsample"]
        self.assertTrue(ds, "25 万点必须返回 downsample 统计，实际 %r" % (ds,))
        self.assertEqual(ds[0]["original"], n)
        self.assertEqual(ds[0]["kept"], 20000)
        self.assertEqual(ds[0]["method"], "lttb")
        self.assertEqual(d["points"], [20000],
                         "points 应为 [20000]，实际 %r" % (d["points"],))
        self.assertTrue(d.get("png_b64"), "没有返回图片")

    def test_render_x_datetime(self):
        """x_datetime=true + ISO 字符串 x 能渲染成功。"""
        spec = {
            "kind": "line", "theme": "paper_nature", "x_datetime": True,
            "xlabel": "time", "ylabel": "y",
            "series": [{"name": "t",
                        "x": ["2024-01-01", "2024-01-02", "2024-01-03", "2024-01-04"],
                        "y": [1.0, 3.0, 2.0, 5.0]}],
        }
        status, d = api("/api/plot/render", {"spec": spec})
        self.assertEqual(status, 200, "接口返回 %d：%r" % (status, d.get("error")))
        self.assertTrue(d.get("ok"), "时间轴渲染失败：%r" % (d.get("error"),))
        png = base64.b64decode(d["png_b64"])
        self.assertTrue(png.startswith(b"\x89PNG"))

    def test_render_invalid_kind(self):
        """非法 kind 返回 400 且 error_type == validation。"""
        status, d = api("/api/plot/render",
                        {"spec": {"kind": "not_a_chart",
                                  "series": [{"x": [0.0, 1.0], "y": [0.0, 1.0]}]}})
        self.assertEqual(status, 400,
                         "非法 kind 应返回 400，实际 %d（%r）" % (status, d))
        self.assertFalse(d.get("ok"))
        self.assertEqual(d.get("error_type"), "validation",
                         "error_type 应为 validation，实际 %r" % (d.get("error_type"),))

    def test_render_dpi_clamped(self):
        """DPI 传 99999 时生效值是上限 1200。"""
        spec = _line_spec()
        spec["dpi"] = 99999
        status, d = api("/api/plot/render", {"spec": spec})
        self.assertEqual(status, 200)
        self.assertTrue(d.get("ok"))
        self.assertEqual(d["spec"]["dpi"], 1200,
                         "DPI 应被截断到 1200，实际 %r" % (d["spec"]["dpi"],))

    # ---------------- 导出 ----------------
    def test_export_four_formats(self):
        """png/svg/pdf/eps 都返回 data_b64 + mime + filename，且文件真的落盘。"""
        expect = {"png": "image/png", "svg": "image/svg+xml",
                  "pdf": "application/pdf", "eps": "application/postscript"}
        for fmt, mime in expect.items():
            spec = _line_spec()
            spec["title"] = "回归测试导出"
            status, d = api("/api/plot/export", {"spec": spec, "fmt": fmt})
            self.assertEqual(status, 200,
                             "%s 导出返回 %d：%r" % (fmt, status, d.get("error")))
            self.assertTrue(d.get("ok"), "%s 导出失败：%r" % (fmt, d.get("error")))

            self.assertTrue(d.get("data_b64"), "%s 没有返回 data_b64" % fmt)
            payload = base64.b64decode(d["data_b64"])
            self.assertGreater(len(payload), 500, "%s 文件过小" % fmt)
            self.assertEqual(d["bytes"], len(payload),
                             "%s 的 bytes 与实际长度不符" % fmt)

            self.assertEqual(d["mime"], mime,
                             "%s 的 mime 应为 %s，实际 %r" % (fmt, mime, d["mime"]))
            self.assertTrue(d["filename"].endswith("." + fmt),
                            "%s 的 filename 后缀不对：%r" % (fmt, d["filename"]))
            self.assertEqual(d["fmt"], fmt)

            path = d["path"]
            self.assertTrue(os.path.exists(path),
                            "%s 文件没有落盘：%r" % (fmt, path))
            self.assertEqual(os.path.getsize(path), len(payload),
                             "%s 落盘文件大小与返回字节数不一致" % fmt)
            self.assertEqual(os.path.dirname(os.path.abspath(path)),
                             str(ROOT / "output"),
                             "%s 没有落在 output/ 目录：%r" % (fmt, path))


if __name__ == "__main__":
    unittest.main(verbosity=2)
