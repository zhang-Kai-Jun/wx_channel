package winwindow

import (
	"bytes"
	"context"
	_ "embed"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"wx_channel/internal/utils"
)

//go:embed popout_helper.exe
var embeddedPopoutHelper []byte

// AutoPopoutManager 负责在 Windows 后台全自动检测微信的“独立窗口显示”并执行点击
type AutoPopoutManager struct {
	mu         sync.Mutex
	running    bool
	cancel     context.CancelFunc
	helperPath string
}

var globalManager = &AutoPopoutManager{}

// StartAutoPopout 启动后台自动独立窗口监听
func StartAutoPopout() {
	globalManager.mu.Lock()
	defer globalManager.mu.Unlock()
	if globalManager.running {
		return
	}

	// 释放内嵌的独立窗口检测专用程序到 Temp 目录
	globalManager.helperPath = ensureHelperExtracted()

	ctx, cancel := context.WithCancel(context.Background())
	globalManager.cancel = cancel
	globalManager.running = true

	go globalManager.loop(ctx)
}

// StopAutoPopout 停止监听
func StopAutoPopout() {
	globalManager.mu.Lock()
	defer globalManager.mu.Unlock()
	if !globalManager.running {
		return
	}
	globalManager.cancel()
	globalManager.running = false
}

func ensureHelperExtracted() string {
	if len(embeddedPopoutHelper) == 0 {
		return ""
	}
	tempDir := os.TempDir()
	targetPath := filepath.Join(tempDir, "video_channel_popout_helper.exe")

	// 如果现有文件内容与嵌入二进制完全相同，直接复用
	if existing, err := os.ReadFile(targetPath); err == nil && bytes.Equal(existing, embeddedPopoutHelper) {
		return targetPath
	}

	// 写入或更新
	if err := os.WriteFile(targetPath, embeddedPopoutHelper, 0755); err != nil {
		// 若因占用无法写入，尝试带时间戳新文件
		altPath := filepath.Join(tempDir, "video_channel_popout_helper_"+strconv.FormatInt(time.Now().UnixNano(), 10)+".exe")
		if altErr := os.WriteFile(altPath, embeddedPopoutHelper, 0755); altErr == nil {
			return altPath
		}
		return ""
	}
	return targetPath
}

// powershellScript 作为后备通道，精准兼容【独立窗口显示】与【獨立窗口顯示】
const popoutPSScript = `
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName WindowsBase

$source = @"
using System;
using System.Runtime.InteropServices;
using System.Windows.Automation;
using System.Text;

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

    public static int Trigger() {
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
                procName = System.Diagnostics.Process.GetProcessById((int)pid).ProcessName;
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
                if (winEl != null) {
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
                }
            } catch {}
            return true;
        }, IntPtr.Zero);

        if (hDefault != IntPtr.Zero) CloseDesktop(hDefault);
        return clicked;
    }
}
"@

Add-Type -TypeDefinition $source -ReferencedAssemblies UIAutomationClient, UIAutomationTypes, WindowsBase
[NativePopoutTrigger]::Trigger()
`

func (m *AutoPopoutManager) loop(ctx context.Context) {
	ticker := time.NewTicker(1200 * time.Millisecond)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			m.trigger()
		}
	}
}

func (m *AutoPopoutManager) trigger() {
	// 优先通道：执行极速预编译原生 Native Helper
	if m.helperPath != "" {
		cmd := exec.Command(m.helperPath)
		cmd.SysProcAttr = &syscall.SysProcAttr{
			HideWindow: true,
		}
		out, _ := cmd.Output()
		trimmed := strings.TrimSpace(string(out))
		if cnt, parseErr := strconv.Atoi(trimmed); parseErr == nil && cnt > 0 {
			utils.LogInfo("🎯 [自动独立窗口] 成功检测并自动点击微信【独立窗口显示】按钮！")
			return
		}
		if len(trimmed) > 0 && trimmed[0] != '0' {
			utils.LogInfo("🎯 [自动独立窗口] 成功检测并自动点击微信【独立窗口显示】按钮！")
			return
		}
	}

	// 备选通道：PowerShell UIAutomation 执行
	cmd := exec.Command("powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", popoutPSScript)
	cmd.SysProcAttr = &syscall.SysProcAttr{
		HideWindow: true,
	}
	out, err := cmd.Output()
	if err != nil {
		return
	}
	res := strings.TrimSpace(string(out))
	if len(res) > 0 && res != "0" {
		utils.LogInfo("🎯 [自动独立窗口] 成功检测并自动点击微信【独立窗口显示】按钮！")
	}
}
