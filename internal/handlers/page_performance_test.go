package handlers

import (
	"io"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/qtgolang/SunnyNet/SunnyNet"
	"github.com/qtgolang/SunnyNet/public"
	"wx_channel/internal/config"
	"wx_channel/internal/utils"
)

func TestPagePerformanceTipsPersistWithoutConsoleOutput(t *testing.T) {
	logPath := filepath.Join(t.TempDir(), "performance.log")
	if err := utils.InitLoggerWithRotation(utils.INFO, logPath, 5); err != nil {
		t.Fatal(err)
	}
	defer func() {
		_ = utils.GetLogger().Close()
		_ = utils.InitLoggerWithRotation(utils.INFO, filepath.Join("logs", "wx_channel.log"), 5)
	}()
	reader, writer, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Close()
	previousStdout := os.Stdout
	os.Stdout = writer
	defer func() { os.Stdout = previousStdout; _ = writer.Close() }()
	h := NewAPIHandler(&config.Config{}, nil)
	conn := &SunnyNet.HttpConn{Type: public.HttpSendRequest, Request: httptest.NewRequest("POST", "/__wx_channels_api/tip",
		strings.NewReader(`{"msg":"[Perf] {\"event\":\"page_resources\",\"page_instance_id\":\"page-1\",\"dom_nodes\":100}"}`))}
	if !h.HandleTip(conn) || conn.Response.StatusCode != 200 {
		t.Fatal("performance tip was not accepted")
	}
	_ = writer.Close()
	output, _ := io.ReadAll(reader)
	data, err := os.ReadFile(logPath)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(data), `"event":"page_resources"`) || !strings.Contains(string(data), `"page_instance_id":"page-1"`) {
		t.Fatalf("browser performance evidence missing from log file: %s", data)
	}
	if len(output) != 0 {
		t.Fatalf("performance diagnostics must bypass synchronous console output: %s", output)
	}
}
