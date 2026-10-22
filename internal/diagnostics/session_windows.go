package diagnostics

import (
	"context"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

var querySessionInformation = windows.NewLazySystemDLL("wtsapi32.dll").NewProc("WTSQuerySessionInformationW")

func readSession() SessionSample {
	var sessionID uint32
	if err := windows.ProcessIdToSessionId(windows.GetCurrentProcessId(), &sessionID); err != nil {
		return SessionSample{State: "unavailable", ProbeError: err.Error()}
	}
	var buffer *byte
	var size uint32
	// WTSInfoEx = 25，使用服务所属的交互会话，避免误读其他登录会话。
	ok, _, callErr := querySessionInformation.Call(0, uintptr(sessionID), 25,
		uintptr(unsafe.Pointer(&buffer)), uintptr(unsafe.Pointer(&size)))
	if ok == 0 {
		return SessionSample{State: "unavailable", SessionID: sessionID, ProbeError: callErr.Error()}
	}
	defer windows.WTSFreeMemory(uintptr(unsafe.Pointer(buffer)))
	if buffer == nil || size < 20 {
		return SessionSample{State: "unavailable", SessionID: sessionID, ProbeError: "invalid_wts_buffer"}
	}
	return decodeSessionInfo(unsafe.Slice(buffer, 20))
}

// StartSessionMonitor 每 5 秒检查一次，状态变化立即记录，稳定状态每 30 秒记录。
// 只观察锁屏状态，不模拟输入、解锁或更改系统电源设置。
func StartSessionMonitor(report func(SessionSample)) func() {
	ctx, cancel := context.WithCancel(context.Background())
	go func() {
		var tracker sessionTracker
		poll := func() {
			if sample, emit := tracker.observe(readSession(), time.Now()); emit {
				report(sample)
			}
		}
		poll()
		ticker := time.NewTicker(5 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				poll()
			}
		}
	}()
	return cancel
}
