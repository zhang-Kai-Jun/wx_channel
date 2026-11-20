package domainpolicy

import (
	"net"
	"net/http"
	"strings"
)

// NormalizeHost 统一处理域名、带端口的地址及 IPv6 字面量。
func NormalizeHost(raw string) string {
	host := strings.TrimSpace(raw)
	if value, _, err := net.SplitHostPort(host); err == nil {
		host = value
	} else if strings.HasPrefix(host, "[") && strings.HasSuffix(host, "]") {
		host = strings.TrimSuffix(strings.TrimPrefix(host, "["), "]")
	}
	return strings.ToLower(strings.TrimSuffix(host, "."))
}

func RequestHost(req *http.Request) string {
	if req == nil {
		return ""
	}
	if req.URL != nil && req.URL.Host != "" {
		return NormalizeHost(req.URL.Host)
	}
	return NormalizeHost(req.Host)
}

func IsLocalHost(host string) bool {
	switch NormalizeHost(host) {
	case "127.0.0.1", "localhost", "::1":
		return true
	}
	return false
}

func IsChannelPageHost(host string) bool {
	switch NormalizeHost(host) {
	case "channels.weixin.qq.com", "weixin.qq.com":
		return true
	}
	return false
}

func IsTargetHost(host string) bool {
	return IsChannelPageHost(host) || NormalizeHost(host) == "res.wx.qq.com"
}

func AllowsChannelAPI(host string) bool {
	return IsLocalHost(host) || IsChannelPageHost(host)
}

func IsChannelPage(host, path string) bool {
	if !IsChannelPageHost(host) {
		return false
	}
	path = strings.TrimSuffix(path, "/")
	return path == "" || path == "/web/pages" || strings.HasPrefix(path, "/web/pages/") ||
		path == "/finder-preview" || strings.HasPrefix(path, "/finder-preview/") ||
		path == "/sph" || strings.HasPrefix(path, "/sph/")
}

func IsJavaScriptResource(host, path string) bool {
	if !strings.HasSuffix(strings.ToLower(path), ".js") {
		return false
	}
	return IsChannelPageHost(host) ||
		(NormalizeHost(host) == "res.wx.qq.com" && strings.HasPrefix(path, "/t/wx_fed/finder/"))
}

func MayRewrite(host, path string) bool {
	return IsChannelPage(host, path) || IsJavaScriptResource(host, path)
}
