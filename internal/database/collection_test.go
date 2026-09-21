package database

import "testing"

func TestCollectionSettings(t *testing.T) {
	defer setupTestDB(t)()
	repo := NewSettingsRepository()
	settings, err := repo.Load()
	if err != nil {
		t.Fatal(err)
	}
	settings.Theme = "dark"
	settings.RadarEnabled = true
	if err := repo.SaveAndValidate(settings); err != nil {
		t.Fatal(err)
	}
	loaded, err := repo.Load()
	if err != nil {
		t.Fatal(err)
	}
	if loaded.Theme != "dark" || !loaded.RadarEnabled {
		t.Fatalf("settings not persisted: %+v", loaded)
	}
	settings.Theme = "invalid"
	if err := repo.Validate(settings); err == nil {
		t.Fatal("invalid theme accepted")
	}
	settings.Theme = "light"
	settings.AutoCleanupEnabled = true
	settings.AutoCleanupDays = 0
	if err := repo.Validate(settings); err == nil {
		t.Fatal("invalid retention accepted")
	}
}

func TestRadarDiscoveryWithoutDownloads(t *testing.T) {
	defer setupTestDB(t)()
	repo := NewRadarRepository()
	for _, id := range []string{"first", "second"} {
		if err := repo.Add(&RadarTarget{ID: id, Username: id, AuthorName: id, Status: RadarStatusActive, IntervalMinutes: 5}); err != nil {
			t.Fatal(err)
		}
	}
	for _, tt := range []struct {
		target string
		want   bool
	}{{"first", true}, {"first", false}, {"second", true}} {
		isNew, err := NewRadarRepository().RecordSeenVideo(tt.target, "video-1")
		if err != nil {
			t.Fatal(err)
		}
		if isNew != tt.want {
			t.Fatalf("target %s new=%v, want %v", tt.target, isNew, tt.want)
		}
	}
}

func TestRadarUpgradePreservesExistingData(t *testing.T) {
	defer setupTestDB(t)()
	if _, err := db.Exec(`DROP TABLE radar_seen_videos; DELETE FROM schema_migrations WHERE version >= 18;
INSERT INTO browse_history (id,title,author,browse_time) VALUES ('kept','title','author',CURRENT_TIMESTAMP);`); err != nil {
		t.Fatal(err)
	}
	if err := runMigrations(); err != nil {
		t.Fatal(err)
	}
	var count int
	if err := db.QueryRow("SELECT COUNT(*) FROM browse_history WHERE id = 'kept'").Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 1 {
		t.Fatal("upgrade removed browse history")
	}
	var version int
	if err := db.QueryRow("SELECT MAX(version) FROM schema_migrations").Scan(&version); err != nil {
		t.Fatal(err)
	}
	if version != 19 {
		t.Fatalf("schema version=%d", version)
	}
}
