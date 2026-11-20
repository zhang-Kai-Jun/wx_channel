package processproxy

import (
	"fmt"
	"os"
	"sync"
	"time"

	"github.com/qtgolang/SunnyNet/SunnyNet"
	"wx_channel/internal/utils"
)

type Driver interface {
	StartProcess() bool
	ProcessAddPid(int) *SunnyNet.Sunny
	ProcessDelPid(int) *SunnyNet.Sunny
}

// Start 不注册进程名、不切换全进程开关，也不修改系统代理。
func Start(driver Driver) (func(), error) {
	return start(driver, scanProcesses, os.Getenv("APPDATA"))
}

func start(driver Driver, scan func() ([]processInfo, error), appData string) (func(), error) {
	processes, err := scan()
	if err != nil {
		return nil, fmt.Errorf("读取微信进程失败: %w", err)
	}
	if !driver.StartProcess() {
		releaseProcesses(processes)
		return nil, fmt.Errorf("进程代理驱动启动失败，请检查管理员权限及驱动状态；未启用系统代理")
	}
	active := make(map[uint32]processInfo)
	reconcile(driver, active, processes, appData)
	stop, done := make(chan struct{}), make(chan struct{})
	go func() {
		defer close(done)
		ticker := time.NewTicker(250 * time.Millisecond)
		defer ticker.Stop()
		for {
			select {
			case <-stop:
				reconcile(driver, active, nil, appData)
				return
			case <-ticker.C:
				processes, err := scan()
				if err != nil {
					// 保留进程句柄，PID 不会被其他软件复用；不扩大接管范围。
					utils.LogWarn("刷新微信进程失败: %v", err)
					continue
				}
				reconcile(driver, active, processes, appData)
			}
		}
	}()
	var once sync.Once
	return func() { once.Do(func() { close(stop); <-done }) }, nil
}

func releaseProcesses(processes []processInfo) {
	for _, process := range processes {
		if process.release != nil {
			process.release()
		}
	}
}

func reconcile(driver Driver, active map[uint32]processInfo, processes []processInfo, appData string) {
	wanted := selectWeChat(processes, appData)
	for pid, process := range active {
		current, ok := wanted[pid]
		if !ok || current.created != process.created {
			driver.ProcessDelPid(int(pid))
			if process.release != nil {
				process.release()
			}
			delete(active, pid)
		}
	}
	for _, process := range processes {
		_, wanted := wanted[process.pid]
		_, alreadyActive := active[process.pid]
		if wanted && !alreadyActive {
			driver.ProcessAddPid(int(process.pid))
			active[process.pid] = process
			utils.LogFileInfo("[进程代理] PID=%d Image=%s", process.pid, process.image)
		} else if process.release != nil {
			process.release()
		}
	}
}
