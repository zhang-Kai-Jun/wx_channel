package database

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"time"
)

// TaskRepository 任务数据库操作
type TaskRepository struct {
	db *sql.DB
}

// NewTaskRepository 创建任务仓库
func NewTaskRepository() *TaskRepository {
	return &TaskRepository{}
}

// EnsureTablesExist 主动调用确保表存在（在数据库初始化后调用）
func (r *TaskRepository) EnsureTablesExist() {
	db := r.GetDB()
	if db == nil {
		return
	}
	r.ensureTablesExist()
}

// ensureTablesExist 内部方法：确保必要的表存在
func (r *TaskRepository) ensureTablesExist() {
	db := r.GetDB()
	if db == nil {
		return
	}

	// 创建 search_tasks 表
	db.Exec(`
		CREATE TABLE IF NOT EXISTS search_tasks (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			task_id TEXT NOT NULL UNIQUE,
			keyword TEXT NOT NULL,
			target_count INTEGER,
			current_count INTEGER,
			status TEXT NOT NULL,
			window_id TEXT,
			created_at DATETIME,
			started_at DATETIME,
			completed_at DATETIME,
			error_message TEXT,
			task_type TEXT,
			video_list TEXT
		)
	`)

	// 创建 task_videos 表
	// video_index 使用视频的 id 作为唯一标识，同一任务内不重复
	db.Exec(`
		CREATE TABLE IF NOT EXISTS task_videos (
			id TEXT PRIMARY KEY,
			task_id TEXT NOT NULL,
			video_data TEXT NOT NULL,
			video_index TEXT NOT NULL DEFAULT '',
			created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
			FOREIGN KEY(task_id) REFERENCES search_tasks(task_id) ON DELETE CASCADE
		)
	`)

	// 创建索引
	db.Exec(`CREATE INDEX IF NOT EXISTS idx_task_videos_task_id ON task_videos(task_id)`)
	// 【关键】唯一索引：同一任务内 video_index（视频id）不能重复，用于防重
	db.Exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_task_videos_unique ON task_videos(task_id, video_index)`)
}

// GetDB 获取数据库连接（懒加载）
func (r *TaskRepository) GetDB() *sql.DB {
	if r.db == nil {
		r.db = GetDB()
	}
	return r.db
}

// CreateTask 创建新任务
func (r *TaskRepository) CreateTask(task *SearchTask) error {
	query := `
		INSERT INTO search_tasks (task_id, keyword, target_count, current_count, status, window_id, created_at, started_at, completed_at, error_message, task_type, video_list)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`
	now := time.Now()
	task.CreatedAt = now

	_, err := r.GetDB().Exec(query,
		task.TaskID,
		task.Keyword,
		task.TargetCount,
		task.CurrentCount,
		task.Status,
		task.WindowID,
		task.CreatedAt,
		nullTime(task.StartedAt),
		nullTime(task.CompletedAt),
		nullString(task.ErrorMessage),
		nullString(task.TaskType),
		nullString(task.VideoList),
	)
	return err
}

func nullTime(t time.Time) interface{} {
	if t.IsZero() {
		return nil
	}
	return t
}

func nullString(s string) interface{} {
	if s == "" {
		return nil
	}
	return s
}

// GetTask 获取任务
func (r *TaskRepository) GetTask(id string) (*SearchTask, error) {
	query := `
		SELECT id, task_id, keyword, target_count, current_count, status, window_id,
		       created_at, started_at, completed_at, error_message, task_type, video_list
		FROM search_tasks WHERE task_id = ?
	`
	var task SearchTask
	var startedAt, completedAt sql.NullTime
	var windowID, errMsg, taskType, videoList sql.NullString
	err := r.GetDB().QueryRow(query, id).Scan(
		&task.DBID,
		&task.TaskID,
		&task.Keyword,
		&task.TargetCount,
		&task.CurrentCount,
		&task.Status,
		&windowID,
		&task.CreatedAt,
		&startedAt,
		&completedAt,
		&errMsg,
		&taskType,
		&videoList,
	)
	if err != nil {
		return nil, err
	}
	if startedAt.Valid {
		task.StartedAt = startedAt.Time
	}
	if completedAt.Valid {
		task.CompletedAt = completedAt.Time
	}
	task.WindowID = windowID.String
	task.ErrorMessage = errMsg.String
	task.TaskType = taskType.String
	task.VideoList = nullStringDefault(videoList.String, "[]")
	task.ID = task.TaskID
	return &task, nil
}

func nullStringDefault(s, def string) string {
	if s == "" {
		return def
	}
	return s
}

// UpdateTask 更新任务
func (r *TaskRepository) UpdateTask(task *SearchTask) error {
	query := `
		UPDATE search_tasks
		SET current_count = ?, status = ?, window_id = ?, started_at = ?,
		    completed_at = ?, error_message = ?, task_type = ?, video_list = ?
		WHERE task_id = ?
	`
	_, err := r.GetDB().Exec(query,
		task.CurrentCount,
		task.Status,
		nullString(task.WindowID),
		nullTime(task.StartedAt),
		nullTime(task.CompletedAt),
		nullString(task.ErrorMessage),
		nullString(task.TaskType),
		nullString(task.VideoList),
		task.ID,
	)
	return err
}

// GetAllTasks 获取所有任务
func (r *TaskRepository) GetAllTasks() ([]*SearchTask, error) {
	query := `
		SELECT id, task_id, keyword, target_count, current_count, status, window_id,
		       created_at, started_at, completed_at, error_message, task_type, video_list
		FROM search_tasks ORDER BY created_at DESC LIMIT 100
	`
	rows, err := r.GetDB().Query(query)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var tasks []*SearchTask
	for rows.Next() {
		var task SearchTask
		var startedAt, completedAt sql.NullTime
		var windowID, errMsg, taskType, videoList sql.NullString
		if err := rows.Scan(
			&task.DBID,
			&task.TaskID,
			&task.Keyword,
			&task.TargetCount,
			&task.CurrentCount,
			&task.Status,
			&windowID,
			&task.CreatedAt,
			&startedAt,
			&completedAt,
			&errMsg,
			&taskType,
			&videoList,
		); err != nil {
			return nil, err
		}
		if startedAt.Valid {
			task.StartedAt = startedAt.Time
		}
		if completedAt.Valid {
			task.CompletedAt = completedAt.Time
		}
		task.WindowID = windowID.String
		task.ErrorMessage = errMsg.String
		task.TaskType = taskType.String
		task.VideoList = nullStringDefault(videoList.String, "[]")
		task.ID = task.TaskID
		tasks = append(tasks, &task)
	}
	return tasks, nil
}

// GetTasksByStatus 按状态获取任务列表
func (r *TaskRepository) GetTasksByStatus(status string) ([]*SearchTask, error) {
	query := `
		SELECT id, task_id, keyword, target_count, current_count, status, window_id,
		       created_at, started_at, completed_at, error_message, task_type, video_list
		FROM search_tasks WHERE status = ? ORDER BY created_at DESC
	`
	rows, err := r.GetDB().Query(query, status)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var tasks []*SearchTask
	for rows.Next() {
		var task SearchTask
		var startedAt, completedAt sql.NullTime
		var windowID, errMsg, taskType, videoList sql.NullString
		if err := rows.Scan(
			&task.DBID,
			&task.TaskID,
			&task.Keyword,
			&task.TargetCount,
			&task.CurrentCount,
			&task.Status,
			&windowID,
			&task.CreatedAt,
			&startedAt,
			&completedAt,
			&errMsg,
			&taskType,
			&videoList,
		); err != nil {
			return nil, err
		}
		if startedAt.Valid {
			task.StartedAt = startedAt.Time
		}
		if completedAt.Valid {
			task.CompletedAt = completedAt.Time
		}
		task.WindowID = windowID.String
		task.ErrorMessage = errMsg.String
		task.TaskType = taskType.String
		task.VideoList = nullStringDefault(videoList.String, "[]")
		task.ID = task.TaskID
		tasks = append(tasks, &task)
	}
	return tasks, nil
}

// AppendVideoWithIndex 追加视频到 task_videos 表
// videoIndex 使用视频的 id 作为唯一标识，同一任务内不重复（防重）
// 使用 INSERT OR IGNORE 配合数据库唯一索引，自动忽略重复数据
func (r *TaskRepository) AppendVideoWithIndex(task *SearchTask, videoIndex string) error {
	query := `
		INSERT OR IGNORE INTO task_videos (id, task_id, video_data, video_index)
		VALUES (?, ?, ?, ?)
	`
	_, err := r.GetDB().Exec(query,
		generateID(),
		task.ID,
		task.VideoList,
		videoIndex,
	)
	return err
}

// GetVideoCount 获取任务已入库的视频数量（以数据库为准）
func (r *TaskRepository) GetVideoCount(taskID string) (int, error) {
	var count int
	err := r.GetDB().QueryRow("SELECT COUNT(*) FROM task_videos WHERE task_id = ?", taskID).Scan(&count)
	return count, err
}

// GetTaskVideos 获取任务的所有视频（按 video_index 升序返回）
func (r *TaskRepository) GetTaskVideos(taskID string) ([]VideoContactInfo, error) {
	query := `
		SELECT video_data FROM task_videos
		WHERE task_id = ? ORDER BY video_index ASC
	`
	rows, err := r.GetDB().Query(query, taskID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var videos []VideoContactInfo
	for rows.Next() {
		var videoData string
		if err := rows.Scan(&videoData); err != nil {
			continue
		}
		var video VideoContactInfo
		if err := json.Unmarshal([]byte(videoData), &video); err == nil {
			videos = append(videos, video)
		}
	}
	return videos, nil
}

// DeleteTask 删除任务及其所有视频数据（事务）
func (r *TaskRepository) DeleteTask(taskID string) error {
	db := r.GetDB()
	if db == nil {
		return fmt.Errorf("database not available")
	}

	// 使用事务确保原子性
	tx, err := db.Begin()
	if err != nil {
		return err
	}
	defer func() {
		if err != nil {
			tx.Rollback()
		}
	}()

	// 删除视频数据
	_, err = tx.Exec("DELETE FROM task_videos WHERE task_id = ?", taskID)
	if err != nil {
		return err
	}

	// 删除任务记录
	_, err = tx.Exec("DELETE FROM search_tasks WHERE task_id = ?", taskID)
	if err != nil {
		return err
	}

	return tx.Commit()
}

// generateID 生成唯一ID
func generateID() string {
	return fmt.Sprintf("%d", time.Now().UnixNano())
}
