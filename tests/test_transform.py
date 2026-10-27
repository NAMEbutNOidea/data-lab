# -*- coding: utf-8 -*-
"""core/transform.py 八种列变换的单元测试。

独立运行：``python tests/test_transform.py``
"""

from __future__ import annotations

import math
import os
import sys

os.environ.setdefault("MKL_THREADING_LAYER", "SEQUENTIAL")
os.environ.setdefault("KMP_DUPLICATE_LIB_OK", "TRUE")

import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from core import transform  # noqa: E402


class TestTransformOps(unittest.TestCase):
    """每个 op 都要"长度不变 + 关键数值正确"。"""

    # ---------------- 通用约束 ----------------
    def test_all_ops_keep_length(self):
        """8 个 op 逐一跑，输出长度恒等于输入长度。"""
        self.assertEqual(len(transform.OPS), 8,
                         "应有 8 种变换，实际 %d 种" % len(transform.OPS))
        values = [1.0, 4.0, 9.0, 16.0, 25.0, 36.0]
        xs = [0.0, 1.0, 2.0, 3.0, 4.0, 5.0]
        for op, meta in transform.OPS.items():
            params = {}
            for p in meta["params"]:
                params[p["key"]] = p["default"]
            out, info = transform.apply(values, op, params, x=xs)
            self.assertEqual(len(out), len(values),
                             "%s 输出长度 %d != 输入 %d" % (op, len(out), len(values)))
            self.assertEqual(info["op"], op)
            self.assertIn("dropped", info)
            self.assertIn("note", info)

    def test_unknown_op_raises(self):
        """未知 op 抛 ValueError。"""
        with self.assertRaises(ValueError):
            transform.apply([1.0, 2.0], "no_such_op")

    def test_none_input_no_crash(self):
        """输入含 None 时不崩，且长度不变。"""
        values = [1.0, None, 3.0, float("nan"), 5.0]
        xs = [0.0, 1.0, 2.0, 3.0, 4.0]
        for op, meta in transform.OPS.items():
            params = {p["key"]: p["default"] for p in meta["params"]}
            try:
                out, _info = transform.apply(values, op, params, x=xs)
            except Exception as e:  # noqa: BLE001
                self.fail("%s 处理含 None 的输入时抛异常：%s: %s"
                          % (op, type(e).__name__, e))
            self.assertEqual(len(out), 5, "%s 输出长度应保持 5" % op)

    # ---------------- 逐 op 数值 ----------------
    def test_log10_values_and_dropped(self):
        """log10：非正值给 None，dropped 计数正确。"""
        out, info = transform.apply([1.0, 10.0, 0.0, -5.0, 100.0], "log10")
        self.assertEqual(len(out), 5)
        self.assertAlmostEqual(out[0], 0.0)
        self.assertAlmostEqual(out[1], 1.0)
        self.assertIsNone(out[2], "0 取对数应为 None")
        self.assertIsNone(out[3], "负值取对数应为 None")
        self.assertAlmostEqual(out[4], 2.0)
        self.assertEqual(info["dropped"], 2,
                         "dropped 应为 2（0 与 -5），实际 %r" % (info["dropped"],))
        self.assertTrue(info["note"], "有丢弃时 note 不应为空")

    def test_ln_values(self):
        """ln：自然对数。"""
        out, info = transform.apply([1.0, math.e, math.e ** 2], "ln")
        self.assertAlmostEqual(out[0], 0.0)
        self.assertAlmostEqual(out[1], 1.0)
        self.assertAlmostEqual(out[2], 2.0)
        self.assertEqual(info["dropped"], 0)

    def test_normalize_max(self):
        """normalize_max：除以最大值；全 0 时全 None。"""
        out, _info = transform.apply([1.0, 2.0, 4.0], "normalize_max")
        self.assertEqual(out, [0.25, 0.5, 1.0])

        out0, info0 = transform.apply([0.0, 0.0, 0.0], "normalize_max")
        self.assertEqual(out0, [None, None, None],
                         "最大值为 0 时应全为 None，实际 %r" % (out0,))
        self.assertEqual(info0["dropped"], 3)
        self.assertTrue(info0["note"])

    def test_normalize_minmax(self):
        """normalize_minmax：线性映射到 [0,1]；max==min 时全 0。"""
        out, _info = transform.apply([2.0, 4.0, 6.0], "normalize_minmax")
        self.assertEqual(out, [0.0, 0.5, 1.0])

        flat, info = transform.apply([3.0, 3.0, 3.0], "normalize_minmax")
        self.assertEqual(flat, [0.0, 0.0, 0.0],
                         "max==min 时应全为 0，实际 %r" % (flat,))
        self.assertEqual(info["dropped"], 0)

    def test_baseline_first(self):
        """baseline_first：减去首个有效值。"""
        out, info = transform.apply([5.0, 6.0, 7.0], "baseline_first")
        self.assertEqual(out, [0.0, 1.0, 2.0])
        self.assertEqual(info["dropped"], 0)
        self.assertTrue(info["note"])

    def test_baseline_mean_range(self):
        """baseline_mean：减区间均值。"""
        out, info = transform.apply([1.0, 2.0, 3.0, 4.0], "baseline_mean",
                                    {"start": 0, "end": 2})
        self.assertEqual(len(out), 4)
        self.assertAlmostEqual(out[0], -0.5)
        self.assertAlmostEqual(out[1], 0.5)
        self.assertAlmostEqual(out[2], 1.5)
        self.assertAlmostEqual(out[3], 2.5)
        self.assertTrue(info["note"])

    def test_baseline_mean_empty_range(self):
        """baseline_mean：区间为空时退回首值，且 note 非空。"""
        out, info = transform.apply([1.0, 2.0, 3.0, 4.0], "baseline_mean",
                                    {"start": 10, "end": 20})
        self.assertEqual(out, [0.0, 1.0, 2.0, 3.0],
                         "区间为空时应等价于减首值 1，实际 %r" % (out,))
        self.assertTrue(info["note"].strip(), "退回分支必须给出 note")
        self.assertEqual(info["dropped"], 0)

    def test_smooth_ma_window1(self):
        """smooth_ma window=1 等于原值。"""
        values = [1.0, 2.0, 3.0, 4.0, 5.0]
        out, info = transform.apply(values, "smooth_ma", {"window": 1})
        self.assertEqual(out, values,
                         "window=1 应等于原值，实际 %r" % (out,))
        self.assertTrue(info["note"])

    def test_smooth_ma_window3(self):
        """smooth_ma window=3：两端按可用点求均值。"""
        out, _info = transform.apply([1.0, 2.0, 3.0, 4.0, 5.0], "smooth_ma",
                                     {"window": 3})
        for got, want in zip(out, [1.5, 2.0, 3.0, 4.0, 4.5]):
            self.assertAlmostEqual(got, want,
                                   msg="滑动平均不符：%r" % (out,))

    def test_derivative_second_order(self):
        """derivative：y=x² 的二阶导约为 2（首尾各两点为边界效应，放宽）。"""
        n = 41
        xs = [float(i) for i in range(n)]
        ys = [v * v for v in xs]
        out, info = transform.apply(ys, "derivative", {"order": 2}, x=xs)
        self.assertEqual(len(out), n)
        for i in range(2, n - 2):
            self.assertAlmostEqual(
                out[i], 2.0, places=6,
                msg="x=%.0f 处二阶导为 %r，期望 2.0（全部：%r）" % (xs[i], out[i], out))
        self.assertTrue(info["note"])

    def test_derivative_first_order(self):
        """derivative：一阶导按 dy/dx 中心差分计算（首尾为单侧差分）。"""
        xs = [0.0, 1.0, 2.0, 3.0, 4.0]
        ys = [v * v for v in xs]
        out, _info = transform.apply(ys, "derivative", {"order": 1}, x=xs)
        # 内部点用中心差分，对 x² 精确等于 2x
        for i in (1, 2, 3):
            self.assertAlmostEqual(out[i], 2.0 * xs[i], places=9,
                                   msg="x=%.0f 处一阶导为 %r，期望 %.1f（全部：%r）"
                                       % (xs[i], out[i], 2.0 * xs[i], out))


if __name__ == "__main__":
    unittest.main(verbosity=2)
