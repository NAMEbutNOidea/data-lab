# -*- coding: utf-8 -*-
"""core/fit_engine.py 中 ``compare_models`` 的单元测试。

独立运行：``python tests/test_fit_engine.py``
"""

from __future__ import annotations

import math
import os
import sys

os.environ.setdefault("MKL_THREADING_LAYER", "SEQUENTIAL")
os.environ.setdefault("KMP_DUPLICATE_LIB_OK", "TRUE")

import json
import unittest
import warnings
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

# curve_fit 在病态模型上会刷 "Covariance ... could not be estimated"，属于预期噪声
warnings.filterwarnings("ignore", message=".*Covariance of the parameters.*")
warnings.filterwarnings("ignore", message=".*divide by zero.*")

from core import dataloader, fit_engine  # noqa: E402

SAMPLE = ROOT / "samples" / "示例数据_光电测量.xlsx"
SHEET = "光电响应"
X_COL = "光强 I(lx)"
Y_COL = "光电流(mA)"


def _sample_xy():
    """读示例文件的「光电响应」表，返回 (x, y)。"""
    sheets = dataloader.parse(SAMPLE.name, SAMPLE.read_bytes())
    df = sheets[SHEET]
    return dataloader.column_values(df, X_COL), dataloader.column_values(df, Y_COL)


class TestCompareModels(unittest.TestCase):
    """9 个模型全跑 + 排序 + 结论 + AIC 口径。"""

    @classmethod
    def setUpClass(cls):
        cls.x, cls.y = _sample_xy()
        cls.res = fit_engine.compare_models(cls.x, cls.y)

    # ---------------- 结构 ----------------
    def test_all_nine_models_present(self):
        """9 个模型一个不少，id 与 MODELS 注册表一致。"""
        results = self.res["results"]
        self.assertEqual(len(results), 9,
                         "应有 9 条结果，实际 %d 条" % len(results))
        ids = [it["model"] for it in results]
        self.assertEqual(sorted(ids), sorted(fit_engine.MODELS.keys()),
                         "模型 id 集合不一致：%r" % (sorted(ids),))
        for it in results:
            for key in ("model", "model_name", "ok", "error", "params", "n",
                        "dof", "k", "sse", "rmse", "r2", "adj_r2", "aic", "bic"):
                self.assertIn(key, it, "结果项缺少字段 %s" % key)

    def test_failed_gaussian_is_last(self):
        """高斯在光电响应数据上不收敛：ok=False 且排在最后。"""
        results = self.res["results"]
        last = results[-1]
        self.assertEqual(last["model"], "gaussian",
                         "最后一个应是 gaussian，实际 %r" % (last["model"],))
        self.assertIs(last["ok"], False, "gaussian 的 ok 应为 False")
        self.assertTrue(last["error"], "失败的模型应带 error 文案")
        self.assertIsNone(last["aic"])
        self.assertIsNone(last["bic"])
        # 其余 8 个都应收敛
        self.assertTrue(all(it["ok"] for it in results[:-1]),
                        "除 gaussian 外都应收敛")

    def test_sorted_by_aic_ascending(self):
        """收敛项按 AIC 升序；AIC 为 None 的与失败项排在后面。"""
        results = self.res["results"]
        aics = [it["aic"] for it in results if it["ok"] and it["aic"] is not None]
        self.assertGreaterEqual(len(aics), 2, "有效 AIC 太少，无法验证排序")
        self.assertEqual(aics, sorted(aics),
                         "AIC 未升序：%r" % (aics,))

        # 一旦出现失败项，后面不能再有收敛项
        seen_bad = False
        for it in results:
            if not it["ok"]:
                seen_bad = True
            elif seen_bad:
                self.fail("失败模型之后仍出现收敛模型：%s" % it["model"])

    def test_best_and_notes(self):
        """best 指向第一条收敛结果，notes 是非空中文句子。"""
        results = self.res["results"]
        best = self.res["best"]
        self.assertTrue(best, "best 不应为空")
        first_ok = next(it for it in results if it["ok"])
        self.assertEqual(best, first_ok["model"],
                         "best 应等于首个收敛模型，实际 %r" % (best,))
        self.assertEqual(best, "exp", "示例数据的最优模型是 exp（指数）")

        notes = self.res["notes"]
        self.assertIsInstance(notes, str)
        self.assertTrue(notes.strip(), "notes 不应为空")
        self.assertTrue(any("\u4e00" <= ch <= "\u9fff" for ch in notes),
                        "notes 应为中文句子，实际 %r" % (notes,))

    def test_k_and_dof_consistent(self):
        """k == 参数个数，dof == n - k。"""
        for it in self.res["results"]:
            if not it["ok"]:
                continue
            self.assertEqual(it["k"], len(it["params"]),
                             "%s 的 k 与 params 长度不符" % it["model"])
            self.assertEqual(it["dof"], it["n"] - it["k"],
                             "%s 的 dof 应为 n-k" % it["model"])

    # ---------------- AIC / BIC 口径 ----------------
    def test_aic_bic_formula_matches_manual(self):
        """手算 n·ln(sse/n)+2k 与返回的 aic 一致（误差 < 1e-6）。

        sse 也用最小二乘公式独立算一遍，避免只验证"公式自洽"。
        """
        xs = [float(i) for i in range(20)]
        ys = [2.5 * v + 3.0 + 0.4 * math.sin(v * 1.7) for v in xs]
        res = fit_engine.compare_models(xs, ys, models=["linear"])
        it = res["results"][0]
        self.assertTrue(it["ok"], "线性拟合应成功，实际 error=%r" % (it["error"],))

        n, k = it["n"], it["k"]
        self.assertEqual((n, k), (20, 2))

        # 独立手算最小二乘 sse
        mx = sum(xs) / n
        my = sum(ys) / n
        sxx = sum((v - mx) ** 2 for v in xs)
        sxy = sum((v - mx) * (w - my) for v, w in zip(xs, ys))
        a = sxy / sxx
        b = my - a * mx
        sse_manual = sum((w - (a * v + b)) ** 2 for v, w in zip(xs, ys))

        self.assertAlmostEqual(it["sse"], sse_manual, places=8,
                               msg="返回的 sse 与手算不符：%.12g vs %.12g"
                                   % (it["sse"], sse_manual))

        aic_manual = n * math.log(sse_manual / n) + 2.0 * k
        bic_manual = n * math.log(sse_manual / n) + k * math.log(n)
        self.assertLess(abs(it["aic"] - aic_manual), 1e-6,
                        "AIC 不符：返回 %.9f，手算 %.9f" % (it["aic"], aic_manual))
        self.assertLess(abs(it["bic"] - bic_manual), 1e-6,
                        "BIC 不符：返回 %.9f，手算 %.9f" % (it["bic"], bic_manual))

    def test_zero_sse_gives_none(self):
        """sse == 0（完美拟合）时 aic/bic 必须是 None，而不是 -inf / NaN。"""
        aic, bic = fit_engine._criteria(0.0, 10, 2)
        self.assertIsNone(aic, "sse=0 时 aic 应为 None，实际 %r" % (aic,))
        self.assertIsNone(bic, "sse=0 时 bic 应为 None，实际 %r" % (bic,))

        # 非正值 / 非有限值同样不能变成 -inf 或 NaN
        for bad in (-1.0, float("nan"), float("inf"), None):
            a, b = fit_engine._criteria(bad, 10, 2)
            self.assertIsNone(a, "sse=%r 时 aic 应为 None" % (bad,))
            self.assertIsNone(b, "sse=%r 时 bic 应为 None" % (bad,))

        # 整条链路里不允许出现 -inf / NaN
        for it in self.res["results"]:
            for key in ("aic", "bic"):
                v = it[key]
                if v is not None:
                    self.assertTrue(math.isfinite(v),
                                    "%s 的 %s 不是有限值：%r" % (it["model"], key, v))

    def test_json_strict_serializable(self):
        """整个返回体必须能 json.dumps(allow_nan=False)。"""
        try:
            text = json.dumps(self.res, allow_nan=False)
        except (TypeError, ValueError) as e:
            self.fail("返回体不能严格 JSON 序列化：%s: %s" % (type(e).__name__, e))
        back = json.loads(text)
        self.assertEqual(len(back["results"]), 9)
        self.assertEqual(back["best"], self.res["best"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
