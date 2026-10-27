// ===========================================================================
// DataLab 一键启动器
// 目标：双击 DataLab.exe → 后台拉起 server.py → 浏览器打开工作台。
// 编译：见同目录 build.bat（只用 .NET Framework 自带的 csc，不联网、无第三方依赖）。
// 说明：见同目录 README.md。本文件用 UTF-8 编码。
// ===========================================================================

using System;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Threading;
using System.Windows.Forms;

namespace DataLab
{
    internal static class Program
    {
        // 预设 conda 解释器（与 run.bat 保持一致）
        private const string CondaPython = @"C:\Users\a3141\.conda\envs\NAMEbutNOidea\python.exe";

        private const int DefaultPort = 8765;
        private const int ProbeTimeoutMs = 300;   // 单次 TCP 探测超时
        private const int ReadyTimeoutMs = 45000; // 最长等待服务就绪
        private const int PollIntervalMs = 200;   // 就绪轮询间隔
        private const int MutexWaitMs = 1500;     // 拿不到锁时的等待

        private static string _projectDir; // server.py 所在目录
        private static string _logPath;    // logs\server.log
        private static int _port = DefaultPort;
        private static Mutex _mutex;       // 进程级互斥体，需在退出前保持引用

        [STAThread]
        private static int Main()
        {
            try
            {
                return Run();
            }
            catch (Exception ex)
            {
                Trace("Main 异常: " + ex);
                Error("DataLab 启动器发生异常：\r\n" + ex.Message);
                return 1;
            }
        }

        private static int Run()
        {
            // ---- 1. 定位项目目录（一律以 exe 所在目录为基准，不看当前工作目录）----
            string exeDir = GetExeDir();
            _projectDir = LocateProjectDir(exeDir);
            if (_projectDir == null)
            {
                Error("未找到 server.py。\r\n\r\n已检查：\r\n  " + exeDir + "\r\n  " +
                      Path.GetDirectoryName(exeDir) +
                      "\r\n\r\n请把 DataLab.exe 放在 data-lab 项目根目录（与 server.py 同级）。");
                return 1;
            }
            _logPath = Path.Combine(_projectDir, "logs", "server.log");

            // ---- 2. 端口 ----
            _port = ResolvePort();
            Trace("projectDir=" + _projectDir + " port=" + _port);

            // 已有服务在跑：直接开浏览器退出，绝不重复起进程
            if (IsListening(_port))
            {
                Trace("端口已监听，直接开浏览器");
                OpenBrowser();
                return 0;
            }

            // ---- 3. 命名互斥体，挡住"连点两下"的并发启动 ----
            if (!TryAcquireMutex())
            {
                Trace("未拿到互斥体");
                // 另一个实例正在启动：等它把端口拉起来，然后按"已在运行"处理
                Thread.Sleep(MutexWaitMs);
                if (IsListening(_port)) OpenBrowser();
                return 0;
            }
            Trace("已拿到互斥体");

            // ---- 4. 解析 Python 解释器 ----
            string python = ResolvePython();
            Trace("python=" + (python ?? "<null>"));
            if (python == null)
            {
                Error("未找到 Python 解释器。请把解释器路径写入 data-lab\\python_path.txt 的第一行。");
                return 1;
            }

            // ---- 5. 启动服务 ----
            Process proc = StartServer(python);
            Trace("proc=" + (proc == null ? "<null>" : proc.Id.ToString()));
            if (proc == null)
            {
                Error("无法启动 Python 进程。\r\n\r\nPython：" + python +
                      "\r\n日志：" + _logPath + "\r\n\r\n" + Tail(_logPath));
                return 1;
            }

            // ---- 6. 等待就绪 ----
            var sw = Stopwatch.StartNew();
            int tick = 0;
            while (sw.ElapsedMilliseconds < ReadyTimeoutMs)
            {
                bool exited = proc.HasExited;
                bool live = IsListening(_port);
                // socket 已 LISTENING 不等于能响应：server.py 在建好 socket 之后才打印横幅、
                // 进 serve_forever，负载高时这个空档能有几秒。再确认一次 HTTP 再开浏览器。
                bool ready = live && HttpReady(_port);
                if (tick++ % 3 == 0) Trace("t=" + sw.ElapsedMilliseconds + "ms exited=" + exited + " listening=" + live + " httpReady=" + ready);

                if (exited)
                    return StartupFailed(python, "服务进程已提前退出", true);

                if (ready)
                {
                    Trace("就绪，耗时 " + sw.ElapsedMilliseconds + "ms");
                    OpenBrowser();
                    return 0; // 服务是独立进程，启动器静默退出
                }
                Thread.Sleep(PollIntervalMs);
            }

            return StartupFailed(python, "等待 " + (ReadyTimeoutMs / 1000) + " 秒后端口仍未就绪", false);
        }

        // -------------------------------------------------------------------
        // 路径 / 端口
        // -------------------------------------------------------------------

        private static string GetExeDir()
        {
            try
            {
                string p = Process.GetCurrentProcess().MainModule.FileName;
                if (!string.IsNullOrEmpty(p)) return Path.GetDirectoryName(p);
            }
            catch (Exception) { /* 极端情况下回退 */ }
            return AppDomain.CurrentDomain.BaseDirectory.TrimEnd('\\');
        }

        /// <summary>server.py 在当前目录找不到时，向外层找一层（兼容 exe 被放进 bin\ 的情况）。</summary>
        private static string LocateProjectDir(string exeDir)
        {
            if (File.Exists(Path.Combine(exeDir, "server.py"))) return exeDir;

            string parent = Path.GetDirectoryName(exeDir);
            if (!string.IsNullOrEmpty(parent) && File.Exists(Path.Combine(parent, "server.py")))
                return parent;

            return null;
        }

        private static int ResolvePort()
        {
            string raw = Environment.GetEnvironmentVariable("DATALAB_PORT");
            int p;
            if (!string.IsNullOrEmpty(raw) && int.TryParse(raw.Trim(), out p) && p > 0 && p < 65536)
                return p;
            return DefaultPort;
        }

        // -------------------------------------------------------------------
        // 互斥体
        // -------------------------------------------------------------------

        private static bool TryAcquireMutex()
        {
            const string name = "DataLabLauncher-";
            try
            {
                // 优先全局命名空间，跨会话（不同登录用户 / 计划任务）也能互斥
                _mutex = new Mutex(false, @"Global\" + name + _port);
            }
            catch (UnauthorizedAccessException)
            {
                // 普通用户创建 Global\ 对象可能被拒，退化为会话级
                _mutex = new Mutex(false, @"Local\" + name + _port);
            }

            try
            {
                return _mutex.WaitOne(0);
            }
            catch (AbandonedMutexException)
            {
                return true; // 上一个持有者异常退出，锁已归我们
            }
        }

        // -------------------------------------------------------------------
        // Python 查找
        // -------------------------------------------------------------------

        /// <summary>按优先级返回第一个存在的解释器；都找不到返回 null。</summary>
        private static string ResolvePython()
        {
            // a. 环境变量
            string p = Clean(Environment.GetEnvironmentVariable("DATALAB_PYTHON"));
            if (IsFile(p)) return p;

            // b. python_path.txt 的第一行非空内容
            try
            {
                string cfg = Path.Combine(_projectDir, "python_path.txt");
                if (File.Exists(cfg))
                {
                    foreach (string line in File.ReadAllLines(cfg))
                    {
                        string cand = Clean(line);
                        if (cand.Length == 0) continue;
                        if (IsFile(cand)) return cand;
                        break; // 首行非空即视为用户指定，不再往下看
                    }
                }
            }
            catch (Exception) { /* 配置文件读不了就当没有 */ }

            // c. 项目自带的便携运行时（为将来打包预留）
            p = Path.Combine(_projectDir, "runtime", "python.exe");
            if (IsFile(p)) return p;

            // d. 预设 conda 环境
            if (IsFile(CondaPython)) return CondaPython;

            // e. PATH 里的 python.exe
            return FindOnPath("python.exe");
        }

        private static string FindOnPath(string fileName)
        {
            string path = Environment.GetEnvironmentVariable("PATH");
            if (string.IsNullOrEmpty(path)) return null;

            foreach (string raw in path.Split(';'))
            {
                string dir = Clean(raw);
                if (dir.Length == 0) continue;
                // 跳过微软商店的 python.exe 占位符（点开只会跳转商店）
                if (dir.IndexOf("WindowsApps", StringComparison.OrdinalIgnoreCase) >= 0) continue;
                try
                {
                    string cand = Path.Combine(dir, fileName);
                    if (IsFile(cand)) return cand;
                }
                catch (Exception) { /* 非法路径片段直接忽略 */ }
            }
            return null;
        }

        private static string Clean(string s)
        {
            if (s == null) return string.Empty;
            s = s.Trim().Trim('"').Trim();
            return s;
        }

        private static bool IsFile(string path)
        {
            if (string.IsNullOrEmpty(path)) return false;
            try { return File.Exists(path); }
            catch (Exception) { return false; }
        }

        // -------------------------------------------------------------------
        // 启动服务
        // -------------------------------------------------------------------

        /// <summary>
        /// 用隐藏的 cmd 包装启动 python，靠 cmd 的 >> 重定向把输出追加进 server.log。
        /// 不用 Process 的管道重定向：启动器一退出读端就关，子进程后续写 stderr 会 EPIPE，
        /// 反过来把服务打挂。cmd 同时充当"服务进程是否还活着"的探针。
        /// 注意必须 `start /wait`：pythonw.exe 是 GUI 子系统程序，cmd /c 直接跑它不会等待，
        /// 会误判成"服务已退出"。
        /// </summary>
        private static Process StartServer(string python)
        {
            string exe = python;
            try
            {
                // 优先 pythonw.exe：没有控制台窗口
                string pyw = Path.Combine(Path.GetDirectoryName(python) ?? string.Empty, "pythonw.exe");
                if (IsFile(pyw)) exe = pyw;
            }
            catch (Exception) { }

            try
            {
                Directory.CreateDirectory(Path.GetDirectoryName(_logPath));
                File.AppendAllText(_logPath,
                    "\r\n===== " + DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") +
                    "  DataLab 启动（端口 " + _port + "，解释器 " + exe + "）=====\r\n",
                    new UTF8Encoding(false));
            }
            catch (Exception) { /* 日志目录不可写时不阻塞启动 */ }

            var psi = new ProcessStartInfo();
            psi.FileName = Path.Combine(Environment.SystemDirectory, "cmd.exe");
            psi.Arguments = "/c start /wait /b \"\" \"" + exe + "\" \"server.py\" >> \"" + _logPath + "\" 2>&1";
            psi.WorkingDirectory = _projectDir;
            psi.UseShellExecute = false;
            psi.CreateNoWindow = true;

            // 环境变量写在自己的进程上让子进程继承，不用 psi.EnvironmentVariables：
            // 该属性的 getter 在父环境存在仅大小写不同的重复键（如 http_proxy / HTTP_PROXY）时
            // 会抛 ArgumentException（.NET Framework 的已知缺陷），这里直接避开。
            //
            // conda 环境的 numpy 线程层双保险（server.py 里也设了，但必须在解释器启动前生效）
            SetEnv("MKL_THREADING_LAYER", "SEQUENTIAL");
            SetEnv("KMP_DUPLICATE_LIB_OK", "TRUE");
            SetEnv("PYTHONIOENCODING", "utf-8");
            // stdout 重定向到文件时 Python 默认块缓冲，不加这个日志要等进程退出才落盘
            SetEnv("PYTHONUNBUFFERED", "1");
            SetEnv("DATALAB_PORT", _port.ToString());

            // 浏览器统一由启动器打开；外层已显式指定则尊重外层的值
            if (string.IsNullOrEmpty(Environment.GetEnvironmentVariable("DATALAB_NO_BROWSER")))
                SetEnv("DATALAB_NO_BROWSER", "1");

            try
            {
                return Process.Start(psi);
            }
            catch (Exception)
            {
                Trace("Process.Start 失败: " + psi.FileName + " " + psi.Arguments);
                return null;
            }
        }

        // -------------------------------------------------------------------
        // 端口探测 / 浏览器 / 报错
        // -------------------------------------------------------------------

        private static bool IsListening(int port)
        {
            try
            {
                using (var client = new TcpClient())
                {
                    IAsyncResult ar = client.BeginConnect(IPAddress.Loopback, port, null, null);
                    if (!ar.AsyncWaitHandle.WaitOne(ProbeTimeoutMs)) return false;
                    client.EndConnect(ar);
                    return true;
                }
            }
            catch (Exception)
            {
                return false;
            }
        }

        /// <summary>确认本机端口能真正应答 HTTP（必须绕开系统代理）。</summary>
        private static bool HttpReady(int port)
        {
            try
            {
                var req = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:" + port + "/");
                req.Proxy = null;
                req.Method = "GET";
                req.Timeout = 1000;
                req.ReadWriteTimeout = 1000;
                req.KeepAlive = false;
                using (var resp = (HttpWebResponse)req.GetResponse())
                    return (int)resp.StatusCode == 200;
            }
            catch (Exception)
            {
                return false;
            }
        }

        private static void OpenBrowser()
        {
            if (Environment.GetEnvironmentVariable("DATALAB_NO_BROWSER") == "1") return;
            try
            {
                Process.Start(new ProcessStartInfo("http://127.0.0.1:" + _port + "/") { UseShellExecute = true });
            }
            catch (Exception) { /* 打不开浏览器不影响服务本身 */ }
        }

        private static int StartupFailed(string python, string reason, bool procExited)
        {
            // 进程刚退出时日志可能还没落盘，稍等一下再读
            if (procExited) Thread.Sleep(400);

            try
            {
                File.AppendAllText(_logPath,
                    "\r\n===== " + DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") +
                    "  启动失败：" + reason + " =====\r\n", new UTF8Encoding(false));
            }
            catch (Exception) { }

            string msg =
                "DataLab 启动失败：" + reason + "\r\n\r\n" +
                "端口：" + _port + "\r\n" +
                "Python：" + python + "\r\n" +
                "日志：" + _logPath + "\r\n\r\n" +
                "—— 日志最后 15 行 ——\r\n" + Tail(_logPath);

            Error(msg);
            return 1;
        }

        /// <summary>读日志尾部 15 行，整段截断到 1200 字符。</summary>
        private static string Tail(string path)
        {
            try
            {
                if (!File.Exists(path)) return "(日志文件不存在)";

                string text;
                using (var fs = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite))
                using (var sr = new StreamReader(fs, Encoding.UTF8))
                    text = sr.ReadToEnd();

                string[] lines = text.Replace("\r\n", "\n").Split('\n');
                int end = lines.Length - 1;
                while (end >= 0 && lines[end].Trim().Length == 0) end--;

                int start = Math.Max(0, end - 14);
                var sb = new StringBuilder();
                for (int i = start; i <= end; i++)
                {
                    if (sb.Length > 0) sb.Append("\r\n");
                    sb.Append(lines[i]);
                }

                string s = sb.ToString();
                if (s.Length > 1200) s = "…" + s.Substring(s.Length - 1199);
                return s.Length == 0 ? "(日志为空)" : s;
            }
            catch (Exception ex)
            {
                return "(日志读取失败：" + ex.Message + ")";
            }
        }

        private static void SetEnv(string name, string value)
        {
            try { Environment.SetEnvironmentVariable(name, value); }
            catch (Exception ex) { Trace("SetEnv 失败 " + name + ": " + ex.Message); }
        }

        private static void Error(string text)
        {
            Trace("弹窗: " + text);
            MessageBox.Show(text, "DataLab", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }

        /// <summary>排障跟踪：设 DATALAB_DEBUG=1 时把关键步骤追加到 %TEMP%\datalab_launcher_dbg.log。</summary>
        private static void Trace(string msg)
        {
            if (Environment.GetEnvironmentVariable("DATALAB_DEBUG") != "1") return;
            try
            {
                File.AppendAllText(Path.Combine(Path.GetTempPath(), "datalab_launcher_dbg.log"),
                    DateTime.Now.ToString("HH:mm:ss.fff") + "  " + msg + "\r\n");
            }
            catch (Exception) { }
        }
    }
}
