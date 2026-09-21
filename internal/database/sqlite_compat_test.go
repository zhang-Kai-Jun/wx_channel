package database

import (
	"context"
	"path/filepath"
	"testing"
	"time"
)

func TestNativeSQLiteConnections(t *testing.T) {
	defer Close()
	cfg := &Config{DBPath: filepath.Join(t.TempDir(), "records.db")}
	if err := Initialize(cfg); err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	for i := 0; i < 2; i++ {
		conn, err := db.Conn(ctx)
		if err != nil {
			t.Fatal(err)
		}
		defer conn.Close()
		var mode string
		if err := conn.QueryRowContext(ctx, "PRAGMA journal_mode").Scan(&mode); err != nil || mode != "wal" {
			t.Fatalf("journal_mode=%s, err=%v", mode, err)
		}
		var foreignKeys, timeout int
		if err := conn.QueryRowContext(ctx, "PRAGMA foreign_keys").Scan(&foreignKeys); err != nil || foreignKeys != 1 {
			t.Fatalf("foreign_keys=%d, err=%v", foreignKeys, err)
		}
		if err := conn.QueryRowContext(ctx, "PRAGMA busy_timeout").Scan(&timeout); err != nil || timeout != 5000 {
			t.Fatalf("busy_timeout=%d, err=%v", timeout, err)
		}
		if _, err := conn.ExecContext(ctx, "INSERT INTO task_videos (id, task_id, video_data) VALUES ('orphan', 'missing', '{}')"); err == nil {
			t.Fatal("orphan task video accepted")
		}
	}
}

func TestLegacyTimestampsSurviveDriverChange(t *testing.T) {
	defer setupTestDB(t)()
	values := []struct {
		stored string
		want   string
	}{
		{"2026-09-21 10:20:30.123456789 +0800 CST m=+12.345", "2026-09-21T10:20:30.123456789+08:00"},
		{"2026-09-21 10:20:30 -0700 PDT", "2026-09-21T10:20:30-07:00"},
		{"2026-09-21 10:20:30 +0000 UTC", "2026-09-21T10:20:30Z"},
		{"2026-09-21T10:20:30+08:00", "2026-09-21T10:20:30+08:00"},
		{"2026-09-21 10:20:30", "2026-09-21T10:20:30Z"},
	}
	if _, err := db.Exec("DELETE FROM schema_migrations WHERE version = 19"); err != nil {
		t.Fatal(err)
	}
	for _, tt := range values {
		if _, err := db.Exec(`INSERT INTO search_tasks (task_id, keyword, status, target_count, current_count, created_at, started_at)
VALUES (?, 'kept', 'pending', 1, 0, ?, ?)`, tt.stored, tt.stored, tt.stored); err != nil {
			t.Fatal(err)
		}
	}
	if err := runMigrations(); err != nil {
		t.Fatal(err)
	}
	if err := runMigrations(); err != nil {
		t.Fatalf("repeat migration: %v", err)
	}
	for _, tt := range values {
		task, err := NewTaskRepository().GetTask(tt.stored)
		if err != nil {
			t.Fatal(err)
		}
		want, err := time.Parse(time.RFC3339Nano, tt.want)
		if err != nil {
			t.Fatal(err)
		}
		if !task.CreatedAt.Equal(want) || !task.StartedAt.Equal(want) || !task.CompletedAt.IsZero() {
			t.Fatalf("timestamp changed for %q: %+v", tt.stored, task)
		}
	}
}

func TestLegacySearchUpgradePreservesVideos(t *testing.T) {
	defer setupTestDB(t)()
	if _, err := db.Exec(`DELETE FROM schema_migrations WHERE version >= 17;
DROP TABLE radar_seen_videos;
ALTER TABLE search_tasks DROP COLUMN task_type;
INSERT INTO search_tasks (task_id, keyword, status, created_at) VALUES ('kept', 'keyword', 'pending', CURRENT_TIMESTAMP);
INSERT INTO task_videos (id, task_id, video_data, video_index) VALUES ('video', 'kept', '{"id":"video"}', 'video');`); err != nil {
		t.Fatal(err)
	}
	if err := runMigrations(); err != nil {
		t.Fatal(err)
	}
	var data string
	if err := db.QueryRow("SELECT video_data FROM task_videos WHERE task_id = 'kept'").Scan(&data); err != nil || data != `{"id":"video"}` {
		t.Fatalf("video not preserved: %q, err=%v", data, err)
	}
	if _, err := db.Exec("DELETE FROM search_tasks WHERE task_id = 'kept'"); err != nil {
		t.Fatal(err)
	}
	var count int
	if err := db.QueryRow("SELECT COUNT(*) FROM task_videos").Scan(&count); err != nil || count != 0 {
		t.Fatalf("foreign key cascade not restored: count=%d, err=%v", count, err)
	}
}
