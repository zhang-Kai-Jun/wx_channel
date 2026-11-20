package processproxy

import (
	"os"
	"strings"
	"testing"
)

func TestWindowsSnapshotSelectsOnlyWeChat(t *testing.T) {
	processes, err := scanProcesses()
	if err != nil {
		t.Fatal(err)
	}
	defer releaseProcesses(processes)
	selected := selectWeChat(processes, os.Getenv("APPDATA"))
	for _, process := range processes {
		if !isCandidate(process.name) {
			continue
		}
		_, included := selected[process.pid]
		t.Logf("PID=%d selected=%v image=%s", process.pid, included, process.image)
		if strings.Contains(normalizeImage(process.image), "/qqmusic/") && included {
			t.Fatalf("QQ Music process included: %s", process.image)
		}
	}
}

func TestWindowsProxyQueryIsReadOnly(t *testing.T) {
	server, flags, err := querySystemProxy()
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("WinINet proxy server=%q flags=%d", server, flags)
}
