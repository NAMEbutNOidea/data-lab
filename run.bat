@echo off
chcp 65001 >nul
title DataLab - 数据可视化工作台

rem ===== 修复 conda 环境 OpenMP/MKL 线程层冲突（否则 numpy 矩阵运算会硬崩） =====
set MKL_THREADING_LAYER=SEQUENTIAL
set KMP_DUPLICATE_LIB_OK=TRUE
set OMP_NUM_THREADS=4

cd /d "%~dp0"

set "PY=C:\Users\a3141\.conda\envs\NAMEbutNOidea\python.exe"
if exist "%PY%" goto found
set "PY=D:\miniconda3\python.exe"
if exist "%PY%" goto found
set "PY=python"
echo [警告] 未找到预设 conda 环境，尝试使用系统 python，可能缺少 numpy/scipy/matplotlib。
echo.

:found
echo 使用解释器: %PY%
echo 正在启动，浏览器将自动打开 ...
echo.
"%PY%" server.py

echo.
echo 服务已退出（按任意键关闭）。
pause >nul
