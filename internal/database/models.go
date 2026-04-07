package database

import (
	"encoding/json"
	"fmt"
	"sync"
	"time"

	"wx_channel/internal/utils"
)

// BrowseRecord 表示视频浏览历史记录
type BrowseRecord struct {
	ID           string    `json:"id"`
	Title        string    `json:"title"`
	Author       string    `json:"author"`
	AuthorID     string    `json:"authorId"`
	Duration     int64     `json:"duration"`
	Size         int64     `json:"size"`
	Resolution   string    `json:"resolution"` // 视频分辨率（例如 "1080p"）
	FileFormat   string    `json:"fileFormat"` // 视频格式标识（例如 "xWT128", "xWT111"）
	CoverURL     string    `json:"coverUrl"`
	VideoURL     string    `json:"videoUrl"`
	DecryptKey   string    `json:"decryptKey"` // 加密视频的解密密钥
	BrowseTime   time.Time `json:"browseTime"`
	LikeCount    int64     `json:"likeCount"`
	CommentCount int64     `json:"commentCount"`
	FavCount     int64     `json:"favCount"`
	ForwardCount int64     `json:"forwardCount"`
	PageURL      string    `json:"pageUrl"`
	CreatedAt    time.Time `json:"createdAt"`
	UpdatedAt    time.Time `json:"updatedAt"`
}

// DownloadRecord 表示视频下载记录
type DownloadRecord struct {
	ID           string    `json:"id"`
	VideoID      string    `json:"videoId"`
	Title        string    `json:"title"`
	Author       string    `json:"author"`
	CoverURL     string    `json:"coverUrl"` // 封面图片 URL
	Duration     int64     `json:"duration"`
	FileSize     int64     `json:"fileSize"`
	FilePath     string    `json:"filePath"`
	Format       string    `json:"format"`
	Resolution   string    `json:"resolution"`
	Status       string    `json:"status"` // pending, in_progress, completed, failed
	DownloadTime time.Time `json:"downloadTime"`
	ErrorMessage string    `json:"errorMessage"`
	LikeCount    int64     `json:"likeCount"`
	CommentCount int64     `json:"commentCount"`
	ForwardCount int64     `json:"forwardCount"`
	FavCount     int64     `json:"favCount"`
	CreatedAt    time.Time `json:"createdAt"`
	UpdatedAt    time.Time `json:"updatedAt"`
}

// DownloadStatus 常量
const (
	DownloadStatusPending    = "pending"
	DownloadStatusInProgress = "in_progress"
	DownloadStatusCompleted  = "completed"
	DownloadStatusFailed     = "failed"
)

// QueueItem 表示下载队列项目
type QueueItem struct {
	ID              string    `json:"id"`
	VideoID         string    `json:"videoId"`
	Title           string    `json:"title"`
	Author          string    `json:"author"`
	CoverURL        string    `json:"coverUrl"` // 封面图片 URL
	VideoURL        string    `json:"videoUrl"`
	DecryptKey      string    `json:"decryptKey"` // 加密视频的解密密钥
	Duration        int64     `json:"duration"`   // 视频时长（秒）
	Resolution      string    `json:"resolution"` // 视频分辨率（例如 "1080p"）
	TotalSize       int64     `json:"totalSize"`
	DownloadedSize  int64     `json:"downloadedSize"`
	Status          string    `json:"status"` // pending, downloading, paused, completed, failed
	Priority        int       `json:"priority"`
	AddedTime       time.Time `json:"addedTime"`
	StartTime       time.Time `json:"startTime"`
	Speed           int64     `json:"speed"`
	ChunkSize       int64     `json:"chunkSize"`
	ChunksTotal     int       `json:"chunksTotal"`
	ChunksCompleted int       `json:"chunksCompleted"`
	RetryCount      int       `json:"retryCount"`
	ErrorMessage    string    `json:"errorMessage"`
	CreatedAt       time.Time `json:"createdAt"`
	UpdatedAt       time.Time `json:"updatedAt"`
}

// QueueStatus 常量
const (
	QueueStatusPending     = "pending"
	QueueStatusDownloading = "downloading"
	QueueStatusPaused      = "paused"
	QueueStatusCompleted   = "completed"
	QueueStatusFailed      = "failed"
)

// Settings 表示应用程序设置
type Settings struct {
	DownloadDir        string `json:"downloadDir"`
	ChunkSize          int64  `json:"chunkSize"`
	ConcurrentLimit    int    `json:"concurrentLimit"`
	AutoCleanupEnabled bool   `json:"autoCleanupEnabled"`
	AutoCleanupDays    int    `json:"autoCleanupDays"`
	MaxRetries         int    `json:"maxRetries"`
	RadarEnabled       bool   `json:"radarEnabled"`
	Theme              string `json:"theme"`
}

// DefaultSettings 返回默认设置
func DefaultSettings() *Settings {
	return &Settings{
		DownloadDir:        "downloads",
		ChunkSize:          10 * 1024 * 1024, // 10MB
		ConcurrentLimit:    3,
		AutoCleanupEnabled: false,
		AutoCleanupDays:    30,
		MaxRetries:         3,
		RadarEnabled:       false,
		Theme:              "light",
	}
}

// PaginationParams 表示分页参数
type PaginationParams struct {
	Page     int    `json:"page"`
	PageSize int    `json:"pageSize"`
	SortBy   string `json:"sortBy"`
	SortDesc bool   `json:"sortDesc"`
}

// FilterParams 表示下载记录的过滤参数
type FilterParams struct {
	PaginationParams
	StartDate *time.Time `json:"startDate"`
	EndDate   *time.Time `json:"endDate"`
	Status    string     `json:"status"`
	Query     string     `json:"query"`
}

// PagedResult 表示分页结果
type PagedResult[T any] struct {
	Items      []T   `json:"items"`
	Total      int64 `json:"total"`
	Page       int   `json:"page"`
	PageSize   int   `json:"pageSize"`
	TotalPages int   `json:"totalPages"`
}

// NewPagedResult 创建一个新的分页结果
func NewPagedResult[T any](items []T, total int64, page, pageSize int) *PagedResult[T] {
	totalPages := int(total) / pageSize
	if int(total)%pageSize > 0 {
		totalPages++
	}
	return &PagedResult[T]{
		Items:      items,
		Total:      total,
		Page:       page,
		PageSize:   pageSize,
		TotalPages: totalPages,
	}
}

// VideoContactInfo 表示存入 task_videos 表的 video_data 结构
type VideoContactInfo struct {
	ID             string   `json:"id"` // 视频 id，用于防重
	Keyword        string   `json:"keyword"`
	HeadUrl        string   `json:"headUrl"`
	Nickname       string   `json:"nickname"`
	Signature      string   `json:"signature"`
	Location       Location `json:"location"`
	Username       string   `json:"username"`
	NormalUsername string   `json:"normalUsername"`
}

// Location 表示地理位置信息
type Location struct {
	City     string `json:"city"`
	Country  string `json:"country"`
	Province string `json:"province"`
}

// RadarLog 表示雷达监控的单次执行记录
type RadarLog struct {
	ID           string    `json:"id"`
	TargetID     string    `json:"target_id"`
	CheckTime    time.Time `json:"check_time"`
	FoundVideos  int       `json:"found_videos"`
	NewVideos    int       `json:"new_videos"`
	Status       string    `json:"status"` // success 或 error
	ErrorMessage string    `json:"error_message"`
	VideoList    string    `json:"video_list"` // JSON 数组，存储每个视频的详情摘要
}

// RadarVideoSummary 单次扫描中某个视频的摘要信息
type RadarVideoSummary struct {
	VideoID string `json:"video_id"`
	Title   string `json:"title"`
	IsNew   bool   `json:"is_new"` // true=新视频并已加入队列，false=已存在
}

// SearchTask 表示搜索任务记录
type SearchTask struct {
	DBID         int64     `json:"db_id"`          // 数据库自增主键
	ID           string    `json:"id"`             // 任务ID，格式: search_keyword_videocontact_{timestamp}
	TaskID       string    `json:"task_id"`        // 同上，业务键
	Keyword      string    `json:"keyword"`       // 搜索关键词
	TargetCount  int       `json:"target_count"`  // 目标数量
	CurrentCount int       `json:"current_count"` // 当前已采集数量
	Status       string    `json:"status"`        // pending, running, completed, failed
	WindowID     string    `json:"window_id"`     // 关联的窗口ID
	CreatedAt    time.Time `json:"created_at"`
	StartedAt    time.Time `json:"started_at"`
	CompletedAt  time.Time `json:"completed_at"`
	ErrorMessage string    `json:"error_message"` // 错误信息
	TaskType     string    `json:"task_type"`      // 任务类型
	VideoList    string    `json:"video_list"`    // 采集到的视频列表 (JSON)
}

// 任务状态常量
const (
	TaskStatusPending                       = "pending"
	TaskStatusListening                     = "listening"
	TaskStatusRunning                       = "running"
	TaskStatusPaused                        = "paused"
	TaskStatusCompleted                     = "completed"
	TaskStatusCompletedWithInsufficientData = "completed_with_insufficient_data"
	TaskStatusFailed                        = "failed"
	TaskStatusStopped                       = "stopped"
)

// TaskContext 任务上下文
type TaskContext struct {
	TaskID      string
	Keyword     string
	TargetCount int
	Type        string
	Status      string
	VideoList   []VideoContactInfo
	CreatedAt   time.Time
}

// StartSearchTaskRequest 开始搜索任务请求
type StartSearchTaskRequest struct {
	Keyword     string `json:"keyword"`
	TargetCount int    `json:"target_count"`
	TaskType    string `json:"task_type"`
}

// SearchTaskService 搜索任务服务
type SearchTaskService struct {
	repo         *TaskRepository
	pendingTasks map[string]*TaskContext
	mu           sync.RWMutex
}

// NewSearchTaskService 创建搜索任务服务
func NewSearchTaskService() *SearchTaskService {
	return &SearchTaskService{
		repo:         NewTaskRepository(),
		pendingTasks: make(map[string]*TaskContext),
	}
}

// EnsureTablesExist 确保数据库表存在
func (s *SearchTaskService) EnsureTablesExist() {
	s.repo.EnsureTablesExist()
}

// StartSearchTask 开始搜索任务
func (s *SearchTaskService) StartSearchTask(req StartSearchTaskRequest) (*TaskContext, error) {
	taskID := fmt.Sprintf("%s_%d", req.TaskType, time.Now().UnixMilli())

	task := &SearchTask{
		ID:           taskID,
		TaskID:       taskID,
		TaskType:     req.TaskType,
		Keyword:      req.Keyword,
		TargetCount:  req.TargetCount,
		CurrentCount: 0,
		Status:       TaskStatusListening,
		VideoList:    "[]",
	}

	if err := s.repo.CreateTask(task); err != nil {
		utils.LogError("创建任务失败: %v", err)
		return nil, fmt.Errorf("创建任务失败: %w", err)
	}

	ctx := &TaskContext{
		TaskID:      taskID,
		Keyword:     req.Keyword,
		TargetCount: req.TargetCount,
		Type:        req.TaskType,
		Status:      TaskStatusListening,
		VideoList:   make([]VideoContactInfo, 0),
		CreatedAt:   time.Now(),
	}

	s.mu.Lock()
	s.pendingTasks[taskID] = ctx
	s.mu.Unlock()

	utils.LogInfo("创建搜索任务成功: %s, 关键词: %s, 目标数量: %d", taskID, req.Keyword, req.TargetCount)

	return ctx, nil
}

// GetTask 获取任务上下文（先从内存查找，找不到则从数据库查找）
func (s *SearchTaskService) GetTask(taskID string) *TaskContext {
	// 先从内存中查找
	s.mu.RLock()
	if ctx, ok := s.pendingTasks[taskID]; ok {
		s.mu.RUnlock()
		return ctx
	}
	s.mu.RUnlock()

	// 内存中找不到，从数据库查找
	task, err := s.repo.GetTask(taskID)
	if err != nil || task == nil {
		return nil
	}

	// 优先从 task_videos 表读取视频数据（这是实际存储位置）
	videoList, _ := s.repo.GetTaskVideos(taskID)

	// 重建上下文
	ctx := &TaskContext{
		TaskID:      task.ID,
		Keyword:     task.Keyword,
		TargetCount: task.TargetCount,
		Type:        task.TaskType,
		Status:      task.Status,
		VideoList:   videoList,
		CreatedAt:   task.CreatedAt,
	}

	// 放回内存以便后续更新
	s.mu.Lock()
	s.pendingTasks[taskID] = ctx
	s.mu.Unlock()

	return ctx
}

// SetTaskFailed 标记任务失败
func (s *SearchTaskService) SetTaskFailed(taskID string, errMsg string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if ctx, ok := s.pendingTasks[taskID]; ok {
		ctx.Status = TaskStatusFailed
	}
}

// AddVideoToTask 向任务添加视频（内存+数据库）
// videoIndex 使用视频的 id 作为唯一标识，同一任务内不重复（防重）
// video_data 存储时会转换为 VideoContactInfo 结构
func (s *SearchTaskService) AddVideoToTask(taskID string, video map[string]interface{}) (count int, inserted bool) {
	videoIndex := ""
	if id, ok := video["id"]; ok {
		videoIndex = fmt.Sprintf("%v", id)
	}
	if videoIndex == "" {
		utils.LogWarn("[AddVideoToTask] 视频缺少 id 字段，无法入库: %v", video["title"])
		return 0, false
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	ctx, ok := s.pendingTasks[taskID]
	if !ok {
		return 0, false
	}

	for _, v := range ctx.VideoList {
		if v.ID == videoIndex {
			return len(ctx.VideoList), false
		}
	}

	transformed := buildVideoContactInfo(ctx.Keyword, video, videoIndex)

	ctx.VideoList = append(ctx.VideoList, transformed)

	inserted = s.saveVideoToDB(taskID, transformed, videoIndex)
	count = len(ctx.VideoList)

	return count, inserted
}

// buildVideoContactInfo 从原始视频数据构建 VideoContactInfo
func buildVideoContactInfo(keyword string, video map[string]interface{}, videoIndex string) VideoContactInfo {
	contact, _ := video["contact"].(map[string]interface{})
	extInfo, _ := contact["extInfo"].(map[string]interface{})

	username := getStringField(video, "username")
	var usernameURL string
	if username != "" {
		usernameURL = fmt.Sprintf("https://channels.weixin.qq.com/web/pages/profile?username=%s", username)
	}

	return VideoContactInfo{
		ID:        videoIndex,
		Keyword:   keyword,
		HeadUrl:   getStringField(contact, "headUrl"),
		Nickname:  getStringField(video, "nickname"),
		Signature: getStringField(contact, "signature"),
		Location: Location{
			City:     getStringField(extInfo, "city"),
			Country:  getStringField(extInfo, "country"),
			Province: getStringField(extInfo, "province"),
		},
		Username:       usernameURL,
		NormalUsername: username,
	}
}

// getStringField 安全获取嵌套 map 中的 string 字段
func getStringField(m map[string]interface{}, key string) string {
	if m == nil {
		return ""
	}
	if val, ok := m[key]; ok {
		if s, ok := val.(string); ok {
			return s
		}
	}
	return ""
}

// saveVideoToDB 单条视频存入数据库（异步）
// videoIndex 使用视频的 id 作为唯一标识，INSERT OR IGNORE 自动忽略重复
func (s *SearchTaskService) saveVideoToDB(taskID string, video interface{}, videoIndex string) bool {
	videoJSON, _ := json.Marshal(video)
	task := &SearchTask{
		ID:        taskID,
		VideoList: string(videoJSON),
	}
	err := s.repo.AppendVideoWithIndex(task, videoIndex)
	if err != nil {
		utils.LogWarn("[saveVideoToDB] 入库失败: taskID=%s, videoIndex=%s, err=%v", taskID, videoIndex, err)
		return false
	}
	return true
}

// PersistTaskStatus 持久化任务状态到数据库
func (s *SearchTaskService) PersistTaskStatus(taskID string, status string) error {
	s.mu.Lock()
	ctx, ok := s.pendingTasks[taskID]
	if !ok {
		s.mu.Unlock()
		return fmt.Errorf("任务不存在: %s", taskID)
	}
	ctx.Status = status
	s.mu.Unlock()

	task := &SearchTask{
		ID:           taskID,
		CurrentCount: s.GetVideoCount(taskID),
		Status:       status,
	}

	return s.repo.UpdateTask(task)
}

// GetTargetCount 获取任务目标数量
func (s *SearchTaskService) GetTargetCount(taskID string) int {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if ctx, ok := s.pendingTasks[taskID]; ok {
		return ctx.TargetCount
	}
	return 0
}

// GetVideoCount 获取任务已入库的视频数量（以数据库为准）
func (s *SearchTaskService) GetVideoCount(taskID string) int {
	count, err := s.repo.GetVideoCount(taskID)
	if err != nil {
		utils.LogWarn("[GetVideoCount] 查询失败: taskID=%s, err=%v", taskID, err)
		return 0
	}
	return count
}

// PersistTaskWithVideos 持久化任务和视频列表到数据库
func (s *SearchTaskService) PersistTaskWithVideos(taskID string, status string) error {
	s.mu.RLock()
	ctx := s.pendingTasks[taskID]
	s.mu.RUnlock()

	if ctx == nil {
		return fmt.Errorf("任务不存在: %s", taskID)
	}

	videoListJSON, err := json.Marshal(ctx.VideoList)
	if err != nil {
		return err
	}

	task := &SearchTask{
		ID:           taskID,
		CurrentCount: len(ctx.VideoList),
		Status:       status,
		VideoList:    string(videoListJSON),
	}

	return s.repo.UpdateTask(task)
}

// GetAllTasks 获取所有任务
func (s *SearchTaskService) GetAllTasks() []*SearchTask {
	tasks, err := s.repo.GetAllTasks()
	if err != nil {
		utils.LogError("获取任务列表失败: %v", err)
		return nil
	}
	return tasks
}

// GetListeningTasksByKeyword 获取指定关键词的 listening 任务（内存优先，数据库兜底）
func (s *SearchTaskService) GetListeningTasksByKeyword(keyword string) []*TaskContext {
	var result []*TaskContext

	// 1. 先从内存查找
	s.mu.RLock()
	for _, ctx := range s.pendingTasks {
		if ctx.Keyword == keyword && ctx.Status == TaskStatusListening {
			result = append(result, ctx)
		}
	}
	s.mu.RUnlock()

	if len(result) > 0 {
		return result
	}

	// 2. 内存没有，从数据库查找
	dbTasks, err := s.repo.GetTasksByStatus(TaskStatusListening)
	if err != nil || len(dbTasks) == 0 {
		return result
	}

	for _, t := range dbTasks {
		if t.Keyword == keyword {
			videoList, _ := s.repo.GetTaskVideos(t.ID)
			if videoList == nil {
				videoList = []VideoContactInfo{}
			}
			ctx := &TaskContext{
				TaskID:      t.ID,
				Keyword:     t.Keyword,
				TargetCount: t.TargetCount,
				Type:        t.TaskType,
				Status:      t.Status,
				VideoList:   videoList,
				CreatedAt:   t.CreatedAt,
			}
			// 放回内存
			s.mu.Lock()
			s.pendingTasks[t.ID] = ctx
			s.mu.Unlock()
			result = append(result, ctx)
		}
	}

	return result
}

// DeleteTask 删除任务（同时删除任务及其视频数据）
func (s *SearchTaskService) DeleteTask(taskID string) error {
	// 从内存中移除
	s.mu.Lock()
	delete(s.pendingTasks, taskID)
	s.mu.Unlock()

	// 从数据库删除任务和视频数据
	return s.repo.DeleteTask(taskID)
}
