package api

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"

	"time"

	"wx_channel/internal/database"
	"wx_channel/internal/response"
	"wx_channel/internal/utils"
	"wx_channel/internal/websocket"
)

// TaskAPI 任务 API
type TaskAPI struct {
	hub     *websocket.Hub
	service *database.SearchTaskService
}

// NewTaskAPI 创建任务 API（共享 hub 的 taskService）
func NewTaskAPI(hub *websocket.Hub) *TaskAPI {
	return &TaskAPI{
		hub:     hub,
		service: hub.TaskService, // 直接使用 Hub 的 taskService，避免实例不一致
	}
}

// StartSearchTask 开始搜索任务
func (api *TaskAPI) StartSearchTask(w http.ResponseWriter, r *http.Request) {
	var req database.StartSearchTaskRequest

	if r.Method == http.MethodGet {
		// GET 请求，从 URL 参数获取
		req.Keyword = r.URL.Query().Get("keyword")
		req.TargetCount, _ = parseIntParam(r.URL.Query().Get("target_count"))
		req.TaskType = r.URL.Query().Get("task_type")
	} else if r.Method == http.MethodPost {
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			response.Error(w, 400, "Invalid request body: "+err.Error())
			return
		}
	}

	// 参数校验
	if req.Keyword == "" {
		response.Error(w, 400, "keyword is required")
		return
	}
	if req.TargetCount <= 0 {
		response.Error(w, 400, "target_count must be greater than 0")
		return
	}
	if req.TaskType == "" {
		req.TaskType = "search_keyword_videocontact" // 默认任务类型
	}

	// 创建任务
	taskCtx, err := api.service.StartSearchTask(req)
	if err != nil {
		response.Error(w, 500, "Failed to start task: "+err.Error())
		return
	}

	// 【修改】只创建任务，不立即发送 watch_video
	// watch_video 将在 StartScroll 时才发送，确保客户端已在搜索页
	// 任务进入 listening 状态等待滚动

	// 更新任务状态为 listening（等待开始滚动）
	api.service.PersistTaskWithVideos(taskCtx.TaskID, database.TaskStatusListening)

	response.Success(w, map[string]interface{}{
		"success":      true,
		"task_id":      taskCtx.TaskID,
		"message":      "Task started, waiting for scroll command",
		"keyword":      taskCtx.Keyword,
		"target_count": taskCtx.TargetCount,
		"task_type":    taskCtx.Type,
	})
}

// GetTask 获取任务状态
func (api *TaskAPI) GetTask(w http.ResponseWriter, r *http.Request) {
	taskID := extractPathParam(r.URL.Path, "/api/v1/tasks/")

	if taskID == "" {
		taskID = extractPathParam(r.URL.Path, "/api/tasks/")
	}

	if taskID == "" {
		response.Error(w, 400, "task_id is required")
		return
	}

	taskCtx := api.service.GetTask(taskID)
	if taskCtx == nil {
		response.Error(w, 404, "Task not found")
		return
	}

	response.Success(w, map[string]interface{}{
		"success":        true,
		"task_id":        taskCtx.TaskID,
		"keyword":        taskCtx.Keyword,
		"target_count":   taskCtx.TargetCount,
		"current_count":  len(taskCtx.VideoList),
		"status":         taskCtx.Status,
		"video_list":     taskCtx.VideoList,
	})
}

// GetAllTasks 获取所有任务
func (api *TaskAPI) GetAllTasks(w http.ResponseWriter, r *http.Request) {
	tasks := api.service.GetAllTasks()
	if tasks == nil {
		response.Success(w, []interface{}{})
		return
	}

	taskList := make([]map[string]interface{}, 0, len(tasks))
	for _, task := range tasks {
		taskList = append(taskList, map[string]interface{}{
			"id":             task.ID,
			"task_id":        task.TaskID,
			"keyword":        task.Keyword,
			"target_count":   task.TargetCount,
			"current_count":  task.CurrentCount,
			"status":         task.Status,
			"window_id":      task.WindowID,
			"created_at":     task.CreatedAt,
			"started_at":     task.StartedAt,
			"completed_at":   task.CompletedAt,
			"error_message":  task.ErrorMessage,
			"task_type":      task.TaskType,
			"video_list":     task.VideoList,
		})
	}

	response.Success(w, taskList)
}

// PauseTask 暂停任务
func (api *TaskAPI) PauseTask(w http.ResponseWriter, r *http.Request) {
	taskID := extractPathParam(r.URL.Path, "/api/v1/tasks/")

	if taskID == "" {
		taskID = extractPathParam(r.URL.Path, "/api/tasks/")
	}

	// 去掉末尾的 /pause
	taskID = strings.TrimSuffix(taskID, "pause")
	taskID = strings.TrimSuffix(taskID, "/")

	if taskID == "" {
		response.Error(w, 400, "task_id is required")
		return
	}

	taskCtx := api.service.GetTask(taskID)
	if taskCtx == nil {
		response.Error(w, 404, "Task not found")
		return
	}

	if taskCtx.Status != "running" {
		response.Error(w, 400, "Only running task can be paused")
		return
	}

	// 发送暂停命令到前端浏览器
	cmdPayload := map[string]interface{}{
		"task_id": taskID,
	}
	api.hub.SendToSearchClients("pause_search_task", cmdPayload)

	// 更新任务状态为 paused
	api.service.PersistTaskStatus(taskID, "paused")

	response.Success(w, map[string]interface{}{
		"success": true,
		"task_id": taskID,
		"message": "Task paused",
		"status":  "paused",
	})
}

// ResumeTask 恢复任务
func (api *TaskAPI) ResumeTask(w http.ResponseWriter, r *http.Request) {
	taskID := extractPathParam(r.URL.Path, "/api/v1/tasks/")

	if taskID == "" {
		taskID = extractPathParam(r.URL.Path, "/api/tasks/")
	}

	// 去掉末尾的 /resume
	taskID = strings.TrimSuffix(taskID, "resume")
	taskID = strings.TrimSuffix(taskID, "/")

	if taskID == "" {
		response.Error(w, 400, "task_id is required")
		return
	}

	taskCtx := api.service.GetTask(taskID)
	if taskCtx == nil {
		response.Error(w, 404, "Task not found")
		return
	}

	if taskCtx.Status != "paused" {
		response.Error(w, 400, "Only paused task can be resumed")
		return
	}

	// 发送恢复命令到前端浏览器
	cmdPayload := map[string]interface{}{
		"task_id": taskID,
	}
	api.hub.SendToSearchClients("resume_search_task", cmdPayload)

	// 更新任务状态为 running
	api.service.PersistTaskStatus(taskID, "running")

	response.Success(w, map[string]interface{}{
		"success": true,
		"task_id": taskID,
		"message": "Task resumed",
		"status":  "running",
	})
}

// DeleteTask 删除任务
func (api *TaskAPI) DeleteTask(w http.ResponseWriter, r *http.Request) {
	taskID := extractPathParam(r.URL.Path, "/api/v1/tasks/")

	if taskID == "" {
		taskID = extractPathParam(r.URL.Path, "/api/tasks/")
	}

	if taskID == "" {
		response.Error(w, 400, "task_id is required")
		return
	}

	// 发送停止命令到前端浏览器（如果任务还在运行或监听中）
	taskCtx := api.service.GetTask(taskID)
	if taskCtx != nil && (taskCtx.Status == "pending" || taskCtx.Status == "running" || taskCtx.Status == "listening" || taskCtx.Status == "paused") {
		cmdPayload := map[string]interface{}{
			"task_id": taskID,
		}
		api.hub.SendToSearchClients("stop_search_task", cmdPayload)
	}

	// 删除任务及其视频数据
	if err := api.service.DeleteTask(taskID); err != nil {
		response.Error(w, 500, "Failed to delete task: "+err.Error())
		return
	}

	response.Success(w, map[string]interface{}{
		"success": true,
		"task_id": taskID,
		"message": "Task deleted",
	})
}

// StartScroll 开始滚动
func (api *TaskAPI) StartScroll(w http.ResponseWriter, r *http.Request) {
	taskID := extractScrollPathParam(r.URL.Path, "/api/v1/tasks/")

	if taskID == "" {
		response.Error(w, 400, "task_id is required")
		return
	}

	taskCtx := api.service.GetTask(taskID)
	if taskCtx == nil {
		response.Error(w, 404, "Task not found")
		return
	}

	if taskCtx.Status != "listening" && taskCtx.Status != "paused" && taskCtx.Status != "running" {
		response.Error(w, 400, fmt.Sprintf("Task status must be listening, paused or running to start scroll, got: %s", taskCtx.Status))
		return
	}

	// 检查是否有搜索页客户端连接
	clientCount := api.hub.ClientCount()
	searchClientCount := 0
	api.hub.GetSearchClientCount(&searchClientCount)
	utils.LogInfo("[StartScroll] task_id=%s, total_client=%d, search_client=%d", taskID, clientCount, searchClientCount)
	if searchClientCount == 0 {
		utils.LogWarn("[StartScroll] 无搜索页客户端连接，跳过发送")
		response.Error(w, 400, "No search page client connected. Please open the WeChat Channels search page in your browser first.")
		return
	}

	// 【关键修改】先发送 watch_video 初始化任务，确保浏览器端准备好
	// 再发送 start_scroll 开始滚动
	// 这样即使 StartSearchTask 时客户端不在搜索页，也能正常工作
	watchPayload := map[string]interface{}{
		"task_id":      taskID,
		"keyword":      taskCtx.Keyword,
		"target_count": taskCtx.TargetCount,
		"task_type":    taskCtx.Type,
	}
	api.hub.SendToSearchClients("watch_video", watchPayload)
	utils.LogInfo("[StartScroll] watch_video 指令已发送, task_id=%s", taskID)

	// 等待一小段时间让 watch_video 处理完成（50ms）
	time.Sleep(50 * time.Millisecond)

	// 定向发送到搜索页客户端（只发给 /web/pages/s 的客户端）
	scrollPayload := map[string]interface{}{
		"task_id": taskID,
	}
	api.hub.SendToSearchClients("start_scroll", scrollPayload)
	utils.LogInfo("[StartScroll] start_scroll 指令已发送, task_id=%s", taskID)

	// 更新任务状态为 running
	api.service.PersistTaskStatus(taskID, "running")

	response.Success(w, map[string]interface{}{
		"success": true,
		"task_id": taskID,
		"message": "Scroll started",
		"status":  "running",
	})
}

// PauseScroll 暂停滚动
func (api *TaskAPI) PauseScroll(w http.ResponseWriter, r *http.Request) {
	taskID := extractScrollPathParam(r.URL.Path, "/api/v1/tasks/")

	if taskID == "" {
		response.Error(w, 400, "task_id is required")
		return
	}

	taskCtx := api.service.GetTask(taskID)
	if taskCtx == nil {
		response.Error(w, 404, "Task not found")
		return
	}

	if taskCtx.Status != "running" {
		response.Error(w, 400, "Only running task can be paused")
		return
	}

	// 定向发送到搜索页客户端
	cmdPayload := map[string]interface{}{
		"task_id": taskID,
	}
	api.hub.SendToSearchClients("pause_scroll", cmdPayload)

	// 更新任务状态为 paused
	api.service.PersistTaskStatus(taskID, "paused")

	response.Success(w, map[string]interface{}{
		"success": true,
		"task_id": taskID,
		"message": "Scroll paused",
		"status":  "paused",
	})
}

// ResumeScroll 恢复滚动
func (api *TaskAPI) ResumeScroll(w http.ResponseWriter, r *http.Request) {
	taskID := extractScrollPathParam(r.URL.Path, "/api/v1/tasks/")

	if taskID == "" {
		response.Error(w, 400, "task_id is required")
		return
	}

	taskCtx := api.service.GetTask(taskID)
	if taskCtx == nil {
		response.Error(w, 404, "Task not found")
		return
	}

	if taskCtx.Status != "paused" {
		response.Error(w, 400, "Only paused task can be resumed")
		return
	}

	// 定向发送到搜索页客户端
	cmdPayload := map[string]interface{}{
		"task_id": taskID,
	}
	api.hub.SendToSearchClients("resume_scroll", cmdPayload)

	// 更新任务状态为 running
	api.service.PersistTaskStatus(taskID, "running")

	response.Success(w, map[string]interface{}{
		"success": true,
		"task_id": taskID,
		"message": "Scroll resumed",
		"status":  "running",
	})
}

// GetListeningTasksByKeyword 获取指定关键词的 listening 任务（供搜索页 JS 自动恢复）
func (api *TaskAPI) GetListeningTasksByKeyword(w http.ResponseWriter, r *http.Request) {
	keyword := r.URL.Query().Get("keyword")
	if keyword == "" {
		response.Error(w, 400, "keyword is required")
		return
	}

	tasks := api.service.GetListeningTasksByKeyword(keyword)
	if tasks == nil {
		response.Success(w, []interface{}{})
		return
	}

	result := make([]map[string]interface{}, 0, len(tasks))
	for _, ctx := range tasks {
		result = append(result, map[string]interface{}{
			"task_id":       ctx.TaskID,
			"keyword":        ctx.Keyword,
			"target_count":   ctx.TargetCount,
			"current_count":  len(ctx.VideoList),
			"status":         ctx.Status,
			"task_type":      ctx.Type,
		})
	}

	response.Success(w, result)
}

// RegisterRoutes 注册任务相关路由
func (api *TaskAPI) RegisterRoutes(mux *http.ServeMux) {
	mux.HandleFunc("/api/v1/tasks", api.GetAllTasks)           // 获取所有任务列表
	mux.HandleFunc("/api/v1/tasks/search", api.GetListeningTasksByKeyword) // 查询 listening 任务
	mux.HandleFunc("/api/v1/tasks/", api.handleTaskByMethod)   // 根据方法处理任务
	mux.HandleFunc("/api/v1/tasks/start", api.StartSearchTask) // 开始新任务（监听视频）
	mux.HandleFunc("/api/v1/tasks/start-test", api.StartSearchTaskTest)

	// 滚动控制路由
	mux.HandleFunc("/api/v1/scroll/", api.handleScrollByMethod)

	mux.HandleFunc("/api/tasks", api.GetAllTasks)
	mux.HandleFunc("/api/tasks/", api.handleTaskByMethod)
	mux.HandleFunc("/api/tasks/start", api.StartSearchTask)
}

// StartSearchTaskTest 测试用：创建任务并直接设置为running（不通过WS）
func (api *TaskAPI) StartSearchTaskTest(w http.ResponseWriter, r *http.Request) {
	var req database.StartSearchTaskRequest

	if r.Method == http.MethodGet {
		req.Keyword = r.URL.Query().Get("keyword")
		req.TargetCount, _ = parseIntParam(r.URL.Query().Get("target_count"))
		req.TaskType = r.URL.Query().Get("task_type")
	} else if r.Method == http.MethodPost {
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			response.Error(w, 400, "Invalid request body: "+err.Error())
			return
		}
	}

	if req.Keyword == "" {
		response.Error(w, 400, "keyword is required")
		return
	}
	if req.TargetCount <= 0 {
		req.TargetCount = 100
	}
	if req.TaskType == "" {
		req.TaskType = "search_keyword_videocontact"
	}

	taskCtx, err := api.service.StartSearchTask(req)
	if err != nil {
		response.Error(w, 500, "Failed to start task: "+err.Error())
		return
	}

	// 直接设置为 running 状态，不通过 WS
	api.service.PersistTaskStatus(taskCtx.TaskID, "running")

	response.Success(w, map[string]interface{}{
		"success":      true,
		"task_id":      taskCtx.TaskID,
		"message":      "Test task started (running)",
		"keyword":      taskCtx.Keyword,
		"target_count": taskCtx.TargetCount,
		"task_type":    taskCtx.Type,
		"status":       "running",
	})
}

// handleTaskByMethod 根据 HTTP 方法分发到对应的处理函数
func (api *TaskAPI) handleTaskByMethod(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		api.GetTask(w, r)
	case http.MethodDelete:
		api.DeleteTask(w, r)
	case http.MethodPost:
		// 根据 URL 末尾判断是 pause 还是 resume
		if strings.HasSuffix(r.URL.Path, "/pause") {
			api.PauseTask(w, r)
		} else if strings.HasSuffix(r.URL.Path, "/resume") {
			api.ResumeTask(w, r)
		} else {
			response.Error(w, 400, "Invalid action")
		}
	default:
		w.Header().Set("Allow", "GET, DELETE, POST")
		response.Error(w, 405, "Method not allowed")
	}
}

// handleScrollByMethod 根据 HTTP 方法分发到对应的滚动处理函数
func (api *TaskAPI) handleScrollByMethod(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodPost:
		if strings.HasSuffix(r.URL.Path, "/start") {
			api.StartScroll(w, r)
		} else if strings.HasSuffix(r.URL.Path, "/pause") {
			api.PauseScroll(w, r)
		} else if strings.HasSuffix(r.URL.Path, "/resume") {
			api.ResumeScroll(w, r)
		} else {
			response.Error(w, 400, "Invalid scroll action")
		}
	default:
		w.Header().Set("Allow", "POST")
		response.Error(w, 405, "Method not allowed")
	}
}

// extractPathParam 从路径中提取参数
func extractPathParam(path, prefix string) string {
	param := strings.TrimPrefix(path, prefix)
	if param == path {
		return ""
	}
	return param
}

// extractScrollPathParam 从滚动路径中提取参数
// 路径格式: /api/v1/scroll/{task_id}/start 或 /api/v1/scroll/{task_id}/pause
func extractScrollPathParam(path, prefix string) string {
	// 先去掉前缀 /api/v1/scroll/
	param := strings.TrimPrefix(path, "/api/v1/scroll/")
	// 再去掉末尾的 /start, /pause, /resume
	param = strings.TrimSuffix(param, "/start")
	param = strings.TrimSuffix(param, "/pause")
	param = strings.TrimSuffix(param, "/resume")
	return param
}

// parseIntParam 解析整数参数
func parseIntParam(s string) (int, error) {
	var n int
	err := json.Unmarshal([]byte(s), &n)
	if err != nil {
		// 尝试直接转换
		for i := 0; i < len(s); i++ {
			if s[i] >= '0' && s[i] <= '9' {
				n = n*10 + int(s[i]-'0')
			} else {
				return 0, err
			}
		}
	}
	return n, nil
}
