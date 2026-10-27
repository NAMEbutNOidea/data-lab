# -*- coding: utf-8 -*-
"""DataLab 绘图渲染模块（子 Agent B）。

职责：
    * 提供 8 套论文/演示风格主题 ``THEMES`` 与 8 套期刊配色 ``PALETTES``；
    * 提供 ``render_png`` / ``render_bytes`` 两个纯函数，把前端传来的 ``spec``
      渲染成 PNG / SVG / PDF / EPS 的字节流。

设计约束（见 CONTRACT.md 第 2、3、6、8 节）：
    * 仅使用模块级函数，不写 class，不落盘文件（只写内存 BytesIO）；
    * 强制使用 Agg 后端，禁止任何 GUI 交互；
    * 每次渲染使用独立 Figure + ``plt.rc_context``，结束必定 ``plt.close(fig)``，
      避免线程间 rcParams 污染与内存泄漏；
    * 中文注释、中文错误信息。
"""

from __future__ import annotations

import datetime as _dtmod
import io
import math
import os
import re
import sys
import warnings

import numpy as np
from scipy import linalg as _sla
from scipy import stats

import matplotlib

# 必须在任何 pyplot 导入之前指定无界面后端
matplotlib.use("Agg")


# --------------------------------------------------------------------------- #
# 〇、numpy 环境兜底（必须在 pyplot 之前安装）
# --------------------------------------------------------------------------- #
# 本机 conda 环境的动态库缺符号，有两处会以 0xc06d007f 硬崩溃（C 层异常，
# try/except 拦不住）：
#   1) numpy.linalg 的 LAPACK 入口（inv / det / svd / solve ...）；
#   2) numpy.dot 的 BLAS dgemm（仅矩阵×矩阵；矩阵×向量、逐元素都正常）。
# 而 matplotlib 在仿射变换求逆（transforms.Affine2DBase.inverted）、
# 变换矩阵相乘（CompositeGenericTransform.get_affine）、tight_layout 与
# bbox_inches="tight" 的刻度计算里都要用到这两者，缺了则一张图都渲染不出来。
# 这里用 scipy.linalg（自带可用的 LAPACK）与 einsum（纯 numpy 循环，不过 BLAS）
# 顶替，返回值约定与 numpy 一致；scipy 不可用时保持原样，不做破坏性修改。
LINALG_PATCHED = False
BLAS_PATCHED = False


def _install_linalg_fallback() -> bool:
    """用 scipy.linalg 替换不可用的 numpy.linalg 入口，返回是否打了补丁。"""
    global LINALG_PATCHED
    if LINALG_PATCHED:
        return True

    def _batch(fn):
        """支持堆叠矩阵：ndim>2 时逐层调用。"""
        def wrapper(a, *args, **kwargs):
            arr = np.asarray(a)
            if arr.ndim < 2:
                raise np.linalg.LinAlgError("矩阵至少需要二维")
            if arr.ndim == 2:
                return fn(arr, *args, **kwargs)
            return np.stack([fn(m, *args, **kwargs) for m in arr])
        return wrapper

    # 下面几个包装函数保持 numpy 的调用签名（numpy 用 rcond，scipy 用 cond），
    # 这样项目里按 numpy 写法调用的代码不会因为兜底而报 TypeError
    def _inv(a):
        return _batch(_sla.inv)(a)

    def _det(a):
        arr = np.asarray(a)
        if arr.ndim < 2 or arr.shape[-1] != arr.shape[-2]:
            # 与 numpy 一致：非方阵抛 LinAlgError
            raise np.linalg.LinAlgError("Last 2 dimensions of the array must be square")
        return _batch(_sla.det)(a)

    def _solve(a, b):
        return _sla.solve(np.asarray(a), np.asarray(b))

    def _lstsq(a, b, rcond=None):
        return _sla.lstsq(np.asarray(a), np.asarray(b),
                          cond=rcond, lapack_driver="gelsd")

    def _svd(a, full_matrices=True, compute_uv=True, hermitian=False):
        return _sla.svd(np.asarray(a), full_matrices=full_matrices,
                        compute_uv=compute_uv)

    def _pinv(a, rcond=1e-15, hermitian=False):
        # scipy.linalg.pinv 内部也走 BLAS 矩阵乘，会崩，这里用 SVD + einsum 手算
        arr = np.asarray(a)
        if arr.ndim != 2:
            raise np.linalg.LinAlgError("pinv 仅支持二维矩阵")
        u, s, vh = _sla.svd(arr, full_matrices=False)
        cut = (1e-15 if rcond is None else abs(float(rcond))) * float(s.max() if s.size else 0.0)
        sinv = np.array([1.0 / x if x > cut else 0.0 for x in s])
        return np.einsum("ji,j,kj->ik", np.conj(vh), sinv, np.conj(u))

    impls = {
        "inv": _inv,
        "det": _det,
        "solve": _solve,
        "pinv": _pinv,
        "svd": _svd,
        "lstsq": _lstsq,
    }

    originals = {}
    for name, fn in impls.items():
        orig = getattr(np.linalg, name, None)
        if orig is None:
            continue
        originals[name] = orig
        setattr(np.linalg, name, fn)

    # 修复模块内部按名字直接调用（如 numpy.linalg.cond / matrix_rank 内部
    # 调用的 svd），以及 matplotlib 里 ``from numpy.linalg import inv`` 的旧绑定。
    # 这些函数在各自模块的 globals 里是另一份引用，只改包属性拦不住。
    for mod in list(sys.modules.values()):
        name = getattr(mod, "__name__", "") or ""
        if not (name.startswith("numpy") or name.startswith("matplotlib")):
            continue
        for fname, orig in originals.items():
            try:
                if getattr(mod, fname, None) is orig:
                    setattr(mod, fname, impls[fname])
            except (AttributeError, TypeError):
                continue

    LINALG_PATCHED = True
    return True


def _install_blas_fallback() -> bool:
    """np.dot 兜底：2 维及以下的乘法改用 einsum，绕开崩溃的 BLAS dgemm。

    说明：``a @ b`` 走的是 ``ndarray.__matmul__`` 的 C ufunc，Python 层拦不住，
    因此本项目内部统一用 ``np.dot`` 做矩阵乘法。
    """
    global BLAS_PATCHED
    if BLAS_PATCHED:
        return True
    orig = np.dot

    def _dot(a, b, out=None):
        try:
            aa = np.asarray(a)
            bb = np.asarray(b)
        except Exception:
            return orig(a, b, out) if out is not None else orig(a, b)
        res = None
        try:
            if aa.ndim == 2 and bb.ndim == 2:
                res = np.einsum("ij,jk->ik", aa, bb)
            elif aa.ndim == 2 and bb.ndim == 1:
                res = np.einsum("ij,j->i", aa, bb)
            elif aa.ndim == 1 and bb.ndim == 2:
                res = np.einsum("i,ij->j", aa, bb)
            elif aa.ndim == 1 and bb.ndim == 1:
                res = np.einsum("i,i->", aa, bb)
        except Exception:
            res = None
        if res is None:
            return orig(a, b, out) if out is not None else orig(a, b)
        if out is not None:
            out[...] = res
            return out
        return res

    np.dot = _dot

    # numpy 内部模块里 ``from numpy._core import dot`` 形式的直接引用也一并替换，
    # 否则 np.cov / np.corrcoef 这类高层封装仍会调到崩溃的 dgemm。
    for mod in list(sys.modules.values()):
        name = getattr(mod, "__name__", "") or ""
        if not name.startswith("numpy"):
            continue
        try:
            if getattr(mod, "dot", None) is orig:
                setattr(mod, "dot", _dot)
        except (AttributeError, TypeError):
            continue

    # matplotlib 贝塞尔求值写的是 ``arr @ self._px``，@ 走 C 层 matmul ufunc，
    # Python 层拦不住，所以单独把该方法换成走 np.dot 的等价实现。
    # 柱状图/任意 Patch 的边界范围计算都会走这里，不换必崩。
    try:
        import matplotlib.bezier as _mbezier

        def _bezier_call(self, t):
            t = np.asarray(t)
            coef = (np.power.outer(1 - t, self._orders[::-1])
                    * np.power.outer(t, self._orders))
            return np.dot(coef, self._px)

        def _bezier_poly_coeffs(self):
            n = self.degree
            P = self.control_points
            j = np.arange(n + 1)[:, None]
            i = np.arange(n + 1)[None, :]
            prefactor = (-1) ** (i + j) * _mbezier._comb(j, i)
            return np.dot(_mbezier._comb(n, j) * prefactor, P)

        _mbezier.BezierSegment.__call__ = _bezier_call
        # polynomial_coefficients 在 matplotlib 上是 property，必须保持 property
        _mbezier.BezierSegment.polynomial_coefficients = property(
            _bezier_poly_coeffs)
    except Exception:
        pass

    BLAS_PATCHED = True
    return True


try:
    _install_linalg_fallback()
except Exception:  # scipy 不可用则放弃兜底
    LINALG_PATCHED = False

try:
    _install_blas_fallback()
except Exception:
    BLAS_PATCHED = False

import matplotlib.pyplot as plt  # noqa: E402
import matplotlib.dates as mdates  # noqa: E402
from matplotlib import colors as mcolors  # noqa: E402
from matplotlib import font_manager  # noqa: E402
from matplotlib.colors import LinearSegmentedColormap  # noqa: E402

__all__ = ["THEMES", "PALETTES", "render_png", "render_bytes", "render_bytes_meta"]


# --------------------------------------------------------------------------- #
# 一、风格预设（8 套）
# --------------------------------------------------------------------------- #
# 每个主题必须包含契约第 6 节列出的全部字段，缺一不可。
THEMES: dict = {
    "paper_nature": {
        "name": "Nature 论文",
        "font": "serif",
        "font_family": ["Times New Roman", "Arial", "SimHei"],
        "font_size": 10,
        "axes_linewidth": 0.8,
        "grid": False,
        "grid_style": "--",
        "tick_direction": "in",
        "spines_top": True,
        "spines_right": True,
        "lines_linewidth": 1.2,
        "bg": "#FFFFFF",
        "fg": "#000000",
        "legend_frame": False,
        "description": "双栏期刊风格，细线宽、内向刻度、无网格",
    },
    "paper_aps": {
        "name": "APS 物理",
        "font": "serif",
        "font_family": ["Times New Roman", "SimSun", "SimHei"],
        "font_size": 9,
        "axes_linewidth": 0.7,
        "grid": False,
        "grid_style": ":",
        "tick_direction": "in",
        "spines_top": True,
        "spines_right": True,
        "lines_linewidth": 1.0,
        "bg": "#FFFFFF",
        "fg": "#000000",
        "legend_frame": False,
        "description": "Physical Review 风格，紧凑排版、单倍行距刻度",
    },
    "ieee": {
        "name": "IEEE 单栏",
        "font": "serif",
        "font_family": ["Times New Roman", "SimSun", "SimHei"],
        "font_size": 8,
        "axes_linewidth": 0.6,
        "grid": False,
        "grid_style": "--",
        "tick_direction": "in",
        "spines_top": True,
        "spines_right": True,
        "lines_linewidth": 1.0,
        "bg": "#FFFFFF",
        "fg": "#000000",
        "legend_frame": False,
        "description": "IEEE 单栏图，小字号、细边框、黑白友好",
    },
    "modern_light": {
        "name": "现代浅色",
        "font": "sans-serif",
        "font_family": ["Segoe UI", "Arial", "Microsoft YaHei"],
        "font_size": 11,
        "axes_linewidth": 1.0,
        "grid": True,
        "grid_style": "-",
        "tick_direction": "out",
        "spines_top": False,
        "spines_right": False,
        "lines_linewidth": 1.8,
        "bg": "#FFFFFF",
        "fg": "#2B2B2B",
        "legend_frame": False,
        "description": "现代网页风格，浅灰网格、隐藏上右边框",
    },
    "dark": {
        "name": "深色演示",
        "font": "sans-serif",
        "font_family": ["Segoe UI", "Arial", "Microsoft YaHei"],
        "font_size": 12,
        "axes_linewidth": 1.0,
        "grid": True,
        "grid_style": "--",
        "tick_direction": "out",
        "spines_top": False,
        "spines_right": False,
        "lines_linewidth": 2.0,
        "bg": "#1C1C1E",
        "fg": "#F2F2F7",
        "legend_frame": False,
        "description": "深色底片，适合投影演示与暗色主题报告",
    },
    "minimal": {
        "name": "极简",
        "font": "sans-serif",
        "font_family": ["Arial", "Microsoft YaHei"],
        "font_size": 10,
        "axes_linewidth": 0.6,
        "grid": False,
        "grid_style": "-",
        "tick_direction": "out",
        "spines_top": False,
        "spines_right": False,
        "lines_linewidth": 1.4,
        "bg": "#FFFFFF",
        "fg": "#111111",
        "legend_frame": False,
        "description": "留白极简风，无边框无网格，突出数据本身",
    },
    "notebook": {
        "name": "笔记本",
        "font": "sans-serif",
        "font_family": ["DejaVu Sans", "Microsoft YaHei"],
        "font_size": 11,
        "axes_linewidth": 0.9,
        "grid": True,
        "grid_style": "-",
        "tick_direction": "out",
        "spines_top": True,
        "spines_right": True,
        "lines_linewidth": 1.5,
        "bg": "#FFFFFF",
        "fg": "#1A1A1A",
        "legend_frame": True,
        "description": "Jupyter 默认观感，四边框 + 浅网格",
    },
    "poster": {
        "name": "海报",
        "font": "sans-serif",
        "font_family": ["Arial", "Microsoft YaHei"],
        "font_size": 16,
        "axes_linewidth": 2.0,
        "grid": False,
        "grid_style": "-",
        "tick_direction": "in",
        "spines_top": True,
        "spines_right": True,
        "lines_linewidth": 2.6,
        "bg": "#FFFFFF",
        "fg": "#111111",
        "legend_frame": True,
        "description": "学术海报风格，大字号粗线条，远距离可读",
    },
}


# --------------------------------------------------------------------------- #
# 二、配色方案（8 套，真实期刊 hex）
# --------------------------------------------------------------------------- #
PALETTES: dict = {
    # Nature Publishing Group 经典配色
    "npg": ["#E64B35", "#4DBBD5", "#00A087", "#3C5488",
            "#F39B7F", "#8491B4", "#91D1C2", "#DC0000"],
    # Science 杂志配色
    "science": ["#3B4992", "#EE0000", "#008B45", "#631879",
                "#008280", "#BB0021", "#5F559B", "#A20056"],
    # The Lancet 配色
    "lancet": ["#00468B", "#ED0000", "#42B540", "#0099B4",
               "#925E9F", "#FDAF91", "#AD002A", "#ADB6B6"],
    # New England Journal of Medicine 配色
    "nejm": ["#BC3C29", "#0072B5", "#E18727", "#20854E",
             "#7876B1", "#6F99AD", "#FFDC91", "#EE4C97"],
    # Okabe-Ito 高对比（色盲友好）
    "highcontrast": ["#000000", "#D55E00", "#0072B2", "#009E73",
                     "#CC79A7", "#E69F00", "#56B4E9", "#F0E442"],
    # 灰度/黑白打印
    "grayscale": ["#000000", "#404040", "#666666", "#8C8C8C",
                  "#A6A6A6", "#BFBFBF", "#2B2B2B", "#D9D9D9"],
    # 冷色系
    "cool": ["#003F5C", "#2F4B7C", "#665191", "#A05195",
             "#0072B5", "#00A6A6", "#4C9F70", "#7FB3D5"],
    # 暖色系
    "warm": ["#B2182B", "#D6604D", "#E66101", "#F1A340",
             "#B8860B", "#8C2D04", "#F4A582", "#D4A017"],
}


# --------------------------------------------------------------------------- #
# 三、常量与内部状态
# --------------------------------------------------------------------------- #
SUPPORTED_KINDS = (
    "line", "scatter", "line_marker", "errorbar", "bar", "bar_grouped",
    "bar_stacked", "hist", "box", "violin", "residual", "qq", "heatmap", "pie",
    "scatter3d", "line3d", "surface3d", "bar3d",
)

_KINDS_3D = ("scatter3d", "line3d", "surface3d", "bar3d")
_TWIN_OK_KINDS = ("line", "scatter", "line_marker", "errorbar", "bar")

SUPPORTED_FORMATS = ("png", "svg", "pdf", "eps")

# 图形类型的能力清单：后端是唯一事实来源，前端据此渲染按钮与分组。
# need_x  —— 是否必须有 X 列（成对绘制）
# need_fit —— 是否依赖拟合结果（残差图）
# group   —— 前端分组标签
KINDS: dict = {
    "line":        {"name": "折线图",   "group": "曲线",  "need_x": True,  "need_fit": False,
                    "desc": "按 X 顺序连线，适合连续扫描数据"},
    "scatter":     {"name": "散点图",   "group": "曲线",  "need_x": True,  "need_fit": False,
                    "desc": "只画数据点，观察分布与相关性"},
    "line_marker": {"name": "点线图",   "group": "曲线",  "need_x": True,  "need_fit": False,
                    "desc": "连线叠加标记点，实验曲线常用"},
    "errorbar":    {"name": "误差棒图", "group": "曲线",  "need_x": True,  "need_fit": False,
                    "desc": "带 X/Y 误差棒的测量结果"},
    "bar":         {"name": "柱状图",   "group": "柱状",  "need_x": True,  "need_fit": False,
                    "desc": "单序列分类对比"},
    "bar_grouped": {"name": "分组柱状", "group": "柱状",  "need_x": True,  "need_fit": False,
                    "desc": "多序列并列对比"},
    "bar_stacked": {"name": "堆叠柱状", "group": "柱状",  "need_x": True,  "need_fit": False,
                    "desc": "多序列累加占比"},
    "hist":        {"name": "直方图",   "group": "柱状",  "need_x": False, "need_fit": False,
                    "desc": "单列数值的频数分布"},
    "box":         {"name": "箱线图",   "group": "分布",  "need_x": False, "need_fit": False,
                    "desc": "中位数、四分位与离群点"},
    "violin":      {"name": "小提琴图", "group": "分布",  "need_x": False, "need_fit": False,
                    "desc": "核密度形状 + 分位信息"},
    "qq":          {"name": "Q-Q 图",   "group": "分布",  "need_x": False, "need_fit": False,
                    "desc": "检验样本是否服从正态分布"},
    "residual":    {"name": "残差图",   "group": "分布",  "need_x": True,  "need_fit": True,
                    "desc": "需先拟合，检查残差是否随机"},
    "heatmap":     {"name": "热力图",   "group": "矩阵",  "need_x": True,  "need_fit": False,
                    "desc": "相关系数矩阵等二维网格"},
    "pie":         {"name": "饼图",     "group": "占比",  "need_x": True,  "need_fit": False,
                    "desc": "部分占整体的比例"},
    "scatter3d":   {"name": "三维散点", "group": "三维",  "need_x": True,  "need_z": True,
                    "need_matrix": False, "need_fit": False, "desc": "X/Y/Z 三列数据的三维点云"},
    "line3d":      {"name": "三维折线", "group": "三维",  "need_x": True,  "need_z": True,
                    "need_matrix": False, "need_fit": False, "desc": "X/Y/Z 三列数据的空间曲线"},
    "surface3d":   {"name": "三维曲面", "group": "三维",  "need_x": True,  "need_z": False,
                    "need_matrix": True,  "need_fit": False, "desc": "矩阵高度数据的连续三维曲面"},
    "bar3d":       {"name": "三维柱状", "group": "三维",  "need_x": True,  "need_z": False,
                    "need_matrix": True,  "need_fit": False, "desc": "矩阵高度数据的三维柱状对比"},
}

# 中文字体探测顺序：微软雅黑 → 黑体 → 宋体 → 等线
_FONT_CANDIDATES = (
    ("C:/Windows/Fonts/msyh.ttc", "Microsoft YaHei"),
    ("C:/Windows/Fonts/simhei.ttf", "SimHei"),
    ("C:/Windows/Fonts/simsun.ttc", "SimSun"),
    ("C:/Windows/Fonts/Deng.ttf", "DengXian"),
)

_FONT_DONE = False   # 字体探测是否已完成（只做一次）
_FONT_PATH = None    # 命中的字体文件路径
_FONT_NAME = None    # 命中的字体族名


def _f(x):
    """numpy -> 原生 float，NaN/inf/非法值 -> None（契约第 3 节）。"""
    try:
        v = float(x)
    except Exception:
        return None
    if math.isnan(v) or math.isinf(v):
        return None
    return v


def _setup_font():
    """探测并注册系统中文字体，返回字体族名（找不到时返回 None）。

    只在首次调用时真正执行；使用 ``font_manager.addfont`` 注册 ttc/ttf，
    再把字体名放进 ``rcParams`` 的 sans-serif / serif 候选表，
    这样 ``font.family`` 为 serif 的主题也能靠 matplotlib 的字形级回退显示中文。
    """
    global _FONT_DONE, _FONT_PATH, _FONT_NAME
    if _FONT_DONE:
        return _FONT_NAME
    _FONT_DONE = True

    for path, _guess in _FONT_CANDIDATES:
        try:
            if not os.path.isfile(path):
                continue
            font_manager.fontManager.addfont(path)
            name = font_manager.FontProperties(fname=path).get_name()
            if name:
                _FONT_PATH, _FONT_NAME = path, name
                break
        except Exception:
            continue

    sans = ["Microsoft YaHei", "SimHei", "SimSun", "DengXian",
            "Segoe UI", "Arial", "DejaVu Sans"]
    serif = ["Times New Roman", "DejaVu Serif", "SimSun", "SimHei"]
    if _FONT_NAME:
        if _FONT_NAME not in sans:
            sans.insert(0, _FONT_NAME)
        if _FONT_NAME not in serif:
            serif.append(_FONT_NAME)

    try:
        matplotlib.rcParams["font.sans-serif"] = sans
        matplotlib.rcParams["font.serif"] = serif
        matplotlib.rcParams["axes.unicode_minus"] = False
        # 连续批量渲染时不刷 "More than 20 figures" 警告（仍会正常关闭）
        matplotlib.rcParams["figure.max_open_warning"] = 0
    except Exception:
        pass
    return _FONT_NAME


# --------------------------------------------------------------------------- #
# 四、入参归一化工具
# --------------------------------------------------------------------------- #
def _get_theme(key) -> dict:
    """按 key 取主题，未知 key 回退到 Nature 论文风格。"""
    if isinstance(key, dict):
        return key
    theme = THEMES.get(str(key or "").strip())
    if theme is None:
        theme = THEMES["paper_nature"]
    return theme


def _get_palette(key) -> list:
    """按 key 取配色，未知 key 回退到 NPG；也允许直接传 hex 列表。"""
    if isinstance(key, (list, tuple)) and key:
        cols = [str(c) for c in key if c]
        if cols:
            return cols
    pal = PALETTES.get(str(key or "").strip())
    if not pal:
        pal = PALETTES["npg"]
    return pal


def _num_list(values) -> list:
    """任意序列 -> float 列表，无法转换的记为 NaN（绘图时自动断开）。"""
    if values is None:
        return []
    if isinstance(values, (str, bytes)):
        return []
    try:
        items = list(values)
    except TypeError:
        return []
    out = []
    for v in items:
        try:
            out.append(float(v))
        except (TypeError, ValueError):
            out.append(float("nan"))
    return out


def _clean(values) -> list:
    """转 float 并剔除 NaN，用于统计类计算（KDE、箱线图等）。"""
    return [v for v in _num_list(values) if not math.isnan(v)]


def _values(s: dict) -> list:
    """取用于分布/统计的数值列：优先 y，y 为空时退回 x（兼容前端只填一列）。"""
    vals = _clean(s.get("y"))
    if vals:
        return vals
    return _clean(s.get("x"))


def _series(spec: dict) -> list:
    """取 series 列表，过滤掉非 dict 项，保证后续绘制对脏数据健壮。"""
    raw = spec.get("series")
    if not isinstance(raw, (list, tuple)):
        return []
    return [s for s in raw if isinstance(s, dict)]


def _sname(s: dict, i: int) -> str:
    """图例标签：优先 series.name，其次 label，最后自动编号。"""
    name = s.get("name") or s.get("label")
    return str(name) if name else "数据 %d" % (i + 1)


# 深色背景专用序列色：亮度足够、彼此区分度高（按 NPG 亮色重排）
_DARK_FALLBACK = [
    "#4DBBD5", "#E64B35", "#00A087", "#F39B7F",
    "#91D1C2", "#DC0000", "#FFDC91", "#8491B4",
]

# 深色背景下的反相灰度序列（供 grayscale 配色使用）
_DARK_GRAY = [
    "#F2F2F2", "#C8C8C8", "#9E9E9E", "#787878",
    "#E0E0E0", "#B4B4B4", "#8A8A8A", "#D2D2D2",
]


def _relative_luminance(c) -> float:
    """WCAG 相对亮度，用于判断颜色在某背景上是否看得见。"""
    r, g, b = mcolors.to_rgb(c)
    def _lin(u):
        return u / 12.92 if u <= 0.04045 else ((u + 0.055) / 1.055) ** 2.4
    return 0.2126 * _lin(r) + 0.7152 * _lin(g) + 0.0722 * _lin(b)


def _contrast_ratio(c1, c2) -> float:
    """两色对比度（1~21）。低于 2.0 基本就看不清了。"""
    l1, l2 = _relative_luminance(c1), _relative_luminance(c2)
    hi, lo = max(l1, l2), min(l1, l2)
    return (hi + 0.05) / (lo + 0.05)


def _ensure_visible(color, bg, min_ratio: float = 2.4):
    """保证线条/标记颜色在给定背景上可见。

    深色主题配「高对比」「灰度」这类以黑色打头的调色板时，黑点会完全融进
    背景，图上什么都看不到。这里按背景明暗把颜色往反方向推。
    """
    try:
        if _contrast_ratio(color, bg) >= min_ratio:
            return color
    except (ValueError, TypeError):
        return color
    r, g, b = mcolors.to_rgb(color)
    if _relative_luminance(bg) > 0.5:
        # 浅背景 → 颜色加深
        t = 0.55
        cand = (r * t, g * t, b * t)
    else:
        # 深背景 → 颜色提亮（与白色混合）
        t = 0.62
        cand = (r + (1 - r) * t, g + (1 - g) * t, b + (1 - b) * t)
    try:
        if _contrast_ratio(cand, bg) < min_ratio:
            lumi = _relative_luminance(bg)
            cand = (0.06, 0.06, 0.06) if lumi > 0.5 else (0.92, 0.92, 0.92)
    except (ValueError, TypeError):
        pass
    return cand


def _apply_contrast(spec: dict, theme: dict, palette: list) -> dict:
    """把所有序列颜色校正到与背景对比度达标，返回新的 spec。

    如果整套配色在深色背景上有一半以上看不清（例如 highcontrast / grayscale
    这类以黑色打头的调色板配 dark 主题），逐个提亮只会得到一片灰，
    这时整替换成深色背景专用的亮色序列。
    """
    raw = spec.get("series")
    if not isinstance(raw, (list, tuple)):
        return spec
    bg = theme.get("bg") or "#FFFFFF"
    dark_bg = _relative_luminance(bg) < 0.5

    pal = palette
    if dark_bg and palette:
        # 灰度调色板在深色底上会全黑，直接用反相灰度序列
        try:
            def _is_gray(c):
                r, g, b = mcolors.to_rgb(c)
                return (max(r, g, b) - min(r, g, b)) < 0.03
            if all(_is_gray(c) for c in palette[:3]):
                pal = _DARK_GRAY
            else:
                # 逐个颜色处理：调色板里过暗的换成深色底专用亮色
                pal = list(palette)
        except (ValueError, TypeError):
            pal = palette

    fixed = []
    for i, s in enumerate(raw):
        if not isinstance(s, dict):
            fixed.append(s)
            continue
        s = dict(s)
        if s.get("color"):
            # 用户显式指定的颜色只做可见性校正，不替换成配色方案
            s["color"] = _ensure_visible(s["color"], bg)
        else:
            c = pal[i % len(pal)]
            if dark_bg:
                try:
                    if _contrast_ratio(c, bg) < 2.4:
                        c = _DARK_FALLBACK[i % len(_DARK_FALLBACK)]
                except (ValueError, TypeError):
                    pass
            s["color"] = c
        fixed.append(s)
    out = dict(spec)
    out["series"] = fixed
    return out


def _color(s: dict, i: int, palette: list):
    """取序列颜色：用户指定优先，否则按配色轮转。"""
    c = s.get("color")
    if c:
        try:
            mcolors.to_rgb(c)
            return c
        except (ValueError, TypeError):
            pass
    return palette[i % len(palette)]


def _alpha(s: dict, default: float = 1.0) -> float:
    a = _f(s.get("alpha"))
    if a is None:
        return default
    return min(max(a, 0.0), 1.0)


def _lw(spec: dict, theme: dict, s: dict | None = None) -> float:
    """线宽：spec.line_width > series.linewidth > 主题默认。"""
    if s is not None:
        v = _f(s.get("linewidth"))
        if v:
            return v
    v = _f(spec.get("line_width"))
    if v:
        return v
    return float(theme.get("lines_linewidth", 1.2))


def _ms(spec: dict, s: dict | None = None) -> float:
    """标记点大小。"""
    if s is not None:
        v = _f(s.get("marker_size"))
        if v:
            return v
    v = _f(spec.get("marker_size"))
    return v if v else 5.0


def _font_size(spec: dict, theme: dict) -> float:
    v = _f(spec.get("font_size"))
    if v and v > 0:
        return float(min(v, 72))
    return float(theme.get("font_size", 10))


def _fmt_size(k: float) -> float:
    """按序列数量自动缩放刻度字号（避免类别多时标签重叠）。"""
    return float(min(1.0, max(0.65, 12.0 / max(k, 1.0))))


# 多子图字号缩放下限：再小就印不出来了，宁可挤一点也不缩成蚂蚁字
_PANEL_FONT_FLOOR = 0.42
# 参考格子边长（英寸）。约 2in 见方时 11pt 的字看着正合适，比这小就按比例缩。
_PANEL_FONT_REF = 2.0


def _panel_font_scale(pw: float, ph: float) -> float:
    """按格子的物理尺寸折算字号缩放系数。

    多子图里每格坐标区被切成一小块，而 font_size 是全局的：11pt 的字塞进
    1.6in×1.05in 的 4×4 格子里，轴标题、刻度、角标、公式框会叠成一团，
    根本看不出画的是什么。这里按"较窄的那条边"等比缩，只缩不放。

    只缩不放是有意的——单图和大格子保持用户设定的字号，行为不变。
    """
    short_side = min(pw, ph)
    if not (short_side > 0):
        return 1.0
    return float(min(1.0, max(_PANEL_FONT_FLOOR, short_side / _PANEL_FONT_REF)))


def _darken(color, factor: float = 0.72):
    """把颜色变深，用于误差棒/拟合线等次级元素。"""
    try:
        r, g, b = mcolors.to_rgb(color)[:3]
        return (r * factor, g * factor, b * factor)
    except (ValueError, TypeError):
        return "#333333"


def _is_dark(color) -> bool:
    """判断背景色是否偏暗（决定标注底框用白还是黑）。"""
    try:
        r, g, b = mcolors.to_rgb(color)[:3]
        return (0.299 * r + 0.587 * g + 0.114 * b) < 0.5
    except (ValueError, TypeError):
        return False


def _mix(c1, c2, t: float):
    """按比例 t 把 c1 混向 c2，返回 rgb 元组。"""
    a = np.array(mcolors.to_rgb(c1)[:3], dtype=float)
    b = np.array(mcolors.to_rgb(c2)[:3], dtype=float)
    return tuple(a + (b - a) * float(t))


def _is_gray_palette(palette) -> bool:
    """调色板是否全为灰阶（用于热图直接走 Greys）。"""
    try:
        for c in palette:
            r, g, b = mcolors.to_rgb(c)[:3]
            if max(abs(r - g), abs(g - b), abs(r - b)) > 0.04:
                return False
        return True
    except (ValueError, TypeError):
        return False


def _heat_cmap(arr, palette, bg="#FFFFFF"):
    """热图色阶。

    分类调色板（8 色）直接当连续色阶会让"数值高低"无法靠明度判断，
    因此这里重新生成：灰阶配色走 Greys；数据跨零走发散色阶；否则用
    调色板主色的顺序色阶（背景色 → 主色 → 深色）。
    """
    if _is_gray_palette(palette):
        return "Greys"
    if arr is None or not np.isfinite(arr).any():
        return "viridis"
    vmin = float(np.nanmin(arr))
    vmax = float(np.nanmax(arr))
    if not math.isfinite(vmin) or not math.isfinite(vmax) or vmax <= vmin:
        return "viridis"

    base = palette[0]
    if vmin < 0 < vmax:
        cool = palette[3] if len(palette) > 3 else "#3C5488"
        colors = [_darken(cool, 0.75), _mix(cool, bg, 0.8), bg,
                  _mix(base, bg, 0.8), _darken(base, 0.75)]
    else:
        colors = [_mix(base, bg, 0.92), _mix(base, bg, 0.5), base,
                  _darken(base, 0.62)]
    return LinearSegmentedColormap.from_list("datalab_heat", colors, N=256)


# --------------------------------------------------------------------------- #
# 四·五、时间轴（datetime）支持
# --------------------------------------------------------------------------- #
# 前端传来的 x 是 ISO 8601 字符串；解析成 datetime 后交给 matplotlib 原生的
# 日期转换器（DateConverter），它会自动选 DateLocator / DateFormatter。
_DT_TYPES = (_dtmod.datetime, _dtmod.date)

# fromisoformat 兜不住的老式写法，按顺序回退
_DT_FALLBACK_FORMATS = (
    "%Y-%m-%d %H:%M:%S",
    "%Y/%m/%d",
    "%Y-%m-%d",
    "%Y/%m/%d %H:%M:%S",
    "%Y-%m-%dT%H:%M",
    "%Y-%m-%d %H:%M",
)


def _parse_datetime(v):
    """单个值 -> datetime；无法解析返回 None（折线在该点断开）。"""
    if v is None:
        return None
    if isinstance(v, _dtmod.datetime):
        return v
    if isinstance(v, _dtmod.date):
        return _dtmod.datetime(v.year, v.month, v.day)
    if isinstance(v, (int, float)):
        # 数字当成"天"为单位的日期序数（matplotlib 内部表示），非法值丢弃
        try:
            if not math.isfinite(float(v)):
                return None
            return mdates.num2date(float(v))
        except Exception:
            return None
    s = str(v).strip()
    if not s:
        return None
    try:
        return _dtmod.datetime.fromisoformat(s)
    except ValueError:
        pass
    for fmt in _DT_FALLBACK_FORMATS:
        try:
            return _dtmod.datetime.strptime(s, fmt)
        except ValueError:
            continue
    return None


def _coerce_datetime(spec: dict) -> dict:
    """就地把 series[].x 与 fit.curve.x 的 ISO 字符串换成 datetime 对象。

    解析失败的点替换成 ``None``（长度保持不变，曲线在此断开），不抛异常。
    """
    raw = spec.get("series")
    if isinstance(raw, (list, tuple)):
        for s in raw:
            if isinstance(s, dict) and isinstance(s.get("x"), (list, tuple)):
                s["x"] = [_parse_datetime(v) for v in s["x"]]
    fit = spec.get("fit")
    if isinstance(fit, dict):
        curve = fit.get("curve")
        if isinstance(curve, dict) and isinstance(curve.get("x"), (list, tuple)):
            curve["x"] = [_parse_datetime(v) for v in curve["x"]]
    return spec


def _is_datetime_list(values) -> bool:
    """序列里是否含有 datetime（含 date）对象。"""
    if not isinstance(values, (list, tuple)):
        return False
    return any(isinstance(v, _DT_TYPES) for v in values)


def _date_numbers(pos):
    """datetime 位置 -> matplotlib 日期数值（None -> NaN）；非日期序列返回 None。"""
    if not _is_datetime_list(pos):
        return None
    out = []
    for p in pos:
        if isinstance(p, _DT_TYPES):
            try:
                out.append(float(mdates.date2num(p)))
            except Exception:
                out.append(float("nan"))
        else:
            out.append(float("nan"))
    return out


def _date_step(nums) -> float:
    """估算日期轴上相邻柱子的间距（天），用于柱宽，取差分中位数。"""
    gaps = []
    for a, b in zip(nums, nums[1:]):
        if math.isfinite(a) and math.isfinite(b) and b > a:
            gaps.append(b - a)
    if not gaps:
        return 1.0
    gaps.sort()
    return float(gaps[len(gaps) // 2]) or 1.0


def _axis_is_datetime(ax, which: str = "x") -> bool:
    """坐标轴是否已被 matplotlib 的日期转换器接管。"""
    try:
        axis = ax.xaxis if which == "x" else ax.yaxis
        conv = axis.get_converter()
    except Exception:
        try:
            axis = ax.xaxis if which == "x" else ax.yaxis
            conv = getattr(axis, "converter", None)
        except Exception:
            return False
    if conv is None:
        return False
    try:
        # 日期转换器有 DateConverter / _SwitchableDateConverter / ConciseDateConverter
        return any("DateConverter" in cls.__name__ for cls in type(conv).__mro__)
    except Exception:
        return False


def _positions(s: dict):
    """解析 x 轴：返回 (位置列表 或 None, 类别标签列表 或 None)。

    全数值 -> 直接用数值；含非数值 -> 用 0..n-1 索引 + 文本标签。
    datetime 序列 -> 原样返回（交给日期转换器），不做分类索引。
    """
    x = s.get("x")
    if not isinstance(x, (list, tuple)) or len(x) == 0:
        return None, None
    raw = list(x)
    # 时间轴：日期值本身是有序数值，绝不能走分类分支
    if _is_datetime_list(raw):
        return raw, None
    pos, labels, numeric = [], [], True
    for v in x:
        try:
            pos.append(float(v))
            labels.append(None)
        except (TypeError, ValueError):
            numeric = False
            break
    if numeric:
        return pos, None
    return list(range(len(raw))), ["" if v is None else str(v) for v in raw]


def _xy(s: dict):
    """取 (x, y)：x 缺失时用序号兜底，长度按 y 对齐。"""
    y = _num_list(s.get("y"))
    pos, labels = _positions(s)
    if pos is None:
        pos = list(range(len(y)))
    if len(pos) < len(y):
        if _is_datetime_list(pos):
            # 日期轴不能用浮点序号补齐，直接截掉多出来的 y
            y = y[:len(pos)]
        else:
            pos = pos + [float(i) for i in range(len(pos), len(y))]
    return pos[:len(y)], y, labels


def _pos_list(s: dict, y: list):
    """柱状图 x 位置解析。

    返回 ``(位置, 类别标签, 日期间距)``；日期轴的位置换成"天"为单位的数值
    （柱宽需要用间距换算），普通轴返回的间距为 None。
    """
    pos, lab = _positions(s)
    if pos is None:
        pos = [float(k) for k in range(len(y))]
    nums = _date_numbers(pos)
    if nums is not None:
        return nums[:len(y)], lab, _date_step(nums)
    if len(pos) < len(y):
        pos = pos + [float(k) for k in range(len(pos), len(y))]
    return pos[:len(y)], lab, None


def _matrix_payload(spec: dict):
    """取矩阵与标签；values 缺失时兼容 series[0].y 的旧写法。"""
    matrix = spec.get("matrix") if isinstance(spec.get("matrix"), dict) else {}
    vals = matrix.get("values")
    if not isinstance(vals, (list, tuple)) or len(vals) == 0:
        se = _series(spec)
        if se:
            y = se[0].get("y")
            if isinstance(y, (list, tuple)) and y and isinstance(y[0], (list, tuple)):
                vals = y
    return matrix, vals


def _matrix_array(spec: dict, kind: str):
    """把矩阵规整为二维 float 数组；脏值留作 NaN，结构错误给中文异常。"""
    matrix, vals = _matrix_payload(spec)
    if not isinstance(vals, (list, tuple)) or not vals:
        raise ValueError("没有可绘制的矩阵数据")
    if not all(isinstance(row, (list, tuple)) for row in vals):
        raise ValueError("矩阵数据必须是二维数组")
    rows = [_num_list(row) for row in vals]
    width = max([len(row) for row in rows] or [0])
    if width == 0:
        raise ValueError("矩阵数据不能为空")
    arr = np.full((len(rows), width), np.nan, dtype=float)
    for i, row in enumerate(rows):
        for j, value in enumerate(row[:width]):
            arr[i, j] = value
    if not np.isfinite(arr).any():
        if kind in _KINDS_3D:
            raise ValueError("三维矩阵没有可用的数值数据")
        raise ValueError("没有可绘制的数据")
    return matrix, arr


def _validate_data(spec: dict, kind: str):
    """按图型能力校验数据，所有用户输入错误统一抛中文 ValueError。"""
    if kind in ("heatmap", "surface3d", "bar3d"):
        _matrix_array(spec, kind)
        return

    se = _series(spec)
    if not se:
        raise ValueError("没有可绘制的数据")

    if kind in ("scatter3d", "line3d"):
        usable = 0
        for s in se:
            x_raw, y_raw, z_raw = s.get("x"), s.get("y"), s.get("z")
            if not isinstance(z_raw, (list, tuple)):
                raise ValueError("三维图缺少 Z 数据")
            if not isinstance(x_raw, (list, tuple)) or not isinstance(y_raw, (list, tuple)):
                raise ValueError("三维图需要 X、Y、Z 三列数据")
            if not (len(x_raw) == len(y_raw) == len(z_raw)):
                raise ValueError("三维图的 X、Y、Z 数据长度必须一致")
            x, y, z = _num_list(x_raw), _num_list(y_raw), _num_list(z_raw)
            if any(math.isfinite(a) and math.isfinite(b) and math.isfinite(c)
                   for a, b, c in zip(x, y, z)):
                usable += 1
        if usable == 0:
            raise ValueError("三维图没有可用的 X、Y、Z 数值数据")
        return

    need_x = kind in ("line", "scatter", "line_marker", "errorbar", "bar",
                      "bar_grouped", "bar_stacked", "residual")
    usable = 0
    for s in se:
        # y 至少要有一个能转成有限数值的点，否则这一条序列算空
        ys = _num_list(s.get("y"))
        has_y = any(not math.isnan(v) for v in ys)
        if not has_y:
            if need_x:
                # 需要 x-y 成对绘制的图，y 空了就是没有数据
                continue
            # 分布类图（hist/box/violin/qq/pie）允许前端只填一列，
            # 这时退回 x 取数
            if not any(not math.isnan(v) for v in _num_list(s.get("x"))):
                continue
        if need_x:
            x = s.get("x")
            if not isinstance(x, (list, tuple)) or len(x) == 0:
                continue
        usable += 1
    if usable == 0:
        raise ValueError("没有可绘制的数据")


# --------------------------------------------------------------------------- #
# 五、rc 参数上下文
# --------------------------------------------------------------------------- #
def _build_rc(theme: dict, spec: dict) -> dict:
    """根据主题与 spec 组装一次性的 rcParams 覆盖字典。"""
    fs = _font_size(spec, theme)
    fg = theme.get("fg", "#000000")
    bg = theme.get("bg", "#FFFFFF")
    aw = float(theme.get("axes_linewidth", 0.8))
    fam = [str(f) for f in (theme.get("font_family") or []) if f]
    if _FONT_NAME and _FONT_NAME not in fam:
        fam.append(_FONT_NAME)
    if not fam:
        fam = ["DejaVu Sans"]
    sans = list(fam) + ["DejaVu Sans"]
    serif = ["Times New Roman"] + list(fam) + ["DejaVu Serif"]
    # 关键：font.family 必须给"具体字体名列表"而不是 "serif"/"sans-serif"
    # 别名，matplotlib 才会逐字形回退到中文字体（否则中文变豆腐块）
    family = serif if theme.get("font") == "serif" else sans

    grid_color = mcolors.to_rgba(fg, 0.18 if not _is_dark(bg) else 0.22)

    rc = {
        "font.family": family,
        "font.sans-serif": sans,
        "font.serif": serif,
        "font.size": fs,
        "font.weight": "normal",
        "mathtext.fontset": "stix" if theme.get("font") == "serif" else "dejavusans",
        "axes.unicode_minus": False,
        "axes.linewidth": aw,
        "axes.edgecolor": fg,
        "axes.labelcolor": fg,
        "axes.labelsize": fs,
        "axes.titlesize": fs * 1.18,
        "axes.titlecolor": fg,
        "axes.facecolor": bg,
        "axes.labelpad": 4.0,
        "axes.formatter.use_mathtext": False,
        "text.color": fg,
        "xtick.color": fg,
        "ytick.color": fg,
        "xtick.labelsize": fs * 0.92,
        "ytick.labelsize": fs * 0.92,
        "xtick.direction": theme.get("tick_direction", "out"),
        "ytick.direction": theme.get("tick_direction", "out"),
        "xtick.major.width": aw,
        "ytick.major.width": aw,
        "xtick.major.size": 3.5,
        "ytick.major.size": 3.5,
        "xtick.minor.size": 2.0,
        "ytick.minor.size": 2.0,
        "lines.linewidth": float(theme.get("lines_linewidth", 1.2)),
        "lines.markersize": _ms(spec),
        "lines.solid_capstyle": "round",
        "grid.color": grid_color,
        "grid.linewidth": 0.6,
        "grid.alpha": 0.55,
        "legend.frameon": bool(theme.get("legend_frame", False)),
        "legend.facecolor": bg,
        "legend.edgecolor": mcolors.to_rgba(fg, 0.45),
        "legend.fontsize": fs * 0.92,
        "legend.labelcolor": fg,
        "figure.facecolor": bg,
        "figure.edgecolor": bg,
        "savefig.facecolor": bg,
        "savefig.edgecolor": bg,
        "figure.max_open_warning": 0,
        "axes.grid": False,
        "axes.axisbelow": True,
        "image.cmap": "viridis",
    }
    return rc


# --------------------------------------------------------------------------- #
# 六、各 kind 的绘制函数
# --------------------------------------------------------------------------- #
def _draw_line(ax, spec, theme, palette):
    """折线图（不含标记点）。"""
    lw = _lw(spec, theme)
    for i, s in enumerate(_series(spec)):
        x, y, _ = _xy(s)
        if not y:
            continue
        ax.plot(x, y,
                color=_color(s, i, palette),
                linewidth=_lw(spec, theme, s) or lw,
                linestyle=s.get("linestyle") or "-",
                alpha=_alpha(s),
                label=_sname(s, i),
                zorder=3)


def _draw_line_marker(ax, spec, theme, palette):
    """带标记的折线图。"""
    for i, s in enumerate(_series(spec)):
        x, y, _ = _xy(s)
        if not y:
            continue
        c = _color(s, i, palette)
        mfc = s.get("markerfacecolor") or c
        ax.plot(x, y,
                color=c,
                linewidth=_lw(spec, theme, s),
                linestyle=s.get("linestyle") or "-",
                marker=s.get("marker") or "o",
                markersize=_ms(spec, s),
                markerfacecolor=mfc,
                markeredgecolor=s.get("markeredgecolor") or c,
                markeredgewidth=0.9,
                alpha=_alpha(s),
                label=_sname(s, i),
                zorder=3)


def _draw_scatter(ax, spec, theme, palette):
    """散点图，点面积由 marker_size 平方换算。"""
    for i, s in enumerate(_series(spec)):
        x, y, _ = _xy(s)
        if not y:
            continue
        ms = _ms(spec, s)
        ax.scatter(x, y,
                   s=max(ms, 1.0) ** 2,
                   c=_color(s, i, palette),
                   marker=s.get("marker") or "o",
                   edgecolors=s.get("markeredgecolor") or "none",
                   linewidths=0.6,
                   alpha=_alpha(s, 0.9),
                   label=_sname(s, i),
                   zorder=3)


def _draw_errorbar(ax, spec, theme, palette):
    """误差棒图：有 yerr/xerr 时画棒，同时保留连线。"""
    for i, s in enumerate(_series(spec)):
        x, y, _ = _xy(s)
        if not y:
            continue
        c = _color(s, i, palette)
        yerr = _num_list(s.get("yerr")) or None
        xerr = _num_list(s.get("xerr")) or None
        # 长度不一致时截断，避免 matplotlib 抛错
        if yerr is not None:
            yerr = yerr[:len(y)]
            yerr = None if len(yerr) < len(y) else yerr
        if xerr is not None:
            xerr = xerr[:len(x)]
            xerr = None if len(xerr) < len(x) else xerr
        ax.errorbar(x, y,
                    yerr=yerr, xerr=xerr,
                    fmt=s.get("marker") or "o",
                    color=c,
                    ecolor=_darken(c, 0.7),
                    elinewidth=0.9,
                    capsize=3,
                    capthick=0.9,
                    markersize=_ms(spec, s),
                    linestyle=s.get("linestyle") or "-",
                    linewidth=_lw(spec, theme, s),
                    alpha=_alpha(s),
                    label=_sname(s, i),
                    zorder=3)


def _apply_cat_ticks(ax, labels, theme, fs):
    """类别轴：设置刻度标签并旋转 30° 防重叠。"""
    if not labels:
        return
    k = len(labels)
    ax.set_xticks(range(k))
    ax.set_xticklabels(labels, rotation=30, ha="right",
                       rotation_mode="anchor",
                       fontsize=fs * _fmt_size(k))


def _draw_bar(ax, spec, theme, palette):
    """柱状图：单序列直接画，多序列自动并排。"""
    se = _series(spec)
    n = max(len(se), 1)
    width = 0.8 if n == 1 else 0.8 / n
    fs = _font_size(spec, theme)
    labels = None
    date_axis = False
    for i, s in enumerate(se):
        y = _num_list(s.get("y"))
        if not y:
            continue
        pos, lab, step = _pos_list(s, y)
        if step is not None:
            # 日期轴：柱宽按相邻日期间距换算（单位是天）
            date_axis = True
            width = step * (0.8 if n == 1 else 0.8 / n)
        if lab and (labels is None or len(lab) > len(labels)):
            labels = lab
        off = 0.0 if n == 1 else (i - (n - 1) / 2.0) * width
        ax.bar([p + off for p in pos], y,
               width=width * 0.96,
               color=_color(s, i, palette),
               alpha=_alpha(s, 0.9),
               edgecolor=theme.get("bg", "#FFFFFF"),
               linewidth=0.6,
               label=_sname(s, i),
               zorder=2)
    if date_axis:
        ax.xaxis_date()
    _apply_cat_ticks(ax, labels, theme, fs)


def _draw_bar_grouped(ax, spec, theme, palette):
    """分组柱状图：每个 series 一组并排。"""
    _draw_bar(ax, spec, theme, palette)


def _draw_bar_stacked(ax, spec, theme, palette):
    """堆叠柱状图：同名 x 位置逐层累加 bottom。"""
    se = _series(spec)
    fs = _font_size(spec, theme)
    labels = None
    bottom = {}
    date_axis = False
    for i, s in enumerate(se):
        y = _num_list(s.get("y"))
        if not y:
            continue
        pos, lab, step = _pos_list(s, y)
        bar_w = 0.72 if step is None else step * 0.72
        if step is not None:
            date_axis = True
        if lab and (labels is None or len(lab) > len(labels)):
            labels = lab
        base = [bottom.get(p, 0.0) for p in pos]
        vals = [0.0 if math.isnan(v) else v for v in y]
        ax.bar(pos, vals,
               bottom=base,
               width=bar_w,
               color=_color(s, i, palette),
               alpha=_alpha(s, 0.92),
               edgecolor=theme.get("bg", "#FFFFFF"),
               linewidth=0.6,
               label=_sname(s, i),
               zorder=2)
        for p, b, v in zip(pos, base, vals):
            bottom[p] = b + v
    if date_axis:
        ax.xaxis_date()
    _apply_cat_ticks(ax, labels, theme, fs)


def _draw_hist(ax, spec, theme, palette):
    """直方图，可选叠加高斯核密度（KDE）曲线。"""
    extra = spec.get("extra") if isinstance(spec.get("extra"), dict) else {}
    try:
        bins = int(extra.get("hist_bins") or 20)
    except (TypeError, ValueError):
        bins = 20
    bins = max(3, min(bins, 500))
    kde_on = bool(extra.get("kde"))
    fs = _font_size(spec, theme)

    for i, s in enumerate(_series(spec)):
        y = _values(s)
        if not y:
            continue
        c = _color(s, i, palette)
        ax.hist(y, bins=bins,
                color=c,
                alpha=_alpha(s, 0.65),
                edgecolor=theme.get("bg", "#FFFFFF"),
                linewidth=0.6,
                density=kde_on,
                label=_sname(s, i),
                zorder=2)
        if kde_on:
            try:
                if len(set(round(v, 12) for v in y)) < 2:
                    continue
                kde = stats.gaussian_kde(y)
                lo, hi = min(y), max(y)
                pad = (hi - lo) * 0.08 or 1.0
                xs = np.linspace(lo - pad, hi + pad, 240)
                ax.plot(xs, kde(xs),
                        color=_darken(c, 0.72),
                        linewidth=_lw(spec, theme, s),
                        zorder=4,
                        label="%s KDE" % _sname(s, i))
            except Exception:
                # KDE 失败不影响直方图本体
                continue
        ax.tick_params(axis="x", labelsize=fs * 0.92)


def _draw_box(ax, spec, theme, palette):
    """箱线图，每组一个箱子，填充半透明配色。"""
    se = _series(spec)
    data, names, colors = [], [], []
    for i, s in enumerate(se):
        y = _values(s)
        if not y:
            continue
        data.append(y)
        names.append(_sname(s, i))
        colors.append(_color(s, i, palette))
    if not data:
        raise ValueError("没有可绘制的数据")

    bp = ax.boxplot(data,
                    patch_artist=True,
                    widths=0.6,
                    showmeans=True,
                    meanprops={"marker": "D", "markerfacecolor": "white",
                               "markeredgecolor": theme.get("fg", "#000000"),
                               "markersize": 4},
                    medianprops={"color": theme.get("fg", "#000000"),
                                 "linewidth": 1.2},
                    whiskerprops={"linewidth": 0.9,
                                  "color": theme.get("fg", "#000000")},
                    capprops={"linewidth": 0.9,
                              "color": theme.get("fg", "#000000")},
                    flierprops={"marker": "o", "markersize": 3,
                                "markerfacecolor": "none",
                                "markeredgecolor": theme.get("fg", "#000000"),
                                "alpha": 0.6})
    for patch, c in zip(bp["boxes"], colors):
        patch.set_facecolor(mcolors.to_rgba(c, 0.55))
        patch.set_edgecolor(_darken(c, 0.8))
        patch.set_linewidth(1.0)

    fs = _font_size(spec, theme)
    k = len(names)
    ax.set_xticks(range(1, k + 1))
    ax.set_xticklabels(names, rotation=30, ha="right",
                       rotation_mode="anchor", fontsize=fs * _fmt_size(k))


def _draw_violin(ax, spec, theme, palette):
    """小提琴图，同时显示中位数与四分位。"""
    se = _series(spec)
    data, names, colors = [], [], []
    for i, s in enumerate(se):
        y = _values(s)
        if len(y) < 2:
            continue
        data.append(y)
        names.append(_sname(s, i))
        colors.append(_color(s, i, palette))
    if not data:
        raise ValueError("没有可绘制的数据")

    vp = ax.violinplot(data, showmeans=False, showmedians=True,
                       showextrema=True, widths=0.75)
    for body, c in zip(vp["bodies"], colors):
        body.set_facecolor(mcolors.to_rgba(c, 0.55))
        body.set_edgecolor(_darken(c, 0.8))
        body.set_linewidth(1.0)
        body.set_alpha(0.75)
    for key in ("cmedians", "cmaxes", "cmins", "cbars"):
        obj = vp.get(key)
        if obj is not None:
            try:
                obj.set_color(theme.get("fg", "#000000"))
                obj.set_linewidth(0.9)
            except Exception:
                pass

    fs = _font_size(spec, theme)
    k = len(names)
    ax.set_xticks(range(1, k + 1))
    ax.set_xticklabels(names, rotation=30, ha="right",
                       rotation_mode="anchor", fontsize=fs * _fmt_size(k))


def _draw_residual(ax, spec, theme, palette):
    """残差图：散点 + y=0 虚线 + ±2σ 阴影带。"""
    fit = spec.get("fit") if isinstance(spec.get("fit"), dict) else {}
    se = _series(spec)
    resid = _num_list(fit.get("residuals"))
    x = []
    if se:
        x, _y, _lab = _xy(se[0])
    if not resid:
        # 退化：用 y 本身当残差
        if se:
            resid = _num_list(se[0].get("y"))
    if not resid:
        raise ValueError("没有可绘制的数据")
    if len(x) != len(resid):
        x = [float(i) for i in range(len(resid))]

    c = _color(se[0], 0, palette) if se else palette[0]
    ms = _ms(spec, se[0] if se else None)
    # 残差图只有一组点，不加图例标签，避免图例块漂浮在阴影带里
    ax.scatter(x, resid, s=max(ms, 1.0) ** 2, c=c, alpha=0.85,
               edgecolors="none", zorder=3)

    # ±2σ 带（σ 用样本标准差，样本不足时退回 RMSE）
    sigma = None
    clean = [v for v in resid if not math.isnan(v)]
    if len(clean) >= 2:
        sigma = float(np.std(clean, ddof=1))
    if not sigma:
        v = _f(fit.get("rmse"))
        sigma = v if v else None
    if sigma and sigma > 0:
        ax.axhspan(-2 * sigma, 2 * sigma,
                   color=mcolors.to_rgba(c, 0.10),
                   zorder=1, linewidth=0)
        ax.axhline(-2 * sigma, color=_darken(c, 0.9), linewidth=0.7,
                   linestyle=":", zorder=2)
        ax.axhline(2 * sigma, color=_darken(c, 0.9), linewidth=0.7,
                   linestyle=":", zorder=2)

    ax.axhline(0.0, color=theme.get("fg", "#000000"),
               linewidth=0.9, linestyle="--", alpha=0.75, zorder=2)


def _draw_qq(ax, spec, theme, palette):
    """Q-Q 图：样本分位数 vs 正态理论分位数，含参考直线。

    这里手算正态理论分位数（不用 ``scipy.stats.probplot``：它内部走
    ``np.cov``/``linregress``，在本机 BLAS 缺符号的环境下会硬崩溃）。
    理论分位数取 ``Φ⁻¹((i-0.5)/n)``，参考线由样本均值与标准差确定。
    """
    se = _series(spec)
    if not se:
        raise ValueError("没有可绘制的数据")
    y = _values(se[0])
    if len(y) < 3:
        raise ValueError("没有可绘制的数据")

    c = _color(se[0], 0, palette)
    ms = _ms(spec, se[0])

    n = len(y)
    osr = np.sort(np.asarray(y, dtype=float))
    probs = (np.arange(1, n + 1) - 0.5) / n
    osm = stats.norm.ppf(probs)

    mean_s = float(np.mean(osr))
    std_s = float(np.std(osr, ddof=1)) if n > 1 else 0.0
    std_t = float(np.std(osm, ddof=0))
    slope = std_s / std_t if std_t > 0 else 0.0
    intercept = mean_s - slope * float(np.mean(osm))

    ax.scatter(osm, osr, s=max(ms, 1.0) ** 2, c=c, alpha=0.85,
               edgecolors="none", zorder=3, label="样本分位数")

    lo = float(min(osm.min(), (osr.min() - intercept) / slope if slope else osm.min()))
    hi = float(max(osm.max(), (osr.max() - intercept) / slope if slope else osm.max()))
    if not math.isfinite(lo) or not math.isfinite(hi) or hi <= lo:
        lo, hi = float(osm.min()), float(osm.max())
    xx = np.array([lo, hi])
    ax.plot(xx, slope * xx + intercept,
            color=_darken(c, 0.75), linewidth=_lw(spec, theme),
            linestyle="--", zorder=2, label="正态参考线")

    ax.set_xlabel(spec.get("xlabel") or "理论分位数")
    ax.set_ylabel(spec.get("ylabel") or "样本分位数")


def _draw_heatmap(ax, spec, theme, palette):
    """热图：imshow + 色条 + 方格数值标注（>100 格时不标）。"""
    matrix = spec.get("matrix") if isinstance(spec.get("matrix"), dict) else {}
    vals = matrix.get("values")
    labels = matrix.get("labels")

    if not vals:
        se = _series(spec)
        if se:
            y = se[0].get("y")
            if isinstance(y, (list, tuple)) and y and isinstance(y[0], (list, tuple)):
                vals = y
    if not vals:
        raise ValueError("没有可绘制的数据")

    rows = [_num_list(r) for r in vals if isinstance(r, (list, tuple))]
    if not rows:
        raise ValueError("没有可绘制的数据")
    width = max(len(r) for r in rows)
    if width == 0:
        raise ValueError("没有可绘制的数据")
    arr = np.full((len(rows), width), np.nan, dtype=float)
    for i, r in enumerate(rows):
        for j, v in enumerate(r[:width]):
            arr[i, j] = v

    try:
        cmap = _heat_cmap(arr, palette, theme.get("bg", "#FFFFFF"))
    except Exception:
        cmap = "viridis"

    im = ax.imshow(arr, aspect="auto", cmap=cmap,
                   interpolation="nearest", origin="upper")
    cbar = ax.figure.colorbar(im, ax=ax, fraction=0.046, pad=0.03)
    cbar.ax.tick_params(labelsize=_font_size(spec, theme) * 0.85,
                        colors=theme.get("fg", "#000000"))
    cbar.outline.set_linewidth(float(theme.get("axes_linewidth", 0.8)))
    cbar.outline.set_edgecolor(theme.get("fg", "#000000"))

    n_rows, n_cols = arr.shape
    fs = _font_size(spec, theme)
    # 行列名
    tick_labels = None
    if isinstance(labels, (list, tuple)) and labels:
        tick_labels = [str(v) for v in labels]
    if tick_labels:
        ax.set_xticks(range(n_cols))
        ax.set_yticks(range(n_rows))
        long_x = any(len(t) > 4 for t in tick_labels[:n_cols]) or n_cols > 8
        ax.set_xticklabels(tick_labels[:n_cols],
                           rotation=30 if long_x else 0,
                           ha="right" if long_x else "center",
                           rotation_mode="anchor",
                           fontsize=fs * _fmt_size(max(n_cols, 1)))
        ax.set_yticklabels(tick_labels[:n_rows], fontsize=fs * _fmt_size(max(n_rows, 1)))
    else:
        ax.set_xticks(range(n_cols))
        ax.set_yticks(range(n_rows))

    # 数值标注：格子不多时才标，字号随行列数自适应
    if n_rows * n_cols <= 100 and np.isfinite(arr).any():
        vmin, vmax = np.nanmin(arr), np.nanmax(arr)
        span = (vmax - vmin) or 1.0
        cell = min(n_rows, n_cols)
        ann_fs = float(min(fs * 0.9, max(4.0, 9.0 * 4.0 / max(cell, 4))))
        fmt = "%.2f" if span <= 10 else "%.1f" if span <= 100 else "%.0f"
        for i in range(n_rows):
            for j in range(n_cols):
                v = arr[i, j]
                if not np.isfinite(v):
                    continue
                rel = (v - vmin) / span
                color = "#FFFFFF" if rel > 0.62 else "#111111"
                ax.text(j, i, fmt % v, ha="center", va="center",
                        fontsize=ann_fs, color=color, zorder=4)

    ax.set_xlabel(spec.get("xlabel") or "")


def _draw_pie(ax, spec, theme, palette):
    """饼图：单序列用其 y 作扇区，多序列用各序列首值。"""
    se = _series(spec)
    if not se:
        raise ValueError("没有可绘制的数据")

    vals, labels = [], []
    if len(se) == 1:
        s0 = se[0]
        vals = _values(s0)
        _pos, lab = _positions(s0)
        if lab and len(lab) >= len(vals):
            labels = lab[:len(vals)]
        if not labels:
            labels = ["%s %d" % (_sname(s0, 0), k + 1) for k in range(len(vals))]
    else:
        for i, s in enumerate(se):
            y = _values(s)
            if not y:
                continue
            vals.append(y[0])
            labels.append(_sname(s, i))

    if not vals:
        raise ValueError("没有可绘制的数据")
    if any(v < 0 for v in vals):
        raise ValueError("饼图数据不能为负数")
    if sum(vals) <= 0:
        raise ValueError("饼图数据之和必须大于 0")

    colors = [palette[i % len(palette)] for i in range(len(vals))]
    wedges, _texts, autotexts = ax.pie(
        vals,
        labels=labels,
        colors=colors,
        autopct="%.1f%%",
        startangle=90,
        counterclock=False,
        wedgeprops={"linewidth": 0.8,
                    "edgecolor": theme.get("bg", "#FFFFFF")},
        textprops={"fontsize": _font_size(spec, theme) * 0.92,
                   "color": theme.get("fg", "#000000")},
        pctdistance=0.72,
    )
    for t in autotexts:
        t.set_fontsize(_font_size(spec, theme) * 0.82)
        t.set_color(theme.get("bg", "#FFFFFF"))
        t.set_fontweight("bold")
    if wedges:
        ax.axis("equal")


def _xyz(s: dict):
    """取三维点并过滤任一坐标为 NaN/inf 的行，避免 mplot3d 在 C 层报错。"""
    x = _num_list(s.get("x"))
    y = _num_list(s.get("y"))
    z = _num_list(s.get("z"))
    points = [(a, b, c) for a, b, c in zip(x, y, z)
              if math.isfinite(a) and math.isfinite(b) and math.isfinite(c)]
    if not points:
        return [], [], []
    xx, yy, zz = zip(*points)
    return list(xx), list(yy), list(zz)


def _draw_scatter3d(ax, spec, theme, palette):
    """三维散点：每条序列独立配色，非法 Z 点按 NaN 语义过滤。"""
    for i, s in enumerate(_series(spec)):
        x, y, z = _xyz(s)
        if not z:
            continue
        ms = _ms(spec, s)
        ax.scatter(x, y, z,
                   s=max(ms, 1.0) ** 2,
                   c=_color(s, i, palette),
                   marker=s.get("marker") or "o",
                   depthshade=True,
                   alpha=_alpha(s, 0.9),
                   label=_sname(s, i))


def _draw_line3d(ax, spec, theme, palette):
    """三维折线：无效点在校验后被过滤，保留每条空间曲线的图例。"""
    for i, s in enumerate(_series(spec)):
        x, y, z = _xyz(s)
        if not z:
            continue
        ax.plot(x, y, z,
                color=_color(s, i, palette),
                linewidth=_lw(spec, theme, s),
                linestyle=s.get("linestyle") or "-",
                marker=s.get("marker") or None,
                markersize=_ms(spec, s),
                alpha=_alpha(s),
                label=_sname(s, i))


def _matrix_axis(raw, fallback, size: int):
    """矩阵标签同时给出绘图坐标；全数值标签保留真实间距，否则用等距序号。"""
    labels = raw if isinstance(raw, (list, tuple)) and raw else fallback
    if isinstance(labels, (list, tuple)) and labels:
        text = [str(v) for v in labels[:size]]
    else:
        text = []
    while len(text) < size:
        text.append(str(len(text)))
    try:
        pos = [float(v) for v in text]
        if not all(math.isfinite(v) for v in pos):
            raise ValueError
    except (TypeError, ValueError):
        pos = [float(i) for i in range(size)]
    return np.asarray(pos, dtype=float), text


def _matrix_axes(matrix: dict, arr):
    """按 xlabels/ylabels → labels → 序号的优先级生成矩阵坐标。"""
    labels = matrix.get("labels")
    x, xtext = _matrix_axis(matrix.get("xlabels"), labels, arr.shape[1])
    y, ytext = _matrix_axis(matrix.get("ylabels"), labels, arr.shape[0])
    return x, y, xtext, ytext


def _set_matrix_ticks(ax, x, y, xtext, ytext, spec, theme):
    """三维矩阵使用真实坐标定位，同时保留原始标签文字。"""
    fs = _font_size(spec, theme) * 0.85
    ax.set_xticks(x)
    ax.set_yticks(y)
    ax.set_xticklabels(xtext, fontsize=fs)
    ax.set_yticklabels(ytext, fontsize=fs)


def _draw_surface3d(ax, spec, theme, palette):
    """三维曲面：矩阵行列映射到 Y/X，并由曲面对象生成色条。"""
    matrix, arr = _matrix_array(spec, "surface3d")
    x, y, xtext, ytext = _matrix_axes(matrix, arr)
    xx, yy = np.meshgrid(x, y)
    try:
        cmap = _heat_cmap(arr, palette, theme.get("bg", "#FFFFFF"))
    except Exception:
        cmap = "viridis"
    surf = ax.plot_surface(xx, yy, arr, cmap=cmap,
                           linewidth=0.25, antialiased=True, alpha=0.95)
    ax.figure.colorbar(surf, ax=ax, shrink=0.62, pad=0.10)
    _set_matrix_ticks(ax, x, y, xtext, ytext, spec, theme)


def _adjacent_step(values) -> float:
    """取最小正相邻间距；单刻度或重复刻度退化为 1，供柱宽乘 0.6。"""
    if len(values) <= 1:
        return 1.0
    ordered = sorted(set(float(v) for v in values if math.isfinite(float(v))))
    gaps = [b - a for a, b in zip(ordered, ordered[1:]) if b > a]
    return min(gaps) if gaps else 1.0


def _draw_bar3d(ax, spec, theme, palette):
    """三维柱状：柱宽深随相邻刻度间距变化，缺失单元不生成柱体。"""
    matrix, arr = _matrix_array(spec, "bar3d")
    x, y, xtext, ytext = _matrix_axes(matrix, arr)
    dx = 0.6 * _adjacent_step(x)
    dy = 0.6 * _adjacent_step(y)
    xpos, ypos, height = [], [], []
    for i, yv in enumerate(y):
        for j, xv in enumerate(x):
            value = float(arr[i, j])
            if not math.isfinite(value):
                continue
            xpos.append(float(xv) - dx / 2.0)
            ypos.append(float(yv) - dy / 2.0)
            height.append(value)
    if not height:
        raise ValueError("三维矩阵没有可用的数值数据")
    vals = np.asarray(height, dtype=float)
    vmin, vmax = float(np.min(vals)), float(np.max(vals))
    norm = mcolors.Normalize(vmin=vmin, vmax=vmax if vmax > vmin else vmin + 1.0)
    try:
        cmap_spec = _heat_cmap(arr, palette, theme.get("bg", "#FFFFFF"))
        cmap = matplotlib.colormaps.get_cmap(cmap_spec)
    except Exception:
        cmap = matplotlib.colormaps.get_cmap("viridis")
    colors = cmap(norm(vals))
    surf = ax.bar3d(xpos, ypos, np.zeros(len(vals)), dx, dy, vals,
                    color=colors, shade=True, alpha=0.92)
    surf.set_cmap(cmap)
    surf.set_norm(norm)
    surf.set_array(vals)
    ax.figure.colorbar(surf, ax=ax, shrink=0.62, pad=0.10)
    _set_matrix_ticks(ax, x, y, xtext, ytext, spec, theme)


_DRAWERS = {
    "line": _draw_line,
    "scatter": _draw_scatter,
    "line_marker": _draw_line_marker,
    "errorbar": _draw_errorbar,
    "bar": _draw_bar,
    "bar_grouped": _draw_bar_grouped,
    "bar_stacked": _draw_bar_stacked,
    "hist": _draw_hist,
    "box": _draw_box,
    "violin": _draw_violin,
    "residual": _draw_residual,
    "qq": _draw_qq,
    "heatmap": _draw_heatmap,
    "pie": _draw_pie,
    "scatter3d": _draw_scatter3d,
    "line3d": _draw_line3d,
    "surface3d": _draw_surface3d,
    "bar3d": _draw_bar3d,
}


# --------------------------------------------------------------------------- #
# 七、拟合叠加与标注
# --------------------------------------------------------------------------- #
def _fit_color(spec: dict, theme: dict, palette: list):
    """拟合曲线颜色：用户指定优先，否则用主题前景色（黑白线不会和数据撞色）。"""
    fit = spec.get("fit") or {}
    c = fit.get("color") if isinstance(fit, dict) else None
    if c:
        try:
            mcolors.to_rgb(c)
            return c
        except (ValueError, TypeError):
            pass
    fg = theme.get("fg", "#000000")
    return mcolors.to_rgba(fg, 0.88)


def _draw_fit(ax, spec, theme, palette):
    """叠加拟合曲线、95% 预测带、公式与 R²。"""
    if spec.get("kind") in ("pie", "heatmap"):
        return
    fit = spec.get("fit")
    if not isinstance(fit, dict) or not fit:
        return

    curve = fit.get("curve") if isinstance(fit.get("curve"), dict) else {}
    raw_x = curve.get("x")
    # 时间轴上曲线 x 是 datetime，不能走 _num_list（会被转成 NaN 而画不出来）
    cx = list(raw_x) if _is_datetime_list(raw_x) else _num_list(raw_x)
    cy = _num_list(curve.get("y"))
    if not cx or not cy or len(cx) != len(cy):
        return

    c = _fit_color(spec, theme, palette)
    lw = _lw(spec, theme)
    ax.plot(cx, cy, color=c, linewidth=lw * 1.1,
            linestyle=fit.get("linestyle") or "-", zorder=5,
            label=fit.get("model_name") or "拟合曲线")

    low = _num_list(curve.get("y_lower"))
    high = _num_list(curve.get("y_upper"))
    if len(low) == len(cx) and len(high) == len(cx):
        try:
            ax.fill_between(cx, low, high,
                            color=c, alpha=0.18, linewidth=0, zorder=2,
                            label="95% 预测带")
        except Exception:
            pass

    # 公式 + R² 标注（左上角，半透明底框）
    eq = fit.get("equation_latex") or fit.get("equation_plain")
    r2 = _f(fit.get("r2"))
    lines = []
    if eq:
        text = str(eq).strip()
        if text.startswith("$") and text.endswith("$"):
            text = text.strip("$")
        lines.append("$%s$" % text)
    if r2 is not None:
        lines.append(r"$R^2 = %.4f$" % r2)
    if lines:
        dark = _is_dark(theme.get("bg", "#FFFFFF"))
        box_bg = (0.10, 0.10, 0.12) if dark else (1.0, 1.0, 1.0)
        # 图例和公式不能抢同一个角。legend_loc 默认是 best，matplotlib 十有八九
        # 会把它放到左上；所以除非图例明确指定在右侧，公式一律靠右，用右对齐
        # 锚在坐标区内，窄面板里也不会横向顶出去。
        loc = str(spec.get("legend_loc") or "best")
        if spec.get("legend") is not False and "right" not in loc:
            tx, ha = 0.978, "right"
        else:
            tx, ha = 0.035, "left"
        # 多子图时每格坐标区只有单图的一半宽：公式按原字号会横向顶出坐标区，
        # 还会跟左上角的 (a)(b) 角标撞在一起，所以收一档字号并下移让开。
        base_fs = _font_size(spec, theme)
        fs_note = base_fs * 0.9
        ty = 0.965
        try:
            dense = len(ax.figure.axes) > 1
        except Exception:
            dense = False
        if dense:
            # 下限跟着正文字号走：4×4 那种小格子里正文已经被缩到 6pt 左右，
            # 若还按固定 5.4pt 兜底，公式框反而比正文还大，喧宾夺主。
            fs_note = max(max(3.8, base_fs * 0.7), fs_note * 0.74)
            ty = 0.895
        ax.text(tx, ty, "\n".join(lines),
                transform=ax.transAxes,
                ha=ha, va="top",
                fontsize=fs_note,
                color=theme.get("fg", "#000000"),
                zorder=6,
                bbox={"boxstyle": "round,pad=0.32",
                      "facecolor": box_bg,
                      "edgecolor": mcolors.to_rgba(theme.get("fg", "#000000"), 0.22),
                      "alpha": 0.78,
                      "linewidth": 0.6})


def _draw_annotations(ax, spec, theme):
    """绘制 spec.annotations 中的人工标注。"""
    items = spec.get("annotations")
    if not isinstance(items, (list, tuple)):
        return
    fs = _font_size(spec, theme) * 0.92
    fg = theme.get("fg", "#000000")
    for a in items:
        if not isinstance(a, dict):
            continue
        text = a.get("text")
        if text is None or str(text) == "":
            continue
        x = _f(a.get("x"))
        y = _f(a.get("y"))
        if x is None or y is None:
            continue
        try:
            if a.get("arrow"):
                ax.annotate(str(text), xy=(x, y), xytext=(14, 16),
                            textcoords="offset points",
                            fontsize=fs, color=fg, zorder=7,
                            arrowprops={"arrowstyle": "->",
                                        "color": fg,
                                        "linewidth": 0.8,
                                        "shrinkA": 0, "shrinkB": 3})
            else:
                ax.annotate(str(text), xy=(x, y), fontsize=fs,
                            color=fg, zorder=7,
                            ha=a.get("ha") or "center",
                            va=a.get("va") or "bottom")
        except Exception:
            continue


# --------------------------------------------------------------------------- #
# 八、统一收尾
# --------------------------------------------------------------------------- #
def _apply_limits(ax, spec):
    """应用 xlim / ylim / zlim（非法值直接忽略）。"""
    items = [("xlim", ax.set_xlim), ("ylim", ax.set_ylim)]
    if hasattr(ax, "set_zlim"):
        items.append(("zlim", ax.set_zlim))
    for key, setter in items:
        lim = spec.get(key)
        if not isinstance(lim, (list, tuple)) or len(lim) != 2:
            continue
        lo, hi = _f(lim[0]), _f(lim[1])
        if lo is None or hi is None or lo == hi:
            continue
        try:
            setter(min(lo, hi), max(lo, hi))
        except Exception:
            continue


def _text_width_pt(text, fs):
    """粗估一段文字的宽度（pt）：中日韩按 1em，西文按 0.55em。"""
    w = 0.0
    for ch in str(text):
        w += 1.0 if ord(ch) > 0x2E80 else 0.55
    return w * float(fs)


def _fit_axis_label(text, ax, fs, vertical):
    """坐标轴标题超出坐标区长度时折成多行。

    竖排（Y 轴）标题绕 90° 之后，它的"长度"要跟坐标区**高度**比；横排跟宽度比。
    多子图里边长只有单图的一半，而自动标题会把多条序列名用逗号连起来
    （"光电流(mA), 理论值(mA)"），不折行就会被画布边缘切掉——字符串本身画得出来，
    只是跑到了 figure 外面。折行后 matplotlib 会把它算进 tight_layout 的包围盒。
    """
    text = str(text or "")
    if not text:
        return text
    try:
        pos = ax.get_position()
        fig_w, fig_h = ax.figure.get_size_inches()
        avail_in = (pos.height * fig_h) if vertical else (pos.width * fig_w)
    except Exception:  # noqa: BLE001
        return text
    avail_pt = avail_in * 72.0 * 0.88
    if _text_width_pt(text, fs) <= avail_pt:
        return text

    parts = [p.strip() for p in re.split(r"[,，;；]\s*", text) if p.strip()]
    if len(parts) < 2:
        parts = [text]

    # 贪心合并：行数尽量少，但每行都不能超长
    lines, cur = [], ""
    for part in parts:
        cand = (cur + ", " + part) if cur else part
        if cur and _text_width_pt(cand, fs) > avail_pt:
            lines.append(cur)
            cur = part
        else:
            cur = cand
    if cur:
        lines.append(cur)
    if len(lines) == 1 and _text_width_pt(lines[0], fs) > avail_pt and len(text) > 1:
        # 没有分隔符可折：从中间硬切两段
        half = max(1, len(text) // 2)
        lines = [text[:half], text[half:]]
    return "\n".join(lines)


def _draw_legend(ax, spec, theme, handles=None, labels=None):
    """在指定轴上画唯一图例；双轴时由调用方传入左右轴合并后的条目。"""
    show_legend = spec.get("legend")
    if show_legend is None:
        show_legend = True
    if not show_legend or spec.get("kind") == "pie":
        return
    fs = _font_size(spec, theme)
    fg = theme.get("fg", "#000000")
    try:
        if handles is None or labels is None:
            handles, labels = ax.get_legend_handles_labels()
        if not handles or not any(lab and not str(lab).startswith("_") for lab in labels):
            return
        loc = spec.get("legend_loc") or "best"
        try:
            ax.legend(handles, labels, loc=loc,
                      frameon=bool(theme.get("legend_frame", False)),
                      fontsize=fs * 0.92,
                      facecolor=theme.get("bg", "#FFFFFF"),
                      edgecolor=mcolors.to_rgba(fg, 0.35),
                      framealpha=0.9,
                      labelcolor=fg,
                      borderpad=0.5,
                      handlelength=1.8,
                      markerscale=0.9)
        except (ValueError, KeyError):
            ax.legend(handles, labels,
                      frameon=bool(theme.get("legend_frame", False)),
                      fontsize=fs * 0.92, labelcolor=fg)
    except Exception:
        pass


def _finalize(ax, spec, theme):
    """统一收尾；三维轴跳过二维 scale、axisbelow 与 spine 语义。"""
    kind = spec.get("kind")
    fs = _font_size(spec, theme)
    fg = theme.get("fg", "#000000")
    aw = float(theme.get("axes_linewidth", 0.8))

    # ---- 标题 / 副标题 ----
    title = spec.get("title")
    subtitle = spec.get("subtitle")
    if title:
        ax.set_title(str(title), color=fg, fontsize=fs * 1.18,
                     fontweight=spec.get("title_weight") or "normal",
                     pad=10 if not subtitle else 20)
        if subtitle:
            ax.text(0.5, 1.008, str(subtitle),
                    transform=ax.transAxes, ha="center", va="bottom",
                    fontsize=fs * 0.88, color=mcolors.to_rgba(fg, 0.78))

    if kind != "pie":
        # ---- 轴标签（qq 图内部已按需设置，不覆盖用户值）----
        if spec.get("xlabel"):
            ax.set_xlabel(_fit_axis_label(spec.get("xlabel"), ax, fs, False),
                          color=fg, fontsize=fs)
        if spec.get("ylabel"):
            ax.set_ylabel(_fit_axis_label(spec.get("ylabel"), ax, fs, True),
                          color=fg, fontsize=fs)

        use_grid = spec.get("grid")
        if isinstance(use_grid, (list, tuple)):
            # 多子图模式下 grid 是 [rows, cols] 形状信息，不是"是否画网格线"
            use_grid = None
        if use_grid is None:
            use_grid = theme.get("grid", False)

        if kind in _KINDS_3D:
            zlabel = spec.get("zlabel")
            if zlabel is None:
                zlabel = spec.get("ylabel") or ""
            ax.set_zlabel(str(zlabel), color=fg, fontsize=fs)
            direction = theme.get("tick_direction", "out")
            ax.tick_params(axis="both", which="major", direction=direction,
                           length=3.5, width=aw, colors=fg,
                           labelsize=fs * 0.92)
            ax.tick_params(axis="both", which="minor", direction=direction,
                           length=2.0, width=aw * 0.8, colors=fg)
            try:
                ax.grid(bool(use_grid))
            except Exception:
                pass
            _apply_limits(ax, spec)
        else:
            # ---- 对数轴 ----
            # 显式设置 linear 会重建 locator，冲掉分类图预先设置的刻度，
            # 所以只在真正需要非线性轴时设置。
            for key, setter in (("xscale", ax.set_xscale), ("yscale", ax.set_yscale)):
                sc = spec.get(key)
                if sc in ("log", "symlog", "logit"):
                    try:
                        setter(sc)
                    except Exception:
                        pass

            # ---- 刻度与边框 ----
            direction = theme.get("tick_direction", "out")
            ax.tick_params(axis="both", which="major", direction=direction,
                           length=3.5, width=aw, colors=fg,
                           labelsize=fs * 0.92)
            ax.tick_params(axis="both", which="minor", direction=direction,
                           length=2.0, width=aw * 0.8, colors=fg)
            for side, visible in (("top", theme.get("spines_top", True)),
                                  ("right", theme.get("spines_right", True))):
                spine = ax.spines.get(side)
                if spine is None:
                    continue
                spine.set_visible(bool(visible))
                spine.set_linewidth(aw)
                spine.set_color(fg)
            for side in ("left", "bottom"):
                spine = ax.spines.get(side)
                if spine is not None:
                    spine.set_linewidth(aw)
                    spine.set_color(fg)

            # ---- 网格 ----
            try:
                if use_grid:
                    ax.grid(True,
                            linestyle=theme.get("grid_style", "--"),
                            linewidth=0.6,
                            color=mcolors.to_rgba(
                                fg, 0.25 if _is_dark(theme.get("bg", "#FFFFFF")) else 0.18),
                            alpha=0.65)
                else:
                    ax.grid(False)
            except Exception:
                pass
            try:
                ax.set_axisbelow(True)
            except Exception:
                # 部分投影轴没有完整的二维 axisbelow 语义，收尾不能因此失败
                pass

            # ---- 对数轴下的范围处理放在刻度之后，避免被重置 ----
            _apply_limits(ax, spec)

            # ---- 时间轴：日期刻度标签通常较长，按需旋转 30° 防重叠 ----
            try:
                if _axis_is_datetime(ax, "x"):
                    labs = [t.get_text() for t in ax.get_xticklabels()]
                    longest = max([len(t) for t in labs] or [0])
                    if labs and (len(labs) >= 6 and longest >= 8 or longest >= 12):
                        ax.tick_params(axis="x", labelrotation=30)
                        for t in ax.get_xticklabels():
                            t.set_horizontalalignment("right")
            except Exception:
                pass

    _draw_legend(ax, spec, theme)


def _valid_color(value):
    """仅接受 matplotlib 能解析的 hex/CSS 颜色，非法值返回 None。"""
    if value is None:
        return None
    try:
        mcolors.to_rgb(value)
        return value
    except (TypeError, ValueError):
        return None


def _prepare_3d_view(ax, spec):
    """绘制前固定三维视角；非法输入退回契约缺省值。"""
    extra = spec.get("extra") if isinstance(spec.get("extra"), dict) else {}
    elev = _f(extra.get("elev"))
    azim = _f(extra.get("azim"))
    ax.view_init(elev=24 if elev is None else elev,
                 azim=-60 if azim is None else azim)


def _draw_with_twin(ax, spec, theme, palette):
    """统一单图/面板绘制；必要时创建右轴并合并图例，返回右轴或 None。"""
    kind = spec.get("kind")
    series = _series(spec)
    right = [s for s in series if str(s.get("axis") or "left").lower() == "right"]
    use_twin = kind in _TWIN_OK_KINDS and bool(right)

    if not use_twin:
        draw_spec = _apply_contrast(spec, theme, palette)
        if kind in _KINDS_3D:
            _prepare_3d_view(ax, draw_spec)
        _DRAWERS[kind](ax, draw_spec, theme, palette)
        if kind not in _KINDS_3D:
            _draw_fit(ax, draw_spec, theme, palette)
        _draw_annotations(ax, draw_spec, theme)
        _finalize(ax, draw_spec, theme)
        return None

    left = [s for s in series if str(s.get("axis") or "left").lower() != "right"]
    pal = list(palette or PALETTES["npg"])
    shift = len(left) % len(pal)
    right_palette = pal[shift:] + pal[:shift]

    left_spec = dict(spec)
    left_spec["series"] = left
    left_spec["legend"] = False
    left_spec = _apply_contrast(left_spec, theme, pal)

    right_spec = dict(spec)
    right_spec["series"] = right
    right_spec["legend"] = False
    right_spec = _apply_contrast(right_spec, theme, right_palette)

    ax2 = ax.twinx()
    if left:
        left_spec["fit"] = spec.get("fit")
        left_spec["annotations"] = spec.get("annotations")
        _DRAWERS[kind](ax, left_spec, theme, pal)
        _draw_fit(ax, left_spec, theme, pal)
        _draw_annotations(ax, left_spec, theme)
    _finalize(ax, left_spec, theme)
    if right:
        _DRAWERS[kind](ax2, right_spec, theme, right_palette)

    # 右轴颜色必须在 finalize 之前定下来：spine/刻度/标签都要用同一色，
    # 否则"哪条线属于右轴"就失去了唯一的视觉线索。
    axis_color = _valid_color(spec.get("y2_color"))
    if axis_color is None and _series(right_spec):
        axis_color = _color(_series(right_spec)[0], 0, right_palette)
    if axis_color is None:
        axis_color = pal[1 % len(pal)]

    right_final = dict(right_spec)
    right_final.update({
        "title": None,
        "subtitle": None,
        "xlabel": "",
        "ylabel": spec.get("y2label") or "",
        "xscale": "linear",
        "yscale": spec.get("y2scale") or "linear",
        "xlim": None,
        "ylim": spec.get("y2lim"),
        "grid": False,
        "legend": False,
        "fit": None,
        "annotations": None,
    })
    right_theme = dict(theme)
    right_theme["fg"] = axis_color
    # 右轴必须可见：twinx 的右边框正是"右轴"的视觉标识
    right_theme["spines_right"] = True
    _finalize(ax2, right_final, right_theme)

    # 隐藏 twinx 复制出来的其余边框，左轴才不会留下一圈重影，
    # 也保证右侧脊柱/刻度/标签统一使用右轴颜色。
    for side in ("left", "top", "bottom"):
        spine = ax2.spines.get(side)
        if spine is not None:
            spine.set_visible(False)
    right_spine = ax2.spines.get("right")
    if right_spine is not None:
        right_spine.set_visible(True)
        right_spine.set_color(axis_color)
        right_spine.set_linewidth(float(theme.get("axes_linewidth", 0.8)))
    ax2.tick_params(axis="y", colors=axis_color)
    ax2.yaxis.label.set_color(axis_color)

    left_handles, left_labels = ax.get_legend_handles_labels()
    right_handles, right_labels = ax2.get_legend_handles_labels()
    _draw_legend(ax, spec, theme,
                 left_handles + right_handles, left_labels + right_labels)
    return ax2


# --------------------------------------------------------------------------- #
# 八·五、多子图（multi-panel）
# --------------------------------------------------------------------------- #
# 面板可从父 spec 继承的字段：只继承版式/样式类，数据与文案一律由面板自己给，
# 避免父 spec 的 title / series 被复制到每个子图上。
_PANEL_INHERIT = (
    "figsize", "dpi", "font_size", "line_width", "marker_size",
    "theme", "palette", "title_weight", "legend_loc", "extra",
)

# 这些字段即使面板里给了，也强制用父 spec 的值（主题/配色/字号/图幅/DPI）
_PANEL_LOCKED = (
    "figsize", "dpi", "font_size", "line_width", "marker_size",
    "theme", "palette",
)


def _grid_is_one(grid) -> bool:
    """grid 是否为 1×1（决定是否退回单轴分支）。"""
    if isinstance(grid, (list, tuple)) and len(grid) >= 2:
        try:
            return int(grid[0]) == 1 and int(grid[1]) == 1
        except (TypeError, ValueError):
            return False
    return False


def _grid_shape(spec: dict, n: int):
    """解析 grid=[rows, cols]，缺省/非法时按面板数自动排布，上限 4×4。"""
    g = spec.get("grid")
    rows = cols = 0
    if isinstance(g, (list, tuple)) and len(g) >= 2:
        try:
            rows, cols = int(g[0]), int(g[1])
        except (TypeError, ValueError):
            rows = cols = 0
    n = max(int(n), 1)
    if rows < 1 or cols < 1:
        cols = int(math.ceil(math.sqrt(n)))
        rows = int(math.ceil(n / float(cols)))
    rows = min(max(rows, 1), 4)
    cols = min(max(cols, 1), 4)
    # 网格装不下所有面板时向外扩，宁可多一格也不能丢面板
    while rows * cols < n and rows < 4:
        rows += 1
    while rows * cols < n and cols < 4:
        cols += 1
    return rows, cols


def _merge_panel(parent: dict, panel: dict) -> dict:
    """以父 spec 的版式字段为底，用面板字段覆盖（锁定字段保持父值）。"""
    merged = {}
    for k in _PANEL_INHERIT:
        if k in parent:
            merged[k] = parent[k]
    if isinstance(panel, dict):
        for k, v in panel.items():
            if k in ("panels", "share_axes"):
                continue
            merged[k] = v
    # 最后再压一遍：主题/配色/字号/线宽/标记大小/图幅/DPI 只认父 spec
    for k in _PANEL_LOCKED:
        if k in parent:
            merged[k] = parent[k]
        else:
            merged.pop(k, None)
    return merged


def _panel_label_text(i: int) -> str:
    """0 -> (a), 25 -> (z), 26 -> (aa)。"""
    letters = "abcdefghijklmnopqrstuvwxyz"
    n, s = int(i), ""
    while True:
        s = letters[n % 26] + s
        n = n // 26 - 1
        if n < 0:
            break
    return "(%s)" % s


def _draw_panel_label(ax, spec: dict, theme: dict, i: int):
    """面板左上角标注 (a)(b)(c)…：压在坐标区内、加粗、不裁切。"""
    label = spec.get("panel_label")
    label = str(label).strip() if label else _panel_label_text(i)
    if not label:
        return
    place = getattr(ax, "text2D", None) if spec.get("kind") in _KINDS_3D else None
    place = place or ax.text
    try:
        place(0.012, 0.985, label,
                transform=ax.transAxes,
                ha="left", va="top",
                fontsize=_font_size(spec, theme) * 1.05,
                fontweight="bold",
                color=theme.get("fg", "#000000"),
                zorder=20,
                clip_on=False)
    except Exception:
        pass


def _panel_area(raw, rows: int, cols: int):
    """引擎侧解析面板 area，返回收敛到网格内的 ``[row, col, rowSpan, colSpan]`` 或 None。

    服务端已经裁决过一遍，这里只做兜底：直接调 ``render_bytes`` 的调用方
    （测试、脚本）可能没走 ``_sanitize_spec``，不能因为 area 脏就崩。
    """
    if rows < 1 or cols < 1:
        return None
    if not isinstance(raw, (list, tuple)) or len(raw) != 4:
        return None
    vals = []
    for v in raw:
        if isinstance(v, bool):
            return None
        try:
            x = float(v)
        except (TypeError, ValueError):
            return None
        if not math.isfinite(x) or abs(x - round(x)) > 1e-9:
            return None
        vals.append(int(round(x)))
    row, col, row_span, col_span = vals
    row_span = min(max(row_span, 1), rows)
    col_span = min(max(col_span, 1), cols)
    return [min(max(row, 0), rows - row_span),
            min(max(col, 0), cols - col_span), row_span, col_span]


def _cells_free(occupied, area) -> bool:
    """area 覆盖的格子是否全部空闲。"""
    row, col, row_span, col_span = area
    for r in range(row, row + row_span):
        line = occupied[r]
        for c in range(col, col + col_span):
            if line[c]:
                return False
    return True


def _fill_cells(occupied, area):
    """把 area 覆盖的格子标成已占。"""
    row, col, row_span, col_span = area
    for r in range(row, row + row_span):
        for c in range(col, col + col_span):
            occupied[r][c] = True


def _find_spot(occupied, rows: int, cols: int, row_span: int, col_span: int):
    """按阅读顺序找第一个能放下 row_span×col_span 的空块，找不到返回 None。"""
    row_span = min(max(int(row_span), 1), rows)
    col_span = min(max(int(col_span), 1), cols)
    for r in range(rows - row_span + 1):
        for c in range(cols - col_span + 1):
            area = [r, c, row_span, col_span]
            if _cells_free(occupied, area):
                return area
    return None


def _place_panels(panels: list, rows: int, cols: int):
    """给每个面板定下最终占位，返回 ([(面板下标, area), ...], 丢弃数)。

    与服务端裁决规则一致：合法且空闲就用，否则按原 span 找空位、再退 1×1、
    最后丢弃。这里的丢弃数只在绕过服务端直接调用时才会非零。
    """
    occupied = [[False] * cols for _ in range(rows)]
    placed = []
    dropped = 0
    for i, panel in enumerate(panels):
        area = _panel_area(panel.get("area") if isinstance(panel, dict) else None,
                           rows, cols)
        if area and _cells_free(occupied, area):
            _fill_cells(occupied, area)
            placed.append((i, area))
            continue
        row_span = area[2] if area else 1
        col_span = area[3] if area else 1
        spot = _find_spot(occupied, rows, cols, row_span, col_span)
        if spot is None:
            spot = _find_spot(occupied, rows, cols, 1, 1)
        if spot is None:
            dropped += 1
            continue
        _fill_cells(occupied, spot)
        placed.append((i, spot))
    return placed, dropped


def _build_panel_figure(spec: dict, panels: list, theme: dict, palette: list,
                        w: float, h: float, dpi: int):
    """构建多子图 Figure，返回 (fig, panels_geo, dropped)。

    每个面板走与单图完全相同的流程：``_DRAWERS`` -> ``_draw_fit`` ->
    ``_draw_annotations`` -> ``_finalize``，最后叠加面板编号。
    版式用 ``GridSpec``：面板按自己的 area 切成 ``gs[r:r+rs, c:c+cs]``，
    没被占用的格子根本不建 ax（不再靠"多余 ax 隐藏"）。
    """
    rows, cols = _grid_shape(spec, len(panels))
    share = bool(spec.get("share_axes"))
    bg = theme.get("bg", "#FFFFFF")

    fig = plt.figure(figsize=(w, h), dpi=dpi, facecolor=bg)
    geo = []
    try:
        gs = fig.add_gridspec(rows, cols)
        placed, _dropped = _place_panels(panels, rows, cols)
        first_ax = None
        has_3d = False
        drawn = []          # [(面板下标, area, 标签, ax)]
        for i, area in placed:
            r, c, rs, cs = area
            # kind 必须先于 add_subplot 解析：投影类型一旦建轴后就不能补改。
            merged = _merge_panel(spec, panels[i])
            kind = str(merged.get("kind") or "line").strip()
            if kind not in SUPPORTED_KINDS:
                raise ValueError("不支持的图形类型：%s" % kind)
            merged["kind"] = kind
            is_3d = kind in _KINDS_3D
            has_3d = has_3d or is_3d

            ax = None
            if is_3d:
                # 三维轴不能与二维/三维面板共享 x/y locator，强制独立投影轴。
                ax = fig.add_subplot(gs[r:r + rs, c:c + cs], projection="3d")
            elif share and first_ax is not None:
                try:
                    ax = fig.add_subplot(gs[r:r + rs, c:c + cs],
                                         sharex=first_ax, sharey=first_ax)
                except Exception:
                    # 共享轴遇到类别轴等不兼容数据时可能报错，退化为不共享
                    ax = None
            if ax is None:
                ax = fig.add_subplot(gs[r:r + rs, c:c + cs])
            if first_ax is None and not is_3d:
                first_ax = ax
            # 按格子的物理尺寸缩字号：这一步必须在 _finalize/_draw_fit 之前，
            # 它们都从 spec["font_size"] 取字号，改这里等于全局生效。
            #
            # 只在「图幅不跟网格放大」时才缩：默认情况（canvas_grow=True）画布已经
            # 按行列数扩过容，每格仍是用户设定的那一格图幅，字号用原值正好，
            # 反而不能缩——缩了就会出现"子图越多字越小"。
            if not bool(spec.get("canvas_grow", True)):
                pw = w * (cs / float(cols))
                ph = h * (rs / float(rows))
                fscale = _panel_font_scale(pw, ph)
                if fscale < 0.999:
                    base_fs = _font_size(merged, theme)
                    merged["font_size"] = round(max(4.2, base_fs * fscale), 2)
            if merged.get("x_datetime"):
                _coerce_datetime(merged)
            _validate_data(merged, kind)
            _draw_with_twin(ax, merged, theme, palette)
            _draw_panel_label(ax, merged, theme, i)
            label = merged.get("panel_label") or _panel_label_text(i)
            drawn.append((i, area, str(label), ax, merged.get("font_size")))

        try:
            # 三维轴（尤其带了 colorbar 时）会触发 "Tight layout not applied" 的
            # UserWarning：tight_layout 不认 3D 轴的 tick labels 尺寸。图能正常出，
            # 但每次渲染往 server.log 刷一行噪音。这里只压这一处，不放宽全局。
            with warnings.catch_warnings():
                warnings.simplefilter("ignore", UserWarning)
                fig.tight_layout()
        except Exception:
            try:
                fig.subplots_adjust(left=0.09, right=0.96, top=0.91, bottom=0.10,
                                    wspace=0.26, hspace=0.30)
            except Exception:
                pass
        if has_3d:
            try:
                fig.subplots_adjust(top=0.90)
            except Exception:
                pass

        # 几何信息必须在最终版式调整之后采：此时坐标区位置才最终确定
        for i, area, label, ax, fsz in drawn:
            try:
                pos = ax.get_position()
                rect = [round(float(pos.x0), 6), round(float(pos.y0), 6),
                        round(float(pos.width), 6), round(float(pos.height), 6)]
            except Exception:
                rect = [0.0, 0.0, 0.0, 0.0]
            geo.append({"index": i, "area": list(area), "label": label,
                        "rect": rect, "font_size": _f(fsz)})
    except Exception:
        # 中途失败时由本函数负责关掉自己创建的 Figure，避免泄漏
        plt.close(fig)
        raise
    return fig, geo, _dropped


# --------------------------------------------------------------------------- #
# 九、对外接口
# --------------------------------------------------------------------------- #
# ---- 输出尺寸保护 -------------------------------------------------------- #
# 浏览器能解码的 PNG 上限：Chromium 系列低于 ≈2.68 亿像素的图会直接解码失败，
# 表现是"服务端明明返回了 3.9 MB 的图，画布却只有一个灰色占位符"。留足余量。
_MAX_OUT_PX = 2.4e8
# 单边上限：Chromium 16384px、Agg canvas 内部 65535px，取小者再留余量。
_MAX_OUT_SIDE = 16000
# 单边/总面积都超限时，降 dpi 的地板：再低就没有出图的意义了
_MIN_OUT_DPI = 36
# 画布单边上限（英寸），同时也是 figsize 的既有上限
_MAX_INCHES = 40.0


def _canvas_inches(spec: dict, w: float, h: float, rows: int, cols: int):
    """多子图时按网格放大画布，保证每一格的物理尺寸不掉。

    这是"子图一多字就变小、越来越糊"的根治办法：figsize × dpi 决定总像素，
    dpi 又决定每英寸多少点。格子从 1 个变 4 个时若 figsize 不动，每格只能分到
    1/4 的像素，曲线看起来就是糊的；而 matplotlib 的 font_size 是绝对 pt，
    塞进变小的格子里又会互相挤压——两个现象其实是同一个原因。

    放大后每格仍是用户设定的「一格图幅」，字号用原值即可，也不需要任何特殊
    排版处理。``canvas_grow=False`` 时留给想要"整图钉死版面"的人（例如期刊要求
    整图不超过 180 mm），那种情况下自动缩字号仍然有意义。
    """
    if rows <= 1 and cols <= 1:
        return w, h, False
    if not bool(spec.get("canvas_grow", True)):
        return w, h, False
    w2 = min(w * float(cols), _MAX_INCHES)
    h2 = min(h * float(rows), _MAX_INCHES)
    if w2 <= w + 1e-9 and h2 <= h + 1e-9:
        return w, h, False
    return w2, h2, True


def _fit_dpi(w: float, h: float, dpi: int, limit_px: float = _MAX_OUT_PX):
    """把 dpi 收敛到「这个图幅下能安全输出」的范围，返回 (dpi, 是否降过)。

    只降 dpi、不动图幅：图幅是内容版式（字号、线宽都按它排的），擅自缩小会让
    字相对变大；dpi 纯粹决定采样密度，降它是唯一不破坏版式的让步方式。
    """
    try:
        d = int(dpi)
    except (TypeError, ValueError):
        d = 300
    d = min(max(d, 50), 1200)
    if not (w > 0 and h > 0):
        return d, False
    origin = d

    # 单边限制：能被宽或高单独触发，例如一条 40in 的通栏图
    long_side = max(w, h)
    if long_side * d > _MAX_OUT_SIDE:
        d = int(_MAX_OUT_SIDE / long_side)
    # 总面积限制：20×20in 配 1200dpi 是 5.76 亿像素，必崩，只能降 dpi
    area = w * h
    if area > 0 and area * d * d > limit_px:
        d = int((limit_px / area) ** 0.5)

    d = max(d, _MIN_OUT_DPI)
    return d, bool(d < origin)


def _figure_size(spec: dict):
    """读取 figsize，非法值回退 6.4×4.2（饼图默认正方形），并做上下限保护。

    返回的是「总画布」英寸；多子图的行列入参传给 :func:`_canvas_inches` 处理。
    """
    fs = spec.get("figsize")
    square = spec.get("kind") == "pie"
    w, h = (5.6, 5.6) if square else (6.4, 4.2)
    if isinstance(fs, (list, tuple)) and len(fs) == 2:
        vw, vh = _f(fs[0]), _f(fs[1])
        if vw and vh and vw > 0.5 and vh > 0.5:
            w, h = min(vw, _MAX_INCHES), min(vh, _MAX_INCHES)
    return w, h


def render_bytes(spec: dict, fmt: str = "png", dpi: int = 300,
                 max_px: float = None) -> bytes:
    """把绘图指令渲染成指定格式的字节流（只要图片，见 ``render_bytes_meta``）。"""
    data, _meta = render_bytes_meta(spec, fmt, dpi, max_px)
    return data


def render_bytes_meta(spec: dict, fmt: str = "png", dpi: int = 300,
                      max_px: float = None):
    """把绘图指令渲染成字节流，并附带多子图的几何信息。

    参数
    ----
    spec : dict
        前端绘图指令，字段见 CONTRACT.md 第 6 节。
    fmt : str
        ``png | svg | pdf | eps``。
    dpi : int
        输出分辨率，仅对位图有意义（50~1200 之间截断）。
    max_px : float
        位图的总像素上限，超出就自动降 dpi（不动图幅）。默认 ``_MAX_OUT_PX``。
        预览场景可以传一个小得多的值：屏幕本来就只有几千像素宽，给 1200dpi
        的 20 英寸图，服务端要老老实实渲染十几秒，浏览器也只是缩小显示。

    返回
    ----
    (bytes, dict)
        图片字节流，以及 ``{"panels_geo": [...], "panels_dropped": int}``。
        ``panels_geo`` 每项是 ``{index, area, label, rect}``，``rect`` 为
        figure 比例的 ``[x0, y0, w0, h0]``（原点左下，tight_layout 之后）；
        单图（无 panels）时为空列表。

    异常
    ----
    ValueError
        图形类型不支持、格式不支持、或没有可绘制的数据。
    """
    if not isinstance(spec, dict):
        raise ValueError("绘图参数必须是对象")

    fmt = str(fmt or "png").lower().lstrip(".")
    if fmt not in SUPPORTED_FORMATS:
        raise ValueError("不支持的导出格式：%s（仅支持 png/svg/pdf/eps）" % fmt)

    kind = str(spec.get("kind") or "line").strip()
    if kind not in SUPPORTED_KINDS:
        raise ValueError("不支持的图形类型：%s" % kind)

    try:
        dpi = int(dpi)
    except (TypeError, ValueError):
        dpi = 300
    dpi = min(max(dpi, 50), 1200)

    _setup_font()
    theme = _get_theme(spec.get("theme"))
    palette = _get_palette(spec.get("palette"))

    # ---- 多子图判定 ----
    # 有 panels 列表就走多面板分支；唯一例外是「1 个面板 + 1×1 网格」，
    # 那种情况等价于单图，把面板字段并进父 spec 后走原来的单 ax 路径。
    raw_panels = spec.get("panels")
    panels = []
    if isinstance(raw_panels, (list, tuple)) and len(raw_panels) > 0:
        panels = [p if isinstance(p, dict) else {} for p in raw_panels]

    if panels:
        multi = not (len(panels) == 1 and _grid_is_one(spec.get("grid")))
    else:
        multi = False

    if not multi:
        if panels:
            # 1×1 单面板：合并后等价单图，保持与旧路径一致的渲染流程
            spec = _merge_panel(spec, panels[0])
            kind = str(spec.get("kind") or "line").strip()
            if kind not in SUPPORTED_KINDS:
                raise ValueError("不支持的图形类型：%s" % kind)

        _validate_data(spec, kind)
        # 时间轴：把 ISO 字符串就地换成 datetime（matplotlib 原生日期轴）
        if spec.get("x_datetime"):
            _coerce_datetime(spec)

    w, h = _figure_size(spec)
    grew = False
    if multi:
        rows, cols = _grid_shape(spec, len(panels))
        w, h, grew = _canvas_inches(spec, w, h, rows, cols)
    # 像素上限只对位图成立：svg/pdf/eps 没有采样密度的概念，
    # 随便 dpi 多大都不会让图变大或解码失败，所以不要为了它砍掉用户的 dpi。
    dpi_used, capped = (dpi, False)
    if fmt == "png":
        try:
            cap = float(max_px) if max_px is not None else _MAX_OUT_PX
        except (TypeError, ValueError):
            cap = _MAX_OUT_PX
        if not (cap > 0):
            cap = _MAX_OUT_PX
        dpi_used, capped = _fit_dpi(w, h, dpi, limit_px=cap)
    rc = _build_rc(theme, spec)

    fig = None
    geo = []
    dropped = int(spec.get("panels_dropped") or 0)
    try:
        with plt.rc_context(rc):
            if multi:
                fig, geo, panel_dropped = _build_panel_figure(
                    spec, panels, theme, palette, w, h, dpi_used)
                # 服务端已裁决过；绕过服务端直调时由引擎补上自己的丢弃数
                dropped += int(panel_dropped)
            else:
                subplot_kw = {"projection": "3d"} if kind in _KINDS_3D else None
                fig, ax = plt.subplots(figsize=(w, h), dpi=dpi_used,
                                       facecolor=theme.get("bg", "#FFFFFF"),
                                       subplot_kw=subplot_kw)
                _draw_with_twin(ax, spec, theme, palette)
                try:
                    # 同 _build_panel_figure：3D 轴的 tight_layout 告警只是噪音
                    with warnings.catch_warnings():
                        warnings.simplefilter("ignore", UserWarning)
                        fig.tight_layout()
                except Exception:
                    pass
                if kind in _KINDS_3D:
                    try:
                        fig.subplots_adjust(top=0.90)
                    except Exception:
                        pass
            buf = io.BytesIO()
            fig.savefig(buf, format=fmt, dpi=dpi_used,
                        bbox_inches="tight",
                        facecolor=fig.get_facecolor(),
                        edgecolor=fig.get_facecolor())
            buf.seek(0)
            return buf.getvalue(), {"panels_geo": geo,
                                    "panels_dropped": dropped,
                                    "figsize_used": [round(w, 3), round(h, 3)],
                                    "dpi_used": int(dpi_used),
                                    "dpi_capped": bool(capped),
                                    "canvas_grown": bool(grew)}
    finally:
        # 必须关闭，否则批量渲染必然内存泄漏
        if fig is not None:
            plt.close(fig)


def render_png(spec: dict) -> bytes:
    """渲染 PNG（dpi 取自 spec，默认 300）。"""
    try:
        dpi = int(spec.get("dpi") or 300)
    except (TypeError, ValueError):
        dpi = 300
    return render_bytes(spec, "png", dpi)


# 导入时完成一次字体注册，避免首图字体生效延迟
try:
    _setup_font()
except Exception:
    pass
