@echo off
rem ===========================================================================
rem  DataLab 启动器编译脚本
rem  只用 .NET Framework 自带的 csc.exe，不依赖 dotnet SDK / nuget / 网络。
rem ===========================================================================
setlocal

set "SRC=%~dp0DataLabLauncher.cs"
set "OUT=%~dp0..\DataLab.exe"

if not exist "%SRC%" (
    echo [错误] 找不到源码：%SRC%
    exit /b 1
)

rem ---- 探测 csc.exe：先 64 位框架，再 32 位框架 ----
set "CSC=C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
if not exist "%CSC%" set "CSC=C:\Windows\Microsoft.NET\Framework\v4.0.30319\csc.exe"
if not exist "%CSC%" (
    echo [错误] 未找到 .NET Framework 4.x 的 csc.exe，请确认系统已安装 .NET Framework 4.x。
    exit /b 1
)

echo 编译器 : %CSC%
echo 源文件 : %SRC%
echo 输出   : %OUT%
echo.

rem /codepage:65001 让 csc 按 UTF-8 读取源码（中文注释与提示文案）
"%CSC%" /nologo /target:winexe /platform:anycpu /optimize+ /utf8output /codepage:65001 ^
    /out:"%OUT%" ^
    /r:System.dll /r:System.Windows.Forms.dll /r:System.Drawing.dll ^
    "%SRC%"

if errorlevel 1 (
    echo.
    echo [错误] 编译失败。
    exit /b 1
)

echo.
echo [完成] 已生成 %OUT%
endlocal
