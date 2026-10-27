# -*- coding: utf-8 -*-
"""列数据变换。

对一列数值做常用变换：取对数、归一化、基线扣除、移动平均平滑、数值求导。

约定：
    * 只用模块级纯函数，不写文件、不读全局状态；
    * 输出与输入**等长**，无法计算的位置给 ``None``（前端按行对齐）；
    * 入参允许含 ``None`` / ``nan``，内部统一转成 ``np.nan`` 表示缺失。
"""

from __future__ import annotations

import math
import os

# 与 fit_engine 同因：本机 Intel OpenMP/MKL 与 numpy 自带 OpenBLAS 冲突，
# 会让 dgemm 以原生异常 0xC06D007F 直接杀进程，必须在 import numpy 前固定线程层。
os.environ.setdefault("MKL_THREADING_LAYER", "SEQUENTIAL")

import numpy as np


# --------------------------------------------------------------------------
# 变换注册表：给前端渲染下拉框与参数表单用
# --------------------------------------------------------------------------
OPS = {
    "log10": {
        "name": "常用对数 lg",
        "params": [],
    },
    "ln": {
        "name": "自然对数 ln",
        "params": [],
    },
    "normalize_max": {
        "name": "归一化（除以最大值）",
        "params": [],
    },
    "normalize_minmax": {
        "name": "归一化（0~1 最小-最大）",
        "params": [],
    },
    "baseline_first": {
        "name": "基线扣除（减首值）",
        "params": [],
    },
    "baseline_mean": {
        "name": "基线扣除（减区间均值）",
        "params": [
            {"key": "start", "label": "起始行", "type": "int", "default": 0},
            {"key": "end", "label": "结束行", "type": "int", "default": 10},
        ],
    },
    "smooth_ma": {
        "name": "移动平均平滑",
        "params": [
            {"key": "window", "label": "窗口点数", "type": "int", "default": 5},
        ],
    },
    "derivative": {
        "name": "数值求导 dy/dx",
        "params": [
            {"key": "order", "label": "阶数", "type": "int", "default": 1},
        ],
    },
}


# --------------------------------------------------------------------------
# 数值工具
# --------------------------------------------------------------------------
def _f(x):
    """numpy -> 原生 float，NaN/inf/非数值 -> None"""
    try:
        v = float(x)
    except Exception:
        return None
    if math.isnan(v) or math.isinf(v):
        return None
    return v


def _num(v) -> str:
    """6 位有效数字的展示文本。"""
    return "%.6g" % float(v)


def _to_array(values) -> np.ndarray:
    """任意序列（可含 None / nan / 数字字符串）-> float 数组，缺失为 nan。"""
    if values is None:
        return np.empty(0, dtype=float)
    arr = np.empty(len(values), dtype=float)
    for i, v in enumerate(values):
        f = _f(v)
        arr[i] = np.nan if f is None else f
    return arr


def _to_list(arr: np.ndarray) -> list:
    """float 数组 -> 原生列表，非有限值转 None。"""
    return [None if not np.isfinite(v) else float(v) for v in arr]


def _int_param(params, key, default) -> int:
    """从 params 里取整数参数，缺失或非法时用默认值。"""
    if not params:
        return int(default)
    try:
        return int(params.get(key, default))
    except Exception:
        return int(default)


# --------------------------------------------------------------------------
# 各变换实现：输入 float 数组，返回 (结果数组, 附注文本)
# --------------------------------------------------------------------------
def _t_log(a, base):
    good = np.isfinite(a) & (a > 0)
    out = np.full(a.size, np.nan)
    with np.errstate(all="ignore"):
        out[good] = np.log10(a[good]) if base == 10 else np.log(a[good])
    dropped = int(np.sum(np.isfinite(a) & ~good))
    note = "%d 个非正值无法取对数，已置空" % dropped if dropped else ""
    return out, note


def _t_normalize_max(a):
    finite = np.isfinite(a)
    if not finite.any():
        return np.full(a.size, np.nan), "该列没有有效数值"
    peak = float(np.max(np.abs(a[finite])))
    if peak == 0.0:
        return np.full(a.size, np.nan), "最大绝对值为 0，无法归一化，已全部置空"
    out = np.full(a.size, np.nan)
    out[finite] = a[finite] / peak
    return out, "已除以最大绝对值 %s" % _num(peak)


def _t_minmax(a):
    finite = np.isfinite(a)
    if not finite.any():
        return np.full(a.size, np.nan), "该列没有有效数值"
    lo = float(np.min(a[finite]))
    hi = float(np.max(a[finite]))
    out = np.full(a.size, np.nan)
    if hi == lo:
        out[finite] = 0.0
        return out, "最大值与最小值相等，已全部置 0"
    out[finite] = (a[finite] - lo) / (hi - lo)
    return out, "按最小值 %s、最大值 %s 归一化" % (_num(lo), _num(hi))


def _t_baseline_first(a):
    finite = np.isfinite(a)
    if not finite.any():
        return np.full(a.size, np.nan), "该列没有有效数值"
    base = float(a[finite][0])
    out = np.full(a.size, np.nan)
    out[finite] = a[finite] - base
    return out, "已减去首个有效值 %s" % _num(base)


def _t_baseline_mean(a, start, end):
    n = a.size
    finite = np.isfinite(a)
    out = np.full(n, np.nan)
    if not finite.any():
        return out, "该列没有有效数值"
    lo = min(max(int(start), 0), n)
    hi = min(max(int(end), 0), n)
    seg = np.zeros(n, dtype=bool)
    seg[lo:hi] = True
    sel = finite & seg
    if sel.any():
        base = float(np.mean(a[sel]))
        note = "基线取第 %d~%d 行（含头不含尾）的均值 %s" % (lo, hi, _num(base))
    else:
        base = float(a[finite][0])
        note = "第 %d~%d 行（含头不含尾）无有效值，已退回首值 %s 作为基线" % (
            lo, hi, _num(base))
    out[finite] = a[finite] - base
    return out, note


def _t_smooth_ma(a, window):
    n = a.size
    w = max(1, int(window))
    if n == 0:
        return a.copy(), "空列"
    # 居中窗口：奇数窗口左右对称，偶数窗口左侧少一点
    left = (w - 1) // 2
    right = w - 1 - left
    finite = np.isfinite(a)
    vals = np.where(finite, a, 0.0).astype(float)
    cs = np.concatenate(([0.0], np.cumsum(vals)))
    cc = np.concatenate(([0], np.cumsum(finite.astype(np.int64))))
    idx = np.arange(n)
    lo = np.maximum(0, idx - left)
    hi = np.minimum(n - 1, idx + right)
    s = cs[hi + 1] - cs[lo]
    c = cc[hi + 1] - cc[lo]
    out = np.full(n, np.nan)
    ok = c > 0
    out[ok] = s[ok] / c[ok]
    if w == 1:
        return out, "窗口为 1，等同于原值"
    return out, "窗口 %d 点居中滑动平均，两端按可用点求均值" % w


def _t_derivative(a, order, x):
    n = a.size
    if order not in (1, 2):
        raise ValueError("求导阶数只支持 1 或 2")
    if n < order + 1:
        return np.full(n, np.nan), "数据点不足（仅 %d 个），无法计算 %d 阶导数" % (n, order)

    xx = None
    if x is not None:
        xx = _to_array(x)
        if xx.size != n:
            raise ValueError("自变量 x 与数据的长度必须一致（%d 与 %d）" % (xx.size, n))
        if not np.all(np.isfinite(xx)):
            xx = None  # 自变量有缺失，退回按索引求导

    try:
        with np.errstate(all="ignore"):
            # np.gradient 对一维只接受一个 spacing，二阶导用两次一阶中心差分实现。
            out = np.gradient(a, xx) if xx is not None else np.gradient(a)
            if order == 2:
                out = np.gradient(out, xx) if xx is not None else np.gradient(out)
    except Exception:
        return np.full(n, np.nan), "求导失败：数据点或自变量不满足求导条件"

    if xx is not None:
        note = "按 dy/dx 求 %d 阶导，首尾用单侧差分" % order
    else:
        note = "未提供 x，按索引差分为 dy/di（%d 阶）" % order
    if not np.isfinite(out).any():
        note = "求导结果全为空：数据点不足或缺失过多"
    return out, note


# --------------------------------------------------------------------------
# 对外入口
# --------------------------------------------------------------------------
def apply(values, op, params=None, x=None):
    """对一列值做变换，返回 ``(新值列表, info_dict)``。

    参数
    ----
    values : list
        原始列（可含 ``None`` / ``nan``）
    op : str
        ``OPS`` 中的变换 id
    params : dict | None
        变换参数，如 ``{"window": 5}``、``{"start": 0, "end": 10}``
    x : list | None
        自变量，仅 ``derivative`` 用到；缺省时按索引求导

    返回
    ----
    (list, dict)
        新值列表与输入等长，无法计算处为 ``None``；
        ``info`` 形如 ``{"op": "log10", "dropped": 3, "note": "3 个非正值无法取对数，已置空"}``

    异常
    ---
    ValueError : 未知变换 id、求导阶数非法、x 与数据长度不一致
    """
    key = (op or "").strip()
    if key not in OPS:
        raise ValueError("不支持的变换：%s" % op)

    a = _to_array(values)
    p = params or {}

    if key == "log10":
        out, note = _t_log(a, 10)
    elif key == "ln":
        out, note = _t_log(a, math.e)
    elif key == "normalize_max":
        out, note = _t_normalize_max(a)
    elif key == "normalize_minmax":
        out, note = _t_minmax(a)
    elif key == "baseline_first":
        out, note = _t_baseline_first(a)
    elif key == "baseline_mean":
        out, note = _t_baseline_mean(
            a, _int_param(p, "start", 0), _int_param(p, "end", 10))
    elif key == "smooth_ma":
        out, note = _t_smooth_ma(a, _int_param(p, "window", 5))
    else:  # derivative
        out, note = _t_derivative(a, _int_param(p, "order", 1), x)

    dropped = int(np.sum(np.isfinite(a) & ~np.isfinite(out)))
    return _to_list(out), {"op": key, "dropped": dropped, "note": note}


__all__ = ["OPS", "apply"]
