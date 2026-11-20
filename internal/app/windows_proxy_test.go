package app

import (
	"testing"

	"github.com/qtgolang/SunnyNet/SunnyNet"
)

type recordingWindowsProxy struct {
	driverReady   bool
	systemChanges []bool
}

func (p *recordingWindowsProxy) StartProcess() bool                { return p.driverReady }
func (p *recordingWindowsProxy) ProcessAddPid(int) *SunnyNet.Sunny { return nil }
func (p *recordingWindowsProxy) ProcessDelPid(int) *SunnyNet.Sunny { return nil }
func (p *recordingWindowsProxy) SetIeProxy(off bool) bool {
	p.systemChanges = append(p.systemChanges, off)
	return true
}

func TestProcessModeNeverChangesSystemProxy(t *testing.T) {
	for _, mode := range []string{"process", "system"} {
		for _, ready := range []bool{true, false} {
			proxy := &recordingWindowsProxy{driverReady: ready}
			cleanup, err := configureWindowsProxy(mode, proxy)
			if (err == nil) != ready {
				t.Fatalf("unexpected driver result: ready=%v err=%v", ready, err)
			}
			if cleanup != nil {
				cleanup()
			}
			if len(proxy.systemChanges) != 0 {
				t.Fatal("process mode changed system proxy")
			}
		}
	}
}
