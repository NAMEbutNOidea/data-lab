# -*- coding: utf-8 -*-
"""序列降采样：用 LTTB 保留曲线形状，替代"直接砍尾巴"。

背景
----
原先 ``_sanitize_spec`` 对每个序列做 ``[:20000]``，也就是只保留前 2 万个点。
数据量一大（比如 20 万点的光谱扫描），画出来的其实只是前 10% 的区间，
而且界面上没有任何提示——用户会以为看到的是全量数据。这是数据正确性问题。

做法
----
- 点数没超上限：原样返回，不做任何改动。
- 超了：用 LTTB（Largest-Triangle-Three-Buckets）按三角形面积挑代表点。
  它在视觉上几乎与原曲线重合，比等距抽稀更不容易丢掉尖峰。
- **保留 NaN/None 造成的断段**：先把序列按"连续有效段"切开，逐段降采样，
  段之间补回 None，这样曲线该断的地方还是断的。
- 同时把 ``yerr`` 按同样的索引取子集，保证 x/y/yerr 仍然对齐。
"""

from __future__ import annotations

import numpy as np

# 每个序列保留的最大点数。与前端 MAX_ROWS 是两回事，这里只管"画多少点"。
MAX_POINTS = 20000


def _segments(xs, ys):
    """把序列切成连续有效段，返回 [(start, end), ...]（end 不含）。"""
    segs = []
    start = None
    for i, (xv, yv) in enumerate(zip(xs, ys)):
        good = isinstance(xv, (int, float)) and isinstance(yv, (int, float))
        if good and start is None:
            start = i
        elif not good and start is not None:
            segs.append((start, i))
            start = None
    if start is not None:
        segs.append((start, len(xs)))
    return segs


def _lttb_indices(x, y, threshold):
    """LTTB 主体：在长度 n 的数组上挑 threshold 个点的索引（相对下标）。"""
    n = len(x)
    if threshold >= n or threshold < 3:
        return list(range(n))

    sampled = [0]
    bucket = (n - 2) / (threshold - 2)
    a = 0

    for i in range(threshold - 2):
        # 下一个桶的均值点（用来算三角形面积）
        avg_lo = int(np.floor((i + 1) * bucket)) + 1
        avg_hi = int(np.floor((i + 2) * bucket)) + 1
        avg_hi = min(avg_hi, n)
        if avg_lo >= n:
            avg_lo = n - 1
        if avg_hi <= avg_lo:
            avg_hi = min(avg_lo + 1, n)
        avg_x = float(np.mean(x[avg_lo:avg_hi]))
        avg_y = float(np.mean(y[avg_lo:avg_hi]))

        # 当前桶的候选范围
        lo = int(np.floor(i * bucket)) + 1
        hi = int(np.floor((i + 1) * bucket)) + 1
        hi = min(hi, n - 1)
        if hi <= lo:
            hi = min(lo + 1, n - 1)

        px, py = float(x[a]), float(y[a])
        # 用 numpy 一次性算完这个桶里所有点的三角形面积，比逐点 Python 循环快一个数量级
        bx = x[lo:hi]
        by = y[lo:hi]
        if bx.size:
            areas = np.abs((px - avg_x) * (by - py) - (px - bx) * (avg_y - py))
            best = lo + int(np.argmax(areas))
        else:
            best = lo
        sampled.append(best)
        a = best

    sampled.append(n - 1)
    return sampled


def downsample_series(x, y, max_points: int = MAX_POINTS, yerr=None):
    """按需降采样一条序列。

    参数
    ----
    x, y : list
        已经洗过 NaN 的序列（无效值是 ``None``），长度应一致。
    max_points : int
        目标点数上限。
    yerr : list | None
        误差棒，按同一索引取子集。

    返回
    ----
    (x2, y2, yerr2, info)
        ``info`` 为 ``None`` 表示未做处理；否则是
        ``{"original": 原始有效点数, "kept": 保留点数, "method": "lttb", "segments": 段数}``。
    """
    n = len(x)
    if n == 0:
        return x, y, yerr, None

    segs = _segments(x, y)
    total_good = sum(e - s for s, e in segs)
    if total_good <= max_points or not segs:
        return x, y, yerr, None

    has_yerr = isinstance(yerr, list) and len(yerr) == n

    # 按段长比例分配预算，每段至少 2 点（LTTB 需要首尾）
    counts = [e - s for s, e in segs]
    budget = []
    left = max_points
    for idx, c in enumerate(counts):
        if idx == len(counts) - 1:
            budget.append(max(2, min(c, left)))
        else:
            take = max(2, int(round(max_points * c / total_good)))
            take = min(take, c)
            budget.append(take)
            left -= take
    # 预算可能超支或剩太多，做一次收尾修正
    over = sum(budget) - max_points
    if over > 0:
        for i in range(len(budget) - 1, -1, -1):
            if over <= 0:
                break
            room = budget[i] - 2
            cut = min(room, over)
            budget[i] -= cut
            over -= cut

    out_x, out_y, out_e = [], [], []
    kept = 0
    for si, (s, e) in enumerate(segs):
        seg_x = np.asarray(x[s:e], dtype=float)
        seg_y = np.asarray(y[s:e], dtype=float)
        idx = _lttb_indices(seg_x, seg_y, budget[si])
        if si > 0:
            # 段与段之间原本隔着无效值，这里补回 None，曲线该断的地方仍然断
            out_x.append(None)
            out_y.append(None)
            if has_yerr:
                out_e.append(None)
        for j in idx:
            out_x.append(x[s + j])
            out_y.append(y[s + j])
            if has_yerr:
                out_e.append(yerr[s + j])
        kept += len(idx)

    info = {
        "original": int(total_good),
        "kept": int(kept),
        "method": "lttb",
        "segments": len(segs),
    }
    return out_x, out_y, (out_e if has_yerr else yerr), info
