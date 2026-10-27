# -*- coding: utf-8 -*-
"""core/downsample.py（LTTB 保形降采样）的单元测试。

独立运行：``python tests/test_downsample.py``
"""

from __future__ import annotations

import math
import os
import sys

# 必须在 import numpy 之前修掉 conda 环境的 MKL/OpenMP 线程层冲突，
# 否则 BLAS 会以 0xC06D007F 在 C 层直接杀进程（try/except 拦不住）。
os.environ.setdefault("MKL_THREADING_LAYER", "SEQUENTIAL")
os.environ.setdefault("KMP_DUPLICATE_LIB_OK", "TRUE")

import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from core import downsample  # noqa: E402

MAXP = downsample.MAX_POINTS


def _wave(n: int, spike_at: int | None = None, spike_y: float = 6.0,
          gap: tuple[int, int] | None = None):
    """造一条 n 点的正弦曲线，可选尖峰与中间断段（None）。"""
    xs = [float(i) for i in range(n)]
    ys = [math.sin(i / 1000.0) for i in range(n)]
    if gap is not None:
        for i in range(gap[0], gap[1]):
            ys[i] = None
    if spike_at is not None:
        ys[spike_at] = spike_y
    return xs, ys


class TestDownsampleLTTB(unittest.TestCase):
    """LTTB 降采样的核心行为。"""

    # ---------------- 基本配额 ----------------
    def test_250k_to_20000_info(self):
        """25 万点降到 20000 点，info 的四个字段都要对。"""
        xs, ys = _wave(250000)
        x2, y2, _e2, info = downsample.downsample_series(xs, ys, MAXP)

        self.assertEqual(len(x2), MAXP, "输出 x 长度应为 %d，实际 %d" % (MAXP, len(x2)))
        self.assertEqual(len(y2), MAXP, "输出 y 长度应为 %d，实际 %d" % (MAXP, len(y2)))
        self.assertIsNotNone(info, "超限时必须返回 info")
        self.assertEqual(info["original"], 250000)
        self.assertEqual(info["kept"], MAXP)
        self.assertEqual(info["method"], "lttb")
        self.assertEqual(info["segments"], 1)
        self.assertEqual(
            sorted(info.keys()), ["kept", "method", "original", "segments"],
            "info 只应包含 original/kept/method/segments")

    def test_spike_preserved(self):
        """18 万点处的 y=6 尖峰不能被抽稀掉（max 仍 ≥ 5.9）。"""
        xs, ys = _wave(250000, spike_at=180000, spike_y=6.0)
        _x2, y2, _e2, info = downsample.downsample_series(xs, ys, MAXP)

        self.assertIsNotNone(info)
        peak = max(v for v in y2 if v is not None)
        self.assertGreaterEqual(peak, 5.9,
                                "尖峰被丢失：降采样后最大值 %.6f < 5.9" % peak)
        # 尖峰之外的正弦幅值只有 1，说明最大值确实来自尖峰本身
        self.assertLessEqual(sum(1 for v in y2 if v is not None and v > 1.5), 2,
                             "尖峰附近出现了异常多的超幅点")

    def test_gap_segments_preserved(self):
        """中间 1 万点是 None 时，输出仍以 None 断段，且 segments == 2。"""
        xs, ys = _wave(200000, gap=(50000, 60000))
        x2, y2, _e2, info = downsample.downsample_series(xs, ys, MAXP)

        self.assertIsNotNone(info)
        self.assertEqual(info["segments"], 2,
                         "应识别为 2 段，实际 %r" % (info["segments"],))
        self.assertEqual(info["original"], 190000, "有效点数应为 200000-10000")
        self.assertEqual(info["kept"], MAXP)
        n_none = sum(1 for v in y2 if v is None)
        self.assertEqual(n_none, 1, "断段处应保留 1 个 None，实际 %d" % n_none)
        self.assertEqual(sum(1 for v in x2 if v is None), 1, "x 也要同步补 None")
        self.assertEqual(len(x2), len(y2), "x/y 长度必须一致")

        idx = next(i for i, v in enumerate(y2) if v is None)
        left = [v for v in y2[:idx] if v is not None]
        right = [v for v in y2[idx + 1:] if v is not None]
        self.assertGreater(len(left), 100, "断段左侧点数过少")
        self.assertGreater(len(right), 100, "断段右侧点数过少")

    def test_below_limit_untouched(self):
        """未超限时原样返回，info 为 None。"""
        xs = [float(i) for i in range(100)]
        ys = [math.sin(i) for i in range(100)]
        x2, y2, e2, info = downsample.downsample_series(xs, ys, MAXP)

        self.assertIsNone(info, "未超限时 info 必须为 None")
        self.assertIs(x2, xs, "未超限时应原样返回同一个 x 对象")
        self.assertIs(y2, ys, "未超限时应原样返回同一个 y 对象")
        self.assertIsNone(e2)

    # ---------------- 边界：不能抛异常 ----------------
    def test_mismatched_lengths_no_raise(self):
        """x/y 长度不等时不得抛异常。"""
        try:
            out = downsample.downsample_series([1.0, 2.0, 3.0], [1.0, 2.0], MAXP)
        except Exception as e:  # noqa: BLE001
            self.fail("长度不等时抛了异常：%s: %s" % (type(e).__name__, e))
        self.assertEqual(len(out), 4, "应返回 (x, y, yerr, info) 四元组")
        self.assertIsNone(out[3])

    def test_empty_no_raise(self):
        """空序列直接返回，不抛异常。"""
        try:
            x2, y2, e2, info = downsample.downsample_series([], [], MAXP)
        except Exception as e:  # noqa: BLE001
            self.fail("空序列抛了异常：%s: %s" % (type(e).__name__, e))
        self.assertEqual((x2, y2, e2, info), ([], [], None, None))

    def test_all_none_no_raise(self):
        """全 None 序列没有有效段，原样返回且 info 为 None。"""
        xs = [None] * 30000
        ys = [None] * 30000
        try:
            x2, y2, _e2, info = downsample.downsample_series(xs, ys, MAXP)
        except Exception as e:  # noqa: BLE001
            self.fail("全 None 序列抛了异常：%s: %s" % (type(e).__name__, e))
        self.assertIsNone(info, "没有有效段时 info 应为 None")
        self.assertEqual(len(x2), 30000)
        self.assertEqual(len(y2), 30000)

    def test_all_none_y_only_no_raise(self):
        """x 正常、y 全 None：同样不能抛异常。"""
        xs = [float(i) for i in range(30000)]
        ys = [None] * 30000
        try:
            x2, _y2, _e2, info = downsample.downsample_series(xs, ys, MAXP)
        except Exception as e:  # noqa: BLE001
            self.fail("y 全 None 时抛了异常：%s: %s" % (type(e).__name__, e))
        self.assertIsNone(info)
        self.assertEqual(len(x2), 30000)


if __name__ == "__main__":
    unittest.main(verbosity=2)
