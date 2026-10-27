# -*- coding: utf-8 -*-
"""公式拼装自检：9 个模型的纯文本 / LaTeX 两版输出 + mathtext 可渲染性。

用法：python launcher/eq_check.py
"""
import os
os.environ.setdefault("MKL_THREADING_LAYER", "SEQUENTIAL")

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

from core.fit_engine import _equation, MODELS

# 每个模型给一组有代表性的参数值（含科学计数的情况）
CASES = {
    "linear":       ([0.4604, 0.03525], 1),
    "poly":         ([1.2e-5, -3.4, 0.88], 2),
    "exp":          ([0.4604, -0.1305], 1),
    "exp_offset":   ([0.4604, -0.1305, 0.03525], 1),
    "power":        ([2.5, -0.75], 1),
    "log":          ([1.8, -0.42], 1),
    "gaussian":     ([1.0, 0.5, 0.12], 1),
    "lorentz":      ([1.0, 0.35, 0.08], 1),
    "sine":         ([1.2, 6.283, -0.5, 0.1], 1),
}

fig = plt.figure(figsize=(8, 1))
bad = []
print("%-12s %-44s %s" % ("model", "plain", "latex"))
print("-" * 110)

for mid in MODELS:
    if mid not in CASES:
        print("%-12s (跳过：无测试用例)" % mid)
        continue
    vals, deg = CASES[mid]
    tp, tl = _equation(mid, vals, deg)
    print("%-12s %-44s %s" % (mid, tp, tl))

    # mathtext 渲染校验：plot_engine 标注就是这么用的
    try:
        t = fig.text(0.05, 0.5, "$%s$" % tl.strip("$"))
        fig.canvas.draw()
        t.remove()
    except Exception as e:
        bad.append((mid, type(e).__name__, str(e)[:120]))

plt.close(fig)

print("-" * 110)
if bad:
    print("mathtext 渲染失败：")
    for mid, kind, msg in bad:
        print("  [%s] %s: %s" % (mid, kind, msg))
    sys.exit(1)
print("全部 %d 个模型的 LaTeX 均可被 matplotlib mathtext 渲染" % len(CASES))
