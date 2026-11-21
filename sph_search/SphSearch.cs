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
using Accessibility;

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
    [StructLayout(LayoutKind.Sequential)]
    public struct POINT {
        public int X;
        public int Y;
    }

    [DllImport("user32.dll")]
    public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")]
    public static extern bool ScreenToClient(IntPtr hWnd, ref POINT lpPoint);
    [DllImport("user32.dll")]
    public static extern bool GetCursorPos(out POINT lpPoint);
    [DllImport("user32.dll")]
    public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, UIntPtr dwExtraInfo);
    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool SetCursorPos(int X, int Y);
    [DllImport("user32.dll")]
    public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern bool PostMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);

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
    public static extern IntPtr GetClipboardData(uint uFormat);
    [DllImport("user32.dll")]
    public static extern IntPtr SetClipboardData(uint uFormat, IntPtr hMem);
    [DllImport("user32.dll")]
    public static extern bool IsClipboardFormatAvailable(uint format);
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

    // MSAA (oleacc.dll) - 兼容新版微信 4.x / WeChatAppEx (UIA2 无法枚举标题栏控件时使用)
    [DllImport("oleacc.dll")]
    public static extern int AccessibleObjectFromWindow(IntPtr hwnd, int dwId, ref Guid riid, [MarshalAs(UnmanagedType.Interface)] out IAccessible ppvObject);
    [DllImport("oleacc.dll")]
    public static extern int AccessibleChildren(IAccessible paccContainer, int iChildStart, int cChildren, [Out, MarshalAs(UnmanagedType.LPArray, ArraySubType = UnmanagedType.Struct, SizeParamIndex = 2)] object[] rgvarChildren, out int pcObtained);

    static readonly Guid IID_IAccessible = new Guid("618736E0-3C3D-11CF-810C-00AA00389B71");
    const int OBJID_CLIENT         = -4;
    const int ROLE_SYSTEM_DOCUMENT = 15;
    const int ROLE_SYSTEM_TEXT     = 42;
    const int TOP_BAR_MAX_HEIGHT   = 160; // 兼容最高 250% DPI 缩放

    const uint WM_MOUSEMOVE        = 0x0200;
    const uint WM_LBUTTONDOWN      = 0x0201;
    const uint WM_LBUTTONUP        = 0x0202;
    const int  MK_LBUTTON          = 0x0001;

    const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
    const uint MOUSEEVENTF_LEFTUP   = 0x0004;
    const uint KEYEVENTF_KEYUP      = 0x0002;
    const int SW_RESTORE            = 9;
    const byte VK_CONTROL           = 0x11;
    const byte VK_A                 = 0x41;
    const byte VK_V                 = 0x56;
    const byte VK_RETURN            = 0x0D;
    const uint CF_UNICODETEXT       = 13;

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

    // ----------------------------------------------------
    // UIA2 CacheRequest + MSAA 极速兼容层（跳过网页 DOM，兼容 3.x / 4.x 与高 DPI）
    // ----------------------------------------------------
    class SearchBtnInfo {
        public string Source;
        public int Cx;
        public int Cy;
        public AutomationElement UiaEl;
        public IAccessible MsaaEl;
    }

    class OmniboxInfo {
        public string Source;
        public int Cx;
        public int Cy;
        public int Width;
        public AutomationElement UiaEl;
        public IAccessible MsaaEl;
    }

    static CacheRequest CreateTopBarCacheRequest() {
        var req = new CacheRequest();
        req.TreeScope = TreeScope.Element;
        req.Add(AutomationElement.ClassNameProperty);
        req.Add(AutomationElement.NameProperty);
        req.Add(AutomationElement.ControlTypeProperty);
        req.Add(AutomationElement.BoundingRectangleProperty);
        return req;
    }

    static string SafeCachedClassName(AutomationElement el) {
        try { return el != null ? (el.Cached.ClassName ?? string.Empty) : string.Empty; } catch { return SafeGetClassName(el); }
    }

    static string SafeCachedName(AutomationElement el) {
        try { return el != null ? (el.Cached.Name ?? string.Empty) : string.Empty; } catch { return SafeGetName(el); }
    }

    static Rect SafeCachedRect(AutomationElement el) {
        try { return el != null ? el.Cached.BoundingRectangle : Rect.Empty; } catch { return SafeGetBoundingRectangle(el); }
    }

    static ControlType SafeCachedControlType(AutomationElement el) {
        try { return el != null ? el.Cached.ControlType : null; } catch { return SafeGetControlType(el); }
    }

    static void CollectTopBarUiaRec(AutomationElement el, int depth, int winTop, CacheRequest cacheReq, List<AutomationElement> results) {
        if (el == null || depth > 12 || results.Count >= 200) return;

        string cls = depth == 0 ? SafeGetClassName(el) : SafeCachedClassName(el);
        if (cls == "Chrome_RenderWidgetHostHWND" || cls == "Intermediate D3D Window") {
            return;
        }
        ControlType ct = depth == 0 ? SafeGetControlType(el) : SafeCachedControlType(el);
        if (ct == ControlType.Document) {
            return;
        }
        Rect r = depth == 0 ? SafeGetBoundingRectangle(el) : SafeCachedRect(el);
        if (depth > 0 && !r.IsEmpty && r.Height > 0 && r.Top >= winTop + TOP_BAR_MAX_HEIGHT) {
            return;
        }

        if (depth > 0) {
            results.Add(el);
        }

        try {
            var walker = TreeWalker.RawViewWalker;
            var child = walker.GetFirstChild(el, cacheReq);
            while (child != null && results.Count < 200) {
                CollectTopBarUiaRec(child, depth + 1, winTop, cacheReq, results);
                child = walker.GetNextSibling(child, cacheReq);
            }
        } catch {}
    }

    static List<AutomationElement> CollectTopBarUiaElements(AutomationElement winEl, int winTop) {
        var results = new List<AutomationElement>();
        var cacheReq = CreateTopBarCacheRequest();
        CollectTopBarUiaRec(winEl, 0, winTop, cacheReq, results);
        return results;
    }

    static IAccessible GetMsaaRoot(IntPtr hWnd) {
        try {
            Guid iid = IID_IAccessible;
            IAccessible acc = null;
            int hr = AccessibleObjectFromWindow(hWnd, OBJID_CLIENT, ref iid, out acc);
            if (hr == 0) return acc;
        } catch {}
        return null;
    }

    static object[] GetMsaaChildren(IAccessible acc) {
        if (acc == null) return new object[0];
        try {
            int cc = acc.accChildCount;
            if (cc <= 0 || cc > 60) return new object[0];
            object[] arr = new object[cc];
            int got = 0;
            int hr = AccessibleChildren(acc, 0, cc, arr, out got);
            if ((hr == 0 || hr == 1) && got > 0) {
                if (got == cc) return arr;
                object[] trimmed = new object[got];
                Array.Copy(arr, trimmed, got);
                return trimmed;
            }
        } catch {}
        return new object[0];
    }

    static string SafeMsaaName(IAccessible acc) {
        if (acc == null) return string.Empty;
        try { return acc.get_accName(0) ?? string.Empty; } catch { return string.Empty; }
    }

    static string SafeMsaaValue(IAccessible acc) {
        if (acc == null) return string.Empty;
        try { return acc.get_accValue(0) ?? string.Empty; } catch { return string.Empty; }
    }

    static int SafeMsaaRole(IAccessible acc) {
        if (acc == null) return 0;
        try {
            object r = acc.get_accRole(0);
            if (r is int) return (int)r;
            int parsed;
            if (r != null && int.TryParse(r.ToString(), out parsed)) return parsed;
        } catch {}
        return 0;
    }

    static bool SafeMsaaLocation(IAccessible acc, out int x, out int y, out int w, out int h) {
        x = y = w = h = 0;
        if (acc == null) return false;
        try {
            acc.accLocation(out x, out y, out w, out h, 0);
            return w > 0 && h > 0;
        } catch {
            return false;
        }
    }

    static void ScanMsaaTopBarRec(IAccessible acc, int depth, int winTop, int omniMinWidth,
        ref OmniboxInfo foundOmni, ref SearchBtnInfo foundBtn) {
        if (acc == null || depth > 10 || (foundOmni != null && foundBtn != null)) return;
        int role = SafeMsaaRole(acc);
        if (role == ROLE_SYSTEM_DOCUMENT) return;

        int ax, ay, aw, ah;
        bool hasLoc = SafeMsaaLocation(acc, out ax, out ay, out aw, out ah);
        if (hasLoc && ay >= winTop + TOP_BAR_MAX_HEIGHT) return;

        if (foundOmni == null && role == ROLE_SYSTEM_TEXT && hasLoc && aw >= omniMinWidth && ah >= 12 && ay < winTop + TOP_BAR_MAX_HEIGHT) {
            string name = SafeMsaaName(acc);
            if (name.Contains("地址") || name.Contains("搜索") || name.IndexOf("Address", StringComparison.OrdinalIgnoreCase) >= 0 || string.IsNullOrEmpty(name)) {
                foundOmni = new OmniboxInfo {
                    Source = "MSAA:AddressBar",
                    Cx = ax + Math.Min(50, aw / 2),
                    Cy = ay + ah / 2,
                    Width = aw,
                    MsaaEl = acc
                };
            }
        }

        object[] children = GetMsaaChildren(acc);
        if (foundBtn == null && depth <= 8 && children.Length > 0) {
            bool hasReload = false;
            int reloadRight = 0;
            foreach (object ch in children) {
                IAccessible ca = ch as IAccessible;
                if (ca == null) continue;
                string name = SafeMsaaName(ca);
                if (name == "重新加载" || name.Equals("Reload", StringComparison.OrdinalIgnoreCase) || name == "刷新") {
                    int rx, ry, rw, rh;
                    if (SafeMsaaLocation(ca, out rx, out ry, out rw, out rh)) reloadRight = rx + rw;
                    hasReload = true;
                    break;
                }
            }
            if (hasReload) {
                foreach (object ch in children) {
                    IAccessible ca = ch as IAccessible;
                    if (ca == null) continue;
                    foreach (object sub in GetMsaaChildren(ca)) {
                        IAccessible sa = sub as IAccessible;
                        if (sa == null) continue;
                        int sx, sy, sw, sh;
                        if (!SafeMsaaLocation(sa, out sx, out sy, out sw, out sh)) continue;
                        int subCc = 0;
                        try { subCc = sa.accChildCount; } catch {}
                        if (subCc == 0 && sw >= 20 && sw <= 72 && sh >= 20 && sh <= 72 &&
                            Math.Abs(sw - sh) <= 10 && sx >= reloadRight - 5 && sy < winTop + TOP_BAR_MAX_HEIGHT) {
                            foundBtn = new SearchBtnInfo {
                                Source = "MSAA:TabBarSearchBtn",
                                Cx = sx + sw / 2,
                                Cy = sy + sh / 2,
                                MsaaEl = sa
                            };
                            break;
                        }
                    }
                    if (foundBtn != null) break;
                }
            }
        }

        foreach (object ch in children) {
            IAccessible ca = ch as IAccessible;
            if (ca != null) {
                ScanMsaaTopBarRec(ca, depth + 1, winTop, omniMinWidth, ref foundOmni, ref foundBtn);
                if (foundOmni != null && foundBtn != null) return;
            }
        }
    }

    static void ScanTopBarOnce(IntPtr hWnd, AutomationElement winEl, Rect winRect, int winTop,
        out OmniboxInfo openOmni, out SearchBtnInfo searchBtn) {
        openOmni = null;
        searchBtn = null;

        // 1. 先扫一次 UIA2（CacheRequest 批量拉属性 + 跳过网页正文）
        var topEls = CollectTopBarUiaElements(winEl, winTop);
        AutomationElement minBtn = null;
        for (int i = 0; i < topEls.Count; i++) {
            var el = topEls[i];
            string cls = SafeCachedClassName(el);
            Rect r = SafeCachedRect(el);
            if (openOmni == null && cls.Contains("OmniboxViewViews") && r.Width > 100 && r.Left < winRect.Right - 150) {
                openOmni = new OmniboxInfo {
                    Source = "UIA2:Omnibox",
                    Cx = (int)(r.Left + Math.Min(50, r.Width / 2)),
                    Cy = (int)(r.Top + r.Height / 2),
                    Width = (int)r.Width,
                    UiaEl = el
                };
                return;
            }
            if (searchBtn == null && (cls.Contains("LocationBarView") || cls.Contains("ToolbarView"))) {
                if (r.Top < winRect.Top + TOP_BAR_MAX_HEIGHT && r.Width > 0 && r.Height > 0) {
                    searchBtn = new SearchBtnInfo {
                        Source = "UIA2:LocationBarView",
                        Cx = (int)(r.Left + r.Width / 2),
                        Cy = (int)(r.Top + r.Height / 2),
                        UiaEl = el
                    };
                }
            }
            if (minBtn == null && SafeCachedName(el) == "最小化") {
                minBtn = el;
            }
        }

        if (searchBtn == null && minBtn != null) {
            Rect minR = SafeCachedRect(minBtn);
            for (int i = 0; i < topEls.Count; i++) {
                Rect r = SafeCachedRect(topEls[i]);
                if (r.Top >= minR.Top - 10 && r.Top <= minR.Bottom + 10 &&
                    r.Right <= minR.Left + 5 && r.Left >= minR.Left - 80 && r.Width >= 16) {
                    searchBtn = new SearchBtnInfo {
                        Source = "UIA2:MinimizeAdjacent",
                        Cx = (int)(r.Left + r.Width / 2),
                        Cy = (int)(r.Top + r.Height / 2),
                        UiaEl = topEls[i]
                    };
                    break;
                }
            }
        }

        if (openOmni != null || searchBtn != null) return;

        // 2. UIA2 未命中 -> 单次 MSAA 扫描同时定位已展开输入框或放大镜按钮
        IAccessible root = GetMsaaRoot(hWnd);
        if (root != null) {
            ScanMsaaTopBarRec(root, 0, winTop, 100, ref openOmni, ref searchBtn);
        }
    }

    static OmniboxInfo FindOmniboxUia(AutomationElement winEl, Rect winRect, int winTop, int minWidth) {
        try {
            var topEls = CollectTopBarUiaElements(winEl, winTop);
            for (int i = 0; i < topEls.Count; i++) {
                var el = topEls[i];
                string cls = SafeCachedClassName(el);
                Rect r = SafeCachedRect(el);
                ControlType ct = SafeCachedControlType(el);
                if ((cls.Contains("OmniboxViewViews") || ct == ControlType.Edit) &&
                    r.Width >= minWidth && r.Left < winRect.Right - 100) {
                    return new OmniboxInfo {
                        Source = "UIA2:Omnibox",
                        Cx = (int)(r.Left + Math.Min(50, r.Width / 2)),
                        Cy = (int)(r.Top + r.Height / 2),
                        Width = (int)r.Width,
                        UiaEl = el
                    };
                }
            }
        } catch {}
        return null;
    }

    static OmniboxInfo FindOmniboxMsaa(IntPtr hWnd, IAccessible hintContainer, int winTop, int minWidth) {
        if (hintContainer != null) {
            OmniboxInfo quickOmni = null;
            SearchBtnInfo dummy = new SearchBtnInfo();
            ScanMsaaTopBarRec(hintContainer, 0, winTop, minWidth, ref quickOmni, ref dummy);
            if (quickOmni != null) return quickOmni;
        }
        IAccessible root = GetMsaaRoot(hWnd);
        if (root != null) {
            OmniboxInfo omni = null;
            SearchBtnInfo dummy = new SearchBtnInfo();
            ScanMsaaTopBarRec(root, 0, winTop, minWidth, ref omni, ref dummy);
            return omni;
        }
        return null;
    }

    static OmniboxInfo WaitForOmnibox(IntPtr hWnd, AutomationElement winEl, Rect winRect, int winTop, int minWidth, int timeoutMs, bool preferMsaa, IAccessible msaaHint) {
        Stopwatch sw = Stopwatch.StartNew();
        while (sw.ElapsedMilliseconds < timeoutMs) {
            OmniboxInfo box = preferMsaa
                ? (FindOmniboxMsaa(hWnd, msaaHint, winTop, minWidth) ?? FindOmniboxUia(winEl, winRect, winTop, minWidth))
                : (FindOmniboxUia(winEl, winRect, winTop, minWidth) ?? FindOmniboxMsaa(hWnd, msaaHint, winTop, minWidth));
            if (box != null) return box;
            Thread.Sleep(40);
        }
        return null;
    }

    static string ReadOmniboxValue(OmniboxInfo box) {
        if (box == null) return string.Empty;
        if (box.UiaEl != null) {
            try {
                object pat;
                if (box.UiaEl.TryGetCurrentPattern(ValuePattern.Pattern, out pat)) {
                    return ((ValuePattern)pat).Current.Value ?? string.Empty;
                }
            } catch {}
        }
        if (box.MsaaEl != null) {
            return SafeMsaaValue(box.MsaaEl);
        }
        return string.Empty;
    }

    static bool ValueMatchesTarget(string actual, string targetUrl) {
        if (string.IsNullOrEmpty(actual)) return false;
        if (actual.IndexOf(targetUrl, StringComparison.OrdinalIgnoreCase) >= 0) return true;
        string stripped = targetUrl.Replace("https://", "").Replace("http://", "");
        return actual.IndexOf(stripped, StringComparison.OrdinalIgnoreCase) >= 0;
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

    // 备份原剪贴板文本（避免破坏用户正在复制的内容）
    static string BackupClipboardText() {
        try {
            if (!IsClipboardFormatAvailable(CF_UNICODETEXT)) return null;
            if (!OpenClipboard(IntPtr.Zero)) return null;
            try {
                IntPtr hData = GetClipboardData(CF_UNICODETEXT);
                if (hData == IntPtr.Zero) return null;
                IntPtr ptr = GlobalLock(hData);
                if (ptr == IntPtr.Zero) return null;
                try {
                    return Marshal.PtrToStringUni(ptr);
                } finally {
                    GlobalUnlock(hData);
                }
            } finally {
                CloseClipboard();
            }
        } catch {
            return null;
        }
    }

    // 原生剪贴板写入
    static void SetClipboardText(string text) {
        if (text == null) return;
        for (int retry = 0; retry < 5; retry++) {
            if (OpenClipboard(IntPtr.Zero)) {
                EmptyClipboard();
                byte[] bytes = Encoding.Unicode.GetBytes(text + "\0");
                IntPtr hGlobal = GlobalAlloc(0x0002, (UIntPtr)bytes.Length);
                IntPtr target = GlobalLock(hGlobal);
                Marshal.Copy(bytes, 0, target, bytes.Length);
                GlobalUnlock(hGlobal);
                SetClipboardData(CF_UNICODETEXT, hGlobal);
                CloseClipboard();
                return;
            }
            Thread.Sleep(50);
        }
    }

    static IntPtr MakeLParam(int x, int y) {
        return (IntPtr)(((y & 0xFFFF) << 16) | (x & 0xFFFF));
    }

    // 无鼠标窗口消息点击 (PostMessage)
    static bool PostMessageClick(IntPtr hWnd, int screenX, int screenY) {
        POINT pt = new POINT { X = screenX, Y = screenY };
        if (!ScreenToClient(hWnd, ref pt)) return false;
        IntPtr lParam = MakeLParam(pt.X, pt.Y);
        PostMessage(hWnd, WM_MOUSEMOVE, IntPtr.Zero, lParam);
        Thread.Sleep(20);
        PostMessage(hWnd, WM_LBUTTONDOWN, (IntPtr)MK_LBUTTON, lParam);
        Thread.Sleep(30);
        PostMessage(hWnd, WM_LBUTTONUP, IntPtr.Zero, lParam);
        return true;
    }

    // 物理鼠标点击兜底（点击后瞬时复原用户原光标位置）
    static void Click(int x, int y) {
        POINT orig;
        bool hasOrig = GetCursorPos(out orig);
        SetCursorPos(x, y);
        Thread.Sleep(40);
        mouse_event(MOUSEEVENTF_LEFTDOWN, 0, 0, 0, UIntPtr.Zero);
        Thread.Sleep(40);
        mouse_event(MOUSEEVENTF_LEFTUP, 0, 0, 0, UIntPtr.Zero);
        Thread.Sleep(30);
        if (hasOrig) {
            SetCursorPos(orig.X, orig.Y);
        }
    }

    static void SendKeyCombo(byte modVk, byte keyVk) {
        keybd_event(modVk, 0, 0, UIntPtr.Zero);
        keybd_event(keyVk, 0, 0, UIntPtr.Zero);
        Thread.Sleep(25);
        keybd_event(keyVk, 0, KEYEVENTF_KEYUP, UIntPtr.Zero);
        keybd_event(modVk, 0, KEYEVENTF_KEYUP, UIntPtr.Zero);
    }

    static void SendEnterKey() {
        keybd_event(VK_RETURN, 0, 0, UIntPtr.Zero);
        Thread.Sleep(40);
        keybd_event(VK_RETURN, 0, KEYEVENTF_KEYUP, UIntPtr.Zero);
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
        Thread.Sleep(150);

        // ====================================================
        // [步骤 2] 极速单次扫描标题栏，无鼠标优先展开搜索栏（失败自动降级物理点击）
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
        int winTop = winRect.IsEmpty ? 0 : (int)winRect.Top;

        OmniboxInfo omni;
        SearchBtnInfo searchBtn;
        ScanTopBarOnce(hVideoWin, winEl, winRect, winTop, out omni, out searchBtn);

        if (omni != null) {
            LogInfo("Step2", "搜索栏已处于展开就绪状态，跳过点击");
        } else {
            if (searchBtn == null) {
                errMsg = "未能通过结构特征定位到搜索按钮";
                errCode = CODE_SEARCH_BTN_NOT_FOUND;
                errCodeName = "SEARCH_BTN_NOT_FOUND";
                errStep = 2;
                errDetail = "标题栏未匹配到 UIA2 LocationBarView/最小化相邻元素，也未匹配到 MSAA 多标签栏搜索按钮";
                return false;
            }

            bool preferMsaa = searchBtn.MsaaEl != null;
            LogInfo("Step2", string.Format("定位到搜索按钮 [{0}]: Center=({1},{2})", searchBtn.Source, searchBtn.Cx, searchBtn.Cy));

            // 方案 2-1: 无障碍原生动作 (InvokePattern / accDoDefaultAction) [无鼠标]
            bool a11yTried = false;
            try {
                if (searchBtn.UiaEl != null) {
                    object pat;
                    if (searchBtn.UiaEl.TryGetCurrentPattern(InvokePattern.Pattern, out pat)) {
                        a11yTried = true;
                        ((InvokePattern)pat).Invoke();
                    }
                } else if (searchBtn.MsaaEl != null) {
                    a11yTried = true;
                    searchBtn.MsaaEl.accDoDefaultAction(0);
                }
            } catch {}

            if (a11yTried) {
                omni = WaitForOmnibox(hVideoWin, winEl, winRect, winTop, 50, 400, preferMsaa, searchBtn.MsaaEl);
                if (omni != null) {
                    LogInfo("Step2", "展开搜索栏成功 [A11Y无鼠标]");
                }
            }

            // 方案 2-2: PostMessage 窗口消息虚拟点击 [无鼠标]
            if (omni == null) {
                PostMessageClick(hVideoWin, searchBtn.Cx, searchBtn.Cy);
                omni = WaitForOmnibox(hVideoWin, winEl, winRect, winTop, 50, 500, preferMsaa, searchBtn.MsaaEl);
                if (omni != null) {
                    LogInfo("Step2", "展开搜索栏成功 [PostMessage无鼠标]");
                }
            }

            // 方案 2-3: 兜底 - 物理鼠标点击（含光标瞬时复原）
            if (omni == null) {
                LogInfo("Step2", string.Format("无鼠标方案未生效，降级物理点击兜底: Center=({0},{1})", searchBtn.Cx, searchBtn.Cy));
                Click(searchBtn.Cx, searchBtn.Cy);
                omni = WaitForOmnibox(hVideoWin, winEl, winRect, winTop, 50, 2500, preferMsaa, searchBtn.MsaaEl);
            }
        }

        // ====================================================
        // [步骤 3] 聚焦输入框，原生粘贴指定链接并回车（无鼠标优先 -> 物理点击兜底）
        // ====================================================
        if (omni == null) {
            omni = WaitForOmnibox(hVideoWin, winEl, winRect, winTop, 50, 1500, false, null);
        }

        if (omni == null) {
            errMsg = "未能在点击后捕获到展开的输入框 (OmniboxViewViews / MSAA 地址和搜索栏)";
            errCode = CODE_OMNIBOX_NOT_FOUND;
            errCodeName = "OMNIBOX_NOT_FOUND";
            errStep = 3;
            errDetail = "展开动画超时或输入框未渲染";
            return false;
        }

        LogInfo("Step3", string.Format("定位到输入框 [{0}]: Click=({1},{2})", omni.Source, omni.Cx, omni.Cy));
        string backupClip = BackupClipboardText();

        try {
            // 方案 3-1: PostMessage 虚拟点击聚焦 + 原生 Ctrl+A / Ctrl+V 粘贴 + 动态短轮询读回校验 + 单次回车 [无鼠标]
            PostMessageClick(hVideoWin, omni.Cx, omni.Cy);
            Thread.Sleep(50);
            SetClipboardText(targetUrl);
            SendKeyCombo(VK_CONTROL, VK_A);
            Thread.Sleep(20);
            SendKeyCombo(VK_CONTROL, VK_V);

            bool pasteVerified = false;
            Stopwatch pasteSw = Stopwatch.StartNew();
            while (pasteSw.ElapsedMilliseconds < 260) {
                Thread.Sleep(25);
                string actual = ReadOmniboxValue(omni);
                if (ValueMatchesTarget(actual, targetUrl)) {
                    pasteVerified = true;
                    break;
                }
            }

            if (pasteVerified) {
                LogInfo("Step3", "聚焦并粘贴目标链接成功 [PostMessage无鼠标]: " + targetUrl);
                SendEnterKey();
            } else {
                // 方案 3-2: 兜底 - 物理点击聚焦（含光标复原）+ 原生粘贴 + 单次回车
                LogWarn("Step3", "PostMessage 聚焦粘贴未通过读回校验，降级物理点击聚焦兜底...");
                Click(omni.Cx, omni.Cy);
                Thread.Sleep(60);
                SetClipboardText(targetUrl);
                SendKeyCombo(VK_CONTROL, VK_A);
                Thread.Sleep(25);
                SendKeyCombo(VK_CONTROL, VK_V);
                Thread.Sleep(150);
                LogInfo("Step3", "聚焦并粘贴目标链接成功 [物理点击兜底]: " + targetUrl);
                SendEnterKey();
            }
        } finally {
            if (backupClip != null) {
                Thread.Sleep(100);
                SetClipboardText(backupClip);
            }
        }

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
