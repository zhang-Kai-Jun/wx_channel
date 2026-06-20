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

	// 会话重置 API（切换用户前调用，清理所有 WebSocket 连接和 pending 请求）
	if path == "/__wx_channels_api/reset_session" {
		h.HandleResetSession(Conn)
		return true
	}

	// 清除导航客户端引用（导航完成后 JS 调用）
	if path == "/__wx_channels_api/clear_navigating" {
		h.HandleClearNavigating(Conn)
		return true
	}

	// 主动探测客户端（关闭页面后调用，触发 Hub 探测并清理死客户端）
	if path == "/__wx_channels_api/probe" {
		h.HandleProbe(Conn)
		return true
	}

	// 精准匹配任务结果回调
	if path == "/__wx_channels_api/matching_callback" {
		h.HandleMatchingCallback(Conn)
		return true
	}

	// 精准匹配任务进度回调
	if path == "/__wx_channels_api/matching_progress" {
		h.HandleMatchingProgress(Conn)
		return true
	}

	// 精准匹配任务结果轮询
	if path == "/__wx_channels_api/matching_result" {
		h.HandleGetMatchingResult(Conn)
		return true
	}

	// fetch_video_comments 评论采集结果回调（inject 采集完成后调用）
	if path == "/__wx_channels_api/fetch_comments_callback" {
		h.HandleFetchCommentsCallback(Conn)
		return true
	}

	// fetch_video_comments 评论采集结果轮询（Node.js 轮询获取）
	if path == "/__wx_channels_api/fetch_comments_result" {
		h.HandleGetFetchCommentsResult(Conn)
		return true
	}

	// 评论快照采集结果回调（inject 采集完成后调用）
	if path == "/__wx_channels_api/comment_snapshot_callback" {
		h.HandleCommentSnapshotCallback(Conn)
		return true
	}

	// 评论快照采集状态轮询（Node.js 轮询获取）
	if path == "/__wx_channels_api/comment_snapshot_status" {
		h.HandleGetCommentSnapshotStatus(Conn)
		return true
	}

	// 取消评论快照采集（任务停止时调用）
	if path == "/__wx_channels_api/cancel_snapshot" {
		h.HandleCancelSnapshot(Conn)
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
		TaskID  string `json:"task_id"`
		// 回复专用字段（用于 do_reply_comment_v2）
		ReplyContent string `json:"replyContent"`
		// 精准匹配专用字段
		TargetNum    int      `json:"target_num"`
		TriggerWords []string `json:"trigger_words"`
		IpFilter     string   `json:"ip_filter"`
		TimeFilter   *struct {
			Enabled bool   `json:"enabled"`
			Value   int    `json:"value"`
			Unit    string `json:"unit"`
		} `json:"time_filter"`
		BlockWords     []string `json:"block_words"`
		DedupUsernames []string `json:"dedup_usernames"`
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
		Action:        req.Action,
		Target:        req.Target,
		Content:       req.Content,
		Index:         req.Index,
		URL:           req.URL,
		TaskID:        req.TaskID,
		ReplyContent:  req.ReplyContent,
		TargetNum:     req.TargetNum,
		TriggerWords:  req.TriggerWords,
		IpFilter:      req.IpFilter,
		TimeFilter:    req.TimeFilter,
		BlockWords:    req.BlockWords,
		DedupUsernames: req.DedupUsernames,
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

	// 【fetch_video_comments 特殊处理】
	// inject 通过 HTTP POST /fetch_comments_callback 异步回调，不走 WebSocket 响应路径。
	// 因此 Go 发送指令后立即返回，Node.js 通过轮询 /fetch_comments_result 获取结果。
	if req.Action == "fetch_video_comments" {
		go func() {
			utils.LogInfo("[DOMAction] fetch_video_comments 启动后台 CallAPI, task_id=%s", req.TaskID)
			wsRespData, err := h.domActionHub.CallAPI("key:channels:dom_action", domReq, 30*time.Second)
			if err != nil {
				utils.LogError("[DOMAction] fetch_video_comments 后台 CallAPI 异常: %v", err)
				return
			}
			utils.LogInfo("[DOMAction] fetch_video_comments 后台 CallAPI 完成, task_id=%s", req.TaskID)

			// inject 通过 resp() 发来的 WebSocket 响应数据写入缓存
			// inject 发送: { success, result: { panel_ready, comment_count, has_more, items, last_comment_id, ... } }
			var wsResp struct {
				Success bool `json:"success"`
				Result  struct {
					PanelReady   bool        `json:"panel_ready"`
					Items        interface{} `json:"items"`
					Total        int         `json:"total"`
					CommentCount int         `json:"comment_count"`
					CurrentTotal int         `json:"current_total"`
					HasMore      bool        `json:"has_more"`
					Buffer       string      `json:"buffer"`
					RawItems     interface{} `json:"raw_items"`
					LastCommentId string     `json:"last_comment_id"`
				} `json:"result"`
			}
			if parseErr := json.Unmarshal(wsRespData, &wsResp); parseErr != nil {
				utils.LogError("[DOMAction] 解析 fetch_video_comments 响应失败: %v", parseErr)
				return
			}
			h.domActionHub.SetFetchCommentsResult(req.TaskID, &websocket.FetchCommentsData{
				Success:        wsResp.Success,
				PanelReady:     wsResp.Result.PanelReady,
				Items:          wsResp.Result.Items,
				Total:          wsResp.Result.Total,
				CommentCount:   wsResp.Result.CommentCount,
				CurrentTotal:   wsResp.Result.CurrentTotal,
				HasMore:        wsResp.Result.HasMore,
				Buffer:         wsResp.Result.Buffer,
				RawItems:       wsResp.Result.RawItems,
				ReceivedAt:     time.Now().Unix(),
			})
			utils.LogInfo("[DOMAction] 评论数据已写入缓存: task_id=%s, panel_ready=%v, comment_count=%d",
				req.TaskID, wsResp.Result.PanelReady, wsResp.Result.CommentCount)
		}()
		// HTTP 立即返回，让 Node.js 开始轮询
		headers := http.Header{}
		headers.Set("Content-Type", "application/json")
		h.setCORSHeadersFromConn(Conn, headers)
		Conn.StopRequest(200, `{"success":true,"message":"fetch_video_comments sent"}`, headers)
		return
	}

	// 【open_comment_panel】打开评论区面板（通过 WebSocket 广播指令）
	// 使用 domActionHub（浏览器-facing Hub），而非 wsHub（旧版 dashboard Hub）
	if req.Action == "open_comment_panel" {
		if h.domActionHub != nil {
			if err := h.domActionHub.BroadcastCommand("open_comment_panel", nil); err != nil {
				utils.LogError("[DOMAction] open_comment_panel 广播失败: %v", err)
				h.sendErrorResponse(Conn, fmt.Errorf("broadcast failed: %v", err))
				return
			}
		}
		headers := http.Header{}
		headers.Set("Content-Type", "application/json")
		h.setCORSHeadersFromConn(Conn, headers)
		Conn.StopRequest(200, `{"success":true}`, headers)
		return
	}

	// 【trigger_comment_snapshot】触发评论采集 + 快照
	// 完整流程（通过浏览器-facing Hub 广播，Node.js 端轮询等待）：
	//   Step1: 广播 start_comment_collection → 浏览器打开评论区 + 展开评论 + 采集完成后自动保存快照
	// goroutine 避免阻塞 HTTP 连接；Node.js 通过轮询 comment_snapshot_status 等待采集完成
	if req.Action == "trigger_comment_snapshot" {
		// 捕获关键值，避免 goroutine 引用 Conn
		taskID := req.TaskID
		domActionHub := h.domActionHub

		// 初始化采集状态，供 Node.js 轮询
		if domActionHub != nil && taskID != "" {
			domActionHub.SetCommentSnapshotStatus(taskID, &websocket.CommentSnapshotStatus{
				Done:         false,
				Success:      false,
				TotalCount:   0,
				LoadedCount:  0,
				SnapshotPath: "",
				Message:      "采集开始",
				UpdatedAt:    time.Now().Unix(),
			})
		}

		// goroutine 在后台广播，不阻塞 HTTP
		go func() {
			if domActionHub != nil {
				// 广播 start_comment_collection（携带 taskID）
				// 浏览器内部：打开评论区 → 循环加载 → 监听 ✅ 评论采集完成 → 调用 dumpAllPiniaStores 保存快照
				if err := domActionHub.BroadcastCommand("start_comment_collection", map[string]interface{}{
					"task_id": taskID,
				}); err != nil {
					utils.LogError("[DOMAction] 广播 start_comment_collection 失败: %v", err)
				} else {
					utils.LogInfo("[DOMAction] 已广播 start_comment_collection (taskID=%s)，等待浏览器采集完成...", taskID)
				}
			}
		}()

		// HTTP 立即返回，Node.js 通过轮询 comment_snapshot_status 等待采集完成
		headers := http.Header{}
		headers.Set("Content-Type", "application/json")
		h.setCORSHeadersFromConn(Conn, headers)
		Conn.StopRequest(200, `{"success":true}`, headers)
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
	navigatingClientPagePath := ""
	if h.domActionHub != nil {
		clientCount = h.domActionHub.ClientCount()
		// 检查是否有已就绪的客户端（支持 DOM Action 的客户端）
		readyCount := h.domActionHub.ReadyClientCount("key:channels:dom_action")
		apiReady = readyCount > 0
		// 获取当前客户端的页面路径
		clientPagePath = h.domActionHub.GetClientPagePath()
		// 获取正在执行导航的客户端的页面路径
		navigatingClientPagePath = h.domActionHub.GetNavigatingClientPagePath()
	}

	result := map[string]interface{}{
		"success":                  true,
		"status":                   "healthy",
		"time":                     time.Now().Unix(),
		"hub_ready":                hubReady,
		"clients":                  clientCount,
		"clientCount":              clientCount,
		"apiReady":                 apiReady,
		"clientPagePath":           clientPagePath,
		"navigatingClientPagePath": navigatingClientPagePath,
		"clientStatuses":           h.domActionHub.ClientStatuses(),
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

// HandleResetSession 会话重置接口（POST /__wx_channels_api/reset_session）
// 在切换用户前调用，关闭所有 WebSocket 连接并清理 Hub 状态
// 确保下一个用户的操作不会受到前一个用户残留连接的影响
func (h *APIHandler) HandleResetSession(Conn *SunnyNet.HttpConn) {
	path := Conn.Request.URL.Path
	if path != "/__wx_channels_api/reset_session" {
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

	utils.LogInfo("[HandleResetSession] 开始重置会话...")

	// 执行完整的 Hub 重置
	h.domActionHub.ResetSession()

	// 返回成功
	headers := http.Header{}
	headers.Set("Content-Type", "application/json")
	h.setCORSHeadersFromConn(Conn, headers)
	Conn.StopRequest(200, `{"success":true,"message":"session reset"}`, headers)
}

// HandleClearNavigating 清除导航客户端引用（POST /__wx_channels_api/clear_navigating）
// 导航完成后（inject 已上报新 pagePath），JS 调用此接口清除 navigatingClient
func (h *APIHandler) HandleClearNavigating(Conn *SunnyNet.HttpConn) {
	path := Conn.Request.URL.Path
	if path != "/__wx_channels_api/clear_navigating" {
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

	h.domActionHub.ClearNavigatingClient()

	headers := http.Header{}
	headers.Set("Content-Type", "application/json")
	h.setCORSHeadersFromConn(Conn, headers)
	Conn.StopRequest(200, `{"success":true}`, headers)
}

// HandleProbe 主动探测客户端（POST /__wx_channels_api/probe）
// 关闭页面后调用，触发 Hub 向所有客户端发送 ping
// 死客户端会在发送失败后被清理，活客户端会回复 pong
func (h *APIHandler) HandleProbe(Conn *SunnyNet.HttpConn) {
	path := Conn.Request.URL.Path
	if path != "/__wx_channels_api/probe" {
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

	utils.LogInfo("[HandleProbe] 主动探测所有客户端...")
	sentCount := h.domActionHub.ProbeAllClients()

	headers := http.Header{}
	headers.Set("Content-Type", "application/json")
	h.setCORSHeadersFromConn(Conn, headers)
	Conn.StopRequest(200, fmt.Sprintf(`{"success":true,"probed":%d}`, sentCount), headers)
}

// HandleMatchingCallback 处理精准匹配任务的结果回调（inject 采集完成后调用）
// POST /__wx_channels_api/matching_callback
// Body: { "task_id": "xxx", "success": true, "reason": "target_reached", "users": [...], "total": 5, "target_num": 10, "comment_count": 200 }
func (h *APIHandler) HandleMatchingCallback(Conn *SunnyNet.HttpConn) {
	path := Conn.Request.URL.Path
	if path != "/__wx_channels_api/matching_callback" {
		return
	}

	if Conn.Request.Method != "POST" {
		headers := http.Header{}
		headers.Set("Content-Type", "application/json")
		h.setCORSHeadersFromConn(Conn, headers)
		Conn.StopRequest(405, string(response.ErrorJSON(405, "Method not allowed, use POST")), headers)
		return
	}

	if h.domActionHub == nil {
		headers := http.Header{}
		headers.Set("Content-Type", "application/json")
		h.setCORSHeadersFromConn(Conn, headers)
		Conn.StopRequest(503, string(response.ErrorJSON(503, "DOM Action service not available")), headers)
		return
	}

	body, err := io.ReadAll(Conn.Request.Body)
	if err != nil {
		h.sendErrorResponse(Conn, err)
		return
	}
	_ = Conn.Request.Body.Close()

	var payload struct {
		TaskID       string        `json:"task_id"`
		Success      bool          `json:"success"`
		Reason       string        `json:"reason"`
		Users        []interface{} `json:"users"`
		Total        int           `json:"total"`
		TargetNum    int           `json:"target_num"`
		CommentCount int           `json:"comment_count"`
	}
	if err := json.Unmarshal(body, &payload); err != nil {
		h.sendErrorResponse(Conn, err)
		return
	}

	if payload.TaskID == "" {
		headers := http.Header{}
		headers.Set("Content-Type", "application/json")
		h.setCORSHeadersFromConn(Conn, headers)
		Conn.StopRequest(400, string(response.ErrorJSON(400, "task_id is required")), headers)
		return
	}

	// 存储到 Hub 的匹配结果缓存
	h.domActionHub.SetMatchingResult(payload.TaskID, map[string]interface{}{
		"success":       payload.Success,
		"reason":        payload.Reason,
		"users":         payload.Users,
		"total":         payload.Total,
		"target_num":    payload.TargetNum,
		"comment_count": payload.CommentCount,
		"timestamp":     time.Now().Unix(),
	})

	utils.LogInfo("[MatchingCallback] 收到匹配结果: task_id=%s, success=%v, total=%d, reason=%s",
		payload.TaskID, payload.Success, payload.Total, payload.Reason)

	headers := http.Header{}
	headers.Set("Content-Type", "application/json")
	h.setCORSHeadersFromConn(Conn, headers)
	Conn.StopRequest(200, `{"success":true}`, headers)
}

// HandleMatchingProgress 处理精准匹配任务的进度回调（inject 采集过程中调用）
// POST /__wx_channels_api/matching_progress
// Body: { "task_id": "xxx", "comment_count": 100, "user_count": 5, "target_num": 10, "percent": 50 }
func (h *APIHandler) HandleMatchingProgress(Conn *SunnyNet.HttpConn) {
	path := Conn.Request.URL.Path
	if path != "/__wx_channels_api/matching_progress" {
		return
	}

	if Conn.Request.Method != "POST" {
		headers := http.Header{}
		headers.Set("Content-Type", "application/json")
		h.setCORSHeadersFromConn(Conn, headers)
		Conn.StopRequest(405, string(response.ErrorJSON(405, "Method not allowed, use POST")), headers)
		return
	}

	if h.domActionHub == nil {
		headers := http.Header{}
		headers.Set("Content-Type", "application/json")
		h.setCORSHeadersFromConn(Conn, headers)
		Conn.StopRequest(503, string(response.ErrorJSON(503, "DOM Action service not available")), headers)
		return
	}

	body, err := io.ReadAll(Conn.Request.Body)
	if err != nil {
		h.sendErrorResponse(Conn, err)
		return
	}
	_ = Conn.Request.Body.Close()

	var payload struct {
		TaskID       string `json:"task_id"`
		CommentCount int    `json:"comment_count"`
		UserCount    int    `json:"user_count"`
		TargetNum    int    `json:"target_num"`
		Percent      int    `json:"percent"`
	}
	if err := json.Unmarshal(body, &payload); err != nil {
		h.sendErrorResponse(Conn, err)
		return
	}

	if payload.TaskID == "" {
		return
	}

	// 更新 Hub 的匹配进度缓存
	h.domActionHub.SetMatchingProgress(payload.TaskID, map[string]interface{}{
		"comment_count": payload.CommentCount,
		"user_count":    payload.UserCount,
		"target_num":    payload.TargetNum,
		"percent":       payload.Percent,
		"timestamp":     time.Now().Unix(),
	})

	headers := http.Header{}
	headers.Set("Content-Type", "application/json")
	h.setCORSHeadersFromConn(Conn, headers)
	Conn.StopRequest(200, `{"success":true}`, headers)
}

// HandleGetMatchingResult 获取精准匹配任务的结果（Node.js 轮询）
// GET /__wx_channels_api/matching_result?task_id=xxx
func (h *APIHandler) HandleGetMatchingResult(Conn *SunnyNet.HttpConn) {
	path := Conn.Request.URL.Path
	if path != "/__wx_channels_api/matching_result" {
		return
	}

	if Conn.Request.Method != "GET" {
		headers := http.Header{}
		headers.Set("Content-Type", "application/json")
		h.setCORSHeadersFromConn(Conn, headers)
		Conn.StopRequest(405, string(response.ErrorJSON(405, "Method not allowed, use GET")), headers)
		return
	}

	if h.domActionHub == nil {
		headers := http.Header{}
		headers.Set("Content-Type", "application/json")
		h.setCORSHeadersFromConn(Conn, headers)
		Conn.StopRequest(503, string(response.ErrorJSON(503, "DOM Action service not available")), headers)
		return
	}

	taskID := Conn.Request.URL.Query().Get("task_id")
	if taskID == "" {
		headers := http.Header{}
		headers.Set("Content-Type", "application/json")
		h.setCORSHeadersFromConn(Conn, headers)
		Conn.StopRequest(400, string(response.ErrorJSON(400, "task_id is required")), headers)
		return
	}

	result := h.domActionHub.GetMatchingResult(taskID)
	progress := h.domActionHub.GetMatchingProgress(taskID)

	headers := http.Header{}
	headers.Set("Content-Type", "application/json")
	h.setCORSHeadersFromConn(Conn, headers)

	responseData := map[string]interface{}{
		"done":     result != nil,
		"result":   result,
		"progress": progress,
	}
	dataJSON, _ := json.Marshal(responseData)
	Conn.StopRequest(200, string(dataJSON), headers)
}

// HandleFetchCommentsCallback 处理 fetch_video_comments 的结果回调（inject 采集完成后调用）
// POST /__wx_channels_api/fetch_comments_callback
// Body: { "task_id": "xxx", "success": true, "message": "ok", "result": { panel_ready, items, total, comment_count, has_more, buffer, raw_items } }
func (h *APIHandler) HandleFetchCommentsCallback(Conn *SunnyNet.HttpConn) {
	path := Conn.Request.URL.Path
	if path != "/__wx_channels_api/fetch_comments_callback" {
		return
	}

	if Conn.Request.Method != "POST" {
		headers := http.Header{}
		headers.Set("Content-Type", "application/json")
		h.setCORSHeadersFromConn(Conn, headers)
		Conn.StopRequest(405, string(response.ErrorJSON(405, "Method not allowed, use POST")), headers)
		return
	}

	if h.domActionHub == nil {
		headers := http.Header{}
		headers.Set("Content-Type", "application/json")
		h.setCORSHeadersFromConn(Conn, headers)
		Conn.StopRequest(503, string(response.ErrorJSON(503, "DOM Action service not available")), headers)
		return
	}

	body, err := io.ReadAll(Conn.Request.Body)
	if err != nil {
		h.sendErrorResponse(Conn, err)
		return
	}
	_ = Conn.Request.Body.Close()

	var payload struct {
		TaskID  string `json:"task_id"`
		Success bool   `json:"success"`
		Message string `json:"message"`
		Result  struct {
			PanelReady    bool        `json:"panel_ready"`
			Items         interface{} `json:"items"`
			Total         int         `json:"total"`
			CommentCount  int         `json:"comment_count"`
			CurrentTotal  int         `json:"current_total"`
			HasMore       bool        `json:"has_more"`
			Buffer        string      `json:"buffer"`
			RawItems      interface{} `json:"raw_items"`
			LastCommentId string      `json:"last_comment_id"`
		} `json:"result"`
	}
	if err := json.Unmarshal(body, &payload); err != nil {
		h.sendErrorResponse(Conn, err)
		return
	}

	if payload.TaskID == "" {
		headers := http.Header{}
		headers.Set("Content-Type", "application/json")
		h.setCORSHeadersFromConn(Conn, headers)
		Conn.StopRequest(400, string(response.ErrorJSON(400, "task_id is required")), headers)
		return
	}

	// 存储到 Hub 的缓存
	h.domActionHub.SetFetchCommentsResult(payload.TaskID, &websocket.FetchCommentsData{
		Success:       payload.Success,
		Message:       payload.Message,
		PanelReady:    payload.Result.PanelReady,
		Items:         payload.Result.Items,
		Total:         payload.Result.Total,
		CommentCount:  payload.Result.CommentCount,
		CurrentTotal:  payload.Result.CurrentTotal,
		HasMore:       payload.Result.HasMore,
		Buffer:        payload.Result.Buffer,
		RawItems:      payload.Result.RawItems,
		ReceivedAt:    time.Now().Unix(),
	})

	utils.LogInfo("[FetchCommentsCallback] 收到评论采集结果: task_id=%s, success=%v, panel_ready=%v, comment_count=%d",
		payload.TaskID, payload.Success, payload.Result.PanelReady, payload.Result.CommentCount)

	headers := http.Header{}
	headers.Set("Content-Type", "application/json")
	h.setCORSHeadersFromConn(Conn, headers)
	Conn.StopRequest(200, `{"success":true}`, headers)
}

// HandleGetFetchCommentsResult 获取 fetch_video_comments 的结果（Node.js 轮询）
// GET /__wx_channels_api/fetch_comments_result?task_id=xxx
func (h *APIHandler) HandleGetFetchCommentsResult(Conn *SunnyNet.HttpConn) {
	path := Conn.Request.URL.Path
	if path != "/__wx_channels_api/fetch_comments_result" {
		return
	}

	if Conn.Request.Method != "GET" {
		headers := http.Header{}
		headers.Set("Content-Type", "application/json")
		h.setCORSHeadersFromConn(Conn, headers)
		Conn.StopRequest(405, string(response.ErrorJSON(405, "Method not allowed, use GET")), headers)
		return
	}

	if h.domActionHub == nil {
		headers := http.Header{}
		headers.Set("Content-Type", "application/json")
		h.setCORSHeadersFromConn(Conn, headers)
		Conn.StopRequest(503, string(response.ErrorJSON(503, "DOM Action service not available")), headers)
		return
	}

	taskID := Conn.Request.URL.Query().Get("task_id")
	if taskID == "" {
		headers := http.Header{}
		headers.Set("Content-Type", "application/json")
		h.setCORSHeadersFromConn(Conn, headers)
		Conn.StopRequest(400, string(response.ErrorJSON(400, "task_id is required")), headers)
		return
	}

	result := h.domActionHub.GetFetchCommentsResult(taskID)

	headers := http.Header{}
	headers.Set("Content-Type", "application/json")
	h.setCORSHeadersFromConn(Conn, headers)

	var responseData map[string]interface{}
	if result != nil {
		responseData = map[string]interface{}{
			"success":        result.Success,
			"message":        result.Message,
			"panel_ready":    result.PanelReady,
			"items":          result.Items,
			"total":          result.Total,
			"comment_count":  result.CommentCount,
			"current_total":  result.CurrentTotal,
			"has_more":       result.HasMore,
			"buffer":         result.Buffer,
			"raw_items":      result.RawItems,
		}
	} else {
		responseData = map[string]interface{}{
			"success": false,
		}
	}

	dataJSON, _ := json.Marshal(responseData)
	Conn.StopRequest(200, string(dataJSON), headers)
}

// HandleCommentSnapshotCallback 处理评论快照采集结果回调（inject 采集完成后调用）
// POST /__wx_channels_api/comment_snapshot_callback
// Body: { "task_id": "xxx", "done": true, "success": true, "total_count": 100, "loaded_count": 50, "snapshot_path": "...", "message": "ok", "error": "" }
func (h *APIHandler) HandleCommentSnapshotCallback(Conn *SunnyNet.HttpConn) {
	path := Conn.Request.URL.Path
	if path != "/__wx_channels_api/comment_snapshot_callback" {
		return
	}

	if Conn.Request.Method != "POST" {
		headers := http.Header{}
		headers.Set("Content-Type", "application/json")
		h.setCORSHeadersFromConn(Conn, headers)
		Conn.StopRequest(405, string(response.ErrorJSON(405, "Method not allowed, use POST")), headers)
		return
	}

	if h.domActionHub == nil {
		headers := http.Header{}
		headers.Set("Content-Type", "application/json")
		h.setCORSHeadersFromConn(Conn, headers)
		Conn.StopRequest(503, string(response.ErrorJSON(503, "DOM Action service not available")), headers)
		return
	}

	body, err := io.ReadAll(Conn.Request.Body)
	if err != nil {
		h.sendErrorResponse(Conn, err)
		return
	}
	_ = Conn.Request.Body.Close()

	var payload struct {
		TaskID       string `json:"task_id"`
		Done         bool   `json:"done"`
		Success      bool   `json:"success"`
		TotalCount   int    `json:"total_count"`
		LoadedCount  int    `json:"loaded_count"`
		SnapshotPath string `json:"snapshot_path"`
		Message      string `json:"message"`
		Error        string `json:"error"`
	}
	if err := json.Unmarshal(body, &payload); err != nil {
		h.sendErrorResponse(Conn, err)
		return
	}

	if payload.TaskID == "" {
		headers := http.Header{}
		headers.Set("Content-Type", "application/json")
		h.setCORSHeadersFromConn(Conn, headers)
		Conn.StopRequest(400, string(response.ErrorJSON(400, "task_id is required")), headers)
		return
	}

	// 写入 Hub 缓存
	h.domActionHub.SetCommentSnapshotStatus(payload.TaskID, &websocket.CommentSnapshotStatus{
		Done:         payload.Done,
		Success:      payload.Success,
		TotalCount:   payload.TotalCount,
		LoadedCount:  payload.LoadedCount,
		SnapshotPath: payload.SnapshotPath,
		Message:      payload.Message,
		Error:        payload.Error,
		UpdatedAt:    time.Now().Unix(),
	})

	utils.LogInfo("[CommentSnapshotCallback] 收到快照状态: task_id=%s, done=%v, success=%v, total=%d, loaded=%d, path=%s",
		payload.TaskID, payload.Done, payload.Success, payload.TotalCount, payload.LoadedCount, payload.SnapshotPath)

	headers := http.Header{}
	headers.Set("Content-Type", "application/json")
	h.setCORSHeadersFromConn(Conn, headers)
	Conn.StopRequest(200, `{"success":true}`, headers)
}

// HandleGetCommentSnapshotStatus 获取评论快照采集状态（Node.js 轮询）
// GET /__wx_channels_api/comment_snapshot_status?task_id=xxx
func (h *APIHandler) HandleGetCommentSnapshotStatus(Conn *SunnyNet.HttpConn) {
	path := Conn.Request.URL.Path
	if path != "/__wx_channels_api/comment_snapshot_status" {
		return
	}

	if Conn.Request.Method != "GET" {
		headers := http.Header{}
		headers.Set("Content-Type", "application/json")
		h.setCORSHeadersFromConn(Conn, headers)
		Conn.StopRequest(405, string(response.ErrorJSON(405, "Method not allowed, use GET")), headers)
		return
	}

	taskID := Conn.Request.URL.Query().Get("task_id")
	if taskID == "" {
		headers := http.Header{}
		headers.Set("Content-Type", "application/json")
		h.setCORSHeadersFromConn(Conn, headers)
		Conn.StopRequest(400, string(response.ErrorJSON(400, "task_id is required")), headers)
		return
	}

	result := h.domActionHub.GetCommentSnapshotStatus(taskID)

	headers := http.Header{}
	headers.Set("Content-Type", "application/json")
	h.setCORSHeadersFromConn(Conn, headers)

	var responseData map[string]interface{}
	if result != nil {
		responseData = map[string]interface{}{
			"done":          result.Done,
			"success":       result.Success,
			"total_count":   result.TotalCount,
			"loaded_count":  result.LoadedCount,
			"snapshot_path": result.SnapshotPath,
			"message":       result.Message,
			"error":         result.Error,
		}
	} else {
		// 尚未收到状态，视为进行中
		responseData = map[string]interface{}{
			"done":    false,
			"success": false,
			"message": "采集进行中",
		}
	}

	dataJSON, _ := json.Marshal(responseData)
	Conn.StopRequest(200, string(dataJSON), headers)
}

// HandleCancelSnapshot 取消指定 missionId 的所有评论快照采集任务
// POST /__wx_channels_api/cancel_snapshot
// Body: { "mission_id": "13095" }
func (h *APIHandler) HandleCancelSnapshot(Conn *SunnyNet.HttpConn) {
	path := Conn.Request.URL.Path
	if path != "/__wx_channels_api/cancel_snapshot" {
		return
	}

	if Conn.Request.Method != "POST" {
		headers := http.Header{}
		headers.Set("Content-Type", "application/json")
		h.setCORSHeadersFromConn(Conn, headers)
		Conn.StopRequest(405, string(response.ErrorJSON(405, "Method not allowed, use POST")), headers)
		return
	}

	body, err := io.ReadAll(Conn.Request.Body)
	if err != nil {
		h.sendErrorResponse(Conn, err)
		return
	}
	_ = Conn.Request.Body.Close()

	var payload struct {
		MissionID string `json:"mission_id"`
		TaskID    string `json:"task_id"` // 可选：只取消单个任务
	}
	if err := json.Unmarshal(body, &payload); err != nil {
		h.sendErrorResponse(Conn, err)
		return
	}

	if payload.MissionID == "" && payload.TaskID == "" {
		headers := http.Header{}
		headers.Set("Content-Type", "application/json")
		h.setCORSHeadersFromConn(Conn, headers)
		Conn.StopRequest(400, string(response.ErrorJSON(400, "mission_id or task_id is required")), headers)
		return
	}

	// 取消采集并广播
	if payload.TaskID != "" {
		// 只取消单个任务
		h.domActionHub.CancelCommentSnapshot(payload.TaskID)
		h.domActionHub.BroadcastCancelSnapshot(payload.TaskID)
		utils.LogInfo("[HandleCancelSnapshot] 取消单个采集任务: taskId=%s", payload.TaskID)
	} else {
		// 取消该 mission 的所有采集任务
		// 1. 先标记 Hub 端的状态
		h.domActionHub.CancelCommentSnapshot(payload.MissionID)
		// 2. 广播取消命令给所有浏览器（按 missionId 前缀匹配 taskId）
		prefix := fmt.Sprintf("sph_%s_", payload.MissionID)
		h.domActionHub.BroadcastCancelSnapshot(prefix)
		utils.LogInfo("[HandleCancelSnapshot] 取消 mission 所有采集: missionId=%s, prefix=%s", payload.MissionID, prefix)
	}

	headers := http.Header{}
	headers.Set("Content-Type", "application/json")
	h.setCORSHeadersFromConn(Conn, headers)
	Conn.StopRequest(200, `{"success":true,"message":"snapshot cancelled"}`, headers)
}
