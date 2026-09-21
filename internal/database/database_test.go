package database

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func setupTestDB(t *testing.T) func() {
	// 创建测试数据库的临时目录
	tmpDir, err := os.MkdirTemp("", "wx_channel_test_*")
	if err != nil {
		t.Fatalf("Failed to create temp dir: %v", err)
	}

	dbPath := filepath.Join(tmpDir, "test.db")

	// 直接打开数据库进行测试（绕过 once）
	testDB, err := openDatabase(dbPath)
	if err != nil {
		os.RemoveAll(tmpDir)
		t.Fatalf("Failed to open database: %v", err)
	}

	// 设置全局数据库
	db = testDB

	// 运行迁移
	if err := runMigrations(); err != nil {
		testDB.Close()
		os.RemoveAll(tmpDir)
		t.Fatalf("Failed to run migrations: %v", err)
	}

	return func() {
		if db != nil {
			db.Close()
			db = nil
		}
		os.RemoveAll(tmpDir)
		// 重置初始化状态以便下次初始化
		initialized = false
	}
}

func TestBrowseHistoryRepository(t *testing.T) {
	cleanup := setupTestDB(t)
	defer cleanup()

	repo := NewBrowseHistoryRepository()

	// 测试创建
	record := &BrowseRecord{
		ID:           "test-video-1",
		Title:        "Test Video",
		Author:       "Test Author",
		AuthorID:     "author-1",
		Duration:     120,
		Size:         1024000,
		CoverURL:     "https://example.com/cover.jpg",
		VideoURL:     "https://example.com/video.mp4",
		BrowseTime:   time.Now(),
		LikeCount:    100,
		CommentCount: 50,
		FavCount:     25,
		ForwardCount: 30,
		PageURL:      "https://example.com/page",
	}

	err := repo.Create(record)
	if err != nil {
		t.Fatalf("Failed to create browse record: %v", err)
	}

	// 测试根据 ID 获取
	retrieved, err := repo.GetByID("test-video-1")
	if err != nil {
		t.Fatalf("Failed to get browse record: %v", err)
	}
	if retrieved == nil {
		t.Fatal("Expected record, got nil")
	}
	if retrieved.Title != "Test Video" {
		t.Errorf("Expected title 'Test Video', got '%s'", retrieved.Title)
	}

	// 测试更新
	record.Title = "Updated Title"
	err = repo.Update(record)
	if err != nil {
		t.Fatalf("Failed to update browse record: %v", err)
	}

	retrieved, _ = repo.GetByID("test-video-1")
	if retrieved.Title != "Updated Title" {
		t.Errorf("Expected title 'Updated Title', got '%s'", retrieved.Title)
	}

	// 测试列表
	result, err := repo.List(&PaginationParams{Page: 1, PageSize: 10, SortDesc: true})
	if err != nil {
		t.Fatalf("Failed to list browse records: %v", err)
	}
	if result.Total != 1 {
		t.Errorf("Expected 1 record, got %d", result.Total)
	}

	// 测试搜索
	searchResult, err := repo.Search("Updated", &PaginationParams{Page: 1, PageSize: 10})
	if err != nil {
		t.Fatalf("Failed to search browse records: %v", err)
	}
	if searchResult.Total != 1 {
		t.Errorf("Expected 1 search result, got %d", searchResult.Total)
	}

	// 测试删除
	err = repo.Delete("test-video-1")
	if err != nil {
		t.Fatalf("Failed to delete browse record: %v", err)
	}

	retrieved, _ = repo.GetByID("test-video-1")
	if retrieved != nil {
		t.Error("Expected nil after delete, got record")
	}
}
