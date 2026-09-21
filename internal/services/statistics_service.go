package services

import (
	"wx_channel/internal/database"
)

// Statistics 表示仪表盘统计数据
type Statistics struct {
	TotalBrowseCount int64                   `json:"totalBrowseCount"`
	RecentBrowse     []database.BrowseRecord `json:"recentBrowse"`
}

// StatisticsService 处理统计业务逻辑
type StatisticsService struct {
	browseRepo *database.BrowseHistoryRepository
}

// NewStatisticsService 创建一个新的 StatisticsService
func NewStatisticsService() *StatisticsService {
	return &StatisticsService{
		browseRepo: database.NewBrowseHistoryRepository(),
	}
}

// GetStatistics 返回仪表盘统计数据
func (s *StatisticsService) GetStatistics() (*Statistics, error) {
	stats := &Statistics{}

	// 获取总浏览计数
	browseCount, err := s.browseRepo.Count()
	if err != nil {
		return nil, err
	}
	stats.TotalBrowseCount = browseCount

	// 获取最近的浏览记录
	// Requirements: 7.3 - 最近 5 个视频
	recentBrowse, err := s.browseRepo.GetRecent(5)
	if err != nil {
		return nil, err
	}
	stats.RecentBrowse = recentBrowse

	return stats, nil
}

// GetRecentBrowse 获取最近的浏览记录
// Requirements: 7.3 - 仪表盘上的最近 5 个视频
func (s *StatisticsService) GetRecentBrowse(limit int) ([]database.BrowseRecord, error) {
	if limit < 1 {
		limit = 5
	}
	return s.browseRepo.GetRecent(limit)
}
