package utils

import (
	"path/filepath"
	"runtime"
	"testing"
)

func TestResolveDataDir(t *testing.T) {
	tests := []struct {
		name      string
		dataDir   string
		expectAbs bool
	}{
		{
			name:      "相对路径",
			dataDir:   "downloads",
			expectAbs: true,
		},
		{
			name:      "绝对路径 - Windows",
			dataDir:   "C:\\downloads",
			expectAbs: true,
		},
		{
			name:      "绝对路径 - Unix",
			dataDir:   "/tmp/downloads",
			expectAbs: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			// 跳过不适用于当前操作系统的测试
			if runtime.GOOS == "windows" && tt.dataDir == "/tmp/downloads" {
				t.Skip("跳过Unix路径测试（当前为Windows）")
			}
			if runtime.GOOS != "windows" && tt.dataDir == "C:\\downloads" {
				t.Skip("跳过Windows路径测试（当前为非Windows）")
			}

			result, err := ResolveDataDir(tt.dataDir)
			if err != nil {
				t.Errorf("ResolveDataDir() error = %v", err)
				return
			}

			if tt.expectAbs && !filepath.IsAbs(result) {
				t.Errorf("ResolveDataDir() = %v, 期望绝对路径", result)
			}

			// 对于相对路径，结果应该包含原始路径
			if !filepath.IsAbs(tt.dataDir) {
				if !contains(result, tt.dataDir) {
					t.Errorf("ResolveDataDir() = %v, 应该包含 %v", result, tt.dataDir)
				}
			}

			// 对于绝对路径，结果应该等于输入
			if filepath.IsAbs(tt.dataDir) {
				if result != tt.dataDir {
					t.Errorf("ResolveDataDir() = %v, 期望 %v", result, tt.dataDir)
				}
			}
		})
	}
}

// contains 检查字符串是否包含子串
func contains(s, substr string) bool {
	return len(s) >= len(substr) && (s == substr || len(s) > len(substr) &&
		(s[:len(substr)] == substr || s[len(s)-len(substr):] == substr ||
			containsMiddle(s, substr)))
}

func containsMiddle(s, substr string) bool {
	for i := 0; i <= len(s)-len(substr); i++ {
		if s[i:i+len(substr)] == substr {
			return true
		}
	}
	return false
}

func TestResolveDataDirEdgeCases(t *testing.T) {
	tests := []struct {
		name        string
		dataDir     string
		expectError bool
	}{
		{
			name:        "空字符串",
			dataDir:     "",
			expectError: false, // 应该返回基础目录
		},
		{
			name:        "点路径",
			dataDir:     ".",
			expectError: false,
		},
		{
			name:        "双点路径",
			dataDir:     "..",
			expectError: false,
		},
	}

	baseDir, err := GetBaseDir()
	if err != nil {
		t.Fatalf("无法获取基础目录: %v", err)
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result, err := ResolveDataDir(tt.dataDir)

			if tt.expectError && err == nil {
				t.Errorf("ResolveDataDir() 期望错误但没有返回错误")
			}

			if !tt.expectError && err != nil {
				t.Errorf("ResolveDataDir() 意外错误 = %v", err)
			}

			if !tt.expectError {
				if !filepath.IsAbs(result) {
					t.Errorf("ResolveDataDir() = %v, 期望绝对路径", result)
				}

				// 验证结果是否正确解析
				expected := filepath.Join(baseDir, tt.dataDir)
				if result != expected {
					// 尝试 Clean 后比较，因为 filepath.Join 可能会清理路径
					if filepath.Clean(result) != filepath.Clean(expected) {
						t.Errorf("ResolveDataDir() = %v, 期望 %v", result, expected)
					}
				}
			}
		})
	}
}
