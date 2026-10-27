# DataLab 启动器

`DataLab.exe`（在项目根目录）双击即用：后台拉起 `server.py`，等服务就绪后自动打开默认浏览器。
启动器自身无控制台窗口、成功时不弹任何提示，服务作为独立进程常驻。

源码：`launcher/DataLabLauncher.cs`（单文件 C#，仅用到 `System.Windows.Forms` 的 MessageBox）。

## 重新编译

双击或在命令行执行：

```
launcher\build.bat
```

- 只用 .NET Framework 自带的 `csc.exe`：先找 `C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe`，
  找不到再找 32 位 `C:\Windows\Microsoft.NET\Framework\v4.0.30319\`；
- 不需要 .NET SDK / nuget / 联网；
- 产物直接覆盖项目根目录的 `DataLab.exe`（约 12 KB）；
- 编译参数含 `/utf8output /codepage:65001`，源码以 UTF-8 保存。

> 注意：`build.bat` 本身以 GBK + CRLF 保存（cmd 解析批处理的要求）。
> 用编辑器改成 UTF-8 后可能错行，如需改动请保持 GBK 编码和 CRLF 换行。

## Python 解释器查找顺序

取第一个存在的：

1. 环境变量 `DATALAB_PYTHON`
2. `<项目目录>\python_path.txt` 的第一行非空内容
3. `<项目目录>\runtime\python.exe`（为将来便携打包预留）
4. `C:\Users\a3141\.conda\envs\NAMEbutNOidea\python.exe`（预设 conda 环境）
5. `PATH` 里的 `python.exe`（自动跳过微软商店的 `WindowsApps` 占位符）

全都找不到时弹窗提示：把解释器路径写进 `python_path.txt` 的第一行。

## 端口与重复启动

- 端口取环境变量 `DATALAB_PORT`，缺省 `8765`；
- 启动前先 TCP 探测 `127.0.0.1:<端口>`：已在监听就直接开浏览器退出，不重复起服务；
- 用命名互斥体 `Global\DataLabLauncher-<端口>`（普通用户无权限时退化为 `Local\`）挡住连点两下；
- 就绪轮询间隔 200ms，最长等 45 秒；超时或服务进程提前退出 → 弹窗显示端口、解释器路径和
  `logs\server.log` 的最后 15 行。

## 启动的服务进程

- 优先 `<python目录>\pythonw.exe`（无窗口），否则 `python.exe`；
- 工作目录 = 项目目录，参数 `server.py`；
- 通过隐藏的 `cmd /c start /wait /b ... >> logs\server.log 2>&1` 包装启动，输出按时间戳分段追加到日志；
- 注入的环境变量：`MKL_THREADING_LAYER=SEQUENTIAL`、`KMP_DUPLICATE_LIB_OK=TRUE`、
  `PYTHONIOENCODING=utf-8`、`PYTHONUNBUFFERED=1`、`DATALAB_PORT=<端口>`、`DATALAB_NO_BROWSER=1`
  （外层若已设置 `DATALAB_NO_BROWSER` 则沿用外层的值）。

## 排障

| 环境变量 | 作用 |
| --- | --- |
| `DATALAB_PORT` | 换端口，例如 `8766` |
| `DATALAB_PYTHON` | 指定解释器，优先于 `python_path.txt` |
| `DATALAB_NO_BROWSER=1` | 不打开浏览器（自动化测试用） |
| `DATALAB_DEBUG=1` | 把启动关键步骤和弹窗文案追加到 `%TEMP%\datalab_launcher_dbg.log` |

服务日志：`logs\server.log`（UTF-8，每次启动插一条 `===== 时间 DataLab 启动 =====` 分隔行）。
