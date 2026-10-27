# -*- coding: utf-8 -*-
"""DataLab 数据装载模块。

职责：
    * 把上传的 xlsx / xls / csv 字节流解析成 ``{工作表名: DataFrame}``；
    * 自动识别真正的表头行（实验数据表常在表头之上放标题、单位、日期）；
    * 推断每列类型（数值 / 文本 / 日期），统计缺失，并从列名里拆出单位。

对外只有三个函数：``parse`` / ``infer_columns`` / ``column_values``。
"""

from __future__ import annotations

import datetime as _dt
import io
import math
import re

import pandas as pd

# 列名尾部的单位写法：电压(V) / 温度/℃ / x （mm） / 时间 [s]
_UNIT_RE = re.compile(r"[\s]*[（(\[]\s*([^（）()\[\]]{1,12})\s*[)）\]][\s]*$")
# 另一种常见写法：电压/V、温度/℃
_SLASH_UNIT_RE = re.compile(r"[/／]\s*([^\s/／]{1,8})$")

# --------------------------------------------------------------------------
# 日期时间识别
# 只认「年-月-日」这类真正的日期写法，必须带分隔符且年份在 1900~2200，
# 以免把 "1-2"、"3/4" 这种比值/测量值误判成日期。
# --------------------------------------------------------------------------
_DT_DASHYMD = re.compile(
    r"^(?P<y>\d{4})[-/](?P<mo>\d{1,2})[-/](?P<d>\d{1,2})"
    r"(?:[ T]+(?P<h>\d{1,2}):(?P<mi>\d{2})(?::(?P<s>\d{2})(?:[.,]\d+)?)?)?$"
)
_DT_MDY = re.compile(
    r"^(?P<mo>\d{1,2})/(?P<d>\d{1,2})/(?P<y>\d{4})"
    r"(?:[ T]+(?P<h>\d{1,2}):(?P<mi>\d{2})(?::(?P<s>\d{2}))?)?$"
)
_DT_CN = re.compile(
    r"^(?P<y>\d{4})\s*年\s*(?P<mo>\d{1,2})\s*月\s*(?P<d>\d{1,2})\s*日?"
    r"(?:\s*(?P<h>\d{1,2}):(?P<mi>\d{2})(?::(?P<s>\d{2}))?)?$"
)
_DT_PATTERNS = (_DT_DASHYMD, _DT_MDY, _DT_CN)
# 全角数字与全角分隔符归一
_FW_TABLE = str.maketrans("０１２３４５６７８９－／：．", "0123456789-/:.")

# 判定为日期列所需的最低命中比例
_DT_RATIO = 0.8


def _norm_dt_text(v) -> str:
    """单元格 -> 归一化后的字符串（全角转半角、去首尾空白）。"""
    if v is None:
        return ""
    if isinstance(v, (_dt.datetime, _dt.date)):
        return v.isoformat(sep=" ")
    s = str(v).replace("\u00a0", " ").strip()
    return s.translate(_FW_TABLE) if s else ""


def _parse_datetime(v):
    """尝试把单元格解析成日期时间。

    返回 ``(datetime 或 None, 是否含时间部分)``；不像日期时返回 ``(None, False)``。
    """
    if v is None or isinstance(v, bool):
        return None, False
    try:
        if pd.isna(v):  # NaN / NaT
            return None, False
    except (TypeError, ValueError):
        pass
    # Excel 读出的日期本身就是 datetime / Timestamp
    if isinstance(v, _dt.datetime):
        has_time = bool(v.hour or v.minute or v.second)
        return _dt.datetime(v.year, v.month, v.day,
                            v.hour, v.minute, v.second), has_time
    if isinstance(v, _dt.date):
        return _dt.datetime(v.year, v.month, v.day), False

    s = _norm_dt_text(v)
    if not s:
        return None, False
    # 硬性前置条件：必须有日期/时间分隔符，纯数字、纯文字直接排除
    if not any(ch in s for ch in "-/:") and "年" not in s:
        return None, False

    for rx in _DT_PATTERNS:
        m = rx.match(s)
        if not m:
            continue
        g = m.groupdict()
        year = int(g["y"])
        if not (1900 <= year <= 2200):
            return None, False
        try:
            dt = _dt.datetime(year, int(g["mo"]), int(g["d"]),
                              int(g.get("h") or 0), int(g.get("mi") or 0),
                              int(g.get("s") or 0))
        except ValueError:  # 13 月、32 日这类
            return None, False
        return dt, g.get("h") is not None
    return None, False


def _scan_datetime(series) -> tuple[int, int]:
    """扫描整列，返回 ``(能解析成日期的个数, 非空个数)``。"""
    hit = total = 0
    for v in series.tolist():
        if _is_blank(v):
            continue
        total += 1
        if _parse_datetime(v)[0] is not None:
            hit += 1
    return hit, total


def _is_datetime_series(series) -> bool:
    """非空值中至少 80% 能解析成日期时间时，认为是日期列。"""
    hit, total = _scan_datetime(series)
    return total > 0 and hit >= total * _DT_RATIO


def _iso(dt, has_time: bool):
    """datetime -> ISO 8601 字符串（不带时区，供 JSON 序列化）。"""
    if dt is None:
        return None
    if has_time:
        return dt.strftime("%Y-%m-%dT%H:%M:%S")
    return dt.strftime("%Y-%m-%d")


def _is_num(v) -> bool:
    """判断单元格是否为可解析的数值（含带单位、千分位、百分号的字符串）。"""
    if v is None:
        return False
    if isinstance(v, bool):
        return False
    if isinstance(v, (int, float)):
        return not (isinstance(v, float) and (math.isnan(v) or math.isinf(v)))
    if isinstance(v, str):
        return _to_float(v) is not None
    return False


def _to_float(v):
    """把单个单元格尽量转成 float，失败返回 None。"""
    if v is None:
        return None
    if isinstance(v, bool):
        return None
    if isinstance(v, (int, float)):
        f = float(v)
        if math.isnan(f) or math.isinf(f):
            return None
        return f
    if isinstance(v, str):
        s = v.strip()
        if not s:
            return None
        # 全角数字与符号归一
        s = s.translate(str.maketrans("０１２３４５６７８９．－＋", "0123456789.-+"))
        s = s.replace(",", "").replace("，", "").replace(" ", "")
        pct = s.endswith("%")
        if pct:
            s = s[:-1]
        # 科学计数法的 Unicode 负号
        s = s.replace("−", "-").replace("–", "-")
        try:
            f = float(s)
        except ValueError:
            return None
        if math.isnan(f) or math.isinf(f):
            return None
        return f / 100.0 if pct else f
    return None


def _clean_name(name, idx: int) -> str:
    """列名清洗：去空、去换行、去纯数字占位。"""
    if name is None or (isinstance(name, float) and math.isnan(name)):
        return f"列{idx + 1}"
    s = str(name).replace("\n", " ").replace("\r", " ").strip()
    if not s or s.lower() in ("nan", "none", "unnamed: 0"):
        return f"列{idx + 1}"
    return s


def split_unit(name: str) -> tuple[str, str | None]:
    """从列名中拆出单位，返回 ``(干净列名, 单位或 None)``。"""
    s = str(name).strip()
    m = _UNIT_RE.search(s)
    if m:
        unit = m.group(1).strip()
        base = s[: m.start()].strip()
        if base and unit:
            return base, unit
    m2 = _SLASH_UNIT_RE.search(s)
    if m2:
        unit = m2.group(1).strip()
        base = s[: m2.start()].strip()
        # 避免把 "x/y" 这种当成单位，要求单位短且不含中文数字
        if base and unit and 0 < len(unit) <= 6:
            return base, unit
    return s, None


def _is_blank(v) -> bool:
    """单元格是否为空（None / NaN / NaT / 空字符串）。"""
    if v is None:
        return True
    if isinstance(v, float) and math.isnan(v):
        return True
    if isinstance(v, str):
        return not v.strip()
    try:
        return bool(pd.isna(v))
    except (TypeError, ValueError):
        return False


def _find_header_row(raw: pd.DataFrame) -> int:
    """定位表头行。

    实验数据表常见结构是「标题行 → 说明行 → 列名行 → 单位行 → 仪器行 → 数据」，
    单靠"下一行是不是数值"会误选到单位行或仪器行。这里改成两条硬判据：
      1) 该行必须是**文本为主**（数值单元格不超过一半）；
      2) 该行非空单元格数不能明显少于表格宽度（排除标题/说明行）。
    从上往下取第一条同时满足的行，即列名行。
    """
    n_row = len(raw)
    scan = min(30, n_row)
    if n_row == 0:
        return 0

    # 表格宽度用前若干行的最大非空单元格数近似（数据行通常最宽）
    width = 0
    for i in range(scan):
        nn = sum(1 for v in raw.iloc[i].tolist() if not _is_blank(v))
        width = max(width, nn)
    if width <= 0:
        return 0

    first_nonblank = None
    for i in range(min(15, n_row)):
        cells = [v for v in raw.iloc[i].tolist() if not _is_blank(v)]
        if len(cells) < 2:
            continue
        if first_nonblank is None:
            first_nonblank = i
        n_num = sum(1 for v in cells if _is_num(v))
        if n_num > len(cells) * 0.5:
            continue  # 数值为主 → 已是数据行
        if len(cells) < width * 0.6:
            continue  # 单元格太少 → 标题或说明行
        return i

    # 兜底：全表都是数值（无表头）或结构异常时取第一条有内容的行
    return first_nonblank if first_nonblank is not None else 0



def _trim_note_rows(body: pd.DataFrame) -> pd.DataFrame:
    """裁掉表头之后、数据之前（以及表格末尾）的说明行。

    典型形态：表头下一行是「单 位 | lx | mA」，再下一行是「仪器 | ...」，
    这些行没有任何数值，不属于数据，留着会污染统计。
    只在表格确实含数值列时才裁，纯文本表原样返回。
    """
    if body.empty:
        return body
    has_numeric_col = False
    for c in body.columns:
        col = body[c].tolist()
        if sum(1 for v in col if _is_num(v)) >= max(1, int(len(col) * 0.5)):
            has_numeric_col = True
            break
    if not has_numeric_col:
        return body

    start = 0
    for i in range(min(8, len(body))):
        if any(_is_num(v) for v in body.iloc[i].tolist()):
            start = i
            break
    end = len(body)
    for j in range(len(body) - 1, max(len(body) - 8, -1), -1):
        if any(_is_num(v) for v in body.iloc[j].tolist()):
            end = j + 1
            break
    if start == 0 and end == len(body):
        return body
    return body.iloc[start:end].reset_index(drop=True)


def _normalize_frame(df: pd.DataFrame) -> pd.DataFrame:
    """列名去重 + 类型收敛（数值列转 float，其余转字符串）。"""
    # 真实实验表格常带用于排版的空白列，先整体丢掉全空列
    df = df.dropna(axis=1, how="all")
    cols, seen = [], {}
    for i, c in enumerate(df.columns):
        name = _clean_name(c, i)
        if name in seen:
            seen[name] += 1
            name = f"{name}_{seen[name]}"
        else:
            seen[name] = 0
        cols.append(name)
    df = df.copy()
    df.columns = cols
    df = df.dropna(axis=0, how="all").reset_index(drop=True)

    for c in df.columns:
        s = df[c]
        converted = s.map(_to_float)
        valid = converted.notna().sum()
        nonnull = s.notna().sum()
        if nonnull > 0 and valid >= max(1, int(nonnull * 0.6)):
            df[c] = converted.astype("float64")
        else:
            df[c] = s.map(lambda v: "" if v is None or (isinstance(v, float) and math.isnan(v)) else str(v).strip())
    return df


def parse(filename: str, data: bytes) -> dict[str, pd.DataFrame]:
    """解析文件，返回 ``{工作表名: DataFrame}``。失败抛 ValueError。"""
    name = (filename or "").lower()
    buf = io.BytesIO(data)

    if name.endswith(".csv") or name.endswith(".txt") or name.endswith(".tsv"):
        sep = "\t" if name.endswith((".tsv", ".txt")) else ","
        last_err = None
        for enc in ("utf-8-sig", "gbk", "utf-16", "latin-1"):
            try:
                buf.seek(0)
                raw = pd.read_csv(buf, header=None, sep=sep, encoding=enc,
                                  engine="python", on_bad_lines="skip")
                break
            except Exception as e:  # noqa: BLE001
                last_err = e
                raw = None
        if raw is None:
            raise ValueError(f"CSV 解析失败：{last_err}")
        hdr = _find_header_row(raw)
        body = raw.iloc[hdr + 1:].reset_index(drop=True)
        body.columns = [_clean_name(v, i) for i, v in enumerate(raw.iloc[hdr].tolist())]
        return {"Sheet1": _normalize_frame(_trim_note_rows(body))}

    if name.endswith((".xlsx", ".xlsm", ".xls")):
        engine = "openpyxl" if not name.endswith(".xls") else None
        try:
            if engine:
                raw_sheets = pd.read_excel(buf, sheet_name=None, header=None, engine=engine)
            else:
                raw_sheets = pd.read_excel(buf, sheet_name=None, header=None)
        except Exception as e:  # noqa: BLE001
            raise ValueError(f"Excel 解析失败：{e}") from e

        out: dict[str, pd.DataFrame] = {}
        for sname, raw in raw_sheets.items():
            if raw is None or raw.empty:
                continue
            hdr = _find_header_row(raw)
            body = raw.iloc[hdr + 1:].reset_index(drop=True)
            body.columns = [_clean_name(v, i) for i, v in enumerate(raw.iloc[hdr].tolist())]
            body = _normalize_frame(_trim_note_rows(body))
            if len(body) == 0:
                continue
            out[str(sname)] = body
        if not out:
            raise ValueError("文件里没有找到可用的数据表")
        return out

    raise ValueError("只支持 .xlsx / .xls / .csv / .tsv 文件")


def infer_columns(df: pd.DataFrame) -> list[dict]:
    """返回列元信息：名称、类型、单位、有效值数、缺失数。

    ``dtype`` 取 ``numeric`` / ``datetime`` / ``text``：
    文本列里非空值至少 80% 能解析成日期时间的，判为 ``datetime``。
    """
    cols = []
    for c in df.columns:
        s = df[c]
        if pd.api.types.is_numeric_dtype(s):
            dtype = "numeric"
            n_valid = int(s.notna().sum())
        else:
            nonblank = s.map(lambda v: str(v).strip() != "" if v is not None else False)
            n_valid = int(nonblank.sum())
            dtype = "datetime" if _is_datetime_series(s) else "text"
        base, unit = split_unit(c)
        cols.append({
            "name": c,
            "base": base,
            "unit": unit,
            "dtype": dtype,
            "n_valid": n_valid,
            "n_missing": int(len(s) - n_valid),
        })
    return cols


def column_values(df: pd.DataFrame, col: str) -> list:
    """取一列的值，供计算与绘图使用。

    * 数值列：返回 ``list[float]``（丢弃缺失）；
    * 日期列：返回与整列**等长**的 ISO 8601 字符串列表，无效位置为 ``None``；
    * 其余文本列：尽量转成 float，全部失败时抛 ValueError。
    """
    if col not in df.columns:
        raise ValueError(f"列不存在：{col}")
    s = df[col]
    if pd.api.types.is_numeric_dtype(s):
        return [float(v) for v in s.dropna().tolist()]
    if _is_datetime_series(s):
        out = []
        for v in s.tolist():
            dt, has_time = _parse_datetime(v)
            out.append(_iso(dt, has_time))
        return out
    vals = [v for v in s.map(_to_float).tolist() if v is not None]
    if not vals:
        raise ValueError(f"列「{col}」不是数值列，无法参与计算")
    return vals
