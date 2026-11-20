package processproxy

import (
	"errors"
	"fmt"
	"reflect"
	"sync"
	"testing"
	"time"

	"github.com/qtgolang/SunnyNet/SunnyNet"
)

type recordingDriver struct {
	ready  bool
	events chan string
}

func (d *recordingDriver) StartProcess() bool { return d.ready }
func (d *recordingDriver) ProcessAddPid(pid int) *SunnyNet.Sunny {
	d.events <- fmt.Sprintf("add:%d", pid)
	return nil
}
func (d *recordingDriver) ProcessDelPid(pid int) *SunnyNet.Sunny {
	d.events <- fmt.Sprintf("del:%d", pid)
	return nil
}

func TestReconcileReleasesPIDBeforeProcessHandle(t *testing.T) {
	driver := &recordingDriver{ready: true, events: make(chan string, 20)}
	active := make(map[uint32]processInfo)
	main := processInfo{pid: 1, name: "Weixin.exe", image: `C:\Tencent\Weixin\Weixin.exe`, created: 1,
		release: func() { driver.events <- "close:1" }}
	other := processInfo{pid: 2, name: "WeChatAppEx.exe", image: `C:\QQMusic\WeChatAppEx.exe`, created: 2,
		release: func() { driver.events <- "close:2" }}
	reconcile(driver, active, []processInfo{main, other}, "")
	if got := []string{<-driver.events, <-driver.events}; !reflect.DeepEqual(got, []string{"add:1", "close:2"}) {
		t.Fatal(got)
	}
	duplicate := main
	duplicate.release = func() { driver.events <- "close:duplicate" }
	reconcile(driver, active, []processInfo{duplicate}, "")
	if got := <-driver.events; got != "close:duplicate" {
		t.Fatal(got)
	}
	reconcile(driver, active, nil, "")
	if got := []string{<-driver.events, <-driver.events}; !reflect.DeepEqual(got, []string{"del:1", "close:1"}) {
		t.Fatal(got)
	}
	if len(active) != 0 || len(driver.events) != 0 {
		t.Fatal("stale PID or unexpected driver operation")
	}
}

func TestMonitorDiscoversNewProcessesAndStops(t *testing.T) {
	driver := &recordingDriver{ready: true, events: make(chan string, 20)}
	var mu sync.Mutex
	var processes []processInfo
	scan := func() ([]processInfo, error) {
		mu.Lock()
		defer mu.Unlock()
		return append([]processInfo(nil), processes...), nil
	}
	stop, err := start(driver, scan, "")
	if err != nil {
		t.Fatal(err)
	}
	defer stop()
	mu.Lock()
	processes = []processInfo{{pid: 12, name: "WeChat.exe", image: `D:\Apps\WeChat\WeChat.exe`, created: 1}}
	mu.Unlock()
	select {
	case event := <-driver.events:
		if event != "add:12" {
			t.Fatal(event)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("new WeChat process was not discovered")
	}
	stop()
	stop()
	if event := <-driver.events; event != "del:12" || len(driver.events) != 0 {
		t.Fatal("cleanup did not remove only the registered PID")
	}
}

func TestStartupFailureDoesNotRegisterProcesses(t *testing.T) {
	driver := &recordingDriver{events: make(chan string, 20)}
	released := false
	scan := func() ([]processInfo, error) {
		return []processInfo{{release: func() { released = true }}}, nil
	}
	if stop, err := start(driver, scan, ""); err == nil || stop != nil || !released || len(driver.events) != 0 {
		t.Fatal("driver failure leaked handles or installed filters")
	}
	if stop, err := start(driver, func() ([]processInfo, error) { return nil, errors.New("snapshot failure") }, ""); err == nil || stop != nil {
		t.Fatal("snapshot failure ignored")
	}
}
