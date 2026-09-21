package database

import (
	"database/sql"
	"fmt"
	"strconv"
	"time"
)

// SettingsRepository 处理设置数据库操作
type SettingsRepository struct {
	db *sql.DB
}

// NewSettingsRepository 创建一个新的 SettingsRepository
func NewSettingsRepository() *SettingsRepository {
	return &SettingsRepository{db: GetDB()}
}

// 设置键
const (
	SettingKeyAutoCleanupEnabled = "auto_cleanup_enabled"
	SettingKeyAutoCleanupDays    = "auto_cleanup_days"
	SettingKeyRadarEnabled       = "radar_enabled"
	SettingKeyTheme              = "theme"
)

// Get 根据键获取设置值
func (r *SettingsRepository) Get(key string) (string, error) {
	var value string
	err := r.db.QueryRow("SELECT value FROM settings WHERE key = ?", key).Scan(&value)
	if err == sql.ErrNoRows {
		return "", nil
	}
	if err != nil {
		return "", fmt.Errorf("failed to get setting: %w", err)
	}
	return value, nil
}

// Set 保存设置值
func (r *SettingsRepository) Set(key, value string) error {
	query := `
		INSERT INTO settings (key, value, updated_at)
		VALUES (?, ?, ?)
		ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = ?
	`
	now := time.Now()
	_, err := r.db.Exec(query, key, value, now, value, now)
	if err != nil {
		return fmt.Errorf("failed to set setting: %w", err)
	}
	return nil
}

// Delete 根据键删除设置
func (r *SettingsRepository) Delete(key string) error {
	_, err := r.db.Exec("DELETE FROM settings WHERE key = ?", key)
	if err != nil {
		return fmt.Errorf("failed to delete setting: %w", err)
	}
	return nil
}

// GetAll 获取所有设置（作为映射）
func (r *SettingsRepository) GetAll() (map[string]string, error) {
	rows, err := r.db.Query("SELECT key, value FROM settings")
	if err != nil {
		return nil, fmt.Errorf("failed to get all settings: %w", err)
	}
	defer rows.Close()

	settings := make(map[string]string)
	for rows.Next() {
		var key, value string
		if err := rows.Scan(&key, &value); err != nil {
			return nil, fmt.Errorf("failed to scan setting: %w", err)
		}
		settings[key] = value
	}

	return settings, nil
}

// Load 获取所有设置（作为 Settings 结构体）
func (r *SettingsRepository) Load() (*Settings, error) {
	settingsMap, err := r.GetAll()
	if err != nil {
		return nil, err
	}

	settings := DefaultSettings()

	if v, ok := settingsMap[SettingKeyAutoCleanupEnabled]; ok {
		settings.AutoCleanupEnabled = v == "true"
	}
	if v, ok := settingsMap[SettingKeyAutoCleanupDays]; ok && v != "" {
		if days, err := strconv.Atoi(v); err == nil {
			settings.AutoCleanupDays = days
		}
	}
	if v, ok := settingsMap[SettingKeyRadarEnabled]; ok {
		settings.RadarEnabled = v == "true"
	}
	if v, ok := settingsMap[SettingKeyTheme]; ok && v != "" {
		settings.Theme = v
	}

	return settings, nil
}

// Save 将 Settings 结构体保存到数据库
func (r *SettingsRepository) Save(settings *Settings) error {
	tx, err := r.db.Begin()
	if err != nil {
		return fmt.Errorf("failed to begin transaction: %w", err)
	}
	defer tx.Rollback()

	now := time.Now()
	query := `
		INSERT INTO settings (key, value, updated_at)
		VALUES (?, ?, ?)
		ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = ?
	`

	// Save each setting
	settingsMap := map[string]string{
		SettingKeyAutoCleanupEnabled: strconv.FormatBool(settings.AutoCleanupEnabled),
		SettingKeyAutoCleanupDays:    strconv.Itoa(settings.AutoCleanupDays),
		SettingKeyRadarEnabled:       strconv.FormatBool(settings.RadarEnabled),
		SettingKeyTheme:              settings.Theme,
	}

	for key, value := range settingsMap {
		_, err := tx.Exec(query, key, value, now, value, now)
		if err != nil {
			return fmt.Errorf("failed to save setting %s: %w", key, err)
		}
	}

	if err := tx.Commit(); err != nil {
		return fmt.Errorf("failed to commit transaction: %w", err)
	}

	return nil
}

// Validate 验证设置值
func (r *SettingsRepository) Validate(settings *Settings) error {
	// Validate auto cleanup days (1 to 365)
	if settings.AutoCleanupEnabled && (settings.AutoCleanupDays < 1 || settings.AutoCleanupDays > 365) {
		return fmt.Errorf("auto cleanup days must be between 1 and 365")
	}

	// Validate theme
	validThemes := map[string]bool{"light": true, "dark": true}
	if !validThemes[settings.Theme] {
		return fmt.Errorf("theme must be 'light' or 'dark'")
	}

	return nil
}

// SaveAndValidate 验证并保存设置
func (r *SettingsRepository) SaveAndValidate(settings *Settings) error {
	if err := r.Validate(settings); err != nil {
		return err
	}
	return r.Save(settings)
}

// GetInt 获取整数设置值
func (r *SettingsRepository) GetInt(key string, defaultValue int) (int, error) {
	value, err := r.Get(key)
	if err != nil {
		return defaultValue, err
	}
	if value == "" {
		return defaultValue, nil
	}
	intValue, err := strconv.Atoi(value)
	if err != nil {
		return defaultValue, nil
	}
	return intValue, nil
}

// GetInt64 获取 int64 设置值
func (r *SettingsRepository) GetInt64(key string, defaultValue int64) (int64, error) {
	value, err := r.Get(key)
	if err != nil {
		return defaultValue, err
	}
	if value == "" {
		return defaultValue, nil
	}
	int64Value, err := strconv.ParseInt(value, 10, 64)
	if err != nil {
		return defaultValue, nil
	}
	return int64Value, nil
}

// GetBool 获取布尔设置值
func (r *SettingsRepository) GetBool(key string, defaultValue bool) (bool, error) {
	value, err := r.Get(key)
	if err != nil {
		return defaultValue, err
	}
	if value == "" {
		return defaultValue, nil
	}
	return value == "true", nil
}

// SetInt 保存整数设置值
func (r *SettingsRepository) SetInt(key string, value int) error {
	return r.Set(key, strconv.Itoa(value))
}

// SetInt64 保存 int64 设置值
func (r *SettingsRepository) SetInt64(key string, value int64) error {
	return r.Set(key, strconv.FormatInt(value, 10))
}

// SetBool 保存布尔设置值
func (r *SettingsRepository) SetBool(key string, value bool) error {
	return r.Set(key, strconv.FormatBool(value))
}
