package database

import (
	"sync"
	"testing"
	"time"
)

func TestBrowseCreateIdempotent(t *testing.T) {
	defer setupTestDB(t)()
	repo := NewBrowseHistoryRepository()
	first := &BrowseRecord{ID: "same", Title: "title", Author: "author", DecryptKey: "key", BrowseTime: time.Now()}
	if err := repo.Create(first); err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	errs := make(chan error, 8)
	later := first.BrowseTime.Add(time.Minute)
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			errs <- repo.Create(&BrowseRecord{ID: "same", BrowseTime: later, DecryptKey: "other"})
		}()
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
	got, err := repo.GetByID("same")
	if err != nil {
		t.Fatal(err)
	}
	if got.Title != "title" || got.Author != "author" || got.DecryptKey != "key" || !got.CreatedAt.Equal(first.CreatedAt) || !got.BrowseTime.Equal(later) {
		t.Fatalf("lost record: %+v", got)
	}
}
