package domainpolicy

import (
	"net/http"
	"net/url"
	"testing"
)

func TestHostPolicy(t *testing.T) {
	for _, scenario := range []struct {
		raw, normalized string
		local, target   bool
	}{
		{"LOCALHOST.:2025", "localhost", true, false},
		{"[::1]:2025", "::1", true, false},
		{"::1", "::1", true, false},
		{"127.0.0.1:2025", "127.0.0.1", true, false},
		{"CHANNELS.WEIXIN.QQ.COM.:443", "channels.weixin.qq.com", false, true},
		{"res.wx.qq.com", "res.wx.qq.com", false, true},
		{"evil-weixin.qq.com", "evil-weixin.qq.com", false, false},
		{"channels.weixin.qq.com.attacker.test", "channels.weixin.qq.com.attacker.test", false, false},
		{"localhost.attacker.test", "localhost.attacker.test", false, false},
		{"finder.video.qq.com", "finder.video.qq.com", false, false},
	} {
		if NormalizeHost(scenario.raw) != scenario.normalized || IsLocalHost(scenario.raw) != scenario.local || IsTargetHost(scenario.raw) != scenario.target {
			t.Errorf("unexpected policy: %+v", scenario)
		}
	}
}

func TestRequestHostUsesProxyDestination(t *testing.T) {
	if got := RequestHost(&http.Request{URL: &url.URL{Host: "www.tapd.cn"}, Host: "localhost:2025"}); got != "www.tapd.cn" {
		t.Fatal(got)
	}
	if got := RequestHost(&http.Request{URL: &url.URL{Path: "/api/health"}, Host: "[::1]:2025"}); got != "::1" {
		t.Fatal(got)
	}
}

func TestSharedCDNIsLimitedToFinderScripts(t *testing.T) {
	if !IsJavaScriptResource("res.wx.qq.com", "/t/wx_fed/finder/web/finder-preview/res/assets/feed.js") ||
		IsJavaScriptResource("res.wx.qq.com", "/other/app.js") ||
		IsChannelPage("channels.weixin.qq.com", "/web/pages-attacker") ||
		AllowsChannelAPI("res.wx.qq.com") {
		t.Fatal("resource boundary is incorrect")
	}
}
