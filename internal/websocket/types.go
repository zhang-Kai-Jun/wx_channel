package websocket

import json "github.com/json-iterator/go"

// WebSocket 消息类型
type WSMessageType string

const (
	WSMessageTypeAPICall      WSMessageType = "api_call"
	WSMessageTypeAPIResponse  WSMessageType = "api_response"
	WSMessageTypePing         WSMessageType = "ping"
	WSMessageTypePong         WSMessageType = "pong"
	WSMessageTypeCommand      WSMessageType = "cmd"
	WSMessageTypeClientState  WSMessageType = "client_state"
	WSMessageTypeTaskStarted  WSMessageType = "task_started"
	WSMessageTypeTaskProgress WSMessageType = "task_progress"
	WSMessageTypeTaskVideo    WSMessageType = "task_video"
	WSMessageTypeTaskComplete WSMessageType = "task_complete"
	WSMessageTypeTaskError    WSMessageType = "task_error"
)

// WebSocket 消息
type WSMessage struct {
	Type WSMessageType   `json:"type"`
	Data json.RawMessage `json:"data,omitempty"`
}

// API 调用请求
type APICallRequest struct {
	ID   string      `json:"id"`
	Key  string      `json:"key"`
	Body interface{} `json:"body"`
}

// API 调用响应
type APICallResponse struct {
	ID      string          `json:"id"`
	Data    json.RawMessage `json:"data"`
	ErrCode int             `json:"errCode,omitempty"`
	ErrMsg  string          `json:"errMsg,omitempty"`
}

// 搜索账号请求体
type SearchContactBody struct {
	Keyword    string `json:"keyword"`
	Type       int    `json:"type"`        // 1=User, 2=Live, 3=Video
	NextMarker string `json:"next_marker"` // for pagination (lastBuff)
	RequestId  string `json:"request_id"`
}

// 获取账号视频列表请求体
type FeedListBody struct {
	Username   string `json:"username"`
	NextMarker string `json:"next_marker"`
}

// 获取视频详情请求体
type FeedProfileBody struct {
	ObjectID string `json:"objectId"`
	NonceID  string `json:"nonceId"`
	URL      string `json:"url"`
}

// ClientStateBody 前端客户端状态
type ClientStateBody struct {
	PagePath  string          `json:"pagePath"`
	Href      string          `json:"href"`
	APIReady  bool            `json:"apiReady"`
	Methods   map[string]bool `json:"methods"`
	Timestamp int64           `json:"timestamp"`
	UserAgent string          `json:"userAgent,omitempty"`
	Visible   bool            `json:"visible,omitempty"`
}

type ClientStatus struct {
	RemoteAddr      string          `json:"remote_addr"`
	PagePath        string          `json:"page_path"`
	Href            string          `json:"href"`
	APIReady        bool            `json:"api_ready"`
	Methods         map[string]bool `json:"methods"`
	ActiveRequests  int             `json:"active_requests"`
	LastSeenAt      string          `json:"last_seen_at"`
	LastPingAt      string          `json:"last_ping_at"`
	SupportsSearch  bool            `json:"supports_search"`
	SupportsFeed    bool            `json:"supports_feed"`
	SupportsProfile bool            `json:"supports_profile"`
}

// TaskMessage 任务消息类型
type TaskMessage struct {
	Type string      `json:"type"` // task_started, task_progress, task_video, task_complete, task_error
	Data interface{} `json:"data"`
}

// TaskStartedData 任务开始数据
type TaskStartedData struct {
	TaskID      string `json:"task_id"`
	Keyword     string `json:"keyword"`
	TargetCount int    `json:"target_count"`
	TaskType    string `json:"task_type"`
}

// TaskProgressData 任务进度数据
type TaskProgressData struct {
	TaskID       string `json:"task_id"`
	CurrentCount int    `json:"current_count"`
	TargetCount  int    `json:"target_count"`
	Status       string `json:"status"`
}

// TaskVideoData 任务视频数据
type TaskVideoData struct {
	TaskID string                 `json:"task_id"`
	Video  map[string]interface{} `json:"video"`
}

// TaskCompleteData 任务完成数据（不包含视频列表，由调用方自行查询）
type TaskCompleteData struct {
	TaskID       string `json:"task_id"`
	CurrentCount int    `json:"current_count"`
	TargetCount  int    `json:"target_count"`
	Status       string `json:"status"` // completed, completed_with_insufficient_data, failed
}

// TaskErrorData 任务错误数据
type TaskErrorData struct {
	TaskID  string `json:"task_id"`
	Message string `json:"message"`
}

// DOMActionBody DOM 操作请求体
type DOMActionBody struct {
	Action      string   `json:"action"`
	Target      string   `json:"target"`
	Content     string   `json:"content"`
	Index       int      `json:"index"`
	URL         string   `json:"url"`
	TaskID      string   `json:"task_id,omitempty"`
	ReplyContent string  `json:"replyContent,omitempty"`
	// 精准匹配专用字段
	TargetNum      int      `json:"target_num,omitempty"`
	TriggerWords   []string `json:"trigger_words,omitempty"`
	IpFilter       string   `json:"ip_filter,omitempty"`
	TimeFilter     *struct {
		Enabled bool   `json:"enabled"`
		Value   int    `json:"value"`
		Unit    string `json:"unit"`
	} `json:"time_filter,omitempty"`
	BlockWords     []string `json:"block_words,omitempty"`
	DedupUsernames []string `json:"dedup_usernames,omitempty"`
}

// DOMActionCallbackPayload HTTP 回调的响应负载（来自 inject 的 sendResponseViaHTTP）
type DOMActionCallbackPayload struct {
	ID  string `json:"id"`  // 请求 ID（与 APICallRequest.ID 对应）
	Req struct {
		Data struct {
			ErrCode int             `json:"errCode"`
			ErrMsg  string          `json:"errMsg"`
			Data    json.RawMessage `json:"data"`
		} `json:"data"`
	} `json:"req,omitempty"` // inject 发来的原始结构
	// 直接内嵌，方便直接 Unmarshal
	ErrCode int             `json:"errCode,omitempty"`
	ErrMsg  string          `json:"errMsg,omitempty"`
	Data    json.RawMessage `json:"data,omitempty"`
}
