package services

import (
	"fmt"

	"time"

	"wx_channel/internal/database"
)

// CleanupResult 包含清理操作的结果
type CleanupResult struct {
	BrowseRecordsDeleted int64     `json:"browseRecordsDeleted"`
	CleanupTime          time.Time `json:"cleanupTime"`
	Errors               []string  `json:"errors,omitempty"`
}

// CleanupService 处理数据清理操作
// Requirements: 5.1, 5.2, 5.3, 5.5, 11.5
type CleanupService struct {
	browseRepo   *database.BrowseHistoryRepository
	settingsRepo *database.SettingsRepository
}

// NewCleanupService 创建一个新的 CleanupService
func NewCleanupService() *CleanupService {
	return &CleanupService{
		browseRepo:   database.NewBrowseHistoryRepository(),
		settingsRepo: database.NewSettingsRepository(),
	}
}

// ClearBrowseHistory 清空所有浏览历史记录
// Requirements: 5.1, 5.2 - 清空所有浏览历史（需确认）
func (s *CleanupService) ClearBrowseHistory() (*CleanupResult, error) {
	// 清空前获取计数
	count, err := s.browseRepo.Count()
	if err != nil {
		return nil, fmt.Errorf("failed to count browse records: %w", err)
	}

	// 清空所有记录
	if err := s.browseRepo.Clear(); err != nil {
		return nil, fmt.Errorf("failed to clear browse history: %w", err)
	}

	return &CleanupResult{
		BrowseRecordsDeleted: count,
		CleanupTime:          time.Now(),
	}, nil
}

// DeleteBrowseRecordsBefore 删除指定日期前的浏览记录
// Requirements: 5.5 - 基于日期的清理
func (s *CleanupService) DeleteBrowseRecordsBefore(date time.Time) (*CleanupResult, error) {
	count, err := s.browseRepo.DeleteBefore(date)
	if err != nil {
		return nil, fmt.Errorf("failed to delete browse records before %v: %w", date, err)
	}

	return &CleanupResult{
		BrowseRecordsDeleted: count,
		CleanupTime:          time.Now(),
	}, nil
}

// RunAutoCleanup 根据设置运行自动清理
// Requirements: 11.5 - 基于设置的自动清理
func (s *CleanupService) RunAutoCleanup() (*CleanupResult, error) {
	// 加载设置
	settings, err := s.settingsRepo.Load()
	if err != nil {
		return nil, fmt.Errorf("failed to load settings: %w", err)
	}

	// 检查自动清理是否启用
	if !settings.AutoCleanupEnabled {
		return &CleanupResult{
			CleanupTime: time.Now(),
		}, nil
	}

	// 计算截止日期
	cutoffDate := time.Now().AddDate(0, 0, -settings.AutoCleanupDays)

	// 删除旧的浏览记录
	browseResult, err := s.DeleteBrowseRecordsBefore(cutoffDate)
	if err != nil {
		return nil, fmt.Errorf("failed to cleanup browse records: %w", err)
	}

	return &CleanupResult{
		BrowseRecordsDeleted: browseResult.BrowseRecordsDeleted,
		CleanupTime:          time.Now(),
	}, nil
}

// DeleteSelectedBrowseRecords 按 ID 删除特定的浏览记录
// Requirements: 5.4 - 选择性删除
func (s *CleanupService) DeleteSelectedBrowseRecords(ids []string) (*CleanupResult, error) {
	count, err := s.browseRepo.DeleteMany(ids)
	if err != nil {
		return nil, fmt.Errorf("failed to delete selected browse records: %w", err)
	}

	return &CleanupResult{
		BrowseRecordsDeleted: count,
		CleanupTime:          time.Now(),
	}, nil
}
