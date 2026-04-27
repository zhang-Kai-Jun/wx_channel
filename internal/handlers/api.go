package handlers

import (
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"wx_channel/internal/config"
	"wx_channel/internal/response"
	"wx_channel/internal/utils"
	"wx_channel/internal/websocket"

	json "github.com/json-iterator/go"
	"github.com/qtgolang/SunnyNet/SunnyNet"
)

// APIHandler API请求处理器
type APIHandler struct {
	cfg            *config.Config
	currentURL     string
	currentProfile map[string]interface{} // 存储当前视频的profile
	domActionHub   *websocket.Hub         // WebSocket Hub 引用，用于 DOM Action
}

// NewAPIHandler 创建API处理器
func NewAPIHandler(cfg *config.Config, hub *websocket.Hub) *APIHandler {
	return &APIHandler{
		cfg:          cfg,
		domActionHub: hub,
	}
}

// getConfig 获取当前配置
func (h *APIHandler) getConfig() *config.Config {
	if h.cfg != nil {
		return h.cfg
	}
	return config.Get()
}

// SetCurrentURL 设置当前页面URL
func (h *APIHandler) SetCurrentURL(url string) {
	h.currentURL = url
}

// GetCurrentURL 获取当前页面URL
func (h *APIHandler) GetCurrentURL() string {
	return h.currentURL
}

// Handle implements router.Interceptor
func (h *APIHandler) Handle(Conn *SunnyNet.HttpConn) bool {
	// CORS Preflight for all __wx_channels_api requests
	if Conn.Request == nil || Conn.Request.URL == nil {
		return false
	}

	// Add local panic recovery
	defer func() {
		if r := recover(); r != nil {
			utils.Error("APIHandler.Handle panic: %v", r)
		}
	}()

	path := Conn.Request.URL.Path

	// CORS 预检请求处理
	if strings.HasPrefix(path, "/__wx_channels_api/") && Conn.Request.Method == "OPTIONS" {
		h.handleCORS(Conn)
		return true
	}

	// DOM Action API - 集成到 wx_channel 主服务
	if strings.HasPrefix(path, "/__wx_channels_api/action") {
		h.HandleDOMAction(Conn)
		return true
	}

	// Health 检查 API
	if path == "/__wx_channels_api/health" {
		h.HandleDOMActionHealth(Conn)
		return true
	}

	// DOM Action HTTP 回调（inject 在 WebSocket 断开时通过此接口提交响应）
	if path == "/__wx_channels_api/response_callback" {
		h.HandleResponseCallback(Conn)
		return true
	}

	if h.HandleProfile(Conn) {
		return true
	}
	if h.HandleGetCurrentProfile(Conn) {
		return true
	}
	if h.HandleTip(Conn) {
		return true
	}
	if h.HandlePageURL(Conn) {
		// HandlePageURL updates state alongside returning true
		return true
	}
	if h.HandleSavePageContent(Conn) {
		return true
	}
	return false
}

// handleCORS 处理CORS预检请求
func (h *APIHandler) handleCORS(Conn *SunnyNet.HttpConn) {
	headers := http.Header{}
	headers.Set("Access-Control-Allow-Methods", "POST, OPTIONS")
	headers.Set("Access-Control-Allow-Headers", "Content-Type, X-Local-Auth")
	if h.getConfig() != nil && len(h.getConfig().AllowedOrigins) > 0 {
		origin := Conn.Request.Header.Get("Origin")
		for _, o := range h.getConfig().AllowedOrigins {
			if o == origin {
				headers.Set("Access-Control-Allow-Origin", origin)
				headers.Set("Vary", "Origin")
				break
			}
		}
	}
	Conn.StopRequest(204, "", headers)
}

// sendEmptyResponse 发送空JSON响应
func (h *APIHandler) sendEmptyResponse(Conn *SunnyNet.HttpConn) {
	headers := http.Header{}
	headers.Set("Content-Type", "application/json")
	if h.getConfig() != nil && len(h.getConfig().AllowedOrigins) > 0 {
		origin := Conn.Request.Header.Get("Origin")
		if origin != "" {
			for _, o := range h.getConfig().AllowedOrigins {
				if o == origin {
					headers.Set("Access-Control-Allow-Origin", origin)
					headers.Set("Vary", "Origin")
					break
				}
			}
		}
	}
	Conn.StopRequest(200, string(response.SuccessJSON(nil)), headers)
}

// sendErrorResponse 发送错误响应
func (h *APIHandler) sendErrorResponse(Conn *SunnyNet.HttpConn, err error) {
	headers := http.Header{}
	headers.Set("Content-Type", "application/json")
	headers.Set("X-Content-Type-Options", "nosniff")
	if h.getConfig() != nil && len(h.getConfig().AllowedOrigins) > 0 {
		origin := Conn.Request.Header.Get("Origin")
		if origin != "" {
			for _, o := range h.getConfig().AllowedOrigins {
				if o == origin {
					headers.Set("Access-Control-Allow-Origin", origin)
					headers.Set("Vary", "Origin")
					break
				}
			}
		}
	}
	// 记录错误但不中断流程（实际响应错误给客户端）
	utils.LogError("API Error: %v", err)
	Conn.StopRequest(500, string(response.ErrorJSON(500, err.Error())), headers)
}

// HandleDOMAction 处理 DOM 操作请求（POST /__wx_channels_api/action）
func (h *APIHandler) HandleDOMAction(Conn *SunnyNet.HttpConn) {
	path := Conn.Request.URL.Path
	if path != "/__wx_channels_api/action" {
		return
	}

	// 只允许 POST 请求
	if Conn.Request.Method != "POST" {
		headers := http.Header{}
		headers.Set("Content-Type", "application/json")
		h.setCORSHeadersFromConn(Conn, headers)
		Conn.StopRequest(405, string(response.ErrorJSON(405, "Method not allowed, use POST")), headers)
		return
	}

	// 如果 WebSocket Hub 不可用，返回服务不可用
	if h.domActionHub == nil {
		headers := http.Header{}
		headers.Set("Content-Type", "application/json")
		h.setCORSHeadersFromConn(Conn, headers)
		Conn.StopRequest(503, string(response.ErrorJSON(503, "DOM Action service not available")), headers)
		return
	}

	// 读取请求体
	body, err := io.ReadAll(Conn.Request.Body)
	if err != nil {
		h.sendErrorResponse(Conn, err)
		return
	}
	if err := Conn.Request.Body.Close(); err != nil {
		utils.HandleError(err, "关闭请求体")
	}

	// 解析请求
	var req struct {
		Action  string `json:"action"`
		Target  string `json:"target"`
		Content string `json:"content"`
		Index   int    `json:"index"`
		URL     string `json:"url"`
	}
	if err := json.Unmarshal(body, &req); err != nil {
		headers := http.Header{}
		headers.Set("Content-Type", "application/json")
		h.setCORSHeadersFromConn(Conn, headers)
		Conn.StopRequest(400, string(response.ErrorJSON(400, "Invalid request body: "+err.Error())), headers)
		return
	}

	if req.Action == "" {
		headers := http.Header{}
		headers.Set("Content-Type", "application/json")
		h.setCORSHeadersFromConn(Conn, headers)
		Conn.StopRequest(400, string(response.ErrorJSON(400, "action is required")), headers)
		return
	}

	// 默认 target
	if req.Target == "" {
		req.Target = "video"
	}

	// 记录日志
	utils.LogInfo("[DOMAction] action=%s, target=%s", req.Action, req.Target)

	// 通过 WebSocket 调用前端 DOM 操作 API
	domReq := websocket.DOMActionBody{
		Action:  req.Action,
		Target:  req.Target,
		Content: req.Content,
		Index:   req.Index,
		URL:     req.URL,
	}

	// 【关键修复】导航操作（open_profile / enter_video）触发页面跳转，
	// WebSocket 连接会断开，旧的 inject 客户端无法发送 WebSocket 响应。
	// 因此：启动 goroutine 在后台等待 WebSocket 响应，HTTP Handler 立即返回。
	isNavigationAction := req.Action == "open_profile" || req.Action == "enter_video"
	if isNavigationAction {
		go func() {
			utils.LogInfo("[DOMAction] 导航操作 %s 启动后台 CallAPI", req.Action)
			_, err := h.domActionHub.CallAPI("key:channels:dom_action", domReq, 60*time.Second)
			if err != nil {
				utils.LogError("[DOMAction] 导航操作 %s 后台 CallAPI 异常: %v", req.Action, err)
			} else {
				utils.LogInfo("[DOMAction] 导航操作 %s 后台 CallAPI 完成", req.Action)
			}
		}()
		// HTTP 立即返回，让 Electron 端快速拿到响应
		headers := http.Header{}
		headers.Set("Content-Type", "application/json")
		h.setCORSHeadersFromConn(Conn, headers)
		Conn.StopRequest(200, `{"success":true,"message":"navigating"}`, headers)
		return
	}

	// CallAPI 超时 30 秒，此处必须加 panic recovery，防止 Go 内部崩溃导致 SunnyNet 连接悬空
	// panic 会导致 SunnyNet 提前关闭 TCP，客户端收到 "SocketError: other side closed"
	var data []byte
	var callErr error
	func() {
		defer func() {
			if r := recover(); r != nil {
				callErr = fmt.Errorf("CallAPI panic: %v", r)
				utils.LogError("[DOMAction] CallAPI panic 恢复: %v", r)
			}
		}()
		data, callErr = h.domActionHub.CallAPI("key:channels:dom_action", domReq, 30*time.Second)
	}()

	if callErr != nil {
		if strings.Contains(callErr.Error(), "no available client") || strings.Contains(callErr.Error(), "no ready client") {
			headers := http.Header{}
			headers.Set("Content-Type", "application/json")
			h.setCORSHeadersFromConn(Conn, headers)
			Conn.StopRequest(503, string(response.ErrorJSON(503, "No ready WeChat page. Please open a supported page.")), headers)
			return
		}
		h.sendErrorResponse(Conn, callErr)
		return
	}

	// 返回结果
	headers := http.Header{}
	headers.Set("Content-Type", "application/json")
	h.setCORSHeadersFromConn(Conn, headers)

	var result interface{}
	if err := json.Unmarshal(data, &result); err != nil {
		Conn.StopRequest(200, string(data), headers)
		return
	}

	resultJSON, _ := json.Marshal(result)
	Conn.StopRequest(200, string(resultJSON), headers)
}

// HandleDOMActionHealth 健康检查（GET /__wx_channels_api/health）
func (h *APIHandler) HandleDOMActionHealth(Conn *SunnyNet.HttpConn) {
	path := Conn.Request.URL.Path
	if path != "/__wx_channels_api/health" {
		return
	}

	headers := http.Header{}
	headers.Set("Content-Type", "application/json")
	h.setCORSHeadersFromConn(Conn, headers)

	// 检查 WebSocket Hub 是否可用
	hubReady := h.domActionHub != nil
	clientCount := 0
	apiReady := false
	clientPagePath := ""
	if h.domActionHub != nil {
		clientCount = h.domActionHub.ClientCount()
		// 检查是否有已就绪的客户端（支持 DOM Action 的客户端）
		readyCount := h.domActionHub.ReadyClientCount("key:channels:dom_action")
		apiReady = readyCount > 0
		// 获取当前客户端的页面路径
		clientPagePath = h.domActionHub.GetClientPagePath()
	}

	result := map[string]interface{}{
		"success":        true,
		"status":         "healthy",
		"time":           time.Now().Unix(),
		"hub_ready":      hubReady,
		"clients":        clientCount,
		"clientCount":    clientCount,
		"apiReady":       apiReady,
		"clientPagePath": clientPagePath,
	}

	resultJSON, _ := json.Marshal(result)
	Conn.StopRequest(200, string(resultJSON), headers)
}

// HandleResponseCallback 处理 inject 的 HTTP 回调（sendResponseViaHTTP）
// inject 在 WebSocket 断开或需要提前响应时，通过此接口将响应提交给 Hub
// inject 发送的格式: POST /__wx_channels_api/response_callback
// Body: { "id": "123", "data": { "errCode": 0, "errMsg": "ok", "data": { actual_result } } }
func (h *APIHandler) HandleResponseCallback(Conn *SunnyNet.HttpConn) {
	path := Conn.Request.URL.Path
	if path != "/__wx_channels_api/response_callback" {
		return
	}

	// 只允许 POST
	if Conn.Request.Method != "POST" {
		headers := http.Header{}
		headers.Set("Content-Type", "application/json")
		h.setCORSHeadersFromConn(Conn, headers)
		Conn.StopRequest(405, string(response.ErrorJSON(405, "Method not allowed, use POST")), headers)
		return
	}

	// 检查 Hub 是否可用
	if h.domActionHub == nil {
		headers := http.Header{}
		headers.Set("Content-Type", "application/json")
		h.setCORSHeadersFromConn(Conn, headers)
		Conn.StopRequest(503, string(response.ErrorJSON(503, "DOM Action service not available")), headers)
		return
	}

	// 读取请求体
	body, err := io.ReadAll(Conn.Request.Body)
	if err != nil {
		h.sendErrorResponse(Conn, err)
		return
	}
	_ = Conn.Request.Body.Close()

	utils.LogInfo("[HandleResponseCallback] 收到回调: %s", string(body))

	// 解析回调负载
	// inject 发送的格式: { "id": "123", "data": { "errCode": 0, "errMsg": "ok", "data": {...} } }
	var payload struct {
		ID           string `json:"id"`
		InnerPayload *struct {
			ErrCode     int             `json:"errCode,omitempty"`
			ErrMsg      string          `json:"errMsg,omitempty"`
			InnerResult json.RawMessage `json:"data,omitempty"`
		} `json:"data,omitempty"`
		ErrCode     int             `json:"errCode,omitempty"`
		ErrMsg      string          `json:"errMsg,omitempty"`
		OuterResult json.RawMessage `json:"data,omitempty"`
	}

	if err := json.Unmarshal(body, &payload); err != nil {
		headers := http.Header{}
		headers.Set("Content-Type", "application/json")
		h.setCORSHeadersFromConn(Conn, headers)
		Conn.StopRequest(400, string(response.ErrorJSON(400, "Invalid callback payload: "+err.Error())), headers)
		return
	}

	if payload.ID == "" {
		headers := http.Header{}
		headers.Set("Content-Type", "application/json")
		h.setCORSHeadersFromConn(Conn, headers)
		Conn.StopRequest(400, string(response.ErrorJSON(400, "id is required")), headers)
		return
	}

	// 提取 errCode / errMsg / respData（可能在内层 data 里，也可能在外层）
	var errCode int
	var errMsg string
	var respData json.RawMessage

	if payload.InnerPayload != nil {
		errCode = payload.InnerPayload.ErrCode
		errMsg = payload.InnerPayload.ErrMsg
		respData = payload.InnerPayload.InnerResult
	} else {
		errCode = payload.ErrCode
		errMsg = payload.ErrMsg
		respData = payload.OuterResult
	}

	// 提交响应到 Hub 的 requests 通道
	h.domActionHub.SubmitResponseByPayload(payload.ID, errCode, errMsg, respData)

	// 返回 200 表示已收到
	headers := http.Header{}
	headers.Set("Content-Type", "application/json")
	h.setCORSHeadersFromConn(Conn, headers)
	Conn.StopRequest(200, `{"success":true}`, headers)
}

// setCORSHeadersFromConn 设置 CORS 头（从 SunnyNet 连接）
func (h *APIHandler) setCORSHeadersFromConn(Conn *SunnyNet.HttpConn, headers http.Header) {
	if h.getConfig() != nil && len(h.getConfig().AllowedOrigins) > 0 {
		origin := Conn.Request.Header.Get("Origin")
		if origin != "" {
			for _, o := range h.getConfig().AllowedOrigins {
				if o == origin {
					headers.Set("Access-Control-Allow-Origin", origin)
					headers.Set("Vary", "Origin")
					break
				}
			}
		}
	}
}
