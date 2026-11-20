//go:build !windows

package processproxy

import "fmt"

func scanProcesses() ([]processInfo, error) {
	return nil, fmt.Errorf("进程代理仅支持 Windows")
}

func CleanupLegacySystemProxy(port int) (bool, error) { return false, nil }
