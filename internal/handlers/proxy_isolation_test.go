package handlers

import (
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"wx_channel/internal/config"
	"wx_channel/internal/websocket"

	"github.com/qtgolang/SunnyNet/SunnyNet"
	"github.com/qtgolang/SunnyNet/public"
)

type untouchedBody struct{ reads, closes int }

func (b *untouchedBody) Read([]byte) (int, error) { b.reads++; return 0, errors.New("must not read") }
func (b *untouchedBody) Close() error             { b.closes++; return nil }

func TestUnrelatedResponsesAreNotRead(t *testing.T) {
	for _, scenario := range []struct{ url, contentType string }{
		{"https://www.tapd.cn/index.html", "text/html"},
		{"https://www.tapd.cn/app.js", "application/javascript"},
		{"https://channels.weixin.qq.com/events", "text/event-stream"},
		{"https://channels.weixin.qq.com/video", "video/mp4"},
		{"https://channels.weixin.qq.com/api/feed", "application/json"},
		{"https://res.wx.qq.com/other-business/app.js", "application/javascript"},
	} {
		body := &untouchedBody{}
		conn := &SunnyNet.HttpConn{Type: public.HttpResponseOK,
			Request:  httptest.NewRequest(http.MethodGet, scenario.url, nil),
			Response: &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": {scenario.contentType}}, Body: body},
		}
		if (&ScriptHandler{}).Handle(conn) || body.reads != 0 || body.closes != 0 || conn.Response.Body != body {
			t.Errorf("response body touched: %s reads=%d closes=%d", scenario.url, body.reads, body.closes)
		}
	}
}

func TestExternalConsoleAndPrivateAPIPassThrough(t *testing.T) {
	static := NewStaticFileHandler()
	for _, host := range []string{"www.tapd.cn", "channels.weixin.qq.com"} {
		conn := &SunnyNet.HttpConn{Request: httptest.NewRequest(http.MethodGet, "https://"+host+"/console", nil)}
		if static.Handle(conn) {
			t.Errorf("external console intercepted: %s", host)
		}
	}
	handler := NewAPIHandler(&config.Config{}, websocket.NewHub(nil))
	for _, scenario := range []struct {
		host    string
		allowed bool
	}{
		{"www.tapd.cn", false}, {"res.wx.qq.com", false}, {"channels.weixin.qq.com", true}, {"127.0.0.1:2025", true},
	} {
		conn := &SunnyNet.HttpConn{Type: public.HttpSendRequest, Request: httptest.NewRequest(http.MethodGet, "https://"+scenario.host+"/__wx_channels_api/health", nil)}
		if handler.Handle(conn) != scenario.allowed || (conn.Response != nil) != scenario.allowed {
			t.Errorf("private API boundary incorrect: %s", scenario.host)
		}
	}
}

type interruptedBody struct {
	step   int
	closed bool
}

func (b *interruptedBody) Read(p []byte) (int, error) {
	b.step++
	switch b.step {
	case 1:
		return copy(p, "prefix"), errors.New("interrupted read")
	case 2:
		return copy(p, "suffix"), io.EOF
	default:
		return 0, io.EOF
	}
}
func (b *interruptedBody) Close() error { b.closed = true; return nil }

func TestReadFailurePreservesConsumedBody(t *testing.T) {
	body := &interruptedBody{}
	conn := &SunnyNet.HttpConn{Type: public.HttpResponseOK,
		Request:  httptest.NewRequest(http.MethodGet, "https://channels.weixin.qq.com/web/pages/home", nil),
		Response: &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": {"text/html"}}, Body: body},
	}
	if (&ScriptHandler{}).Handle(conn) || body.closed {
		t.Fatal("failed read consumed or closed upstream")
	}
	data, err := io.ReadAll(conn.Response.Body)
	if err != nil || string(data) != "prefixsuffix" {
		t.Fatalf("body lost: %q err=%v", data, err)
	}
	conn.Response.Body.Close()
	if !body.closed {
		t.Fatal("original body not closed")
	}
}

func TestUnmodifiedJavaScriptPreservesResponse(t *testing.T) {
	const source = "const value = 1;"
	conn := &SunnyNet.HttpConn{Type: public.HttpResponseOK,
		Request:  httptest.NewRequest(http.MethodGet, "https://res.wx.qq.com/t/wx_fed/finder/web/web-finder/res/js/plain.js", nil),
		Response: &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": {"application/javascript"}, "Cache-Control": {"max-age=600"}}, Body: io.NopCloser(strings.NewReader(source))},
	}
	if (&ScriptHandler{}).Handle(conn) {
		t.Fatal("unmodified JavaScript reported as rewritten")
	}
	data, err := io.ReadAll(conn.Response.Body)
	if err != nil || string(data) != source || conn.Response.Header.Get("Cache-Control") != "max-age=600" || conn.Response.Header.Get("__debug") != "" {
		t.Fatalf("unmodified response corrupted: data=%q err=%v headers=%v", data, err, conn.Response.Header)
	}
}
