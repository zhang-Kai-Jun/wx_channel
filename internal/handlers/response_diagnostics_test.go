package handlers

import (
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/qtgolang/SunnyNet/SunnyNet"
	"github.com/qtgolang/SunnyNet/public"
	"wx_channel/internal/utils"
)

type delayedDiagnosticBody struct {
	io.Reader
	delay time.Duration
}

func (b *delayedDiagnosticBody) Read(p []byte) (int, error) {
	if b.delay > 0 {
		time.Sleep(b.delay)
		b.delay = 0
	}
	return b.Reader.Read(p)
}

func TestSlowRewriteDiagnosticsPreserveResponse(t *testing.T) {
	logPath := filepath.Join(t.TempDir(), "rewrite.log")
	if err := utils.InitLoggerWithRotation(utils.INFO, logPath, 5); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = utils.GetLogger().Close()
		_ = utils.InitLoggerWithRotation(utils.INFO, filepath.Join("logs", "wx_channel.log"), 5)
	})
	h := newScriptResponseTestHandler(t)
	for _, delay := range []time.Duration{0, 550 * time.Millisecond} {
		body := `<html><head></head><body>original</body></html>`
		conn := &SunnyNet.HttpConn{MessageId: 731, Type: public.HttpResponseOK,
			Request: httptest.NewRequest("GET", "https://channels.weixin.qq.com/web/pages/feed?pass_ticket=secret", nil),
			Response: &http.Response{StatusCode: http.StatusOK, ContentLength: int64(len(body)),
				Header: http.Header{"Content-Type": {"text/html"}},
				Body:   io.NopCloser(&delayedDiagnosticBody{Reader: strings.NewReader(body), delay: delay})}}
		if !h.Handle(conn) {
			t.Fatal("HTML injection was bypassed")
		}
		result, _ := io.ReadAll(conn.Response.Body)
		_ = conn.Response.Body.Close()
		if !strings.Contains(string(result), "original") || !strings.Contains(string(result), "__sph_perf_log") {
			t.Fatal("diagnostics changed the original response or removed injection")
		}
		data, err := os.ReadFile(logPath)
		if err != nil {
			t.Fatal(err)
		}
		logged := strings.Contains(string(data), "[Perf][response_rewrite]")
		if logged != (delay > 0) {
			t.Fatalf("slow diagnostic present=%v for delay=%v", logged, delay)
		}
		if delay > 0 {
			for _, field := range []string{"request_id=731", "read_ms=", "decode_ms=", "rewrite_ms=", "total_ms=", "raw_bytes=", "decoded_bytes=", "modified=true"} {
				if !strings.Contains(string(data), field) {
					t.Errorf("missing %s in %s", field, data)
				}
			}
			if strings.Contains(string(data), "secret") {
				t.Fatal("diagnostic leaked URL credentials")
			}
		}
	}
}

func TestPageDiagnosticsPrecedeOtherInjectedScripts(t *testing.T) {
	h := &ScriptHandler{}
	scripts := h.buildInjectedScripts("/web/pages/feed")
	if !strings.HasPrefix(scripts, h.getPerformanceDiagnosticsScript()) {
		t.Fatal("page errors before the bridge or collection initialization cannot be captured")
	}
}
