# -*- coding: utf-8 -*-
"""统计与不确定度计算引擎。

本模块只包含**模块级纯函数**，不写 class、不读全局状态、不写文件。
所有数值返回前统一转成 Python 原生 float；NaN / inf 一律转成 None，
保证结果可以直接 ``json.dumps(..., allow_nan=False)``。

依赖：numpy、scipy（仅 scipy.stats）。
"""

from __future__ import annotations

import math
import os

# 本机 conda 环境的 Intel OpenMP/MKL 线程层与 numpy 自带 OpenBLAS 冲突，
# 会导致 dgemm / LAPACK 以原生异常 0xC06D007F 直接终止进程（Python 无法 try 捕获）。
# 必须在 import numpy 之前把 MKL 线程层固定为顺序执行，否则整个服务会崩。
os.environ.setdefault("MKL_THREADING_LAYER", "SEQUENTIAL")

import numpy as np
from scipy import stats


# --------------------------------------------------------------------------
# 数值转换工具（契约第 3 节，各模块自行复制，不跨模块 import）
# --------------------------------------------------------------------------
def _f(x):
    """numpy -> 原生 float，NaN/inf -> None"""
    try:
        v = float(x)
    except Exception:
        return None
    if math.isnan(v) or math.isinf(v):
        return None
    return v


def _arr(values, name="数据"):
    """把用户输入转成一维 float 数组，过滤 NaN/inf。

    参数
    ----
    values : 可迭代数值
    name : 出错信息里显示的变量名

    返回
    ----
    numpy.ndarray（已去除非有限值）

    异常
    ----
    ValueError : 无有效数据或有效数据少于 2 个
    """
    if values is None:
        raise ValueError("样本量不足，至少需要 2 个有效数据点")
    try:
        a = np.asarray(list(values), dtype=float).ravel()
    except Exception:
        raise ValueError("数据格式有误，无法转换为数值序列")
    if a.size == 0:
        raise ValueError("样本量不足，至少需要 2 个有效数据点")
    a = a[np.isfinite(a)]
    if a.size < 2:
        raise ValueError("样本量不足，至少需要 2 个有效数据点")
    return a


def _pair(x, y):
    """把 x、y 配对成等长数组，成对去除非有限值。

    配对类检验（配对 t、Wilcoxon、相关分析）要求两列**逐行对应**，
    长度不一致直接报错，避免静默截断造成数据丢失。
    """
    if x is None or y is None:
        raise ValueError("该检验需要两组数据（x 与 y）")
    try:
        ax = np.asarray(list(x), dtype=float).ravel()
        ay = np.asarray(list(y), dtype=float).ravel()
    except Exception:
        raise ValueError("数据格式有误，无法转换为数值序列")
    if ax.size != ay.size:
        raise ValueError("配对检验要求 x 与 y 长度相同（当前 %d 与 %d）"
                         % (ax.size, ay.size))
    mask = np.isfinite(ax) & np.isfinite(ay)
    ax, ay = ax[mask], ay[mask]
    if ax.size < 2:
        raise ValueError("样本量不足，至少需要 2 个有效数据点")
    return ax, ay


def _p_str(p):
    """p 值显示：不小于 1e-4 用 4 位小数，否则用科学计数法。"""
    if p is None:
        return "p = NA"
    if p <= 0:
        return "p < 1e-16"
    if p >= 1e-4:
        return "p = %.4f" % p
    return "p = %.2e" % p


# --------------------------------------------------------------------------
# 描述统计
# --------------------------------------------------------------------------
def describe(values):
    """计算一组数据的完整描述统计量。

    参数
    ----
    values : list[float]

    返回
    ----
    dict
        ``n, sum, mean, median, mode, std, std_err, variance, cv, min, max,
        range, q1, q3, iqr, skewness, kurtosis, ci95_low, ci95_high``

    说明
    ----
    - ``std`` / ``variance`` 为样本统计量（ddof=1）
    - ``cv = std / mean``，均值接近 0 时返回 None
    - ``skewness`` / ``kurtosis`` 用 bias=False 的无偏估计，峰度为超额峰度（fisher=True）
    - ``ci95`` 用 t 分布：``mean ± t.ppf(0.975, n-1) * std_err``
    """
    a = _arr(values)
    n = int(a.size)
    mean = float(np.mean(a))
    std = float(np.std(a, ddof=1))
    var = float(np.var(a, ddof=1))
    std_err = std / math.sqrt(n)
    median = float(np.median(a))
    q1 = float(np.percentile(a, 25))
    q3 = float(np.percentile(a, 75))
    mn, mx = float(np.min(a)), float(np.max(a))

    # 众数：出现次数最多的值，多众数时 scipy 返回最小值
    try:
        mode_v = float(stats.mode(a, keepdims=False).mode)
    except Exception:
        mode_v = None

    # 偏度 / 峰度：n < 3 时无偏估计无定义
    skew_v = _f(stats.skew(a, bias=False)) if n >= 3 else None
    kurt_v = _f(stats.kurtosis(a, fisher=True, bias=False)) if n >= 4 else None

    # 95% 置信区间（t 分布）
    if n >= 2 and std_err > 0:
        half = float(stats.t.ppf(0.975, n - 1) * std_err)
        ci_low, ci_high = mean - half, mean + half
    elif n >= 2:
        ci_low = ci_high = mean
    else:
        ci_low = ci_high = None

    return {
        "n": n,
        "sum": _f(np.sum(a)),
        "mean": _f(mean),
        "median": _f(median),
        "mode": _f(mode_v),
        "std": _f(std),
        "std_err": _f(std_err),
        "variance": _f(var),
        "cv": _f(std / mean) if abs(mean) > 1e-12 else None,
        "min": _f(mn),
        "max": _f(mx),
        "range": _f(mx - mn),
        "q1": _f(q1),
        "q3": _f(q3),
        "iqr": _f(q3 - q1),
        "skewness": skew_v,
        "kurtosis": kurt_v,
        "ci95_low": _f(ci_low),
        "ci95_high": _f(ci_high),
    }


# --------------------------------------------------------------------------
# 不确定度评定
# --------------------------------------------------------------------------
def uncertainty_type_a(values):
    """A 类标准不确定度：由重复测量的统计分散性评定。

    ``u_A = s / sqrt(n)``，其中 s 为样本标准差（ddof=1）。

    参数
    ----
    values : list[float]  重复测量值

    返回
    ----
    dict
        ``n, mean, s, u_a, formula``
    """
    a = _arr(values)
    n = int(a.size)
    mean = float(np.mean(a))
    s = float(np.std(a, ddof=1))
    u_a = s / math.sqrt(n)
    return {
        "n": n,
        "mean": _f(mean),
        "s": _f(s),
        "u_a": _f(u_a),
        "formula": "u_A = s / sqrt(n)",
    }


# 正态分布下置信概率 -> 包含因子 k
_NORMAL_K = {
    0.683: 1.0,
    0.6830: 1.0,
    0.95: 1.96,
    0.950: 1.96,
    0.9545: 2.0,
    0.99: 2.576,
    0.9973: 3.0,
}


def uncertainty_type_b(delta, distribution="uniform", confidence=0.683,
                       custom_k=None):
    """B 类标准不确定度：由仪器最大允差 / 说明书指标等先验信息评定。

    参数
    ----
    delta : float
        仪器最大允差（半宽 a）。为 0 时 u_B = 0。
    distribution : str
        ``uniform``（均匀/矩形，k=√3）、``triangular``（三角，k=√6）、
        ``normal``（正态，k 由 confidence 决定）、``rect_halfwidth``（矩形半宽，k=√3）
    confidence : float
        正态分布时的置信概率，支持 0.683 / 0.95 / 0.9545 / 0.99 / 0.9973
    custom_k : float | None
        自定义包含因子，非 None 时直接使用

    返回
    ----
    dict
        ``delta, distribution, k, u_b, formula, k_source``
    """
    try:
        d = abs(float(delta))
    except Exception:
        raise ValueError("最大允差 a 必须是数值")
    if math.isnan(d) or math.isinf(d):
        raise ValueError("最大允差 a 必须是有限数值")

    dist = (distribution or "uniform").strip().lower()
    if dist not in ("uniform", "triangular", "normal", "rect_halfwidth"):
        raise ValueError(
            "分布类型只能是 uniform / triangular / normal / rect_halfwidth")

    if custom_k is not None:
        try:
            k = float(custom_k)
        except Exception:
            raise ValueError("自定义包含因子 k 必须是数值")
        if k <= 0:
            raise ValueError("包含因子 k 必须大于 0")
        source = "自定义包含因子 k=%.4g" % k
    elif dist == "uniform":
        k = math.sqrt(3.0)
        source = "均匀（矩形）分布 k=√3"
    elif dist == "rect_halfwidth":
        k = math.sqrt(3.0)
        source = "矩形分布半宽 a，k=√3"
    elif dist == "triangular":
        k = math.sqrt(6.0)
        source = "三角分布 k=√6"
    else:  # normal
        try:
            c = float(confidence)
        except Exception:
            raise ValueError("置信概率必须是数值")
        k = None
        for key, val in _NORMAL_K.items():
            if abs(c - key) < 1e-9:
                k = val
                break
        if k is None:
            if not (0.0 < c < 1.0):
                raise ValueError("置信概率必须在 0 与 1 之间")
            k = float(stats.norm.ppf(0.5 + c / 2.0))
            source = "正态分布 P=%.4g → k=%.4g（由分位数计算）" % (c, k)
        else:
            source = "正态分布 P=%.4g → k=%.4g" % (c, k)

    u_b = d / k if k > 0 else 0.0
    return {
        "delta": _f(d),
        "distribution": dist,
        "k": _f(k),
        "u_b": _f(u_b),
        "formula": "u_B = a / k",
        "k_source": source,
    }


def combine_uncertainty(components, coverage_k=2.0):
    """合成标准不确定度与扩展不确定度。

    ``u_C = sqrt(Σ u_i²)``，``U = k · u_C``。None 分量自动跳过。

    参数
    ----
    components : list[float]  各不确定度分量
    coverage_k : float        包含因子（默认 2）

    返回
    ----
    dict
        ``u_c, coverage_k, U, relative, formula``
    """
    if components is None:
        raise ValueError("请提供至少一个不确定度分量")
    vals = []
    for c in components:
        v = _f(c)
        if v is None:
            continue
        vals.append(abs(v))
    if not vals:
        raise ValueError("没有有效的不确定度分量")
    try:
        k = float(coverage_k)
    except Exception:
        raise ValueError("包含因子 k 必须是数值")
    if k <= 0:
        raise ValueError("包含因子 k 必须大于 0")

    u_c = math.sqrt(sum(v * v for v in vals))
    return {
        "u_c": _f(u_c),
        "coverage_k": _f(k),
        "U": _f(k * u_c),
        "relative": None,
        "formula": "u_C = sqrt(Σu_i²) , U = k·u_C",
    }


# 包含因子 -> 置信概率文字
_K_TO_P = {1.0: "68.3%", 1.96: "95%", 2.0: "95%", 2.576: "99%", 3.0: "99.7%"}


def _p_of_k(k):
    """把包含因子换算成置信概率文字。"""
    for key, txt in _K_TO_P.items():
        if abs(k - key) < 1e-9:
            return txt
    return "%.1f%%" % (100.0 * (2.0 * float(stats.norm.cdf(k)) - 1.0))


def _decimals_of(u):
    """按扩展不确定度保留 2 位有效数字，决定平均值与 U 的小数位数。"""
    if u is None or u <= 0:
        return 3
    e = math.floor(math.log10(u))
    return int(max(0, min(6, 1 - e)))


def full_uncertainty(values, delta=None, distribution="uniform",
                     confidence=0.683, custom_k=None, coverage_k=2.0):
    """不确定度综合评定报告（A 类 + B 类 + 合成 + 扩展）。

    参数
    ----
    values : list[float]   重复测量值（A 类评定用）
    delta : float | None   仪器最大允差；为 None 时不评 B 类，u_C = u_A
    distribution / confidence / custom_k : 同 ``uncertainty_type_b``
    coverage_k : float     扩展不确定度的包含因子

    返回
    ----
    dict
        ``mean, n, s, u_a, u_b, u_c, coverage_k, U, relative_U, result_str``
    """
    ta = uncertainty_type_a(values)
    mean = ta["mean"]
    n = ta["n"]
    s = ta["s"]
    u_a = ta["u_a"]

    u_b = None
    k_source = None
    if delta is not None:
        tb = uncertainty_type_b(delta, distribution=distribution,
                                confidence=confidence, custom_k=custom_k)
        u_b = tb["u_b"]
        k_source = tb["k_source"]

    if u_b is None:
        u_c = u_a
        k = float(coverage_k)
    else:
        cu = combine_uncertainty([u_a, u_b], coverage_k=coverage_k)
        u_c = cu["u_c"]
        k = cu["coverage_k"]

    U = None if (u_c is None or k is None) else k * u_c

    # 相对扩展不确定度
    if U is not None and mean is not None and abs(mean) > 1e-12:
        relative_U = U / abs(mean)
    else:
        relative_U = None

    # 结果表达："12.345 ± 0.012 (k=2, P=95%)"
    if mean is None or U is None:
        result_str = "无法计算（数据异常）"
    else:
        d = _decimals_of(U)
        result_str = "%.*f ± %.*f (k=%g, P=%s)" % (
            d, mean, d, U, k, _p_of_k(k))

    return {
        "mean": _f(mean),
        "n": int(n),
        "s": _f(s),
        "u_a": _f(u_a),
        "u_b": _f(u_b),
        "u_c": _f(u_c),
        "coverage_k": _f(k),
        "U": _f(U),
        "relative_U": _f(relative_U),
        "result_str": result_str,
        "delta": _f(delta),
        "distribution": distribution,
        "k_source": k_source,
    }


# --------------------------------------------------------------------------
# 假设检验
# --------------------------------------------------------------------------
# 检验 id -> (中文名, 原假设, 备择假设, 显著时的结论短语)
_TEST_META = {
    "ttest_1samp": ("单样本 t 检验", "样本均值等于给定值", "样本均值不等于给定值",
                    "样本均值与给定值差异显著"),
    "ttest_ind": ("独立样本 t 检验", "两总体均值相等", "两总体均值不等",
                  "两组均值差异显著"),
    "ttest_rel": ("配对样本 t 检验", "配对差值均值为 0", "配对差值均值不为 0",
                  "配对前后差异显著"),
    "ftest": ("F 检验（方差比）", "两总体方差相等", "两总体方差不等",
              "两组方差差异显著"),
    "anova": ("单因素方差分析", "各组均值相等", "至少一组均值不同",
              "各组均值差异显著"),
    "shapiro": ("Shapiro-Wilk 正态性检验", "数据服从正态分布", "数据不服从正态分布",
                "数据不服从正态分布"),
    "levene": ("Levene 方差齐性检验", "各组方差相等", "各组方差不等",
               "各组方差不齐"),
    "pearson": ("Pearson 相关检验", "两变量无线性相关", "两变量存在线性相关",
                "两变量存在显著线性相关"),
    "spearman": ("Spearman 秩相关检验", "两变量无单调相关", "两变量存在单调相关",
                 "两变量存在显著单调相关"),
    "mannwhitney": ("Mann-Whitney U 检验", "两组分布位置相同", "两组分布位置不同",
                    "两组分布位置差异显著"),
    "wilcoxon": ("Wilcoxon 符号秩检验", "配对差值中位数为 0", "配对差值中位数不为 0",
                 "配对差值中位数显著不为 0"),
    "chisq_gof": ("卡方拟合优度检验", "观测频数与期望频数一致", "观测频数与期望频数不一致",
                  "观测频数与期望频数差异显著"),
}


def _result(test, statistic, p_value, dof, alpha, effect_size,
            effect_size_name, h0, h1):
    """组装统一的假设检验返回结构。"""
    name, _h0, _h1, sig_phrase = _TEST_META[test]
    stat_v = _f(statistic)
    p_v = _f(p_value)
    try:
        a = float(alpha)
    except Exception:
        raise ValueError("显著性水平 α 必须是数值")
    if not (0.0 < a < 1.0):
        raise ValueError("显著性水平 α 必须在 0 与 1 之间")

    significant = bool(p_v is not None and p_v < a)
    if p_v is None:
        conclusion = "p 值无法计算，结论不可靠"
    elif significant:
        conclusion = "%s < α = %g，拒绝原假设：%s" % (_p_str(p_v), a, sig_phrase)
    else:
        conclusion = "%s ≥ α = %g，不能拒绝原假设" % (_p_str(p_v), a)

    return {
        "test": test,
        "test_name": name,
        "statistic": stat_v,
        "p_value": p_v,
        "dof": dof,
        "alpha": _f(a),
        "significant": significant,
        "effect_size": _f(effect_size),
        "effect_size_name": effect_size_name,
        "h0": h0 if h0 is not None else _h0,
        "h1": h1 if h1 is not None else _h1,
        "conclusion": conclusion,
    }


def _welch_dof(a, b):
    """Welch-Satterthwaite 自由度。"""
    n1, n2 = a.size, b.size
    v1, v2 = np.var(a, ddof=1) / n1, np.var(b, ddof=1) / n2
    den = v1 * v1 / (n1 - 1) + v2 * v2 / (n2 - 1)
    if den <= 0:
        return float(n1 + n2 - 2)
    return float((v1 + v2) ** 2 / den)


def hypothesis_test(x, y=None, test="ttest_1samp", mu=0.0, alpha=0.05,
                    alternative="two-sided", equal_var=True):
    """统一假设检验入口。

    参数
    ----
    x, y : list[float]
        ``y`` 仅在双样本 / 配对 / 相关类检验中使用。
    test : str
        ``ttest_1samp | ttest_ind | ttest_rel | ftest | anova | shapiro |
        levene | pearson | spearman | mannwhitney | wilcoxon | chisq_gof``
    mu : float          单样本 t 检验的给定值
    alpha : float       显著性水平
    alternative : str   ``two-sided | less | greater``
    equal_var : bool    独立样本 t 检验是否假设方差齐性

    返回
    ----
    dict
        ``test, test_name, statistic, p_value, dof, alpha, significant,
        effect_size, effect_size_name, h0, h1, conclusion``
    """
    t = (test or "").strip()
    if t not in _TEST_META:
        raise ValueError("不支持的检验类型：%s" % test)
    alt = (alternative or "two-sided").strip()
    if alt not in ("two-sided", "less", "greater"):
        raise ValueError("alternative 只能是 two-sided / less / greater")

    # ---------------- 单样本 t 检验 ----------------
    if t == "ttest_1samp":
        a = _arr(x)
        try:
            mu_v = float(mu)
        except Exception:
            raise ValueError("给定值 μ 必须是数值")
        res = stats.ttest_1samp(a, mu_v, alternative=alt)
        std = float(np.std(a, ddof=1))
        d = (float(np.mean(a)) - mu_v) / std if std > 0 else None
        h0 = "样本均值等于 μ = %.4g" % mu_v
        h1 = "样本均值不等于 μ = %.4g" % mu_v
        return _result(t, res.statistic, res.pvalue, float(a.size - 1), alpha,
                       d, "Cohen's d", h0, h1)

    # ---------------- 卡方拟合优度 ----------------
    if t == "chisq_gof":
        a = _arr(x)
        if np.any(a < 0):
            raise ValueError("卡方拟合优度检验要求频数非负")
        if y is None:
            exp = np.full(a.size, float(np.sum(a)) / a.size)
        else:
            e = np.asarray(list(y), dtype=float).ravel()
            e = e[np.isfinite(e)]
            if e.size != a.size:
                raise ValueError("观测频数与期望频数长度必须一致")
            if np.any(e <= 0):
                raise ValueError("期望频数必须大于 0")
            exp = e
        res = stats.chisquare(a, exp)
        return _result(t, res.statistic, res.pvalue, float(a.size - 1), alpha,
                       None, None,
                       "观测频数与期望频数一致", "观测频数与期望频数不一致")

    # ---------------- 以下都需要两列数据 ----------------
    if t == "shapiro":
        a = _arr(x)
        res = stats.shapiro(a)
        return _result(t, res.statistic, res.pvalue, None, alpha, None, None,
                       "数据服从正态分布", "数据不服从正态分布")

    # 独立样本检验：两列各自清理（长度可以不同）
    if t in ("ttest_ind", "ftest", "anova", "levene", "mannwhitney"):
        if y is None:
            raise ValueError("该检验需要两组数据（x 与 y）")
        ax = _arr(x)
        ay = _arr(y)
    else:
        # 配对 / 相关类检验：要求两列逐行对应
        ax, ay = _pair(x, y)

    if t == "ttest_ind":
        res = stats.ttest_ind(ax, ay, equal_var=bool(equal_var),
                              alternative=alt)
        n1, n2 = ax.size, ay.size
        m1, m2 = float(np.mean(ax)), float(np.mean(ay))
        s1, s2 = float(np.var(ax, ddof=1)), float(np.var(ay, ddof=1))
        pooled = math.sqrt(((n1 - 1) * s1 + (n2 - 1) * s2) / (n1 + n2 - 2))
        d = (m1 - m2) / pooled if pooled > 0 else None
        dof = float(n1 + n2 - 2) if equal_var else _welch_dof(ax, ay)
        return _result(t, res.statistic, res.pvalue, dof, alpha, d, "Cohen's d",
                       "两总体均值相等", "两总体均值不等")

    if t == "ttest_rel":
        res = stats.ttest_rel(ax, ay, alternative=alt)
        diff = ax - ay
        sd = float(np.std(diff, ddof=1))
        d = float(np.mean(diff)) / sd if sd > 0 else None
        return _result(t, res.statistic, res.pvalue, float(ax.size - 1), alpha,
                       d, "Cohen's d",
                       "配对差值均值为 0", "配对差值均值不为 0")

    if t == "ftest":
        v1 = float(np.var(ax, ddof=1))
        v2 = float(np.var(ay, ddof=1))
        if v2 <= 0:
            raise ValueError("第二组数据方差为 0，无法做 F 检验")
        fn = v1 / v2
        df1, df2 = ax.size - 1, ay.size - 1
        sf = float(stats.f.sf(fn, df1, df2))
        cdf = float(stats.f.cdf(fn, df1, df2))
        if alt == "greater":
            p = sf
        elif alt == "less":
            p = cdf
        else:
            p = min(1.0, 2.0 * min(sf, cdf))
        return _result(t, fn, p, "%d, %d" % (df1, df2), alpha, None, None,
                       "两总体方差相等", "两总体方差不等")

    if t == "anova":
        f_oneway_res = stats.f_oneway(ax, ay)
        # 组间 / 组内平方和（两组情形）
        n1, n2 = ax.size, ay.size
        gm = float(np.mean(np.concatenate([ax, ay])))
        ss_b = n1 * (float(np.mean(ax)) - gm) ** 2 + \
            n2 * (float(np.mean(ay)) - gm) ** 2
        ss_w = float(np.sum((ax - np.mean(ax)) ** 2)) + \
            float(np.sum((ay - np.mean(ay)) ** 2))
        ss_t = ss_b + ss_w
        eta2 = ss_b / ss_t if ss_t > 0 else None
        return _result(t, f_oneway_res.statistic, f_oneway_res.pvalue,
                       "%d, %d" % (1, n1 + n2 - 2), alpha, eta2, "η²",
                       "各组均值相等", "至少一组均值不同")

    if t == "levene":
        res = stats.levene(ax, ay)
        return _result(t, res.statistic, res.pvalue, None, alpha, None, None,
                       "各组方差相等", "各组方差不等")

    if t == "pearson":
        res = stats.pearsonr(ax, ay)
        r = _f(res.statistic)
        r2 = r * r if r is not None else None
        return _result(t, r, res.pvalue, float(ax.size - 2), alpha, r2, "r²",
                       "两变量无线性相关", "两变量存在线性相关")

    if t == "spearman":
        res = stats.spearmanr(ax, ay)
        r = _f(res.statistic)
        r2 = r * r if r is not None else None
        return _result(t, r, res.pvalue, float(ax.size - 2), alpha, r2, "r²",
                       "两变量无单调相关", "两变量存在单调相关")

    if t == "mannwhitney":
        res = stats.mannwhitneyu(ax, ay, alternative=alt)
        return _result(t, res.statistic, res.pvalue, None, alpha, None, None,
                       "两组分布位置相同", "两组分布位置不同")

    if t == "wilcoxon":
        res = stats.wilcoxon(ax, ay, alternative=alt)
        return _result(t, res.statistic, res.pvalue, None, alpha, None, None,
                       "配对差值中位数为 0", "配对差值中位数不为 0")

    raise ValueError("不支持的检验类型：%s" % test)


def hypothesis_test_groups(groups, test="anova", alpha=0.05):
    """多组数据的均值比较（单因素方差分析 / Kruskal-Wallis）。

    参数
    ----
    groups : list[list[float]]  各组数据，至少 2 组，每组至少 2 个有效值
    test : str                  ``anova`` 或 ``kruskal``
    alpha : float               显著性水平

    返回
    ----
    dict
        与 ``hypothesis_test`` 相同字段，另加
        ``groups``（各组 n/mean/std）、``ss_between``、``ss_within``、``eta_squared``
    """
    t = (test or "").strip()
    if t not in ("anova", "kruskal"):
        raise ValueError("多组检验只支持 anova 或 kruskal")

    if not groups or len(groups) < 2:
        raise ValueError("至少需要 2 组数据")

    arrs = []
    info = []
    for i, g in enumerate(groups):
        try:
            a = np.asarray(list(g), dtype=float).ravel()
        except Exception:
            raise ValueError("第 %d 组数据格式有误" % (i + 1))
        a = a[np.isfinite(a)]
        if a.size < 2:
            raise ValueError("样本量不足，至少需要 2 个有效数据点（第 %d 组）" % (i + 1))
        arrs.append(a)
        info.append({
            "name": "G%d" % (i + 1),
            "n": int(a.size),
            "mean": _f(np.mean(a)),
            "std": _f(np.std(a, ddof=1)),
        })

    k = len(arrs)
    n_total = int(sum(a.size for a in arrs))
    grand = float(np.mean(np.concatenate(arrs)))
    ss_between = float(sum(a.size * (float(np.mean(a)) - grand) ** 2 for a in arrs))
    ss_within = float(sum(np.sum((a - np.mean(a)) ** 2) for a in arrs))
    ss_total = ss_between + ss_within
    eta2 = ss_between / ss_total if ss_total > 0 else None

    try:
        alpha_v = float(alpha)
    except Exception:
        raise ValueError("显著性水平 α 必须是数值")
    if not (0.0 < alpha_v < 1.0):
        raise ValueError("显著性水平 α 必须在 0 与 1 之间")

    if t == "anova":
        res = stats.f_oneway(*arrs)
        name = "单因素方差分析"
        stat, p = res.statistic, res.pvalue
        dof = "%d, %d" % (k - 1, n_total - k)
        h0, h1, phrase = "各组均值相等", "至少一组均值不同", "各组均值差异显著"
        es_name = "η²"
    else:
        res = stats.kruskal(*arrs)
        name = "Kruskal-Wallis 检验"
        stat, p = res.statistic, res.pvalue
        dof = float(k - 1)
        h0, h1, phrase = "各组分布位置相同", "至少一组分布位置不同", "各组分布位置差异显著"
        es_name = "η²（基于平方和）"

    stat_v = _f(stat)
    p_v = _f(p)
    significant = bool(p_v is not None and p_v < alpha_v)
    if p_v is None:
        conclusion = "p 值无法计算，结论不可靠"
    elif significant:
        conclusion = "%s < α = %g，拒绝原假设：%s" % (_p_str(p_v), alpha_v, phrase)
    else:
        conclusion = "%s ≥ α = %g，不能拒绝原假设" % (_p_str(p_v), alpha_v)

    return {
        "test": t,
        "test_name": name,
        "statistic": stat_v,
        "p_value": p_v,
        "dof": dof,
        "alpha": _f(alpha_v),
        "significant": significant,
        "effect_size": _f(eta2),
        "effect_size_name": es_name,
        "h0": h0,
        "h1": h1,
        "conclusion": conclusion,
        "groups": info,
        "ss_between": _f(ss_between),
        "ss_within": _f(ss_within),
        "eta_squared": _f(eta2),
    }


__all__ = [
    "describe",
    "uncertainty_type_a",
    "uncertainty_type_b",
    "combine_uncertainty",
    "full_uncertainty",
    "hypothesis_test",
    "hypothesis_test_groups",
]
