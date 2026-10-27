# -*- coding: utf-8 -*-
"""core/dataloader.py 时间列识别相关的单元测试。

独立运行：``python tests/test_dataloader.py``
"""

from __future__ import annotations

import os
import sys

os.environ.setdefault("MKL_THREADING_LAYER", "SEQUENTIAL")
os.environ.setdefault("KMP_DUPLICATE_LIB_OK", "TRUE")

import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import pandas as pd  # noqa: E402

from core import dataloader  # noqa: E402


def _dtype_of(df, col):
    for c in dataloader.infer_columns(df):
        if c["name"] == col:
            return c["dtype"]
    raise AssertionError("列 %s 不在 infer_columns 里" % col)


class TestDatetimeInfer(unittest.TestCase):
    """日期列要认出来，长得像日期的测量值不能认成日期。"""

    def test_plain_date_column(self):
        """纯日期列：dtype=datetime，column_values 返回 ISO 字符串。"""
        df = pd.DataFrame({
            "日期": ["2024-01-01", "2024-01-02", "2024-01-03", "2024-01-04"],
            "读数": [1.0, 2.0, 3.0, 4.0],
        })
        self.assertEqual(_dtype_of(df, "日期"), "datetime",
                         "日期列未被识别成 datetime")
        vals = dataloader.column_values(df, "日期")
        self.assertEqual(vals, ["2024-01-01", "2024-01-02", "2024-01-03", "2024-01-04"],
                         "ISO 字符串不符：%r" % (vals,))

    def test_datetime_with_time_and_missing(self):
        """带时分秒的列：ISO 里带 T；无效位置为 None，且与整列等长。"""
        df = pd.DataFrame({
            "时刻": ["2024-03-05 08:30:00", "2024-03-05 09:45:10", None,
                     "2024-03-05 11:00:00"],
        })
        self.assertEqual(_dtype_of(df, "时刻"), "datetime")
        vals = dataloader.column_values(df, "时刻")
        self.assertEqual(len(vals), 4, "日期列取值应与整列等长（含 None 占位）")
        self.assertEqual(vals[0], "2024-03-05T08:30:00")
        self.assertEqual(vals[1], "2024-03-05T09:45:10")
        self.assertIsNone(vals[2], "空单元格应映射为 None")
        self.assertEqual(vals[3], "2024-03-05T11:00:00")

    def test_ratio_like_values_are_text(self):
        """反例：'1-2' / '3/4' / '5-6' 是测量值，不能判成 datetime。"""
        df = pd.DataFrame({"比值": ["1-2", "3/4", "5-6", "7-8", "9-10"]})
        dtype = _dtype_of(df, "比值")
        self.assertEqual(dtype, "text",
                         "比值型字符串被误判成 %r" % (dtype,))

    def test_partial_60_percent_is_text(self):
        """只有 60% 能解析成日期的列必须判成 text（阈值 80%）。"""
        df = pd.DataFrame({
            "部分日期": ["2024-01-01", "2024-01-02", "2024-01-03", "abc", "xyz"],
        })
        dtype = _dtype_of(df, "部分日期")
        self.assertEqual(dtype, "text",
                         "60%% 命中率的列被误判成 %r（阈值应为 80%%）" % (dtype,))

    def test_partial_80_percent_is_datetime(self):
        """80% 恰好达到阈值，应判成 datetime（边界另一侧）。"""
        df = pd.DataFrame({
            "八成日期": ["2024-01-01", "2024-01-02", "2024-01-03", "2024-01-04", "abc"],
        })
        self.assertEqual(_dtype_of(df, "八成日期"), "datetime")

    def test_numeric_column_unchanged(self):
        """普通数值列仍然是 numeric，取值是 float 列表。"""
        df = pd.DataFrame({"温度": [23.5, 24.1, 22.8, 25.0]})
        self.assertEqual(_dtype_of(df, "温度"), "numeric")
        self.assertEqual(dataloader.column_values(df, "温度"), [23.5, 24.1, 22.8, 25.0])

    def test_text_column_unchanged(self):
        """普通文本列仍然是 text，且不能参与数值计算。"""
        df = pd.DataFrame({"样品": ["A", "B", "C"]})
        self.assertEqual(_dtype_of(df, "样品"), "text")
        with self.assertRaises(ValueError):
            dataloader.column_values(df, "样品")

    def test_infer_columns_meta_fields(self):
        """infer_columns 的名称/单位/缺失统计保持原样。"""
        df = pd.DataFrame({
            "光强 I(lx)": [0.5, 1.0, 1.5],
            "样品": ["A", "A", None],
        })
        cols = {c["name"]: c for c in dataloader.infer_columns(df)}
        self.assertEqual(cols["光强 I(lx)"]["base"], "光强 I")
        self.assertEqual(cols["光强 I(lx)"]["unit"], "lx")
        self.assertEqual(cols["光强 I(lx)"]["dtype"], "numeric")
        self.assertEqual(cols["样品"]["dtype"], "text")
        self.assertEqual(cols["样品"]["n_missing"], 1)


if __name__ == "__main__":
    unittest.main(verbosity=2)
