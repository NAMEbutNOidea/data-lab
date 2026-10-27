# -*- coding: utf-8 -*-
"""DataLab 本地服务：数据处理与图表可视化工作台。

零额外依赖，只用 Python 标准库 + numpy/scipy/matplotlib/pandas/openpyxl。
启动：``python server.py``，默认 http://127.0.0.1:8765
"""

# ---------------------------------------------------------------------------
# 必须在 import numpy 之前修掉 conda 环境的 OpenMP/MKL 线程层冲突，
# 否则 BLAS 矩阵乘法会以 0xc06d007f 在 C 层直接杀死进程（Python 拦不住）。
# ---------------------------------------------------------------------------
import os

os.environ.setdefault("MKL_THREADING_LAYER", "SEQUENTIAL")
os.environ.setdefault("KMP_DUPLICATE_LIB_OK", "TRUE")
os.environ.setdefault("OMP_NUM_THREADS", "4")

import base64
import json
import math
import mimetypes
import re
import socket
import sys
import threading
import time
import traceback
import uuid
import webbrowser
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlparse

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))

from core import dataloader  # noqa: E402
import core.plot_engine as plot_engine  # noqa: E402  先导入以装上 BLAS 兜底补丁
from core import fit_engine, stats_engine, transform  # noqa: E402
from core import downsample as downsampler  # noqa: E402

WEB_DIR = ROOT / "web"
OUT_DIR = ROOT / "output"
OUT_DIR.mkdir(exist_ok=True)

# 数据集缓存： ds_id -> {"name": filename, "sheets": {sheet: DataFrame}, "ts": float}
_STORE: dict[str, dict] = {}

# 进程级运行时信息，供 /api/connection 回传给前端的「后端状态窗口」
_RUNTIME: dict = {"port": 0, "started": 0.0}
_STORE_LOCK = threading.Lock()
# matplotlib 不是线程安全的，渲染串行化
_RENDER_LOCK = threading.Lock()
MAX_STORE = 12
# 预览用的像素预算：约 4000×3000。屏幕/画布窗口撑死两三千 CSS 像素宽，
# 给更大的图浏览器也只是缩放显示，服务端却要按真实密度把整幅画出来——
# 20in 配 1200dpi 是 5.76 亿像素，渲染 12 秒、出来还超过浏览器解码上限变白板。
# 图幅不变，降的只是采样密度，导出接口另行给到用户要的 dpi。
_PREVIEW_PX = 1.2e7


def _json_safe(obj):
    """递归把 numpy 标量 / NaN / inf 转成 JSON 可序列化值。"""
    import math

    try:
        import numpy as np
    except Exception:  # pragma: no cover
        np = None

    if obj is None or isinstance(obj, (bool, str)):
        return obj
    if isinstance(obj, int):
        return obj
    if isinstance(obj, float):
        if math.isnan(obj) or math.isinf(obj):
            return None
        return obj
    if np is not None:
        if isinstance(obj, np.bool_):
            return bool(obj)
        if isinstance(obj, np.integer):
            return int(obj)
        if isinstance(obj, np.floating):
            v = float(obj)
            return None if (math.isnan(v) or math.isinf(v)) else v
        if isinstance(obj, np.ndarray):
            return [_json_safe(v) for v in obj.tolist()]
    if isinstance(obj, dict):
        return {str(k): _json_safe(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [_json_safe(v) for v in obj]
    return obj


def json_safe(obj, _depth=0):
    """先做类型规整，再走 json 的 allow_nan=False 严格校验。"""
    return _json_safe(obj)


def _get_frame(ds: str, sheet: str):
    with _STORE_LOCK:
        rec = _STORE.get(ds)
    if rec is None:
        raise ValueError("数据集已失效，请重新导入文件")
    sheets = rec["sheets"]
    if sheet not in sheets:
        if len(sheets) == 1:
            return sheets[next(iter(sheets))]
        raise ValueError(f"工作表不存在：{sheet}")
    return sheets[sheet]


def _put_dataset(filename: str, sheets) -> dict:
    ds = uuid.uuid4().hex[:10]
    with _STORE_LOCK:
        _STORE[ds] = {"name": filename, "sheets": sheets, "ts": time.time()}
        # 超出上限时淘汰最旧的
        while len(_STORE) > MAX_STORE:
            oldest = min(_STORE.items(), key=lambda kv: kv[1]["ts"])[0]
            _STORE.pop(oldest, None)
    return {
        "ds": ds,
        "filename": filename,
        "sheets": [
            {
                "name": sname,
                "row_count": int(len(df)),
                "columns": dataloader.infer_columns(df),
            }
            for sname, df in sheets.items()
        ],
    }


# ---------------------------------------------------------------------------
# 绘图指令归一化：前端只负责表达意图，取值范围与合法性由后端兜住。
# 这样即使前端状态被改坏（例如 DPI 手输 20000、figsize 给负数），
# 也不会把 matplotlib 拖死或产出几百 MB 的图片。
# ---------------------------------------------------------------------------

_COLOR_RE = re.compile(r"^(#[0-9a-fA-F]{3,8}|[a-zA-Z]{3,20})$")


def _clamp(value, lo: float, hi: float, default: float) -> float:
    """把任意输入收敛到 [lo, hi]，非法值退回 default。"""
    if isinstance(value, bool):
        return default
    try:
        x = float(value)
    except (TypeError, ValueError):
        return default
    if not math.isfinite(x):
        return default
    return min(max(x, lo), hi)


def _finite_or_none(value):
    """数值型单元格：非有限值统一转 None（引擎按 NaN 处理并断线）。"""
    if isinstance(value, bool) or value is None:
        return None
    if isinstance(value, (int, float)):
        return float(value) if math.isfinite(float(value)) else None
    if isinstance(value, str):
        text = value.strip()
        if text == "":
            return None
        try:
            x = float(text)
        except ValueError:
            return text  # 类别型 X 轴标签原样保留
        return x if math.isfinite(x) else None
    return None


def _clean_values(values):
    """把序列里的 NaN/inf 洗成 None，长度不变（保证 x/y 仍能对齐）。"""
    if not isinstance(values, (list, tuple)):
        return []
    return [_finite_or_none(v) for v in values]


def _sanitize_series(raw_series, max_series: int = 16):
    """校验并归一化序列列表，返回 (series, downsample_stats)。"""
    series = []
    stats = []
    if not isinstance(raw_series, (list, tuple)):
        return series, stats

    for item in raw_series[:max_series]:
        if not isinstance(item, dict):
            continue
        one = dict(item)
        axis = str(one.get("axis") or "left").lower()
        one["axis"] = axis if axis in ("left", "right") else "left"
        one["x"] = _clean_values(one.get("x"))
        one["y"] = _clean_values(one.get("y"))
        if isinstance(one.get("yerr"), (list, tuple)):
            one["yerr"] = _clean_values(one["yerr"])
        has_z = isinstance(one.get("z"), list)
        if has_z:
            one["z"] = _clean_values(one["z"])
        else:
            # 二维图不得被无效输入污染出 z=[] 占位；缺失与空 Z 在三维校验里语义不同。
            one.pop("z", None)

        lengths = [len(one["x"]), len(one["y"])]
        if has_z:
            lengths.append(len(one["z"]))
        n = min(lengths)
        if n:
            one["x"], one["y"] = one["x"][:n], one["y"][:n]
            if has_z:
                one["z"] = one["z"][:n]
            ye = one.get("yerr")
            if isinstance(ye, list):
                ye = ye[:n]

            # 三维序列把 Z 当作降采样附带列；同一算法再跑一次即可让 yerr
            # 使用完全相同的确定性索引，避免任一附带列与 X/Y 错位。
            raw_x, raw_y = one["x"], one["y"]
            aux = one["z"] if has_z else ye
            x2, y2, aux2, info = downsampler.downsample_series(
                raw_x, raw_y, downsampler.MAX_POINTS, aux)
            one["x"], one["y"] = x2, y2
            if has_z:
                one["z"] = aux2 if isinstance(aux2, list) else []
                if isinstance(ye, list):
                    _x2, _y2, ye2, _unused = downsampler.downsample_series(
                        raw_x, raw_y, downsampler.MAX_POINTS, ye)
                    one["yerr"] = ye2
            elif isinstance(aux2, list):
                one["yerr"] = aux2
            if info:
                info["name"] = str(one.get("name") or ("序列%d" % (len(series) + 1)))[:60]
                stats.append(info)
        else:
            one["x"], one["y"] = [], []
            if has_z:
                one["z"] = []
        if one.get("color") is not None:
            # 只接受 #rgb/#rrggbb(aa) 或 CSS 颜色名，避免把脏字符串塞进 matplotlib
            color = str(one["color"]).strip()
            if _COLOR_RE.match(color):
                one["color"] = color
            else:
                one.pop("color", None)
        series.append(one)
    return series, stats


def _int_or_none(value):
    """整数解析：bool / 非数值 / 非整数一律 None（area 只接受整格坐标）。"""
    if isinstance(value, bool):
        return None
    try:
        x = float(value)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(x) or abs(x - round(x)) > 1e-9:
        return None
    return int(round(x))


def _sanitize_area(raw, rows: int, cols: int):
    """解析面板占位 area=[row, col, rowSpan, colSpan]，返回收敛后的 4 元 list 或 None。

    越界（负坐标、span 超过网格、row+rowSpan 出界）一律收敛到网格内；
    结构不合法（不是 4 个数 / 含布尔或非整数）返回 None，交给占位裁决按 1×1 自动放。
    """
    if rows < 1 or cols < 1:
        return None
    if not isinstance(raw, (list, tuple)) or len(raw) != 4:
        return None
    vals = [_int_or_none(v) for v in raw]
    if any(v is None for v in vals):
        return None
    row, col, row_span, col_span = vals
    row_span = min(max(row_span, 1), rows)
    col_span = min(max(col_span, 1), cols)
    row = min(max(row, 0), rows - row_span)
    col = min(max(col, 0), cols - col_span)
    return [row, col, row_span, col_span]


def _area_free(occupied, area) -> bool:
    """area 覆盖的格子是否全部空闲。"""
    row, col, row_span, col_span = area
    for r in range(row, row + row_span):
        line = occupied[r]
        for c in range(col, col + col_span):
            if line[c]:
                return False
    return True


def _mark_area(occupied, area):
    """把 area 覆盖的格子标成已占。"""
    row, col, row_span, col_span = area
    for r in range(row, row + row_span):
        for c in range(col, col + col_span):
            occupied[r][c] = True


def _first_free(occupied, rows: int, cols: int, row_span: int, col_span: int):
    """按阅读顺序（先行后列）找第一个能放下 row_span×col_span 的空块。"""
    row_span = min(max(int(row_span), 1), rows)
    col_span = min(max(int(col_span), 1), cols)
    for r in range(rows - row_span + 1):
        for c in range(cols - col_span + 1):
            area = [r, c, row_span, col_span]
            if _area_free(occupied, area):
                return area
    return None


def _arbitrate_areas(panels: list, rows: int, cols: int):
    """占位裁决：按数组顺序给每个面板定下最终 area，返回 (保留的面板, 丢弃数)。

    规则：area 合法且格子空闲就照用；否则按原 span 找第一个空块，再退 1×1，
    实在没位置就跳过该面板。绝不覆盖已占格子，也绝不因冲突抛错。
    """
    occupied = [[False] * cols for _ in range(rows)]
    kept = []
    dropped = 0
    for panel in panels:
        area = panel.get("area")
        if area and _area_free(occupied, area):
            _mark_area(occupied, area)
            panel["area"] = list(area)
            kept.append(panel)
            continue
        row_span = area[2] if area else 1
        col_span = area[3] if area else 1
        spot = _first_free(occupied, rows, cols, row_span, col_span)
        if spot is None:
            spot = _first_free(occupied, rows, cols, 1, 1)
        if spot is None:
            dropped += 1
            continue
        _mark_area(occupied, spot)
        panel["area"] = spot
        kept.append(panel)
    return kept, dropped


def _sanitize_matrix(raw):
    """归一化矩阵数据（热图/三维曲面/三维柱状共用）。

    矩阵由前端直接透传，这里只做两件事：把每个格子收敛成有限数值或 None
    （引擎侧按 NaN 处理并留白），以及把行列标签截短。结构不合法返回 None，
    由引擎给出中文错误提示。
    """
    if not isinstance(raw, dict):
        return None
    raw_values = raw.get("values")
    if not isinstance(raw_values, (list, tuple)):
        return None
    rows = []
    for row in raw_values[:200]:
        if not isinstance(row, (list, tuple)):
            return None
        rows.append([_finite_or_none(v) for v in row[:200]])
    if not rows:
        return None

    def _labels(key):
        vals = raw.get(key)
        if not isinstance(vals, (list, tuple)):
            return None
        return [str(v)[:40] for v in vals[:200]]

    out = {"values": rows}
    for key in ("labels", "xlabels", "ylabels"):
        lab = _labels(key)
        if lab is not None:
            out[key] = lab
    return out


def _sanitize_panel(raw, idx: int, rows: int = 0, cols: int = 0) -> dict:
    """校验单个子图配置。主题/配色/图幅/DPI 一律从父 spec 继承，这里不处理。"""
    p = dict(raw) if isinstance(raw, dict) else {}

    kind = str(p.get("kind") or "line").strip()
    if kind not in plot_engine.SUPPORTED_KINDS:
        kind = "line"

    out = {"kind": kind}
    for key in ("title", "xlabel", "ylabel"):
        if p.get(key) is not None:
            out[key] = str(p[key])[:120]

    label = p.get("panel_label")
    out["panel_label"] = (str(label)[:8] if label not in (None, "")
                          else "(%s)" % chr(97 + idx % 26))

    for key in ("xscale", "yscale"):
        s = str(p.get(key) or "linear").strip().lower()
        out[key] = s if s in ("linear", "log") else "linear"
    # 双轴、三维：按子图生效（故意不进 _PANEL_LOCKED，父值也不覆盖）
    s2 = str(p.get("y2scale") or "linear").strip().lower()
    out["y2scale"] = s2 if s2 in ("linear", "log", "symlog") else "linear"
    for key in ("y2label", "zlabel"):
        if p.get(key) is not None:
            out[key] = str(p[key])[:80]
    lim = p.get("y2lim")
    if isinstance(lim, (list, tuple)) and len(lim) >= 2:
        lo, hi = _finite_or_none(lim[0]), _finite_or_none(lim[1])
        if isinstance(lo, (int, float)) and isinstance(hi, (int, float)) and lo != hi:
            out["y2lim"] = [min(lo, hi), max(lo, hi)]

    out["grid"] = bool(p.get("grid", True))
    out["legend"] = bool(p.get("legend", True))
    # 矩阵类图（热图/三维曲面/三维柱状）的数据挂在面板自己身上
    if p.get("matrix") is not None:
        out["matrix"] = _sanitize_matrix(p.get("matrix"))
    out["x_datetime"] = bool(p.get("x_datetime", False))
    # 跨格占位：越界收敛到网格内，结构非法则 None（由 _sanitize_spec 统一裁决）
    out["area"] = _sanitize_area(p.get("area"), rows, cols)

    out["series"], _stats = _sanitize_series(p.get("series"))
    fit = p.get("fit")
    out["fit"] = fit if isinstance(fit, dict) else None
    ann = p.get("annotations")
    out["annotations"] = ann if isinstance(ann, (list, tuple)) else None
    return out, _stats



def _sanitize_spec(raw: dict) -> dict:
    """校验并归一化绘图指令，返回全新 dict（不改动入参）。"""
    if not isinstance(raw, dict):
        raise ValueError("绘图参数必须是对象")

    spec = dict(raw)

    kind = str(spec.get("kind") or "line").strip()
    if kind not in plot_engine.SUPPORTED_KINDS:
        raise ValueError(f"不支持的图形类型：{kind}")
    spec["kind"] = kind

    theme = str(spec.get("theme") or "paper_nature").strip()
    spec["theme"] = theme if theme in plot_engine.THEMES else "paper_nature"
    palette = str(spec.get("palette") or "npg").strip()
    spec["palette"] = palette if palette in plot_engine.PALETTES else "npg"

    fig = spec.get("figsize")
    if isinstance(fig, (list, tuple)) and len(fig) >= 2:
        w = _clamp(fig[0], 1.0, 30.0, 6.4)
        h = _clamp(fig[1], 1.0, 30.0, 4.2)
    else:
        w, h = 6.4, 4.2
    spec["figsize"] = [round(w, 3), round(h, 3)]

    spec["dpi"] = int(_clamp(spec.get("dpi"), 50, 1200, 300))
    # 多子图时画布要不要跟着网格放大：默认 True，放开了每格的物理尺寸、
    # 字号和清晰度才不随子图数量下降。要钉死整图版面（期刊限宽）时置 False。
    spec["canvas_grow"] = bool(spec.get("canvas_grow", True))
    spec["font_size"] = _clamp(spec.get("font_size"), 4.0, 48.0, 11.0)
    spec["line_width"] = _clamp(spec.get("line_width"), 0.2, 10.0, 1.6)
    spec["marker_size"] = _clamp(spec.get("marker_size"), 0.5, 30.0, 5.0)

    for key in ("xscale", "yscale"):
        scale = str(spec.get(key) or "linear").strip().lower()
        spec[key] = scale if scale in ("linear", "log") else "linear"
    # 双轴与三维的附加字段：类型收敛后透传给引擎（面板级允许逐子图不同）
    y2scale = str(spec.get("y2scale") or "linear").strip().lower()
    spec["y2scale"] = y2scale if y2scale in ("linear", "log", "symlog") else "linear"
    for key in ("y2label", "zlabel"):
        if spec.get(key) is not None:
            spec[key] = str(spec[key])[:80]
        elif key in spec:
            spec.pop(key)
    y2lim = spec.get("y2lim")
    if isinstance(y2lim, (list, tuple)) and len(y2lim) >= 2:
        lo, hi = _finite_or_none(y2lim[0]), _finite_or_none(y2lim[1])
        if isinstance(lo, (int, float)) and isinstance(hi, (int, float)) and lo != hi:
            spec["y2lim"] = [min(lo, hi), max(lo, hi)]
        else:
            spec.pop("y2lim", None)
    elif "y2lim" in spec:
        spec.pop("y2lim")
    if spec.get("matrix") is not None:
        spec["matrix"] = _sanitize_matrix(spec.get("matrix"))

    for key in ("title", "xlabel", "ylabel", "subtitle"):
        if spec.get(key) is not None:
            spec[key] = str(spec[key])[:200]

    # 网格线开关与子图网格形状是两个不同的东西：前端用 grid（布尔）表示"画不画网格线"，
    # grid_shape（[rows, cols]）表示子图排布。绘图引擎里 grid 一个键兼两义
    # （list=形状 / bool=网格线），所以这里按有没有 panels 决定发哪种。
    show_grid = bool(spec.get("grid", True))
    spec["legend"] = bool(spec.get("legend", True))

    raw_panels = spec.get("panels")
    panels = []
    downsample_stats = []
    rows = cols = 0
    if isinstance(raw_panels, (list, tuple)) and len(raw_panels) > 0:
        count = min(len(raw_panels), 16)
        # 网格必须先定下来：area 的收敛要用 rows/cols，所以形状计算提前到面板循环之前
        shape = spec.get("grid_shape")
        if isinstance(shape, (list, tuple)) and len(shape) >= 2:
            rows = int(_clamp(shape[0], 1, 4, 1))
            cols = int(_clamp(shape[1], 1, 4, 1))
        if rows < 1 or cols < 1:
            rows, cols = 1, max(1, min(4, count))
        # 装不下就向外扩，宁可多留一格也不能丢面板（跨格面板由裁决环节负责挤位）
        while rows * cols < count and rows < 4:
            rows += 1
        while rows * cols < count and cols < 4:
            cols += 1
        for i, p in enumerate(raw_panels[:16]):
            panel, pstats = _sanitize_panel(p, i, rows, cols)
            panels.append(panel)
            downsample_stats.extend(pstats)

    if panels:
        # 占位裁决：冲突的面板挪位或丢弃，结果写回 panels / panels_dropped
        panels, dropped = _arbitrate_areas(panels, rows, cols)
        spec["grid"] = [rows, cols]        # 引擎见到 list 就按"形状"处理
        spec["panels"] = panels
        spec["panels_dropped"] = dropped
        spec["share_axes"] = bool(spec.get("share_axes", False))
        spec["x_datetime"] = bool(spec.get("x_datetime", False))
        spec["series"] = []                # 多子图模式下顶层 series 无用，清空免得误绘
    else:
        spec.pop("panels", None)
        spec.pop("grid_shape", None)
        spec.pop("panels_dropped", None)
        spec["grid"] = show_grid
        spec["x_datetime"] = bool(spec.get("x_datetime", False))
        spec["series"], downsample_stats = _sanitize_series(spec.get("series"))

    spec["downsample"] = downsample_stats

    if spec.get("fit") is not None and not isinstance(spec["fit"], dict):
        spec["fit"] = None

    return spec


# ---------------------------------------------------------------------------
# 业务动作
# ---------------------------------------------------------------------------

def act_upload(payload: dict) -> dict:
    filename = str(payload.get("filename") or "上传文件.xlsx")
    b64 = payload.get("data_b64") or ""
    if not b64:
        raise ValueError("没有收到文件内容")
    if "," in b64 and b64.strip().startswith("data:"):
        b64 = b64.split(",", 1)[1]
    try:
        raw = base64.b64decode(b64)
    except Exception as e:  # noqa: BLE001
        raise ValueError(f"文件解码失败：{e}") from e
    if len(raw) > 60 * 1024 * 1024:
        raise ValueError("文件超过 60MB，请先裁剪")
    sheets = dataloader.parse(filename, raw)
    return _put_dataset(filename, sheets)


def act_preview(payload: dict) -> dict:
    df = _get_frame(payload.get("ds"), payload.get("sheet"))
    total = int(len(df))
    offset = max(0, int(payload.get("offset") or 0))
    limit = int(payload.get("limit") or 200)
    limit = max(1, min(limit, 200000))
    view = df.iloc[offset: offset + limit]
    rows = []
    for rec in view.itertuples(index=False, name=None):
        row = []
        for v in rec:
            if isinstance(v, float):
                row.append(None if (v != v) else round(v, 10))
            else:
                row.append("" if v is None else str(v))
        rows.append(row)
    return {
        "rows": rows,
        "columns": dataloader.infer_columns(df),
        "total": total,
        "offset": offset,
        "limit": limit,
    }


def _col(df, name):
    return dataloader.column_values(df, name)


_ISO_FORMATS = ("%Y-%m-%dT%H:%M:%S", "%Y-%m-%d %H:%M:%S", "%Y-%m-%d",
                "%Y/%m/%d %H:%M:%S", "%Y/%m/%d", "%Y年%m月%d日")


def _parse_iso(text):
    """把 ISO / 常见日期写法解析成 datetime，失败返回 None。"""
    if text is None:
        return None
    s = str(text).strip()
    if not s:
        return None
    try:
        return datetime.fromisoformat(s)
    except ValueError:
        pass
    for fmt in _ISO_FORMATS:
        try:
            return datetime.strptime(s, fmt)
        except ValueError:
            continue
    return None


def _column_dtype(df, name):
    for c in dataloader.infer_columns(df):
        if c.get("name") == name:
            return c.get("dtype")
    return None


def _fit_series(df, name):
    """取一列用于计算。

    时间列不能直接进 curve_fit / 统计，这里换算成"相对首点的秒数"，
    这样"随时间变化的趋势拟合"也能做；其余列原样返回。
    """
    vals = dataloader.column_values(df, name)
    if _column_dtype(df, name) != "datetime":
        return vals
    times = [_parse_iso(v) for v in vals]
    base = next((t for t in times if t is not None), None)
    if base is None:
        return [None] * len(vals)
    return [None if t is None else (t - base).total_seconds() for t in times]



def act_describe(payload: dict) -> dict:
    df = _get_frame(payload.get("ds"), payload.get("sheet"))
    cols = payload.get("cols") or []
    if not cols:
        cols = [c for c in df.columns if str(df[c].dtype).startswith("float")]
    results = []
    for c in cols:
        if _column_dtype(df, c) == "datetime":
            raise ValueError("「%s」是时间列，描述统计请选择数值列" % c)
        res = stats_engine.describe(_col(df, c))
        res["col"] = c
        base, unit = dataloader.split_unit(c)
        res["base"] = base
        res["unit"] = unit
        results.append(res)
    return {"results": results}


def act_uncertainty(payload: dict) -> dict:
    df = _get_frame(payload.get("ds"), payload.get("sheet"))
    col = payload.get("col")
    vals = _col(df, col)
    delta = payload.get("delta")
    delta = None if delta in (None, "", "null") else float(delta)
    res = stats_engine.full_uncertainty(
        vals,
        delta=delta,
        distribution=payload.get("distribution") or "uniform",
        confidence=float(payload.get("confidence") or 0.683),
        custom_k=(None if payload.get("custom_k") in (None, "", "null") else float(payload.get("custom_k"))),
        coverage_k=float(payload.get("coverage_k") or 2.0),
    )
    base, unit = dataloader.split_unit(col)
    res["col"] = col
    res["unit"] = unit
    return res


def act_test(payload: dict) -> dict:
    df = _get_frame(payload.get("ds"), payload.get("sheet"))
    test = payload.get("test") or "ttest_1samp"
    x = _col(df, payload.get("col_x"))
    y = None
    if payload.get("col_y"):
        y = _col(df, payload.get("col_y"))
    return stats_engine.hypothesis_test(
        x, y,
        test=test,
        mu=float(payload.get("mu") or 0.0),
        alpha=float(payload.get("alpha") or 0.05),
        alternative=payload.get("alternative") or "two-sided",
        equal_var=bool(payload.get("equal_var", True)),
    )


def act_fit(payload: dict) -> dict:
    df = _get_frame(payload.get("ds"), payload.get("sheet"))
    x = _fit_series(df, payload.get("x_col"))
    y = _fit_series(df, payload.get("y_col"))
    n = min(len(x), len(y))
    if n < 3:
        raise ValueError("有效数据点不足 3 个，无法拟合")
    x, y = x[:n], y[:n]
    yerr = None
    if payload.get("use_yerr") and payload.get("yerr_col"):
        ye = dataloader.column_values(df, payload.get("yerr_col"))
        m = min(n, len(ye))
        x, y, yerr = x[:m], y[:m], ye[:m]
    res = fit_engine.fit(x, y, model=payload.get("model") or "linear",
                         deg=int(payload.get("deg") or 2), yerr=yerr)
    res["x_col"] = payload.get("x_col")
    res["y_col"] = payload.get("y_col")
    return res


def act_fit_compare(payload: dict) -> dict:
    """把全部拟合模型跑一遍，按 AIC 升序返回，用于"到底该选哪个模型"。"""
    df = _get_frame(payload.get("ds"), payload.get("sheet"))
    x = _fit_series(df, payload.get("x_col"))
    y = _fit_series(df, payload.get("y_col"))
    n = min(len(x), len(y))
    if n < 3:
        raise ValueError("有效数据点不足 3 个，无法比较模型")
    x, y = x[:n], y[:n]
    yerr = None
    if payload.get("use_yerr") and payload.get("yerr_col"):
        ye = dataloader.column_values(df, payload.get("yerr_col"))
        m = min(n, len(ye))
        x, y, yerr = x[:m], y[:m], ye[:m]
    only = payload.get("models")
    res = fit_engine.compare_models(
        x, y,
        deg=int(payload.get("deg") or 2),
        yerr=yerr,
        models=only if isinstance(only, (list, tuple)) and only else None,
    )
    res["x_col"] = payload.get("x_col")
    res["y_col"] = payload.get("y_col")
    return res


def act_transform(payload: dict) -> dict:
    """对一列做变换，结果作为**新列**写回数据集（原始列不动）。"""
    df = _get_frame(payload.get("ds"), payload.get("sheet"))
    col = payload.get("col")
    if not col:
        raise ValueError("请选择要变换的列")
    op = str(payload.get("op") or "").strip()
    params = payload.get("params")
    if params is not None and not isinstance(params, dict):
        params = None

    values = _fit_series(df, col)
    xcol = payload.get("x_col")
    xvals = _fit_series(df, xcol) if xcol else None

    new_vals, info = transform.apply(values, op, params, x=xvals)

    meta = transform.OPS.get(op) or {}
    base_name = str(payload.get("name") or ("%s · %s" % (col, meta.get("name", op))))[:80]
    name, k = base_name, 2
    while name in df.columns:                 # 重名自动加序号，不覆盖已有列
        name = "%s (%d)" % (base_name, k)
        k += 1
    df[name] = new_vals

    return {
        "name": name,
        "info": info,
        "row_count": int(len(df)),
        "columns": dataloader.infer_columns(df),
        "values": new_vals[:200],
    }


def act_datasets(payload: dict | None = None) -> dict:
    """列出内存里还活着的数据集，供前端做"最近打开"。"""
    now = time.time()
    items = []
    with _STORE_LOCK:
        ordered = sorted(_STORE.items(), key=lambda kv: kv[1]["ts"], reverse=True)
        for ds, rec in ordered:
            sheets, rows_total = [], 0
            for sname, frame in rec["sheets"].items():
                rows_total += int(len(frame))
                sheets.append({"name": sname, "rows": int(len(frame)),
                               "cols": int(frame.shape[1])})
            items.append({
                "ds": ds,
                "filename": rec["name"],
                "age_s": int(max(0, now - rec["ts"])),
                "rows": rows_total,
                "sheets": sheets,
            })
    return {"datasets": items}


def act_render(payload: dict) -> dict:
    spec = _sanitize_spec(payload.get("spec") or {})
    t0 = time.perf_counter()
    with _RENDER_LOCK:
        # 预览按屏幕需要的密度来：损失不了版面（图幅不变），却能把 12 秒的等待
        # 压回几百毫秒。真正的 1200dpi 交给导出，那里才需要完整精度。
        png, meta = plot_engine.render_bytes_meta(spec, "png", spec["dpi"],
                                                  max_px=_PREVIEW_PX)
        svg = None
        if spec.get("with_svg", True):
            try:
                svg = plot_engine.render_bytes(spec, "svg", 150).decode("utf-8", "replace")
            except Exception:  # noqa: BLE001
                svg = None
    elapsed = int((time.perf_counter() - t0) * 1000)
    return {
        "png_b64": base64.b64encode(png).decode("ascii"),
        "svg": svg,
        "elapsed_ms": elapsed,
        "bytes": len(png),
        # 降采样说明：前端据此提示"数据点数很多，已按形状抽稀"
        "downsample": spec.get("downsample") or [],
        "points": [len(s.get("x") or []) for s in spec.get("series") or []],
        # 每个面板在 figure 里的实际位置（tight_layout 之后的坐标区），供前端叠占位层
        "panels_geo": meta.get("panels_geo") or [],
        "panels_dropped": int(meta.get("panels_dropped") or 0),
        # 实际生效值：图幅可能被网格放大过，dpi 可能被像素上限压过小，
        # 前端一律以这里为准，别拿请求值当承诺（否则会显示 24000×24000 这种鬼数）
        "figsize_used": meta.get("figsize_used") or spec["figsize"],
        "dpi_used": int(meta.get("dpi_used") or spec["dpi"]),
        "dpi_capped": bool(meta.get("dpi_capped")),
        "canvas_grown": bool(meta.get("canvas_grown")),
        "export_dpi": int(spec["dpi"]),
        "spec": {k: spec[k] for k in ("kind", "theme", "palette", "figsize", "dpi",
                                      "font_size", "line_width", "marker_size",
                                      "grid", "x_datetime", "share_axes",
                                      "canvas_grow") if k in spec}
                | {"panels": len(spec.get("panels") or [])},
    }


def act_export_fig(payload: dict) -> dict:
    spec = _sanitize_spec(payload.get("spec") or {})
    fmt = (payload.get("fmt") or "png").lower()
    if fmt not in ("png", "svg", "pdf", "eps"):
        raise ValueError("不支持的图片格式")
    dpi = int(payload.get("dpi") or spec.get("dpi") or 300)
    dpi = min(max(dpi, 50), 1200)
    with _RENDER_LOCK:
        data, meta = plot_engine.render_bytes_meta(spec, fmt, dpi)
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    title = str(spec.get("title") or "figure")
    # 只保留文件系统安全字符，并把连续空白压成单个下划线，避免出现 "a  b.pdf"
    safe = "".join(ch if (ch.isalnum() or ch in "._-") else " " for ch in title)
    safe = "_".join(safe.split())[:60] or "figure"
    path = OUT_DIR / f"{safe}_{stamp}.{fmt}"
    path.write_bytes(data)
    mime = {"png": "image/png", "svg": "image/svg+xml",
            "pdf": "application/pdf", "eps": "application/postscript"}[fmt]
    # 同时返回字节流：前端一律走浏览器下载，四种格式落点统一，不再出现
    # "PNG 在下载文件夹、PDF 在 output/ 目录"这种割裂。
    return {
        "path": str(path),
        "bytes": len(data),
        "fmt": fmt,
        "filename": path.name,
        "mime": mime,
        "data_b64": base64.b64encode(data).decode("ascii"),
        "panels_geo": meta.get("panels_geo") or [],
        "panels_dropped": int(meta.get("panels_dropped") or 0),
        # 导出也走同一套保护：用户的 dpi 若被像素上限压过，这里如实告诉前端，
        # 由界面提示"实际 xxx dpi"，不要让作者以为拿到了 1200dpi 的 PNG。
        "figsize_used": meta.get("figsize_used") or spec["figsize"],
        "dpi_used": int(meta.get("dpi_used") or dpi),
        "dpi_capped": bool(meta.get("dpi_capped")),
        "canvas_grown": bool(meta.get("canvas_grown")),
    }


def act_export_data(payload: dict) -> dict:
    df = _get_frame(payload.get("ds"), payload.get("sheet"))
    fmt = (payload.get("fmt") or "xlsx").lower()
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    if fmt == "csv":
        path = OUT_DIR / f"data_{stamp}.csv"
        df.to_csv(path, index=False, encoding="utf-8-sig")
    else:
        path = OUT_DIR / f"data_{stamp}.xlsx"
        df.to_excel(path, index=False)
    return {"path": str(path), "rows": int(len(df)), "fmt": fmt}


def act_themes() -> dict:
    themes = {
        k: {"name": v.get("name", k), "description": v.get("description", ""),
            "bg": v.get("bg"), "fg": v.get("fg"), "font_size": v.get("font_size")}
        for k, v in plot_engine.THEMES.items()
    }
    palettes = {k: list(v) for k, v in plot_engine.PALETTES.items()}
    models = {k: {"name": v["name"], "params": list(v["params"]), "latex": v.get("latex", "")}
              for k, v in fit_engine.MODELS.items()}
    kind_groups = []
    for kid, meta in plot_engine.KINDS.items():
        group = meta.get("group", "其他")
        if group not in kind_groups:
            kind_groups.append(group)
    kinds = {k: dict(v) for k, v in plot_engine.KINDS.items()}
    return {"themes": themes, "palettes": palettes, "models": models,
            "kinds": kinds, "kind_groups": kind_groups,
            "transforms": {k: dict(v) for k, v in transform.OPS.items()},
            "formats": list(plot_engine.SUPPORTED_FORMATS)}


ROUTES = {
    "/api/upload": act_upload,
    "/api/preview": act_preview,
    "/api/stats/describe": act_describe,
    "/api/stats/uncertainty": act_uncertainty,
    "/api/stats/test": act_test,
    "/api/stats/fit": act_fit,
    "/api/fit/compare": act_fit_compare,
    "/api/data/transform": act_transform,
    "/api/plot/render": act_render,
    "/api/plot/export": act_export_fig,
    "/api/data/export": act_export_data,
}


class Handler(BaseHTTPRequestHandler):
    server_version = "DataLab/1.0"
    protocol_version = "HTTP/1.1"

    # ---- 基础工具 ----
    def _send(self, code: int, body: bytes, ctype: str):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def _send_json(self, obj, code: int = 200):
        body = json.dumps(obj, ensure_ascii=False, allow_nan=False).encode("utf-8")
        self._send(code, body, "application/json; charset=utf-8")

    def _read_json(self) -> dict:
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0:
            return {}
        raw = self.rfile.read(length)
        try:
            return json.loads(raw.decode("utf-8"))
        except Exception as e:  # noqa: BLE001
            raise ValueError(f"请求体不是合法 JSON：{e}") from e

    def log_message(self, fmt, *args):  # 安静模式：只打错误
        if args and str(args[0]).startswith(("4", "5")):
            sys.stderr.write("[%s] %s\n" % (datetime.now().strftime("%H:%M:%S"), fmt % args))

    # ---- 路由 ----
    def do_GET(self):
        path = unquote(urlparse(self.path).path)
        try:
            if path in ("/", "/index.html"):
                return self._serve_file(WEB_DIR / "index.html")
            if path == "/api/themes":
                return self._send_json({"ok": True, **act_themes()})
            if path == "/api/datasets":
                return self._send_json({"ok": True, **act_datasets()})
            if path == "/api/connection":
                with _STORE_LOCK:
                    n = len(_STORE)
                return self._send_json({
                    "ok": True, "python": sys.version.split()[0],
                    "executable": sys.executable, "datasets": n,
                    "blas_patched": getattr(plot_engine, "BLAS_PATCHED", None),
                    "port": _RUNTIME.get("port") or 0,
                    "uptime_s": int(time.time() - (_RUNTIME.get("started") or time.time())),
                    "pid": os.getpid(),
                })
            if path.startswith("/static/"):
                rel = path[len("/static/"):]
                target = (WEB_DIR / rel).resolve()
                if WEB_DIR.resolve() not in target.parents and target.parent != WEB_DIR.resolve():
                    return self._send_json({"ok": False, "error": "非法路径"}, 403)
                return self._serve_file(target)
            if path == "/favicon.ico":
                return self._send(204, b"", "image/x-icon")
            # 根路径静态资源回退：index.html 里用 ./style.css、./js/01-base.js 引用，
            # 浏览器会请求 /style.css、/js/01-base.js，这里统一映射到 web 目录。
            if "." in path.rsplit("/", 1)[-1]:
                target = (WEB_DIR / path.lstrip("/")).resolve()
                root = WEB_DIR.resolve()
                if (root in target.parents) and target.is_file():
                    return self._serve_file(target)
            return self._send_json({"ok": False, "error": f"未知路径 {path}"}, 404)
        except Exception as e:  # noqa: BLE001
            self._fail(e)

    def do_POST(self):
        path = unquote(urlparse(self.path).path)
        fn = ROUTES.get(path)
        if fn is None:
            return self._send_json({"ok": False, "error": f"未知接口 {path}",
                                    "error_type": "not_found"}, 404)
        t0 = time.perf_counter()
        try:
            payload = self._read_json()
            result = fn(payload)
            self._send_json({"ok": True, **json_safe(result)})
        except ValueError as e:
            # 用户输入类错误：可直接展示给用户，不需要堆栈
            self._send_json({"ok": False, "error": str(e), "error_type": "validation"}, 400)
        except Exception as e:  # noqa: BLE001
            traceback.print_exc()
            self._send_json({"ok": False,
                             "error": f"服务器内部错误：{type(e).__name__}: {e}",
                             "error_type": "server"}, 500)
        finally:
            cost = int((time.perf_counter() - t0) * 1000)
            sys.stderr.write("[%s] POST %s %d ms\n"
                             % (datetime.now().strftime("%H:%M:%S"), path, cost))

    def _fail(self, e):
        if isinstance(e, ValueError):
            self._send_json({"ok": False, "error": str(e), "error_type": "validation"}, 400)
        else:
            traceback.print_exc()
            self._send_json({"ok": False, "error": f"{type(e).__name__}: {e}",
                             "error_type": "server"}, 500)

    def _serve_file(self, path: Path):
        if not path.exists() or not path.is_file():
            return self._send_json({"ok": False, "error": "文件不存在"}, 404)
        ctype = mimetypes.guess_type(str(path))[0] or "application/octet-stream"
        if path.suffix in (".js", ".css", ".html"):
            ctype += "; charset=utf-8"
        body = path.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass


def _pick_port(start: int = 8765, tries: int = 20) -> int:
    for p in range(start, start + tries):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                s.bind(("127.0.0.1", p))
                return p
            except OSError:
                continue
    raise SystemExit("找不到可用端口，请先关闭占用 8765 的程序")


def main():
    port = _pick_port(int(os.environ.get("DATALAB_PORT") or 8765))
    url = f"http://127.0.0.1:{port}/"
    _RUNTIME["port"] = port
    _RUNTIME["started"] = time.time()
    srv = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    srv.daemon_threads = True
    print("=" * 62)
    print("  DataLab · 数据可视化与统计分析工作台")
    print("-" * 62)
    print(f"  地址   : {url}")
    print(f"  Python : {sys.version.split()[0]}  ({sys.executable})")
    print(f"  输出   : {OUT_DIR}")
    print("  关闭   : 在本窗口按 Ctrl+C，或直接关掉窗口")
    print("=" * 62)
    if os.environ.get("DATALAB_NO_BROWSER") != "1":
        threading.Timer(0.8, lambda: webbrowser.open(url)).start()
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止。")
    finally:
        srv.server_close()


if __name__ == "__main__":
    main()
