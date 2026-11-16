using System;
using System.Text;
using System.Drawing;
using System.Threading;
using System.Net;
using System.IO;
using System.Diagnostics;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Windows;
using System.Windows.Automation;
using Microsoft.Win32;

public class SphSearch {
    // ----------------------------------------------------
    // 标准化错误码体系 (与 TS 强类型对齐)
    // ----------------------------------------------------
    public const int CODE_SUCCESS                  = 0;
    public const int CODE_WECHAT_NOT_RUNNING       = 1001; // 微信主程序未运行/未登录
    public const int CODE_PROTOCOL_REPAIR_FAILED   = 1002; // weixin:// 注册表自愈写入失败
    public const int CODE_WINDOW_NOT_FOUND         = 1003; // 步骤1：视频号原生窗口拉起超时/未找到
    public const int CODE_SEARCH_BTN_NOT_FOUND     = 1004; // 步骤2：未能通过结构特征找到右上角搜索按钮
    public const int CODE_OMNIBOX_NOT_FOUND        = 1005; // 步骤3：未能捕获展开的搜索网址输入框
    public const int CODE_CLIENT_CONNECT_TIMEOUT   = 1006; // 步骤4：代理健康端点 clientCount 轮询超时(未连上)
    public const int CODE_DESKTOP_ACCESS_DENIED    = 1007; // 交互式桌面 Default 切换失败

    // Win32 API 声明
    [DllImport("user32.dll", SetLastError = true)]
    public static extern IntPtr OpenDesktop(string lpszDesktop, int dwFlags, bool fInherit, uint dwDesiredAccess);
    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool SetThreadDesktop(IntPtr hDesktop);
    [DllImport("user32.dll")]
    public static extern bool CloseDesktop(IntPtr hDesktop);
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
    [DllImport("user32.dll")]
    public static extern bool EnumDesktopWindows(IntPtr hDesktop, EnumWindowsProc enumProc, IntPtr lParam);
    [DllImport("user32.dll", CharSet = CharSet.Auto)]
    public static extern int GetWindowText(IntPtr hWnd, StringBuilder title, int size);
    [DllImport("user32.dll", CharSet = CharSet.Auto)]
    public static extern int GetClassName(IntPtr hWnd, StringBuilder className, int size);
    [DllImport("user32.dll")]
    public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")]
    public static extern bool BringWindowToTop(IntPtr hWnd);
    [DllImport("user32.dll")]
    public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")]
    public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, UIntPtr dwExtraInfo);
    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool SetCursorPos(int X, int Y);
    [DllImport("user32.dll")]
    public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);

    // ShellExecute 原生协议唤醒 (零物理按键模拟)
    [DllImport("shell32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern IntPtr ShellExecute(IntPtr hwnd, string lpOperation, string lpFile, string lpParameters, string lpDirectory, int nShowCmd);

    // 原生剪贴板 API
    [DllImport("user32.dll")]
    public static extern bool OpenClipboard(IntPtr hWndNewOwner);
    [DllImport("user32.dll")]
    public static extern bool CloseClipboard();
    [DllImport("user32.dll")]
    public static extern bool EmptyClipboard();
    [DllImport("user32.dll")]
    public static extern IntPtr SetClipboardData(uint uFormat, IntPtr hMem);
    [DllImport("kernel32.dll")]
    public static extern IntPtr GlobalAlloc(uint uFlags, UIntPtr dwBytes);
    [DllImport("kernel32.dll")]
    public static extern IntPtr GlobalLock(IntPtr hMem);
    [DllImport("kernel32.dll")]
    public static extern bool GlobalUnlock(IntPtr hMem);

    // 进程路径获取 (32/64位安全)
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern IntPtr OpenProcess(uint processAccess, bool bInheritHandle, uint processId);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern bool QueryFullProcessImageName(IntPtr hProcess, uint flags, StringBuilder text, out uint size);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool CloseHandle(IntPtr hObject);

    const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
    const uint MOUSEEVENTF_LEFTUP   = 0x0004;
    const uint KEYEVENTF_KEYUP      = 0x0002;
    const int SW_RESTORE            = 9;
    const byte VK_CONTROL           = 0x11;
    const byte VK_A                 = 0x41;
    const byte VK_V                 = 0x56;
    const byte VK_RETURN            = 0x0D;

    // 运行状态与控制
    static bool g_JsonOnly = false;
    static bool g_HasExplicitUrl = false;
    static Stopwatch g_Stopwatch = new Stopwatch();
    static bool g_Exited = false;

    // 简练排查日志打印 (带统一前缀)
    static void LogInfo(string tag, string message) {
        if (!g_JsonOnly) {
            Console.WriteLine(string.Format("[INFO] [{0}] {1}", tag, message));
        }
    }

    static void LogWarn(string tag, string message) {
        if (!g_JsonOnly) {
            Console.WriteLine(string.Format("[WARN] [{0}] {1}", tag, message));
        }
    }

    static void LogError(string tag, string codeName, int code, string message) {
        if (!g_JsonOnly) {
            Console.WriteLine(string.Format("[ERROR] [{0}] ({1}:{2}) {3}", tag, codeName, code, message));
        }
    }

    // UIAutomation 元素安全属性读取辅助函数（避免 ElementNotAvailableException 等崩溃）
    static string SafeGetClassName(AutomationElement el) {
        if (el == null) return string.Empty;
        try { return el.Current.ClassName ?? string.Empty; } catch { return string.Empty; }
    }

    static string SafeGetName(AutomationElement el) {
        if (el == null) return string.Empty;
        try { return el.Current.Name ?? string.Empty; } catch { return string.Empty; }
    }

    static Rect SafeGetBoundingRectangle(AutomationElement el) {
        if (el == null) return Rect.Empty;
        try { return el.Current.BoundingRectangle; } catch { return Rect.Empty; }
    }

    static ControlType SafeGetControlType(AutomationElement el) {
        if (el == null) return null;
        try { return el.Current.ControlType; } catch { return null; }
    }

    // 退出并输出标准化 JSON 结果（保证即使异常也绝对输出合法 JSON）
    static void ExitWithResult(bool success, int code, string errorName, int failedStep, string message, string detail = "", string windowHwnd = "0x0", int clientCount = 0, string pagePath = "") {
        if (g_Exited) return;
        g_Exited = true;
        try { g_Stopwatch.Stop(); } catch {}
        Environment.ExitCode = code;

        StringBuilder json = new StringBuilder();
        json.Append("{");
        json.Append(string.Format("\"success\":{0},", success ? "true" : "false"));
        json.Append(string.Format("\"code\":{0},", code));
        json.Append(string.Format("\"error\":{0},", errorName == null ? "null" : "\"" + errorName + "\""));
        json.Append(string.Format("\"failedStep\":{0},", failedStep));
        json.Append(string.Format("\"message\":\"{0}\",", (message ?? "").Replace("\\", "\\\\").Replace("\"", "\\\"").Replace("\r", "").Replace("\n", " ")));
        json.Append(string.Format("\"detail\":\"{0}\",", (detail ?? "").Replace("\\", "\\\\").Replace("\"", "\\\"").Replace("\r", "").Replace("\n", " ")));
        json.Append(string.Format("\"windowHwnd\":\"{0}\",", windowHwnd ?? "0x0"));
        json.Append(string.Format("\"clientCount\":{0},", clientCount));
        json.Append(string.Format("\"pagePath\":\"{0}\",", pagePath ?? ""));
        json.Append(string.Format("\"durationMs\":{0}", g_Stopwatch.ElapsedMilliseconds));
        json.Append("}");

        if (g_JsonOnly) {
            Console.WriteLine(json.ToString());
        } else {
            if (success) {
                Console.WriteLine(string.Format("[SUCCESS] 微信视频号端到端调起成功！总耗时: {0}ms", g_Stopwatch.ElapsedMilliseconds));
            } else {
                Console.WriteLine(string.Format("[FAILURE] 执行中断于步骤 {0} (错误码: {1})，耗时: {2}ms", failedStep, code, g_Stopwatch.ElapsedMilliseconds));
            }
            Console.WriteLine("[JSON_RESULT] " + json.ToString());
        }
    }

    // 原生剪贴板写入
    static void SetClipboardText(string text) {
        for (int retry = 0; retry < 5; retry++) {
            if (OpenClipboard(IntPtr.Zero)) {
                EmptyClipboard();
                byte[] bytes = Encoding.Unicode.GetBytes(text + "\0");
                IntPtr hGlobal = GlobalAlloc(0x0002, (UIntPtr)bytes.Length);
                IntPtr target = GlobalLock(hGlobal);
                Marshal.Copy(bytes, 0, target, bytes.Length);
                GlobalUnlock(hGlobal);
                SetClipboardData(13 /* CF_UNICODETEXT */, hGlobal);
                CloseClipboard();
                return;
            }
            Thread.Sleep(50);
        }
    }

    // 动态鼠标点击
    static void Click(int x, int y) {
        SetCursorPos(x, y);
        Thread.Sleep(50);
        mouse_event(MOUSEEVENTF_LEFTDOWN, 0, 0, 0, UIntPtr.Zero);
        Thread.Sleep(50);
        mouse_event(MOUSEEVENTF_LEFTUP, 0, 0, 0, UIntPtr.Zero);
        Thread.Sleep(100);
    }

    // 前置守护：微信运行/登录检测
    static string EnsureWeChatRunning() {
        Process[] procs = Process.GetProcesses();
        string wechatExePath = null;
        foreach (var p in procs) {
            string name = p.ProcessName.ToLower();
            if (name == "weixin" || name == "wechat") {
                IntPtr hProc = OpenProcess(0x1000, false, (uint)p.Id);
                if (hProc != IntPtr.Zero) {
                    StringBuilder sb = new StringBuilder(1024);
                    uint size = (uint)sb.Capacity;
                    if (QueryFullProcessImageName(hProc, 0, sb, out size)) {
                        wechatExePath = sb.ToString();
                    }
                    CloseHandle(hProc);
                }
                if (!string.IsNullOrEmpty(wechatExePath) && File.Exists(wechatExePath)) {
                    break;
                }
            }
        }
        return wechatExePath;
    }

    // 前置自愈：检测修复 HKCU\Software\Classes\weixin 协议
    static bool EnsureWeixinProtocol(string wechatExe) {
        try {
            string regPath = @"Software\Classes\weixin";
            using (var key = Registry.CurrentUser.OpenSubKey(regPath + @"\shell\open\command", false)) {
                if (key != null) {
                    string cmd = key.GetValue("") as string;
                    if (!string.IsNullOrEmpty(cmd) && cmd.IndexOf(wechatExe, StringComparison.OrdinalIgnoreCase) >= 0) {
                        return true;
                    }
                }
            }

            LogWarn("Guard", "检测到 weixin:// 注册表关联不完整，执行静默自愈...");
            using (var rootKey = Registry.CurrentUser.CreateSubKey(regPath)) {
                rootKey.SetValue("", "weixinProtocol");
                rootKey.SetValue("URL Protocol", "");
            }
            using (var iconKey = Registry.CurrentUser.CreateSubKey(regPath + @"\DefaultIcon")) {
                iconKey.SetValue("", "\"" + wechatExe + "\",1");
            }
            using (var cmdKey = Registry.CurrentUser.CreateSubKey(regPath + @"\shell\open\command")) {
                cmdKey.SetValue("", "\"" + wechatExe + "\" \"%1\"");
            }
            LogInfo("Guard", "weixin:// 协议已自动自愈修复完成");
            return true;
        } catch (Exception ex) {
            LogWarn("Guard", "注册表自愈受限: " + ex.Message);
            return false;
        }
    }

    // 精准枚举属于 WeChatAppEx 的 Chrome_WidgetWin_0 窗口
    static List<IntPtr> SnapshotVideoWindows(IntPtr hDesk) {
        List<IntPtr> list = new List<IntPtr>();
        EnumDesktopWindows(hDesk, (hWnd, lParam) => {
            if (IsWindowVisible(hWnd)) {
                StringBuilder sbCls = new StringBuilder(256);
                GetClassName(hWnd, sbCls, 256);
                if (sbCls.ToString() == "Chrome_WidgetWin_0") {
                    uint pid;
                    GetWindowThreadProcessId(hWnd, out pid);
                    try {
                        string pName = Process.GetProcessById((int)pid).ProcessName;
                        if (pName.Equals("WeChatAppEx", StringComparison.OrdinalIgnoreCase)) {
                            list.Add(hWnd);
                        }
                    } catch {}
                }
            }
            return true;
        }, IntPtr.Zero);
        return list;
    }

    // 静默底层协议唤醒 (零物理按键模拟，双通道系统级派发)
    static void LaunchProtocolSilent(string protocolUrl) {
        try {
            // 通道 1: Windows Shell API 直调 (SW_SHOWNORMAL；SW_HIDE 会让微信把视频号窗口以隐藏状态创建)
            IntPtr ret = ShellExecute(IntPtr.Zero, "open", protocolUrl, null, null, 1);
            if (ret.ToInt64() > 32) return;
        } catch {}

        try {
            // 通道 2: 静默 cmd.exe start 兜底 (无窗运行)
            var psi = new ProcessStartInfo {
                FileName = "cmd.exe",
                Arguments = "/d /s /c start \"\" \"" + protocolUrl + "\"",
                CreateNoWindow = true,
                UseShellExecute = false,
                WindowStyle = ProcessWindowStyle.Hidden
            };
            using (var p = Process.Start(psi)) {
                if (p != null) p.WaitForExit(1000);
            }
        } catch {}
    }

    // 单次调起与导航尝试
    static bool ExecuteAttempt(string targetUrl, string expectedPath, IntPtr hDesk, int attempt,
        out int errCode, out string errCodeName, out int errStep, out string errMsg, out string errDetail) {

        errCode = 0;
        errCodeName = null;
        errStep = 0;
        errMsg = "";
        errDetail = "";

        // ====================================================
        // [阶段 0] 前置守护检查
        // ====================================================
        string wechatExe = EnsureWeChatRunning();
        if (string.IsNullOrEmpty(wechatExe)) {
            errMsg = "微信未在运行或未登录，请先启动微信";
            errCode = CODE_WECHAT_NOT_RUNNING;
            errCodeName = "WECHAT_NOT_RUNNING";
            errStep = 0;
            errDetail = "未找到 Weixin.exe 或 WeChat.exe 进程";
            return false;
        }
        LogInfo("Guard", string.Format("微信进程活跃, 路径={0}", wechatExe));
        EnsureWeixinProtocol(wechatExe);

        // ====================================================
        // [步骤 1] 纯静默协议拉起视频号原生窗口 (彻底抛弃物理模拟)
        // ====================================================
        var beforeWindows = SnapshotVideoWindows(hDesk);
        LaunchProtocolSilent("weixin://launchfinder");

        IntPtr hVideoWin = IntPtr.Zero;
        for (int i = 0; i < 20; i++) {
            Thread.Sleep(300);
            var currentWindows = SnapshotVideoWindows(hDesk);
            foreach (var h in currentWindows) {
                if (!beforeWindows.Contains(h)) {
                    hVideoWin = h;
                    break;
                }
            }
            if (hVideoWin != IntPtr.Zero) break;

            if (currentWindows.Count > 0 && i >= 5) {
                hVideoWin = currentWindows[0];
                break;
            }

            if (i == 6) {
                LaunchProtocolSilent("weixin://launchfinder");
            }
        }

        if (hVideoWin == IntPtr.Zero) {
            errMsg = "未能检测到微信视频号窗口 (Chrome_WidgetWin_0)";
            errCode = CODE_WINDOW_NOT_FOUND;
            errCodeName = "WINDOW_NOT_FOUND";
            errStep = 1;
            errDetail = "等待 6 秒未发现匹配的 WeChatAppEx 窗口";
            return false;
        }

        string hwndStr = string.Format("0x{0:X}", hVideoWin.ToInt64());
        LogInfo("Step1", string.Format("视频号窗口就绪: HWND={0}", hwndStr));
        try {
            ShowWindow(hVideoWin, SW_RESTORE);
            SetForegroundWindow(hVideoWin);
            BringWindowToTop(hVideoWin);
        } catch {}
        Thread.Sleep(300);

        // ====================================================
        // [步骤 2] 分析窗体结构，动态定位右上角搜索按钮并点击
        // ====================================================
        AutomationElement winEl = null;
        try {
            winEl = AutomationElement.FromHandle(hVideoWin);
        } catch (Exception ex) {
            errMsg = "无法从句柄获取视频号自动化元素: " + ex.Message;
            errCode = CODE_WINDOW_NOT_FOUND;
            errCodeName = "WINDOW_NOT_FOUND";
            errStep = 1;
            return false;
        }

        var winRect = SafeGetBoundingRectangle(winEl);
        AutomationElementCollection allDesc = null;
        try {
            allDesc = winEl.FindAll(TreeScope.Descendants, Condition.TrueCondition);
        } catch (Exception ex) {
            LogWarn("Step2", "枚举子节点时发生异常: " + ex.Message);
        }

        bool alreadyOpen = false;
        if (allDesc != null) {
            for (int i = 0; i < allDesc.Count; i++) {
                try {
                    var el = allDesc[i];
                    string cls = SafeGetClassName(el);
                    if (cls.Contains("OmniboxViewViews")) {
                        var r = SafeGetBoundingRectangle(el);
                        if (r.Width > 100 && r.Left < winRect.Right - 150) {
                            alreadyOpen = true;
                            break;
                        }
                    }
                } catch {}
            }
        }

        if (alreadyOpen) {
            LogInfo("Step2", "搜索栏已处于展开就绪状态，跳过点击");
        } else {
            AutomationElement searchBtn = null;
            if (allDesc != null) {
                // 结构特征 1: LocationBarView / ToolbarView
                for (int i = 0; i < allDesc.Count; i++) {
                    try {
                        var el = allDesc[i];
                        string cls = SafeGetClassName(el);
                        if (cls.Contains("LocationBarView") || cls.Contains("ToolbarView")) {
                            var r = SafeGetBoundingRectangle(el);
                            if (r.Top < winRect.Top + 60 && r.Width > 0 && r.Height > 0) {
                                searchBtn = el;
                                break;
                            }
                        }
                    } catch {}
                }

                // 结构特征 2: 最小化按钮左邻近容器
                if (searchBtn == null) {
                    AutomationElement minBtn = null;
                    for (int i = 0; i < allDesc.Count; i++) {
                        try {
                            if (SafeGetName(allDesc[i]) == "最小化") {
                                minBtn = allDesc[i];
                                break;
                            }
                        } catch {}
                    }
                    if (minBtn != null) {
                        var minR = SafeGetBoundingRectangle(minBtn);
                        for (int i = 0; i < allDesc.Count; i++) {
                            try {
                                var r = SafeGetBoundingRectangle(allDesc[i]);
                                if (r.Top >= minR.Top - 10 && r.Top <= minR.Bottom + 10 &&
                                    r.Right <= minR.Left + 5 && r.Left >= minR.Left - 50 && r.Width >= 16) {
                                    searchBtn = allDesc[i];
                                    break;
                                }
                            } catch {}
                        }
                    }
                }
            }

            if (searchBtn == null) {
                errMsg = "未能通过结构特征定位到右上角搜索按钮";
                errCode = CODE_SEARCH_BTN_NOT_FOUND;
                errCodeName = "SEARCH_BTN_NOT_FOUND";
                errStep = 2;
                errDetail = "标题栏未匹配到 LocationBarView 容器或最小化相邻元素";
                return false;
            }

            var sRect = SafeGetBoundingRectangle(searchBtn);
            int searchCx = (int)(sRect.Left + sRect.Width / 2);
            int searchCy = (int)(sRect.Top + sRect.Height / 2);
            LogInfo("Step2", string.Format("点击搜索按钮: Center=({0},{1})", searchCx, searchCy));
            Click(searchCx, searchCy);
            Thread.Sleep(500);
        }

        // ====================================================
        // [步骤 3] 定位展开的输入框，粘贴指定链接并回车
        // ====================================================
        AutomationElement omniEl = null;
        for (int retry = 0; retry < 15; retry++) {
            Thread.Sleep(200);
            AutomationElementCollection refreshDesc = null;
            try {
                refreshDesc = winEl.FindAll(TreeScope.Descendants, Condition.TrueCondition);
            } catch {}

            if (refreshDesc != null) {
                for (int i = 0; i < refreshDesc.Count; i++) {
                    try {
                        var el = refreshDesc[i];
                        string cls = SafeGetClassName(el);
                        var r = SafeGetBoundingRectangle(el);
                        ControlType ct = SafeGetControlType(el);
                        if ((cls.Contains("OmniboxViewViews") || ct == ControlType.Edit) && 
                            r.Width > 50 && r.Left < winRect.Right - 100) {
                            omniEl = el;
                            break;
                        }
                    } catch {}
                }
            }
            if (omniEl != null) break;
        }

        if (omniEl == null) {
            errMsg = "未能在点击后捕获到展开的输入框 (OmniboxViewViews)";
            errCode = CODE_OMNIBOX_NOT_FOUND;
            errCodeName = "OMNIBOX_NOT_FOUND";
            errStep = 3;
            errDetail = "展开动画超时或输入框未渲染";
            return false;
        }

        var oRect = SafeGetBoundingRectangle(omniEl);
        int omniCx = (int)(oRect.Left + 50);
        int omniCy = (int)(oRect.Top + oRect.Height / 2);
        Click(omniCx, omniCy);
        Thread.Sleep(100);

        SetClipboardText(targetUrl);
        LogInfo("Step3", "聚焦输入框并粘贴目标链接: " + targetUrl);

        // Ctrl+V -> Enter
        keybd_event(VK_CONTROL, 0, 0, UIntPtr.Zero);
        keybd_event(VK_V, 0, 0, UIntPtr.Zero);
        Thread.Sleep(30);
        keybd_event(VK_V, 0, KEYEVENTF_KEYUP, UIntPtr.Zero);
        keybd_event(VK_CONTROL, 0, KEYEVENTF_KEYUP, UIntPtr.Zero);
        Thread.Sleep(300);

        keybd_event(VK_RETURN, 0, 0, UIntPtr.Zero);
        Thread.Sleep(50);
        keybd_event(VK_RETURN, 0, KEYEVENTF_KEYUP, UIntPtr.Zero);

        // 如果显式传入了 --url 打开具体链接，完成回车输入后即视为成功打开，跳过步骤 4 的代理连接校验
        if (g_HasExplicitUrl) {
            LogInfo("Step3", "已输入链接并回车，显式 URL 模式直接完成");
            ExitWithResult(true, CODE_SUCCESS, null, 0, "链接已成功打开", "", hwndStr, 0, expectedPath);
            return true;
        }

        // ====================================================
        // [步骤 4] 轮询健康端点验证 clientCount >= 1
        // ====================================================
        LogInfo("Step4", "轮询代理健康端点 http://127.0.0.1:2025/__wx_channels_api/health ...");
        bool clientReady = false;
        string lastResponse = "";

        for (int s = 1; s <= 20; s++) {
            Thread.Sleep(1000);
            try {
                HttpWebRequest req = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:2025/__wx_channels_api/health");
                req.Timeout = 1500;
                using (HttpWebResponse resp = (HttpWebResponse)req.GetResponse()) {
                    using (StreamReader sr = new StreamReader(resp.GetResponseStream())) {
                        string json = sr.ReadToEnd();
                        lastResponse = json;
                        var match = System.Text.RegularExpressions.Regex.Match(json, "\"clientCount\"\\s*:\\s*(\\d+)");
                        int cnt = 0;
                        if (match.Success && int.TryParse(match.Groups[1].Value, out cnt) && cnt >= 1) {
                            clientReady = true;
                            LogInfo("Step4", string.Format("clientCount={0} 验证成功 (第 {1} 秒)", cnt, s));
                            break;
                        } else {
                            if (s == 3) {
                                keybd_event(VK_RETURN, 0, 0, UIntPtr.Zero);
                                Thread.Sleep(50);
                                keybd_event(VK_RETURN, 0, KEYEVENTF_KEYUP, UIntPtr.Zero);
                            }
                        }
                    }
                }
            } catch (Exception ex) {
                lastResponse = ex.Message;
            }
        }

        if (!clientReady) {
            errMsg = "等待客户端连接超时 (20秒内 clientCount 未达成 1)";
            errCode = CODE_CLIENT_CONNECT_TIMEOUT;
            errCodeName = "CLIENT_CONNECT_TIMEOUT";
            errStep = 4;
            errDetail = "最后端点响应: " + lastResponse;
            return false;
        }

        // 全部流程圆满通过！
        ExitWithResult(true, CODE_SUCCESS, null, 0, "全部流程顺利执行通过", "", hwndStr, 1, expectedPath);
        return true;
    }

    // 主执行逻辑，内置 3 次重试机制与全局容错
    static void Run(string[] args) {
        string targetUrl = "https://channels.weixin.qq.com/web/pages/feed?skipLiteApp=1";

        for (int i = 0; i < args.Length; i++) {
            string arg = args[i];
            if (arg.Equals("--json", StringComparison.OrdinalIgnoreCase) || arg.Equals("-j", StringComparison.OrdinalIgnoreCase)) {
                g_JsonOnly = true;
            } else if (arg.Equals("--url", StringComparison.OrdinalIgnoreCase) || arg.Equals("-u", StringComparison.OrdinalIgnoreCase)) {
                if (i + 1 < args.Length) {
                    targetUrl = args[++i];
                    g_HasExplicitUrl = true;
                }
            } else if (arg.StartsWith("http://", StringComparison.OrdinalIgnoreCase) || arg.StartsWith("https://", StringComparison.OrdinalIgnoreCase)) {
                targetUrl = arg;
                g_HasExplicitUrl = true;
            }
        }

        string expectedPath = "/web/pages/feed";
        try {
            Uri parsedUri = new Uri(targetUrl);
            expectedPath = parsedUri.AbsolutePath;
        } catch {}

        g_Stopwatch.Start();

        // 桌面上下文切换
        IntPtr hDesk = OpenDesktop("Default", 0, false, 0x01FF);
        bool deskOk = SetThreadDesktop(hDesk);
        if (!deskOk) {
            LogError("Desktop", "DESKTOP_ACCESS_DENIED", CODE_DESKTOP_ACCESS_DENIED, "无法附加至系统交互式桌面 Default");
            ExitWithResult(false, CODE_DESKTOP_ACCESS_DENIED, "DESKTOP_ACCESS_DENIED", 0, "无法附加至系统交互式桌面 Default", "SetThreadDesktop failed, LastWin32Error=" + Marshal.GetLastWin32Error());
            return;
        }

        try {
            const int MAX_ATTEMPTS = 3;
            string lastErrorMsg = "";
            string lastDetail = "";
            int lastCode = 0;
            string lastCodeName = "";
            int lastStep = 0;

            for (int attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
                if (attempt > 1) {
                    LogInfo("Retry", string.Format("=== 开始第 {0}/{1} 次重试 ===", attempt, MAX_ATTEMPTS));
                }

                try {
                    bool ok = ExecuteAttempt(targetUrl, expectedPath, hDesk, attempt, out lastCode, out lastCodeName, out lastStep, out lastErrorMsg, out lastDetail);
                    if (ok) {
                        return;
                    }
                } catch (Exception ex) {
                    lastStep = 0;
                    lastCode = 1099;
                    lastCodeName = ex.GetType().Name;
                    try { lastErrorMsg = ex.Message ?? ""; } catch { lastErrorMsg = "执行异常"; }
                    try { lastDetail = ex.StackTrace ?? ""; } catch { lastDetail = ""; }
                    LogWarn("Retry", string.Format("第 {0}/{1} 次尝试出现异常: {2}", attempt, MAX_ATTEMPTS, lastErrorMsg));
                }

                if (attempt < MAX_ATTEMPTS) {
                    LogInfo("Retry", string.Format("第 {0} 次尝试未成功 ({1})，等待 1.5 秒后重试...", attempt, lastErrorMsg));
                    Thread.Sleep(1500);
                }
            }

            // 3 次尝试均失败，输出最后一次失败原因
            LogError("Main", lastCodeName ?? "LAUNCH_RETRY_EXHAUSTED", lastCode != 0 ? lastCode : CODE_CLIENT_CONNECT_TIMEOUT, "3次重试均未成功: " + lastErrorMsg);
            ExitWithResult(false, lastCode != 0 ? lastCode : CODE_CLIENT_CONNECT_TIMEOUT, lastCodeName ?? "LAUNCH_RETRY_EXHAUSTED", lastStep, "视频号调起失败 (已重试3次): " + lastErrorMsg, lastDetail);
        } finally {
            try { CloseDesktop(hDesk); } catch {}
        }
    }

    public static void Main(string[] args) {
        try {
            Console.OutputEncoding = System.Text.Encoding.UTF8;
        } catch {}

        try {
            Run(args);
        } catch (Exception ex) {
            string errType = ex.GetType().Name;
            string errMsg = "";
            try { errMsg = ex.Message ?? ""; } catch { errMsg = "未知异常"; }
            string errStack = "";
            try { errStack = ex.StackTrace ?? ""; } catch {}

            LogError("Fatal", errType, 1099, errMsg);
            ExitWithResult(false, 1099, errType, 0, "程序异常退出: " + errMsg, errStack);
        }
    }
}
