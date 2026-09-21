package handlers

import (
	"net/http"
	"net/url"
	"strings"
	"time"

	json "github.com/json-iterator/go"
	"github.com/qtgolang/SunnyNet/SunnyNet"
	"wx_channel/internal/utils"
	"wx_channel/internal/websocket"
)

func (h *APIHandler) handleManualOpenLink(conn *SunnyNet.HttpConn, req websocket.DOMActionBody) {
	headers := http.Header{"Content-Type": {"application/json"}}
	h.setCORSHeadersFromConn(conn, headers)
	reject := func(message string) {
		data, _ := json.Marshal(map[string]interface{}{"success": false, "message": message})
		conn.StopRequest(200, string(data), headers)
	}
	link := strings.TrimSpace(req.URL)
	parsed, err := url.Parse(link)
	if err != nil || parsed.Scheme != "https" || parsed.Host != "channels.weixin.qq.com" || parsed.User != nil || req.TaskID != "" {
		reject("手动打开需要有效的视频号链接，不能携带任务编号")
		return
	}
	result, err := h.domActionHub.CallManualOpenLink(link, 10*time.Second)
	if err != nil {
		utils.LogWarn("[ManualOpenLink] 页面未确认收到打开指令: %v", err)
		reject("视频号页面未就绪或打开链接回执超时，请稍后重试")
		return
	}
	conn.StopRequest(200, string(result), headers)
}
