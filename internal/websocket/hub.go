package websocket

import (
	"errors"
	"fmt"
	"sync"
	"sync/atomic"
	"time"

	"wx_channel/internal/database"
	"wx_channel/internal/utils"

	json "github.com/json-iterator/go"
)

// Hub 管理所有 WebSocket 客户端连接
type Hub struct {
	clients    map[*Client]bool
	register   chan *Client
	unregister chan *Client
	mu         sync.RWMutex
	lastClient *Client // 最后注册的客户端

	// API 调用管理
	requests   map[string]chan APICallResponse
	requestsMu sync.RWMutex
	reqSeq     uint64

	// 【关键】当前任务的活跃客户端：记录哪个客户端收到了 watch_video
	// 这样 start_scroll 可以确保发给同一个客户端
	activeTaskClient   *Client
	activeTaskClientMu sync.RWMutex

	// 负载均衡选择器
	selector ClientSelector

	// 任务服务（导出供外部共享使用）
	TaskService *database.SearchTaskService
}

// NewHub 创建新的 Hub
func NewHub(taskService *database.SearchTaskService) *Hub {
	return &Hub{
		clients:     make(map[*Client]bool),
		register:    make(chan *Client),
		unregister:  make(chan *Client),
		requests:    make(map[string]chan APICallResponse),
		selector:    NewLeastConnectionSelector(),
		TaskService: taskService,
	}
}

// Run 启动 Hub
func (h *Hub) Run() {
	for {
		select {
		case client := <-h.register:
			h.mu.Lock()
			h.clients[client] = true
			h.lastClient = client // 记录最后注册的客户端
			h.mu.Unlock()
			utils.LogInfo("WebSocket 客户端已连接: %s", client.RemoteAddr)

		case client := <-h.unregister:
			h.mu.Lock()
			if _, ok := h.clients[client]; ok {
				addr := client.RemoteAddr
				delete(h.clients, client)
				client.Close()
				// 如果注销的是最后一个客户端，清除引用
				if h.lastClient == client {
					h.lastClient = nil
					// 尝试找到另一个活跃的客户端
					for c := range h.clients {
						h.lastClient = c
						break
					}
				}
				utils.LogInfo("WebSocket 客户端已断开: %s", addr)
			}
			h.mu.Unlock()
		}
	}
}

// RegisterClient 注册新客户端
func (h *Hub) RegisterClient(client *Client) {
	h.register <- client
}

// GetClient 获取一个可用的客户端（使用负载均衡选择器）
func (h *Hub) GetClient() (*Client, error) {
	h.mu.RLock()
	defer h.mu.RUnlock()

	// 使用负载均衡选择器选择客户端
	if h.selector != nil {
		return h.selector.Select(h.clients)
	}

	// 如果没有选择器，使用默认逻辑（向后兼容）
	// 优先使用最后注册的客户端
	if h.lastClient != nil {
		if _, ok := h.clients[h.lastClient]; ok {
			return h.lastClient, nil
		}
	}

	// 如果最后注册的客户端不可用，使用任意一个
	for client := range h.clients {
		return client, nil
	}

	return nil, errors.New("no available client")
}

// GetClientForKey 获取支持指定 API 的客户端
func (h *Hub) GetClientForKey(key string) (*Client, error) {
	h.mu.RLock()
	defer h.mu.RUnlock()

	filtered := make(map[*Client]bool)
	for client := range h.clients {
		if client.SupportsKey(key) {
			filtered[client] = true
		}
	}

	if len(filtered) == 0 {
		return nil, fmt.Errorf("no ready client for key: %s", key)
	}

	if h.selector != nil {
		return h.selector.Select(filtered)
	}

	for client := range filtered {
		return client, nil
	}

	return nil, fmt.Errorf("no ready client for key: %s", key)
}

// SetSelector 设置负载均衡选择器
func (h *Hub) SetSelector(selector ClientSelector) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.selector = selector
}

// ClientCount 返回当前连接的客户端数量
func (h *Hub) ClientCount() int {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return len(h.clients)
}

func (h *Hub) ClientStatuses() []ClientStatus {
	h.mu.RLock()
	defer h.mu.RUnlock()

	statuses := make([]ClientStatus, 0, len(h.clients))
	for client := range h.clients {
		statuses = append(statuses, client.Status())
	}
	return statuses
}

// CallAPI 调用前端 API
func (h *Hub) CallAPI(key string, body interface{}, timeout time.Duration) (json.RawMessage, error) {
	client, err := h.GetClientForKey(key)
	if err != nil {
		return nil, err
	}

	// 增加活跃请求计数
	client.IncrementActiveRequests()
	defer client.DecrementActiveRequests()

	// 生成请求 ID
	id := atomic.AddUint64(&h.reqSeq, 1)
	reqID := fmt.Sprintf("%d", id)

	// 创建响应通道（增加缓冲区大小以防止阻塞）
	respChan := make(chan APICallResponse, 2)
	h.requestsMu.Lock()
	h.requests[reqID] = respChan
	h.requestsMu.Unlock()

	// 确保清理响应通道
	defer func() {
		h.requestsMu.Lock()
		delete(h.requests, reqID)
		h.requestsMu.Unlock()
		close(respChan) // 关闭通道防止泄漏
	}()

	// 构建请求消息
	req := APICallRequest{
		ID:   reqID,
		Key:  key,
		Body: body,
	}

	reqData, err := json.Marshal(req)
	if err != nil {
		utils.LogError("序列化 API 请求失败: %v", err)
		return nil, fmt.Errorf("marshal request failed: %w", err)
	}

	msg := WSMessage{
		Type: WSMessageTypeAPICall,
		Data: reqData,
	}

	msgData, err := json.Marshal(msg)
	if err != nil {
		utils.LogError("序列化 WebSocket 消息失败: %v", err)
		return nil, fmt.Errorf("marshal message failed: %w", err)
	}

	// 记录请求开始时间
	startTime := time.Now()
	utils.LogInfo("发送 API 请求: ID=%s, Key=%s, Timeout=%v", reqID, key, timeout)

	// 发送请求
	if err := client.Send(msgData); err != nil {
		utils.LogError("发送 API 请求失败: ID=%s, Error=%v", reqID, err)
		return nil, fmt.Errorf("send request failed: %w", err)
	}

	// 等待响应
	select {
	case resp, ok := <-respChan:
		if !ok {
			utils.LogError("响应通道已关闭: ID=%s", reqID)
			return nil, errors.New("response channel closed")
		}

		duration := time.Since(startTime)
		if resp.ErrCode != 0 {
			utils.LogError("API 调用失败: ID=%s, Duration=%v, ErrCode=%d, ErrMsg=%s",
				reqID, duration, resp.ErrCode, resp.ErrMsg)
			return nil, fmt.Errorf("API error (code=%d): %s", resp.ErrCode, resp.ErrMsg)
		}

		utils.LogInfo("API 调用成功: ID=%s, Duration=%v, DataSize=%d",
			reqID, duration, len(resp.Data))
		return resp.Data, nil

	case <-time.After(timeout):
		utils.LogError("API 调用超时: ID=%s, Timeout=%v", reqID, timeout)
		return nil, fmt.Errorf("request timeout after %v", timeout)
	}
}

// handleAPIResponse 处理 API 响应
func (h *Hub) handleAPIResponse(resp APICallResponse) {
	h.requestsMu.RLock()
	respChan, ok := h.requests[resp.ID]
	h.requestsMu.RUnlock()

	if ok {
		// 使用 select 防止阻塞
		select {
		case respChan <- resp:
			// 响应已发送
		case <-time.After(5 * time.Second):
			utils.LogError("响应通道发送超时: ID=%s (可能接收方已超时)", resp.ID)
		}
	} else {
		utils.LogWarn("未找到响应通道: ID=%s (可能已超时或已清理)", resp.ID)
	}
}

// SendToSearchClients 向搜索页客户端发送指令（pagePath == "/web/pages/s"）
// 关键修改：watch_video 和 start_scroll 必须发给同一个客户端
func (h *Hub) SendToSearchClients(action string, payload interface{}) error {
	h.mu.RLock()
	defer h.mu.RUnlock()

	cmdData := map[string]interface{}{
		"action":  action,
		"payload": payload,
	}

	data, err := json.Marshal(cmdData)
	if err != nil {
		return err
	}

	msg := WSMessage{
		Type: WSMessageTypeCommand,
		Data: data,
	}

	msgData, err := json.Marshal(msg)
	if err != nil {
		return err
	}

	// 找到所有搜索页客户端
	var searchClients []*Client
	for client := range h.clients {
		if client.pagePath == "/web/pages/s" {
			searchClients = append(searchClients, client)
		}
	}

	if len(searchClients) == 0 {
		utils.LogWarn("[SendToSearchClients] 无搜索页客户端连接, action=%s", action)
		return nil
	}

	// 【关键】如果存在活跃任务客户端，且该客户端还在连接中且在搜索页，则优先使用它
	// 这样确保 watch_video 和 start_scroll 发给同一个客户端
	h.activeTaskClientMu.RLock()
	activeClient := h.activeTaskClient
	h.activeTaskClientMu.RUnlock()

	var bestClient *Client
	if activeClient != nil {
		// 检查活跃客户端是否还在连接中
		stillActive := false
		for _, client := range searchClients {
			if client == activeClient {
				stillActive = true
				break
			}
		}
		if stillActive {
			bestClient = activeClient
			utils.LogInfo("[SendToSearchClients] 使用活跃任务客户端: action=%s, client=%s", action, bestClient.RemoteAddr)
		} else {
			utils.LogWarn("[SendToSearchClients] 活跃任务客户端已断开，清除并重新选择: action=%s", action)
			// 活跃客户端已断开，清除引用
			h.activeTaskClientMu.Lock()
			h.activeTaskClient = nil
			h.activeTaskClientMu.Unlock()
		}
	}

	// 如果没有活跃客户端，按 lastSeen 选择一个
	if bestClient == nil {
		for _, client := range searchClients {
			if bestClient == nil || client.lastSeen.After(bestClient.lastSeen) {
				bestClient = client
			}
		}
	}

	if bestClient != nil {
		bestClient.Send(msgData)

		// 【关键】如果是 watch_video，记录这个客户端为活跃任务客户端
		if action == "watch_video" {
			h.activeTaskClientMu.Lock()
			h.activeTaskClient = bestClient
			h.activeTaskClientMu.Unlock()
			utils.LogInfo("[SendToSearchClients] ★★★ watch_video 已记录活跃客户端: client=%s, total_clients=%d",
				bestClient.RemoteAddr, len(searchClients))
		}

		utils.LogInfo("[SendToSearchClients] action=%s, payload=%v, sent=1 (client=%s, total_clients=%d)",
			action, payload, bestClient.RemoteAddr, len(searchClients))
	}

	return nil
}

// ClearActiveTaskClient 清除活跃任务客户端（可选调用）
func (h *Hub) ClearActiveTaskClient() {
	h.activeTaskClientMu.Lock()
	h.activeTaskClient = nil
	h.activeTaskClientMu.Unlock()
	utils.LogInfo("[Hub] 已清除活跃任务客户端")
}

// GetSearchClientCount 获取搜索页客户端数量（通过指针返回，协程安全）
func (h *Hub) GetSearchClientCount(count *int) {
	h.mu.RLock()
	defer h.mu.RUnlock()
	*count = 0
	for client := range h.clients {
		if client.pagePath == "/web/pages/s" {
			*count++
		}
	}
}

// BroadcastCommand 向所有客户端广播指令
func (h *Hub) BroadcastCommand(action string, payload interface{}) error {
	h.mu.RLock()
	clientCount := len(h.clients)
	clientList := make([]string, 0, clientCount)
	for client := range h.clients {
		clientList = append(clientList, client.ID)
	}
	h.mu.RUnlock()

	// 没有客户端连接时不报错，任务保持 running 状态等待客户端
	if clientCount == 0 {
		utils.LogWarn("[BroadcastCommand] 无客户端连接，跳过广播 action=%s", action)
		return nil
	}

	cmdData := map[string]interface{}{
		"action":  action,
		"payload": payload,
	}

	data, err := json.Marshal(cmdData)
	if err != nil {
		return err
	}

	msg := WSMessage{
		Type: WSMessageTypeCommand,
		Data: data,
	}

	msgData, err := json.Marshal(msg)
	if err != nil {
		return err
	}

	sentCount := 0
	h.mu.RLock()
	for client := range h.clients {
		client.Send(msgData)
		sentCount++
	}
	h.mu.RUnlock()

	utils.LogInfo("[BroadcastCommand] action=%s, payload=%v, client_count=%d, sent=%d", action, payload, clientCount, sentCount)
	return nil
}

// Broadcast 广播任意消息到所有客户端
func (h *Hub) Broadcast(message interface{}) error {
	h.mu.RLock()
	defer h.mu.RUnlock()

	if len(h.clients) == 0 {
		return nil
	}

	data, err := json.Marshal(message)
	if err != nil {
		return err
	}

	for client := range h.clients {
		client.Send(data)
	}

	return nil
}

// BroadcastTaskStarted 广播任务开始消息
func (h *Hub) BroadcastTaskStarted(data TaskStartedData) error {
	msg := TaskMessage{
		Type: "task_started",
		Data: data,
	}
	return h.Broadcast(msg)
}

// BroadcastTaskProgress 广播任务进度消息
func (h *Hub) BroadcastTaskProgress(data TaskProgressData) error {
	msg := TaskMessage{
		Type: "task_progress",
		Data: data,
	}
	return h.Broadcast(msg)
}

// BroadcastTaskVideo 广播任务视频数据
func (h *Hub) BroadcastTaskVideo(data TaskVideoData) error {
	msg := TaskMessage{
		Type: "task_video",
		Data: data,
	}
	return h.Broadcast(msg)
}

// BroadcastTaskComplete 广播任务完成消息
func (h *Hub) BroadcastTaskComplete(data TaskCompleteData) error {
	msg := TaskMessage{
		Type: "task_complete",
		Data: data,
	}
	return h.Broadcast(msg)
}

// BroadcastTaskError 广播任务错误消息
func (h *Hub) BroadcastTaskError(data TaskErrorData) error {
	msg := TaskMessage{
		Type: "task_error",
		Data: data,
	}
	return h.Broadcast(msg)
}

// HandleTaskMessage 处理前端上报的任务消息
func (h *Hub) HandleTaskMessage(msg TaskMessage) {
	switch msg.Type {
	case "task_progress":
		if data, ok := msg.Data.(map[string]interface{}); ok {
			h.handleTaskProgress(data)
		}
	case "task_video":
		if data, ok := msg.Data.(map[string]interface{}); ok {
			h.handleTaskVideo(data)
		}
	case "task_complete":
		if data, ok := msg.Data.(map[string]interface{}); ok {
			h.handleTaskComplete(data)
		}
	case "task_error":
		if data, ok := msg.Data.(map[string]interface{}); ok {
			h.handleTaskError(data)
		}
	}
}

// handleTaskProgress 处理任务进度
func (h *Hub) handleTaskProgress(data map[string]interface{}) {
	taskID, _ := data["task_id"].(string)
	currentCount, _ := data["current_count"].(float64)
	targetCount, _ := data["target_count"].(float64)

	if taskID == "" {
		return
	}

	utils.LogInfo("[任务] 进度: task_id=%s, current=%d, target=%d",
		taskID, int(currentCount), int(targetCount))

	// 广播给所有客户端
	h.BroadcastTaskProgress(TaskProgressData{
		TaskID:       taskID,
		CurrentCount: int(currentCount),
		TargetCount:  int(targetCount),
		Status:       "running",
	})
}

// handleTaskVideo 处理任务视频数据
func (h *Hub) handleTaskVideo(data map[string]interface{}) {
	taskID, _ := data["task_id"].(string)
	video, _ := data["video"].(map[string]interface{})

	if taskID == "" || video == nil {
		return
	}

	// 添加视频到任务（内存+数据库，内存和 DB 层都做了防重）
	_, inserted := h.TaskService.AddVideoToTask(taskID, video)

	// 只有真正入库时才广播进度和日志（避免重复上报）
	// CurrentCount 以数据库实际入库数为准
	if inserted {
		dbCount := h.TaskService.GetVideoCount(taskID)
		h.BroadcastTaskProgress(TaskProgressData{
			TaskID:       taskID,
			CurrentCount: dbCount,
			TargetCount:  h.TaskService.GetTargetCount(taskID),
		})
	}
}

// handleTaskComplete 处理任务完成
func (h *Hub) handleTaskComplete(data map[string]interface{}) {
	taskID, _ := data["task_id"].(string)
	targetCount, _ := data["target_count"].(float64)
	status, _ := data["status"].(string)

	if taskID == "" {
		return
	}

	dbCount := h.TaskService.GetVideoCount(taskID)

	utils.LogInfo("[任务] 完成: task_id=%s, current=%d, target=%d, status=%s",
		taskID, dbCount, int(targetCount), status)

	// 根据状态映射最终状态
	finalStatus := database.TaskStatusCompleted
	switch status {
	case "insufficient_data":
		finalStatus = database.TaskStatusCompletedWithInsufficientData
	case "stopped":
		finalStatus = database.TaskStatusStopped
	case "timeout":
		finalStatus = database.TaskStatusCompletedWithInsufficientData
	}

	// 持久化任务状态
	h.TaskService.PersistTaskStatus(taskID, finalStatus)

	// 广播完成消息（CurrentCount 以数据库实际入库数为准）
	h.BroadcastTaskComplete(TaskCompleteData{
		TaskID:       taskID,
		CurrentCount: dbCount,
		TargetCount:  int(targetCount),
		Status:       finalStatus,
	})
}

// handleTaskError 处理任务错误
func (h *Hub) handleTaskError(data map[string]interface{}) {
	taskID, _ := data["task_id"].(string)
	message, _ := data["message"].(string)

	if taskID == "" {
		return
	}

	// 只在任务刚开始时（非搜索页面）才标记失败
	// 如果视频已开始采集，说明任务实际在执行中，忽略后续错误
	ctx := h.TaskService.GetTask(taskID)

	// 如果已有视频数据，说明任务实际已完成，只记录日志
	if ctx != nil && len(ctx.VideoList) > 0 {
		utils.LogWarn("[任务] 忽略后续错误（任务已有 %d 条视频）: task_id=%s, message=%s",
			len(ctx.VideoList), taskID, message)
		return
	}

	utils.LogError("[任务] 错误: task_id=%s, message=%s", taskID, message)

	// 检查是否是"不在搜索页面"错误，这种情况下任务保持 listening 状态
	// 等待用户在正确的页面重新操作，此时 StartScroll 会允许该状态
	if message == "当前不在搜索页面" {
		utils.LogWarn("[任务] 浏览器不在搜索页面，任务保持 listening 状态等待用户切换页面: task_id=%s", taskID)
		return
	}

	// 其他错误标记任务失败
	h.TaskService.SetTaskFailed(taskID, message)
	h.TaskService.PersistTaskWithVideos(taskID, "failed")

	// 广播给所有客户端
	h.BroadcastTaskError(TaskErrorData{
		TaskID:  taskID,
		Message: message,
	})
}

// GetTaskService 获取任务服务
func (h *Hub) GetTaskService() *database.SearchTaskService {
	return h.TaskService
}
