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
    [DllImport("user32.dll")]
    public static extern bool GetCursorPos(out POINT lpPoint);
    [DllImport("user32.dll")]
    public static extern bool SetCursorPos(int X, int Y);
    [DllImport("user32.dll")]
    public static extern void mouse_event(uint dwFlags, int dx, int dy, uint dwData, UIntPtr dwExtraInfo);
    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr hWnd);

    [StructLayout(LayoutKind.Sequential)]
    public struct POINT { public int X; public int Y; }

    const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
    const uint MOUSEEVENTF_LEFTUP = 0x0004;

    static bool IsTargetButton(string name, string help, string className, string procName, string winClass) {
        name = (name ?? "").Trim();
        help = (help ?? "").Trim();
        className = (className ?? "").Trim();

        bool isHostWindow = procName.Equals("Weixin", StringComparison.OrdinalIgnoreCase) ||
                            procName.Equals("WeChat", StringComparison.OrdinalIgnoreCase) ||
                            winClass.IndexOf("Qt", StringComparison.OrdinalIgnoreCase) >= 0;

        // 仅匹配微信宿主窗口 (Qt) 右上角将侧边栏/创作者主页独立弹出的按钮：ImageButton，Name 为“恢复”/“还原”/“還原”
        bool isRestore = name == "恢复" || name == "还原" || name == "還原" ||
                         help == "恢复" || help == "还原" || help == "還原";

        if (isHostWindow && className == "ImageButton" && isRestore) {
            return true;
        }

        return false;
    }

    static void ClickElement(IntPtr hWnd, AutomationElement el) {
        var rect = el.Current.BoundingRectangle;
        if (rect.Width <= 0 || rect.Height <= 0) return;

        int cx = (int)(rect.Left + rect.Width / 2);
        int cy = (int)(rect.Top + rect.Height / 2);

        try {
            var pat = el.GetCurrentPattern(InvokePattern.Pattern) as InvokePattern;
            if (pat != null) pat.Invoke();
        } catch {}

        // Qt 宿主上的 ImageButton 依赖物理鼠标事件才能触发弹出
        POINT oldPos;
        bool hasOldPos = GetCursorPos(out oldPos);
        SetForegroundWindow(hWnd);
        System.Threading.Thread.Sleep(20);
        SetCursorPos(cx, cy);
        System.Threading.Thread.Sleep(20);
        mouse_event(MOUSEEVENTF_LEFTDOWN, 0, 0, 0, UIntPtr.Zero);
        System.Threading.Thread.Sleep(30);
        mouse_event(MOUSEEVENTF_LEFTUP, 0, 0, 0, UIntPtr.Zero);
        if (hasOldPos) {
            System.Threading.Thread.Sleep(20);
            SetCursorPos(oldPos.X, oldPos.Y);
        }
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

                bool matched = false;

                // 1. 优先检查 Button 控件
                var condBtn = new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Button);
                var allBtns = winEl.FindAll(TreeScope.Descendants, condBtn);
                for (int b = 0; b < allBtns.Count; b++) {
                    var btn = allBtns[b];
                    string name = btn.Current.Name;
                    string help = btn.Current.HelpText;
                    string bCls = btn.Current.ClassName;
                    if (IsTargetButton(name, help, bCls, procName, cls)) {
                        ClickElement(hWnd, btn);
                        clicked++;
                        matched = true;
                        break;
                    }
                }

                // 2. 若 Button 控件未命中，则遍历所有控件兜底
                if (!matched) {
                    var allDesc = winEl.FindAll(TreeScope.Descendants, Condition.TrueCondition);
                    for (int i = 0; i < allDesc.Count; i++) {
                        var el = allDesc[i];
                        string name = el.Current.Name;
                        string help = el.Current.HelpText;
                        string elCls = el.Current.ClassName;
                        if (IsTargetButton(name, help, elCls, procName, cls)) {
                            ClickElement(hWnd, el);
                            clicked++;
                            break;
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
