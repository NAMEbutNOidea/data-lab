# -*- coding: utf-8 -*-
"""曲线拟合引擎。

只包含模块级纯函数：``MODELS`` 注册表 + ``fit()``。
拟合统一走 ``scipy.optimize.curve_fit``，初值由模型自带的 ``guess`` 给出，
失败时按不同尺度重试多组初值；拟合结果的协方差被用来做 95% 预测带。

所有返回值中的 NaN / inf 统一转成 None，可直接 ``json.dumps(allow_nan=False)``。
"""

from __future__ import annotations

import math
import os
import re

# 本机 conda 环境的 Intel OpenMP/MKL 线程层与 numpy 自带 OpenBLAS 冲突，
# 会导致 dgemm / LAPACK 以原生异常 0xC06D007F 直接终止进程（Python 无法 try 捕获）。
# 必须在 import numpy 之前把 MKL 线程层固定为顺序执行，否则整个服务会崩。
os.environ.setdefault("MKL_THREADING_LAYER", "SEQUENTIAL")

import numpy as np
from scipy.optimize import curve_fit


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


# --------------------------------------------------------------------------
# 模型函数（第一个参数恒为自变量 x，其余为待拟合参数）
# --------------------------------------------------------------------------
def _linear(x, a, b):
    """线性：a*x + b"""
    return a * np.asarray(x, dtype=float) + b


def _poly(x, *cs):
    """多项式：c0 + c1*x + ... （升幂）"""
    x = np.asarray(x, dtype=float)
    out = np.zeros_like(x)
    for i, c in enumerate(cs):
        out = out + c * np.power(x, i)
    return out


def _exp(x, a, b):
    """指数：a*exp(b*x)"""
    x = np.asarray(x, dtype=float)
    with np.errstate(over="ignore", invalid="ignore"):
        return a * np.exp(b * x)


def _exp_offset(x, a, b, c):
    """带偏移的指数：a*exp(b*x) + c"""
    x = np.asarray(x, dtype=float)
    with np.errstate(over="ignore", invalid="ignore"):
        return a * np.exp(b * x) + c


def _power(x, a, b):
    """幂律：a*x^b（要求 x > 0）"""
    x = np.asarray(x, dtype=float)
    with np.errstate(invalid="ignore", divide="ignore"):
        return a * np.power(x, b)


def _log(x, a, b):
    """对数：a*ln(x) + b（要求 x > 0）"""
    x = np.asarray(x, dtype=float)
    with np.errstate(invalid="ignore", divide="ignore"):
        return a * np.log(x) + b


def _gaussian(x, a, mu, s):
    """高斯：a*exp(-(x-mu)^2 / (2*s^2))"""
    x = np.asarray(x, dtype=float)
    with np.errstate(over="ignore", invalid="ignore", divide="ignore"):
        return a * np.exp(-((x - mu) ** 2) / (2.0 * s * s))


def _lorentz(x, a, x0, w):
    """洛伦兹：a / (1 + ((x-x0)/w)^2)"""
    x = np.asarray(x, dtype=float)
    with np.errstate(over="ignore", invalid="ignore", divide="ignore"):
        return a / (1.0 + ((x - x0) / w) ** 2)


def _sine(x, a, w, phi, c):
    """正弦：a*sin(w*x + phi) + c"""
    x = np.asarray(x, dtype=float)
    return a * np.sin(w * x + phi) + c


# --------------------------------------------------------------------------
# 初值估计
# --------------------------------------------------------------------------
def _span(x):
    """x 的取值范围（避免 0）。"""
    return max(float(np.max(x) - np.min(x)), 1e-9)


def _guess_linear(x, y):
    """线性：最小二乘解析初值。"""
    try:
        k, b = np.polyfit(x, y, 1)
        return [float(k), float(b)]
    except Exception:
        return [1.0, float(np.mean(y))]


def _guess_poly(x, y, deg):
    """多项式：用 polyfit 结果作为初值（升幂）。"""
    try:
        c = np.polyfit(x, y, deg)
        return [float(v) for v in c[::-1]]
    except Exception:
        g = [0.0] * (deg + 1)
        g[0] = float(np.mean(y))
        return g


def _guess_exp(x, y):
    """指数：优先用半对数线性回归，退化时用 y[0] 与 1/x 范围。"""
    if np.all(y > 0):
        try:
            k, b0 = np.polyfit(x, np.log(y), 1)
            if np.isfinite(k) and np.isfinite(b0):
                return [float(np.exp(b0)), float(k)]
        except Exception:
            pass
    a0 = float(y[0]) if abs(float(y[0])) > 1e-12 else float(np.max(y))
    b0 = 1.0 / _span(x)
    return [a0, b0]


def _guess_exp_offset(x, y):
    """带偏移指数：在对数回归基础上加常数项初值。"""
    a0, b0 = _guess_exp(x, y)
    return [a0, b0, float(np.min(y))*0.5]


def _guess_power(x, y):
    """幂律：log-log 线性回归。"""
    if np.all(x > 0) and np.all(y > 0):
        try:
            b0, a0 = np.polyfit(np.log(x), np.log(y), 1)
            if np.isfinite(a0) and np.isfinite(b0):
                return [float(np.exp(a0)), float(b0)]
        except Exception:
            pass
    return [1.0, 1.0]


def _guess_log(x, y):
    """对数：用首尾点估斜率。"""
    try:
        lx = np.log(x)
        a0 = (float(y[-1]) - float(y[0])) / (float(lx[-1]) - float(lx[0]))
        b0 = float(np.mean(y)) - a0 * float(np.mean(lx))
        if np.isfinite(a0) and np.isfinite(b0):
            return [a0, b0]
    except Exception:
        pass
    return [1.0, float(np.mean(y))]


def _guess_gaussian(x, y):
    """高斯：峰高、峰位、宽度。"""
    i = int(np.argmax(y))
    a0 = float(y[i])
    mu0 = float(x[i])
    s0 = float(np.std(x)) if np.std(x) > 0 else _span(x) / 4.0
    return [a0, mu0, max(s0, _span(x) / 10.0)]


def _guess_lorentz(x, y):
    """洛伦兹：峰高、峰位、半宽。"""
    i = int(np.argmax(y))
    a0 = float(y[i])
    x0 = float(x[i])
    w0 = max(_span(x) / 10.0, 1e-9)
    return [a0, x0, w0]


def _guess_sine(x, y):
    """正弦：用 FFT 找主频，幅值取半峰峰值。"""
    a0 = (float(np.max(y)) - float(np.min(y))) / 2.0
    if a0 <= 0:
        a0 = 1.0
    c0 = float(np.mean(y))
    w0 = 1.0
    phi0 = 0.0
    try:
        dx = float(np.median(np.diff(x))) if x.size > 1 else 1.0
        if dx <= 0:
            dx = 1.0
        spec = np.abs(np.fft.rfft(y - c0))
        freqs = np.fft.rfftfreq(y.size, d=dx)
        if spec.size > 1:
            k = int(np.argmax(spec[1:])) + 1
            w0 = float(2.0 * math.pi * freqs[k])
            if not np.isfinite(w0) or w0 <= 0:
                w0 = 1.0
    except Exception:
        w0 = 1.0
    return [a0, w0, phi0, c0]


# --------------------------------------------------------------------------
# 模型注册表
# --------------------------------------------------------------------------
MODELS = {
    "linear": {
        "name": "线性",
        "func": _linear,
        "params": ["a", "b"],
        "guess": _guess_linear,
        "latex": "y = ax + b",
    },
    "poly": {
        "name": "多项式",
        "func": _poly,
        "params": ["c0", "c1", "…", "cn"],
        "guess": _guess_poly,
        "latex": "y = c_n x^n + ... + c_1 x + c_0",
    },
    "exp": {
        "name": "指数",
        "func": _exp,
        "params": ["a", "b"],
        "guess": _guess_exp,
        "latex": "y = a e^{bx}",
    },
    "exp_offset": {
        "name": "指数（含偏移）",
        "func": _exp_offset,
        "params": ["a", "b", "c"],
        "guess": _guess_exp_offset,
        "latex": "y = a e^{bx} + c",
    },
    "power": {
        "name": "幂律",
        "func": _power,
        "params": ["a", "b"],
        "guess": _guess_power,
        "latex": "y = a x^{b}",
    },
    "log": {
        "name": "对数",
        "func": _log,
        "params": ["a", "b"],
        "guess": _guess_log,
        "latex": "y = a \\ln x + b",
    },
    "gaussian": {
        "name": "高斯",
        "func": _gaussian,
        "params": ["a", "mu", "s"],
        "guess": _guess_gaussian,
        "latex": "y = a e^{-(x-\\mu)^2/(2s^2)}",
    },
    "lorentz": {
        "name": "洛伦兹",
        "func": _lorentz,
        "params": ["a", "x0", "w"],
        "guess": _guess_lorentz,
        "latex": "y = \\frac{a}{1+((x-x_0)/w)^2}",
    },
    "sine": {
        "name": "正弦",
        "func": _sine,
        "params": ["a", "w", "phi", "c"],
        "guess": _guess_sine,
        "latex": "y = a \\sin(wx+\\phi) + c",
    },
}

# 参数名 -> LaTeX 显示
_PARAM_LATEX = {
    "a": "a", "b": "b", "c": "c", "s": "\\sigma", "mu": "\\mu",
    "w": "\\omega", "phi": "\\phi", "x0": "x_0",
}

# 需要 x > 0 的模型
_POSITIVE_X = ("power", "log")

_MUL_PLAIN = "·"
_MUL_LATEX = "\\cdot "


# --------------------------------------------------------------------------
# 方程文本拼装
# --------------------------------------------------------------------------
def _num(v):
    """保留 4 位有效数字的数值文本。"""
    return "%.4g" % float(v)


_SCI_RE = re.compile(r"^(-?[0-9]*\.?[0-9]+)[eE]([-+]?[0-9]+)$")


def _num_tex(v):
    """数值 -> LaTeX 文本。

    ``%.4g`` 遇到很小/很大的系数会吐 ``1.2e-05``，这种写法直接进 LaTeX 会被当成
    ``1.2e`` 减 ``05``（斜体 e 后面跟一串数字），渲染出来是错的。
    这里统一改写成 ``1.2\\times10^{-5}``，保证导出的公式在 Word / LaTeX 里都正常。
    """
    s = "%.4g" % float(v)
    m = _SCI_RE.match(s)
    if not m:
        return s
    return r"%s\times10^{%d}" % (m.group(1), int(m.group(2)))


def _join_terms(terms, mul, numf=None):
    """把 [(系数, 主体)] 拼成 ``1.234·x + 5.678`` 形式，负号用 " - "。

    ``numf`` 指定数字格式化函数（纯文本用 ``_num``，LaTeX 用 ``_num_tex``）。
    """
    numf = numf or _num
    parts = []
    for i, (coef, body) in enumerate(terms):
        v = float(coef)
        txt = numf(abs(v))
        if body:
            txt = txt + mul + body
        if i == 0:
            parts.append(("-" if v < 0 else "") + txt)
        else:
            parts.append((" - " if v < 0 else " + ") + txt)
    return "".join(parts)


def _shift(mu, numf=None):
    """生成 (x - mu) 或 (x + |mu|) 的文本，避免出现 x--2 这种写法。"""
    numf = numf or _num
    v = float(mu)
    if v < 0:
        return "(x + %s)" % numf(abs(v))
    return "(x - %s)" % numf(v)


def _phase(phi, numf=None):
    """生成正弦相位部分：+ 0.5 或 - 1.5。"""
    numf = numf or _num
    v = float(phi)
    if v < 0:
        return " - %s" % numf(abs(v))
    return " + %s" % numf(v)


def _equation(mid, vals, deg):
    """按模型拼出 (equation_plain, equation_latex)。

    纯文本版给人看（``y = 0.4604·exp(-0.1305·x) + 0.03525``），
    LaTeX 版给论文用（``y = 0.4604\cdot e^{-0.1305 x} + 0.03525``）。
    两版数字一致，只有乘号/上标/函数的写法不同。
    """
    vals = [float(v) for v in vals]

    if mid == "linear":
        tp = _join_terms([(vals[0], "x"), (vals[1], "")], _MUL_PLAIN)
        tl = _join_terms([(vals[0], "x"), (vals[1], "")], _MUL_LATEX, _num_tex)
        return "y = " + tp, "y = " + tl

    if mid == "poly":
        scale = max([abs(v) for v in vals] + [1e-30])
        tp, tl = [], []
        for i in range(deg, -1, -1):
            c = vals[i]
            # 跳过高阶的数值零项（避免 x^2 系数 1e-17 这种噪声）
            if i > 0 and abs(c) <= 1e-12 * scale:
                continue
            if i == 0:
                tp.append((c, ""))
                tl.append((c, ""))
            elif i == 1:
                tp.append((c, "x"))
                tl.append((c, "x"))
            else:
                tp.append((c, "x^%d" % i))
                tl.append((c, "x^{%d}" % i))
        if not tp:
            tp, tl = [(vals[0], "")], [(vals[0], "")]
        return ("y = " + _join_terms(tp, _MUL_PLAIN),
                "y = " + _join_terms(tl, _MUL_LATEX, _num_tex))

    if mid == "exp":
        b = vals[1]
        tp = _join_terms([(vals[0], "exp(%s%sx)" % (_num(b), _MUL_PLAIN))], _MUL_PLAIN)
        tl = _join_terms([(vals[0], "e^{%s x}" % _num_tex(b))], _MUL_LATEX, _num_tex)
        return "y = " + tp, "y = " + tl

    if mid == "exp_offset":
        b = vals[1]
        tp = _join_terms([(vals[0], "exp(%s%sx)" % (_num(b), _MUL_PLAIN)),
                          (vals[2], "")], _MUL_PLAIN)
        tl = _join_terms([(vals[0], "e^{%s x}" % _num_tex(b)),
                          (vals[2], "")], _MUL_LATEX, _num_tex)
        return "y = " + tp, "y = " + tl

    if mid == "power":
        tp = _join_terms([(vals[0], "x^%s" % _num(vals[1]))], _MUL_PLAIN)
        tl = _join_terms([(vals[0], "x^{%s}" % _num_tex(vals[1]))], _MUL_LATEX, _num_tex)
        return "y = " + tp, "y = " + tl

    if mid == "log":
        tp = _join_terms([(vals[0], "ln(x)"), (vals[1], "")], _MUL_PLAIN)
        tl = _join_terms([(vals[0], "\\ln(x)"), (vals[1], "")], _MUL_LATEX, _num_tex)
        return "y = " + tp, "y = " + tl

    if mid == "gaussian":
        a, mu, s = vals[0], vals[1], vals[2]
        tp = _join_terms([(a, "exp(-%s^2/(2%s%s^2))" % (_shift(mu), _MUL_PLAIN, _num(s)))], _MUL_PLAIN)
        tl = _join_terms([(a, "e^{-%s^{2}/(2%s%s^{2})}" % (_shift(mu, _num_tex), _MUL_LATEX, _num_tex(s)))],
                         _MUL_LATEX, _num_tex)
        return "y = " + tp, "y = " + tl

    if mid == "lorentz":
        a, x0, w = vals[0], vals[1], vals[2]
        tp = "y = %s/(1+(%s/%s)^2)" % (_num(a), _shift(x0), _num(w))
        tl = "y = \\frac{%s}{1+\\left(\\frac{%s}{%s}\\right)^2}" % (
            _num_tex(a), _shift(x0, _num_tex), _num_tex(w))
        return tp, tl

    if mid == "sine":
        a, w, phi, c = vals[0], vals[1], vals[2], vals[3]
        tp = _join_terms([(a, "sin(%s%sx%s)" % (_num(w), _MUL_PLAIN, _phase(phi))),
                          (c, "")], _MUL_PLAIN)
        tl = _join_terms([(a, "\\sin(%s x%s)" % (_num_tex(w), _phase(phi, _num_tex))),
                          (c, "")], _MUL_LATEX, _num_tex)
        return "y = " + tp, "y = " + tl

    # 兜底：只列参数值
    return "y = " + _join_terms([(v, "") for v in vals], _MUL_PLAIN), \
        "y = " + _join_terms([(v, "") for v in vals], _MUL_LATEX, _num_tex)


# --------------------------------------------------------------------------
# 拟合主流程
# --------------------------------------------------------------------------
def _clean_xy(x, y, yerr=None):
    """清理成等长的有限值数组，返回 (x, y, sigma|None)。"""
    if x is None or y is None:
        raise ValueError("请提供 x 与 y 两组数据")
    try:
        ax = np.asarray(list(x), dtype=float).ravel()
        ay = np.asarray(list(y), dtype=float).ravel()
    except Exception:
        raise ValueError("数据格式有误，无法转换为数值序列")
    n = min(ax.size, ay.size)
    if n < 2:
        raise ValueError("样本量不足，至少需要 2 个有效数据点")
    if ax.size != ay.size:
        raise ValueError("x 与 y 的数据点数量必须一致（当前 %d 与 %d）"
                         % (ax.size, ay.size))
    ax, ay = ax[:n], ay[:n]

    s = None
    if yerr is not None:
        try:
            s = np.asarray(list(yerr), dtype=float).ravel()[:n]
        except Exception:
            raise ValueError("yerr 格式有误，无法转换为数值序列")
        if s.size != n:
            raise ValueError("yerr 长度必须与数据点数量一致")

    if s is None:
        mask = np.isfinite(ax) & np.isfinite(ay)
    else:
        mask = np.isfinite(ax) & np.isfinite(ay) & np.isfinite(s) & (s > 0)
    ax, ay = ax[mask], ay[mask]
    if s is not None:
        s = s[mask]
        if s.size == 0:
            s = None
    if ax.size < 2:
        raise ValueError("样本量不足，至少需要 2 个有效数据点")
    return ax, ay, s


def _jacobian(func, xs, p, rel=1e-6):
    """中心差分求雅可比矩阵 J[i, j] = d f(x_i) / d p_j。"""
    p = np.asarray(p, dtype=float)
    m = p.size
    J = np.zeros((xs.size, m))
    for j in range(m):
        h = rel * max(1.0, abs(p[j]))
        if h == 0.0:
            h = rel
        dp = np.zeros(m)
        dp[j] = h
        try:
            fp = np.asarray(func(xs, *(p + dp)), dtype=float)
            fm = np.asarray(func(xs, *(p - dp)), dtype=float)
            J[:, j] = (fp - fm) / (2.0 * h)
        except Exception:
            J[:, j] = np.nan
    return J


def _candidates(guess, p0):
    """生成多组初值：用户初值优先，其次按 0.5x / 1x / 2x 等尺度重试。"""
    out = []
    if p0 is not None:
        try:
            base_user = [float(v) for v in p0]
        except Exception:
            raise ValueError("p0 初值必须是数值列表")
        out.append(base_user)
    base = [float(v) for v in guess]
    for s in (1.0, 0.5, 2.0, 0.1, 5.0):
        cand = [v * s for v in base]
        if all(abs(v) < 1e-12 for v in cand):
            cand = [1.0 + 0.1 * i for i in range(len(cand))]
        out.append(cand)
    # 去重（保留顺序）
    seen, uniq = set(), []
    for c in out:
        key = tuple(round(v, 12) for v in c)
        if key not in seen:
            seen.add(key)
            uniq.append(c)
    return uniq


def fit(x, y, model="linear", deg=2, yerr=None, p0=None):
    """对数据做曲线拟合。

    参数
    ----
    x, y : list[float]
    model : str
        ``MODELS`` 中的模型 id，默认 ``linear``
    deg : int
        仅 ``poly`` 使用，多项式阶数（1~9）
    yerr : list[float] | None
        y 的标准差，给出时用 ``absolute_sigma=True`` 加权拟合
    p0 : list[float] | None
        自定义初值，优先使用

    返回
    ----
    dict
        ``model, model_name, params, param_values, equation_latex,
        equation_plain, n, dof, r2, adj_r2, chi2, chi2_red, rmse, sse,
        curve, residuals, fitted``

    异常
    ---
    ValueError : 数据不足、模型未知或拟合不收敛
    """
    mid = (model or "linear").strip()
    if mid not in MODELS:
        raise ValueError("不支持的拟合模型：%s" % model)

    # 多项式阶数
    if mid == "poly":
        try:
            d = int(deg)
        except Exception:
            raise ValueError("多项式阶数 deg 必须是整数")
        if d < 1 or d > 9:
            raise ValueError("多项式阶数 deg 必须在 1~9 之间")
    else:
        d = 0

    ax, ay, sigma = _clean_xy(x, y, yerr)

    # 幂律 / 对数要求 x > 0
    if mid in _POSITIVE_X:
        mask = ax > 0
        ax, ay = ax[mask], ay[mask]
        if sigma is not None:
            sigma = sigma[mask]
        if ax.size < 2:
            raise ValueError("%s 模型要求 x > 0，负值或零已剔除后数据不足" % MODELS[mid]["name"])

    # 参数名与初值
    if mid == "poly":
        names = ["c%d" % i for i in range(d + 1)]
        func = lambda xx, *cs: _poly(xx, *cs)  # noqa: E731
        guess = _guess_poly(ax, ay, d)
    else:
        names = list(MODELS[mid]["params"])
        func = MODELS[mid]["func"]
        guess = MODELS[mid]["guess"](ax, ay)

    npar = len(names)
    if ax.size < npar + 1:
        raise ValueError(
            "有效数据点不足，至少需要 %d 个点才能拟合该模型" % (npar + 1))
    if p0 is not None and len(list(p0)) != npar:
        raise ValueError("初值个数应为 %d 个（%s）" % (npar, ", ".join(names)))

    if float(np.max(ax) - np.min(ax)) <= 0:
        raise ValueError("x 的取值范围为 0，无法进行拟合")

    # 多组初值 + 重试
    popt, pcov, last_err = None, None, None
    for cand in _candidates(guess, p0):
        try:
            with np.errstate(all="ignore"):
                p_opt, p_cov = curve_fit(
                    func, ax, ay, p0=cand, sigma=sigma,
                    absolute_sigma=(sigma is not None), maxfev=40000)
        except Exception as e:  # 不收敛 / 残差非有限 / 参数越界
            last_err = e
            continue
        fitted_try = np.asarray(func(ax, *p_opt), dtype=float)
        if not np.all(np.isfinite(p_opt)) or not np.all(np.isfinite(fitted_try)):
            last_err = "拟合结果包含非有限值"
            continue
        popt, pcov = p_opt, p_cov
        break

    if popt is None:
        raise ValueError("拟合不收敛，请更换模型或检查数据")

    # ---------------- 统计量 ----------------
    fitted = np.asarray(func(ax, *popt), dtype=float)
    resid = ay - fitted
    sse = float(np.sum(resid ** 2))
    n = int(ax.size)
    dof = n - npar
    ybar = float(np.mean(ay))
    sst = float(np.sum((ay - ybar) ** 2))
    r2 = 1.0 - sse / sst if sst > 0 else None
    adj_r2 = (1.0 - (1.0 - r2) * (n - 1) / dof) if (r2 is not None and dof > 0) else None

    if sigma is not None:
        chi2 = float(np.sum((resid / sigma) ** 2))
    else:
        chi2 = sse
    chi2_red = chi2 / dof if dof > 0 else None
    rmse = math.sqrt(sse / n) if n > 0 else None

    # ---------------- 参数与标准误 ----------------
    errs = [None] * npar
    if pcov is not None and np.all(np.isfinite(pcov)):
        diag = np.diag(pcov)
        for i in range(npar):
            v = float(diag[i])
            errs[i] = _f(math.sqrt(v)) if v >= 0 else None
        cov_ok = True
    else:
        cov_ok = False

    params = []
    param_values = {}
    for i, nm in enumerate(names):
        val = _f(popt[i])
        params.append({
            "name": nm,
            "value": val,
            "stderr": errs[i],
            "latex": _PARAM_LATEX.get(nm, nm),
        })
        param_values[nm] = val

    eq_plain, eq_latex = _equation(mid, popt, d)

    # ---------------- 拟合曲线 + 95% 预测带 ----------------
    lo = float(np.min(ax))
    hi = float(np.max(ax))
    xs = np.linspace(lo, hi, 200)
    with np.errstate(all="ignore"):
        ys = np.asarray(func(xs, *popt), dtype=float)

    y_lower = y_upper = None
    if cov_ok:
        J = _jacobian(func, xs, popt)
        if np.all(np.isfinite(J)):
            var_fit = np.einsum("ij,jk,ik->i", J, pcov, J)
            var_fit = np.maximum(var_fit, 0.0)
            s2 = sse / dof if dof > 0 else 0.0
            with np.errstate(all="ignore"):
                band = 2.0 * np.sqrt(var_fit + s2)
            y_lower = [_f(v) for v in (ys - band)]
            y_upper = [_f(v) for v in (ys + band)]
            if all(v is None for v in y_lower):
                y_lower = y_upper = None

    return {
        "model": mid,
        "model_name": MODELS[mid]["name"] + "拟合",
        "params": params,
        "param_values": param_values,
        "equation_latex": eq_latex,
        "equation_plain": eq_plain,
        "n": n,
        "dof": float(dof),
        "r2": _f(r2),
        "adj_r2": _f(adj_r2),
        "chi2": _f(chi2),
        "chi2_red": _f(chi2_red),
        "rmse": _f(rmse),
        "sse": _f(sse),
        "curve": {
            "x": [_f(v) for v in xs],
            "y": [_f(v) for v in ys],
            "y_lower": y_lower,
            "y_upper": y_upper,
        },
        "residuals": [_f(v) for v in resid],
        "fitted": [_f(v) for v in fitted],
    }


# --------------------------------------------------------------------------
# 模型比较：全部模型跑一遍，按 AIC 排序
# --------------------------------------------------------------------------
def _criteria(sse, n, k):
    """按残差平方和算 (AIC, BIC)。

    ``aic = n·ln(sse/n) + 2k``，``bic = n·ln(sse/n) + k·ln(n)``，
    ``k`` 为该模型实际拟合的参数个数。``sse <= 0``（完美拟合）时两条信息准则
    无定义（ln0 = -inf），统一返回 None 而不是 -inf。
    """
    try:
        sse = float(sse)
        n = int(n)
        k = int(k)
    except Exception:
        return None, None
    if not math.isfinite(sse) or sse <= 0 or n <= 0 or k < 1:
        return None, None
    base = n * math.log(sse / n)
    return _f(base + 2.0 * k), _f(base + k * math.log(n))


def _result_order(results, ids):
    """排序：收敛且 AIC 有值的按 AIC 升序，AIC 为 None 的其次，失败的全部垫底。

    同分（或同类）时保持 ``MODELS`` / 传入顺序，保证结果稳定可复现。
    """
    rank = {m: i for i, m in enumerate(ids)}
    aic_items = [r for r in results if r["ok"] and r["aic"] is not None]
    none_items = [r for r in results if r["ok"] and r["aic"] is None]
    bad_items = [r for r in results if not r["ok"]]
    aic_items.sort(key=lambda r: (r["aic"], rank[r["model"]]))
    none_items.sort(key=lambda r: rank[r["model"]])
    bad_items.sort(key=lambda r: rank[r["model"]])
    return aic_items + none_items + bad_items


def _comparison_notes(ordered):
    """生成一句中文结论（ΔAIC<2 不显著，2~10 有一定区分度，>10 显著更优）。"""
    ranked = [r for r in ordered if r["ok"] and r["aic"] is not None]
    n_bad = sum(1 for r in ordered if not r["ok"])
    n_perfect = sum(1 for r in ordered if r["ok"] and r["aic"] is None)

    if not ranked:
        if n_perfect:
            return "全部模型残差为 0（完美拟合），AIC/BIC 无定义，无法据此选型。"
        return "全部 %d 个模型均未收敛，无法给出模型比较结论。" % len(ordered)

    if len(ranked) == 1:
        only = ranked[0]
        # 只跑了一个模型时不存在"其余模型失败"这回事，要单独给话术
        if len(ordered) == 1:
            return "只比较了「%s」一个模型（AIC=%.1f），没有可比对象，建议多选几个模型。" % (
                only["model_name"], only["aic"])
        if n_bad == len(ordered) - 1:
            return "仅「%s」收敛，其余模型拟合失败，不建议据此选型。" % only["model_name"]
        return "仅「%s」给出有效 AIC（%.1f），其余模型未收敛或残差为 0，不建议据此选型。" % (
            only["model_name"], only["aic"])

    first, second = ranked[0], ranked[1]
    delta = second["aic"] - first["aic"]
    if delta < 2.0:
        judge = "两者差异不显著（ΔAIC<2）。"
    elif delta <= 10.0:
        judge = "两者有一定区分度（2≤ΔAIC≤10）。"
    else:
        judge = "前者显著更优（ΔAIC>10）。"
    note = "最优为「%s」(AIC=%.1f)；其次「%s」ΔAIC=%.1f，%s" % (
        first["model_name"], first["aic"], second["model_name"], delta, judge)
    if n_bad:
        note += "另有 %d 个模型未收敛，已排除。" % n_bad
    if len({r["n"] for r in ranked}) > 1:
        note += "注意：各模型的有效样本量 n 不一致（幂律/对数会剔除 x≤0 的点），AIC 仅供参考。"
    return note


def compare_models(x, y, deg=2, yerr=None, models=None):
    """把多个模型逐个拟合，按 AIC 升序返回比较结果。

    参数
    ----
    x, y : list[float]
    deg : int
        仅 ``poly`` 使用，多项式阶数
    yerr : list[float] | None
        y 的标准差，给出时加权拟合
    models : list[str] | str | None
        要比较的模型 id 列表，缺省为 ``MODELS`` 全部（9 个）

    返回
    ----
    dict
        ``{"results": [...], "best": "exp_offset" | None, "notes": "中文结论"}``。
        每个结果项含 ``model, model_name, ok, error, params, equation_plain,
        equation_latex, n, dof, k, sse, rmse, r2, adj_r2, aic, bic``；
        拟合失败的模型同样出现在结果里，``ok=False`` 且 ``aic=None``。

    排序：收敛且有 AIC 的按 AIC 升序，AIC 为 None 的其后，失败的全部垫底。
    """
    if models is None:
        ids = list(MODELS.keys())
    else:
        if isinstance(models, str):
            models = [models]
        ids = [str(m).strip() for m in models]
        bad = [m for m in ids if m not in MODELS]
        if bad:
            raise ValueError("不支持的拟合模型：%s" % "、".join(bad))
        if not ids:
            raise ValueError("请至少指定一个要比较的模型")

    results = []
    for mid in ids:
        item = {
            "model": mid,
            "model_name": MODELS[mid]["name"],
            "ok": False,
            "error": None,
            "params": [],
            "equation_plain": None,
            "equation_latex": None,
            "n": 0,
            "dof": None,
            "k": 0,
            "sse": None,
            "rmse": None,
            "r2": None,
            "adj_r2": None,
            "aic": None,
            "bic": None,
        }
        try:
            r = fit(x, y, model=mid, deg=deg, yerr=yerr)
        except Exception as e:  # 单个模型失败不影响其他模型
            msg = str(e).strip() or e.__class__.__name__
            item["error"] = msg
            results.append(item)
            continue

        params = r.get("params") or []
        k = len(params)
        n = int(r.get("n") or 0)
        sse = r.get("sse")
        aic, bic = _criteria(sse, n, k)
        item.update({
            "ok": True,
            "error": None,
            "params": params,
            "equation_plain": r.get("equation_plain"),
            "equation_latex": r.get("equation_latex"),
            "n": n,
            "dof": int(n - k),
            "k": k,
            "sse": sse,
            "rmse": r.get("rmse"),
            "r2": r.get("r2"),
            "adj_r2": r.get("adj_r2"),
            "aic": aic,
            "bic": bic,
        })
        results.append(item)

    ordered = _result_order(results, ids)
    best = next((it["model"] for it in ordered
                 if it["ok"] and it["aic"] is not None), None)
    return {"results": ordered, "best": best, "notes": _comparison_notes(ordered)}


__all__ = ["MODELS", "fit", "compare_models"]
