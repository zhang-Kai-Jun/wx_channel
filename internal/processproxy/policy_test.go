package processproxy

import "testing"

func TestSelectWeChatExcludesOtherApplications(t *testing.T) {
	appData := `C:\Users\test\AppData\Roaming`
	processes := []processInfo{
		{pid: 1, name: "Weixin.exe", image: `C:\Program Files\Tencent\Weixin\Weixin.exe`, created: 10},
		{pid: 2, parent: 1, name: "WeChatAppEx.exe", image: appData + `\Tencent\xwechat\xplugin\plugins\RadiumWMPF\WeChatAppEx.exe`, created: 11},
		{pid: 3, parent: 2, name: "WeChatAppEx.exe", image: processesRuntime(appData), created: 12},
		{pid: 4, name: "QQMusic.exe", image: `C:\QQMusic\QQMusic.exe`, created: 1},
		{pid: 5, parent: 4, name: "WeChatAppEx.exe", image: appData + `\Tencent\QQMusic\wmpf\runtime\WeChatAppEx.exe`, created: 13},
		// 即使父 PID 恰好匹配，也不能接管其他程序目录里的同名进程。
		{pid: 6, parent: 1, name: "WeChatAppEx.exe", image: appData + `\Tencent\QQMusic\wmpf\runtime\WeChatAppEx.exe`, created: 14},
		{pid: 7, parent: 4, name: "WeChatAppEx.exe", image: processesRuntime(appData), created: 15},
		{pid: 8, parent: 1, name: "WeChatAppEx.exe", image: processesRuntime(appData), created: 9},
		{pid: 9, parent: 1, name: "WeChatAppEx.exe", created: 16},
		{pid: 10, parent: 10, name: "WeChatAppEx.exe", image: processesRuntime(appData), created: 16},
		{pid: 11, name: "Weixin.exe", image: `C:\QQMusic\Weixin.exe`, created: 17},
		{pid: 12, parent: 1, name: "WeChatAppEx.exe", image: appData + `\Tencent\xwechat\xplugin-other\WeChatAppEx.exe`, created: 18},
	}
	selected := selectWeChat(processes, appData)
	for _, process := range processes {
		_, got := selected[process.pid]
		want := process.pid <= 3
		if got != want {
			t.Errorf("PID=%d selected=%v, want %v", process.pid, got, want)
		}
	}
}

func processesRuntime(appData string) string {
	return appData + `\Tencent\xwechat\xplugin\plugins\RadiumWMPF\WeChatAppEx.exe`
}

func TestSelectClassicWeChatAndCustomDrive(t *testing.T) {
	processes := []processInfo{
		{pid: 1, name: "WeChat.exe", image: `D:\Apps\WeChat\3.9.12.17\WeChat.exe`, created: 1},
		{pid: 2, parent: 1, name: "WeChatAppEx.exe", image: `D:\Apps\WeChat\3.9.12.17\Plugins\WeChatAppEx.exe`, created: 2},
	}
	if got := selectWeChat(processes, ""); len(got) != 2 {
		t.Fatalf("classic WeChat rejected: %v", got)
	}
}
