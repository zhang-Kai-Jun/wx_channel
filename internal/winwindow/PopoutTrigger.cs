using System;
using System.Runtime.InteropServices;
using System.Windows.Automation;
using System.Text;
using System.Diagnostics;

public class NativePopoutTrigger {
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
    public static extern int GetClassName(IntPtr hWnd, StringBuilder className, int size);
    [DllImport("user32.dll")]
    public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
    [DllImport("user32.dll")]
    public static extern bool PostMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);

    static bool IsTargetButton(string name, string help, string className, string procName, string winClass) {
        name = (name ?? "").Trim();
        help = (help ?? "").Trim();
        className = (className ?? "").Trim();

        // 1. 完全相等匹配“独立窗口显示”或“獨立窗口顯示”
        if (name == "独立窗口显示" || help == "独立窗口显示" ||
            name == "獨立窗口顯示" || help == "獨立窗口顯示") {
            return true;
        }

        // 2. 微信内嵌视频号（Qt 窗口）：UIA 中按钮 Name 为“還原”/“还原”/“恢复”，Class 为 ImageButton
        // 注意：只在微信主进程宿主窗口 (Weixin / Qt) 内触发独立，切勿在独立后的弹出窗口 (WeChatAppEx / Chrome_WidgetWin) 内触发反向还原！
        bool isHostWindow = procName.Equals("Weixin", StringComparison.OrdinalIgnoreCase) ||
                            winClass.IndexOf("Qt5", StringComparison.OrdinalIgnoreCase) >= 0;

        if (isHostWindow && className == "ImageButton" && (name == "還原" || name == "恢复" || name == "还原")) {
            return true;
        }

        return false;
    }

    public static int Main(string[] args) {
        IntPtr hDefault = OpenDesktop("Default", 0, false, 0x01FF);
        if (hDefault != IntPtr.Zero) SetThreadDesktop(hDefault);

        int clicked = 0;
        EnumDesktopWindows(hDefault, (hWnd, lParam) => {
            if (!IsWindowVisible(hWnd)) return true;
            uint pid = 0;
            GetWindowThreadProcessId(hWnd, out pid);
            if (pid == 0) return true;

            string procName = "";
            try {
                procName = Process.GetProcessById((int)pid).ProcessName;
            } catch {}

            bool isWeChatProc = procName.Equals("Weixin", StringComparison.OrdinalIgnoreCase) ||
                               procName.Equals("WeChatAppEx", StringComparison.OrdinalIgnoreCase) ||
                               procName.Equals("WeChat", StringComparison.OrdinalIgnoreCase);

            if (!isWeChatProc) return true;

            StringBuilder sbC = new StringBuilder(256);
            GetClassName(hWnd, sbC, 256);
            string cls = sbC.ToString();

            try {
                var winEl = AutomationElement.FromHandle(hWnd);
                if (winEl == null) return true;

                // 仅精准匹配【独立窗口显示】目标按钮
                bool matched = false;

                // 1. 先快速检查 Button 控件
                var condBtn = new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Button);
                var allBtns = winEl.FindAll(TreeScope.Descendants, condBtn);
                for (int b = 0; b < allBtns.Count; b++) {
                    var btn = allBtns[b];
                    string name = btn.Current.Name;
                    string help = btn.Current.HelpText;
                    string bCls = btn.Current.ClassName;
                    if (IsTargetButton(name, help, bCls, procName, cls)) {
                        var pat = btn.GetCurrentPattern(InvokePattern.Pattern) as InvokePattern;
                        if (pat != null) {
                            pat.Invoke();
                            clicked++;
                            matched = true;
                            break;
                        } else {
                            var rect = btn.Current.BoundingRectangle;
                            if (rect.Width > 0 && rect.Height > 0) {
                                int cx = (int)(rect.Left + rect.Width / 2);
                                int cy = (int)(rect.Top + rect.Height / 2);
                                IntPtr lparam = (IntPtr)((cy << 16) | (cx & 0xFFFF));
                                PostMessage(hWnd, 0x0201, (IntPtr)1, lparam);
                                System.Threading.Thread.Sleep(30);
                                PostMessage(hWnd, 0x0202, IntPtr.Zero, lparam);
                                clicked++;
                                matched = true;
                                break;
                            }
                        }
                    }
                }

                // 2. 若 Button 控件未命中，且是 Chromium 窗口，则遍历所有控件匹配
                if (!matched) {
                    bool isChromium = procName.Equals("WeChatAppEx", StringComparison.OrdinalIgnoreCase) || cls.Contains("Chrome_WidgetWin");
                    if (isChromium) {
                        var allDesc = winEl.FindAll(TreeScope.Descendants, Condition.TrueCondition);
                        for (int i = 0; i < allDesc.Count; i++) {
                            var el = allDesc[i];
                            string name = el.Current.Name;
                            string help = el.Current.HelpText;
                            string elCls = el.Current.ClassName;
                            if (IsTargetButton(name, help, elCls, procName, cls)) {
                                var pat = el.GetCurrentPattern(InvokePattern.Pattern) as InvokePattern;
                                if (pat != null) {
                                    pat.Invoke();
                                    clicked++;
                                    break;
                                } else {
                                    var rect = el.Current.BoundingRectangle;
                                    if (rect.Width > 0 && rect.Height > 0) {
                                        int cx = (int)(rect.Left + rect.Width / 2);
                                        int cy = (int)(rect.Top + rect.Height / 2);
                                        IntPtr lparam = (IntPtr)((cy << 16) | (cx & 0xFFFF));
                                        PostMessage(hWnd, 0x0201, (IntPtr)1, lparam);
                                        System.Threading.Thread.Sleep(30);
                                        PostMessage(hWnd, 0x0202, IntPtr.Zero, lparam);
                                        clicked++;
                                        break;
                                    }
                                }
                            }
                        }
                    }
                }
            } catch {}
            return true;
        }, IntPtr.Zero);

        if (hDefault != IntPtr.Zero) CloseDesktop(hDefault);
        Console.Write(clicked);
        return 0;
    }
}
