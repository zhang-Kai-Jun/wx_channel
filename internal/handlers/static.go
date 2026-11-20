package handlers

import (
	"net/http"
	"os"
	"strings"

	"wx_channel/internal/domainpolicy"
	"wx_channel/internal/utils"

	"github.com/qtgolang/SunnyNet/SunnyNet"
)

// StaticFileHandler 处理静态文件请求
type StaticFileHandler struct {
}

// NewStaticFileHandler 创建静态文件处理器
func NewStaticFileHandler() *StaticFileHandler {
	return &StaticFileHandler{}
}

// Handle implements router.Interceptor
func (h *StaticFileHandler) Handle(Conn *SunnyNet.HttpConn) bool {

	if Conn == nil || Conn.Request == nil || Conn.Request.URL == nil {
		return false
	}
	if !domainpolicy.IsLocalHost(domainpolicy.RequestHost(Conn.Request)) {
		return false
	}
	path := Conn.Request.URL.Path

	// 1. 处理控制台页面重定向/加载
	if path == "/console" || path == "/console/" {
		consoleHTML, err := os.ReadFile("web/console.html")
		if err != nil {
			utils.Warn("无法读取 web/console.html: %v", err)
			Conn.StopRequest(404, "Console not found", http.Header{})
			return true
		}
		headers := http.Header{}
		headers.Set("Content-Type", "text/html; charset=utf-8")
		Conn.StopRequest(200, string(consoleHTML), headers)
		return true
	}

	// 2. 检查是否为微信资源（排除）
	isWeixinResource := strings.Contains(path, "pic_blank.gif") ||
		strings.Contains(path, "we-emoji") ||
		strings.Contains(path, "Expression") ||
		strings.Contains(path, "auth_icon") ||
		strings.Contains(path, "weixin/checkresupdate") ||
		strings.Contains(path, "fed_upload") ||
		strings.HasPrefix(path, "/a/") ||
		strings.HasPrefix(path, "/weixin/")

	if isWeixinResource {
		return false
	}

	// 3. 处理静态资源文件
	if strings.HasPrefix(path, "/js/") || strings.HasPrefix(path, "/css/") || strings.HasPrefix(path, "/docs/") ||
		strings.HasSuffix(path, ".png") || strings.HasSuffix(path, ".jpg") ||
		strings.HasSuffix(path, ".jpeg") || strings.HasSuffix(path, ".gif") ||
		strings.HasSuffix(path, ".svg") || strings.HasSuffix(path, ".ico") ||
		strings.HasSuffix(path, ".md") {

		filePath := "web" + path
		content, err := os.ReadFile(filePath)
		if err != nil {
			// 此时不拦截，可能不是本地文件，交给后续处理或透传
			return false
		}

		headers := http.Header{}
		if strings.HasSuffix(path, ".js") {
			headers.Set("Content-Type", "application/javascript; charset=utf-8")
		} else if strings.HasSuffix(path, ".css") {
			headers.Set("Content-Type", "text/css; charset=utf-8")
		}
		// 可以添加更多MIME类型支持

		Conn.StopRequest(200, string(content), headers)
		return true
	}

	return false
}
