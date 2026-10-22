package diagnostics

import (
	"encoding/binary"
	"testing"
	"time"
)

func TestDecodeSessionInfo(t *testing.T) {
	for _, tt := range []struct {
		name string
		flag uint32
		want string
	}{
		{"locked", 0, "locked"},
		{"unlocked", 1, "unlocked"},
		{"unknown", 0xffffffff, "unavailable"},
	} {
		t.Run(tt.name, func(t *testing.T) {
			data := make([]byte, 24)
			binary.LittleEndian.PutUint32(data, 1)
			binary.LittleEndian.PutUint32(data[8:], 7)
			binary.LittleEndian.PutUint32(data[16:], tt.flag)
			sample := decodeSessionInfo(data)
			if sample.State != tt.want || sample.SessionID != 7 {
				t.Fatalf("got %+v, want state=%s session=7", sample, tt.want)
			}
		})
	}
	for _, data := range [][]byte{nil, make([]byte, 19), make([]byte, 24)} {
		if got := decodeSessionInfo(data); got.State != "unavailable" {
			t.Fatalf("invalid WTS response reported as unlocked: %+v", got)
		}
	}
}

func TestSessionReportsChangesAndBoundedHeartbeat(t *testing.T) {
	var tracker sessionTracker
	now := time.Unix(1000, 0)
	locked := SessionSample{State: "locked", SessionID: 1}
	if sample, ok := tracker.observe(locked, now); !ok || sample.StateDurationMS != 0 {
		t.Fatalf("missing baseline: %+v, %v", sample, ok)
	}
	if _, ok := tracker.observe(locked, now.Add(5*time.Second)); ok {
		t.Fatal("unchanged state must not produce a log every poll")
	}
	if sample, ok := tracker.observe(locked, now.Add(30*time.Second)); !ok || sample.StateDurationMS != 30000 {
		t.Fatalf("missing duration heartbeat: %+v, %v", sample, ok)
	}
	unlocked := SessionSample{State: "unlocked", SessionID: 1}
	if sample, ok := tracker.observe(unlocked, now.Add(31*time.Second)); !ok || sample.PreviousState != "locked" || sample.PreviousStateDurationMS != 31000 {
		t.Fatalf("unlock must preserve blocked interval: %+v, %v", sample, ok)
	}
	if _, ok := tracker.observe(SessionSample{State: "unavailable", SessionID: 1}, now.Add(32*time.Second)); !ok {
		t.Fatal("probe failure must not silently retain unlocked status")
	}
}
