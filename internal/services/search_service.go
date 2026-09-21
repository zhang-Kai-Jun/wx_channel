package services

import (
	"wx_channel/internal/database"
)

// SearchResult 表示全局搜索结果
// Requirements: 12.2 - 按来源分组并显示计数
type SearchResult struct {
	BrowseResults []database.BrowseRecord `json:"browseResults"`
	BrowseCount   int64                   `json:"browseCount"`
	TotalCount    int64                   `json:"totalCount"`
}

// SearchService 处理全局搜索业务逻辑
type SearchService struct {
	browseRepo *database.BrowseHistoryRepository
}

// NewSearchService 创建一个新的 SearchService
func NewSearchService() *SearchService {
	return &SearchService{
		browseRepo: database.NewBrowseHistoryRepository(),
	}
}

// Search 在浏览记录中执行全局搜索
// Requirements: 12.1 - 搜索浏览记录
// Requirements: 12.2 - 按来源分组并显示计数
func (s *SearchService) Search(query string, limit int) (*SearchResult, error) {
	if limit < 1 {
		limit = 20
	}

	result := &SearchResult{
		BrowseResults: []database.BrowseRecord{},
	}

	// 搜索浏览记录
	browseParams := &database.PaginationParams{
		Page:     1,
		PageSize: limit,
		SortBy:   "browse_time",
		SortDesc: true,
	}
	browseResult, err := s.browseRepo.Search(query, browseParams)
	if err != nil {
		return nil, err
	}
	result.BrowseResults = browseResult.Items
	result.BrowseCount = browseResult.Total

	result.TotalCount = result.BrowseCount

	return result, nil
}

// SearchBrowse 仅搜索浏览记录
func (s *SearchService) SearchBrowse(query string, params *database.PaginationParams) (*database.PagedResult[database.BrowseRecord], error) {
	if params == nil {
		params = &database.PaginationParams{
			Page:     1,
			PageSize: 20,
			SortBy:   "browse_time",
			SortDesc: true,
		}
	}
	return s.browseRepo.Search(query, params)
}
