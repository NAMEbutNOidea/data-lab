# -*- coding: utf-8 -*-
"""DataLab 回归测试入口：一条命令跑完 tests/ 下所有用例。

用法
----
    python tests/run_all.py
    python tests/run_all.py --verbose      # 额外打印每个用例名

退出码：全部通过 0，有失败/异常 1。
"""

from __future__ import annotations

import os
import sys

os.environ.setdefault("MKL_THREADING_LAYER", "SEQUENTIAL")
os.environ.setdefault("KMP_DUPLICATE_LIB_OK", "TRUE")

import importlib
import time
import traceback
import unittest
from pathlib import Path

TESTS_DIR = Path(__file__).resolve().parent
ROOT = TESTS_DIR.parent
for _p in (str(ROOT), str(TESTS_DIR)):
    if _p not in sys.path:
        sys.path.insert(0, _p)

# 用例模块（顺序即输出顺序）
MODULES = [
    "test_downsample",
    "test_fit_engine",
    "test_dataloader",
    "test_transform",
    "test_panel_area",
    "test_twin3d",
    "test_api",
]

HEADER = "================ DataLab 回归测试 ================"
FOOTER = "-" * 49


def _ensure_utf8():
    """Windows 控制台默认 cp936，中文/省略号会炸，尽量切到 utf-8。"""
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError, OSError):
            pass


def _one_line(text, limit: int = 280) -> str:
    s = " ".join(str(text).split())
    return s if len(s) <= limit else s[:limit] + "…"


def _short_name(test) -> str:
    """只留方法名，输出更短：TestX.test_foo -> test_foo"""
    ident = getattr(test, "id", lambda: str(test))()
    return ident.rsplit(".", 1)[-1]


class _Collector(unittest.TestResult):
    """记录每个用例的结果，供汇总行与失败明细使用。"""

    def __init__(self, verbose: bool):
        super().__init__()
        self.verbose = verbose
        self.records = []          # [(name, status, message)]

    # unittest 的回调
    def addSuccess(self, test):
        super().addSuccess(test)
        self._add(test, "ok", "")

    def addFailure(self, test, err):
        super().addFailure(test, err)
        self._add(test, "fail", _describe(err))

    def addError(self, test, err):
        super().addError(test, err)
        self._add(test, "error", _describe(err))

    def addSkip(self, test, reason):
        super().addSkip(test, reason)
        self._add(test, "skip", reason)

    def addExpectedFailure(self, test, err):
        super().addExpectedFailure(test, err)
        self._add(test, "ok", "")

    def addUnexpectedSuccess(self, test):
        super().addUnexpectedSuccess(test)
        self._add(test, "fail", "预期失败的用例竟然通过了")

    # 内部
    def _add(self, test, status, message):
        name = _short_name(test)
        self.records.append((name, status, message))
        if self.verbose:
            tag = {"ok": "[ok]", "fail": "[fail]", "error": "[err ]",
                   "skip": "[skip]"}[status]
            print("         %s %s" % (tag, name), flush=True)

    # 统计
    def count(self, status: str) -> int:
        return sum(1 for _n, s, _m in self.records if s == status)


def _describe(err):
    """把 (type, value, tb) 变成一行可读文本。"""
    etype, evalue, tb = err
    if isinstance(evalue, AssertionError):
        text = str(evalue).strip()
        if text:
            return _one_line(text)
        # assertTrue/assertIsNone 之类没有消息时，给出出错位置
        line = traceback.extract_tb(tb)[-1]
        return "断言失败（%s:%s）" % (Path(line.filename).name, line.lineno)
    text = str(evalue).strip()
    return _one_line("%s: %s" % (etype.__name__, text) if text else etype.__name__)


def _run_module(name: str, verbose: bool):
    """跑一个模块，返回 (本次结果收集器, 错误说明或 None)。"""
    try:
        module = importlib.import_module(name)
    except Exception:  # noqa: BLE001
        return None, _one_line(traceback.format_exc().strip().splitlines()[-1])

    try:
        suite = unittest.TestLoader().loadTestsFromModule(module)
    except Exception:  # noqa: BLE001
        return None, _one_line(traceback.format_exc().strip().splitlines()[-1])

    if getattr(suite, "countTestCases", lambda: 0)() == 0:
        return None, "没有找到任何用例"

    result = _Collector(verbose)
    suite.run(result)
    return result, None


def main(argv) -> int:
    _ensure_utf8()
    verbose = "--verbose" in argv or "-v" in argv

    print(HEADER, flush=True)
    t0 = time.perf_counter()

    total_ok = total_fail = total_skip = 0

    for mod_name in MODULES:
        label = mod_name[5:] if mod_name.startswith("test_") else mod_name
        result, err = _run_module(mod_name, verbose)
        if result is None:
            print("[FAIL] %s: 无法运行（%s）" % (label, err), flush=True)
            total_fail += 1
            continue

        ok = result.count("ok")
        bad = result.count("fail") + result.count("error")
        skip = result.count("skip")
        total_ok += ok
        total_fail += bad
        total_skip += skip

        extra = "，%d skipped" % skip if skip else ""
        if bad == 0:
            print("[OK]   %s: %d passed%s" % (label, ok, extra), flush=True)
        else:
            print("[FAIL] %s: %d passed, %d failed%s"
                  % (label, ok, bad, extra), flush=True)
            detail = [(n, s, m) for n, s, m in result.records
                      if s in ("fail", "error")]
            for name, status, msg in detail:
                head = "异常 %s" % msg if status == "error" else msg
                print("       - %s: %s" % (name, head), flush=True)

    elapsed = time.perf_counter() - t0
    print(FOOTER, flush=True)
    parts = ["%d passed" % total_ok, "%d failed" % total_fail]
    if total_skip:
        parts.insert(1, "%d skipped" % total_skip)
    print("合计 %s, 用时 %.1fs" % (", ".join(parts), elapsed), flush=True)

    return 0 if total_fail == 0 else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
