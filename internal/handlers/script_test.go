package handlers

import (
	"bytes"
	"compress/gzip"
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"os/exec"
	"strconv"
	"strings"
	"testing"
	"time"

	"wx_channel/internal/config"

	"github.com/qtgolang/SunnyNet/SunnyNet"
	sunnyPublic "github.com/qtgolang/SunnyNet/public"
)

func newScriptResponseTestHandler(t *testing.T) *ScriptHandler {
	t.Helper()
	cfg := config.Get()
	previous := cfg.SavePageJS
	cfg.SavePageJS = false
	t.Cleanup(func() { cfg.SavePageJS = previous })
	return &ScriptHandler{version: "?v=test", searchJS: []byte("window.__search_test__=true;")}
}

func TestScriptHandlerModifiedResponseHeaders(t *testing.T) {
	handler := newScriptResponseTestHandler(t)
	for _, scenario := range []struct {
		path        string
		contentType string
		body        string
	}{
		{"/web/pages/home", "text/html; charset=utf-8", `<html><head><script src="entry.js"></script></head></html>`},
		{"/web/pages/feed", "text/html; charset=utf-8", `<html><head><script src="entry.js"></script></head></html>`},
		{"/web/pages/profile", "text/html; charset=utf-8", `<html><head><script src="entry.js"></script></head></html>`},
		{"/web/pages/account/like", "text/html; charset=utf-8", `<html><head><script src="entry.js"></script></head></html>`},
		{"/web/pages/s", "text/html; charset=utf-8", `<html><head><script src="entry.js"></script></head></html>`},
		{"/web/pages/unknown", "text/html; charset=utf-8", `<html><head><script src="entry.js"></script></head></html>`},
		{"/t/wx_fed/finder/web/web-finder/res/js/virtual_svg-icons-register.test.js", "application/javascript", `import "./entry.js";const api={};export{api};`},
		{"/connect.publish.test.js", "application/javascript", `import "./entry.js";`},
		{"/ordinary.js", "application/javascript", `import "./entry.js";`},
	} {
		t.Run(scenario.path, func(t *testing.T) {
			conn := &SunnyNet.HttpConn{
				Type:    sunnyPublic.HttpResponseOK,
				Request: httptest.NewRequest(http.MethodGet, "https://channels.weixin.qq.com"+scenario.path, nil),
				Response: &http.Response{
					StatusCode:    http.StatusOK,
					ContentLength: int64(len(scenario.body)),
					Header: http.Header{
						"Content-Type":     {scenario.contentType},
						"Content-Encoding": {"identity"},
						"Content-Length":   {strconv.Itoa(len(scenario.body))},
						"Cache-Control":    {"public, max-age=600"},
						"X-Test":           {"preserved"},
					},
					Body: io.NopCloser(strings.NewReader(scenario.body)),
				},
			}
			if !handler.Handle(conn) {
				t.Fatal("响应未经过脚本改写")
			}
			defer conn.Response.Body.Close()
			body, err := io.ReadAll(conn.Response.Body)
			if err != nil {
				t.Fatal(err)
			}
			if !strings.Contains(string(body), "entry.js?v=test") {
				t.Fatal("改写后的脚本版本参数丢失")
			}
			if scenario.path == "/web/pages/s" && !bytes.Contains(body, handler.searchJS) {
				t.Fatal("现有搜索模块未注入")
			}
			for name, want := range map[string]string{
				"Content-Encoding": "",
				"Content-Length":   "",
				"Cache-Control":    "no-cache, no-store, must-revalidate",
				"Pragma":           "no-cache",
				"Expires":          "0",
				"X-Test":           "preserved",
			} {
				if got := conn.Response.Header.Get(name); got != want {
					t.Errorf("%s = %q，期望 %q", name, got, want)
				}
			}
			if conn.Response.ContentLength != -1 {
				t.Errorf("响应仍保留上游正文长度：%d", conn.Response.ContentLength)
			}
		})
	}
}

func TestScriptHandlerModuleReferenceWhitespace(t *testing.T) {
	handler := newScriptResponseTestHandler(t)
	for _, whitespace := range []string{"", " ", "  ", "\t", "\n", "\r\n"} {
		t.Run(strconv.Quote(whitespace), func(t *testing.T) {
			source := `import {x} from` + whitespace + `"./named.js";import` + whitespace + `"./side.js";` +
				`const lazy=import("./lazy.js");const deps=["js/dependency.js"];`
			conn := &SunnyNet.HttpConn{Response: &http.Response{Header: http.Header{"Content-Type": {"application/javascript"}}}}
			if !handler.HandleJavaScriptResponse(conn, "res.wx.qq.com", "/ordinary.js", []byte(source)) {
				t.Fatal("JavaScript 响应未处理")
			}
			defer conn.Response.Body.Close()
			body, err := io.ReadAll(conn.Response.Body)
			if err != nil {
				t.Fatal(err)
			}
			want := `import {x} from "./named.js?v=test";import "./side.js?v=test";` +
				`const lazy=import("./lazy.js?v=test");const deps=["js/dependency.js?v=test"];`
			if string(body) != want {
				t.Errorf("模块引用改写不一致\n实际：%s\n期望：%s", body, want)
			}
		})
	}
}

func TestScriptHandlerPreservesEncodedResponses(t *testing.T) {
	var compressed bytes.Buffer
	writer := gzip.NewWriter(&compressed)
	if _, err := writer.Write([]byte(`<html><head><script src="entry.js"></script></head></html>`)); err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	handler := &ScriptHandler{version: "?v=test"}
	for _, contentType := range []string{"text/html; charset=utf-8", "application/javascript", "application/octet-stream"} {
		t.Run(contentType, func(t *testing.T) {
			conn := &SunnyNet.HttpConn{
				Type:    sunnyPublic.HttpResponseOK,
				Request: httptest.NewRequest(http.MethodGet, "https://channels.weixin.qq.com/web/pages/s", nil),
				Response: &http.Response{
					StatusCode:    http.StatusOK,
					ContentLength: int64(compressed.Len()),
					Header: http.Header{
						"Content-Type":     {contentType},
						"Content-Encoding": {"gzip"},
						"Content-Length":   {strconv.Itoa(compressed.Len())},
						"Cache-Control":    {"public, max-age=600"},
					},
					Body: io.NopCloser(bytes.NewReader(compressed.Bytes())),
				},
			}
			if handler.Handle(conn) {
				t.Fatal("压缩正文不应按明文改写")
			}
			defer conn.Response.Body.Close()
			body, err := io.ReadAll(conn.Response.Body)
			if err != nil {
				t.Fatal(err)
			}
			if !bytes.Equal(body, compressed.Bytes()) || conn.Response.ContentLength != int64(compressed.Len()) ||
				conn.Response.Header.Get("Content-Encoding") != "gzip" ||
				conn.Response.Header.Get("Content-Length") != strconv.Itoa(compressed.Len()) ||
				conn.Response.Header.Get("Cache-Control") != "public, max-age=600" {
				t.Fatal("透传响应的正文、编码、长度或缓存策略被改变")
			}
		})
	}
}

func TestAPILoadedInjectionDoesNotBreakNativeModule(t *testing.T) {
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("需要 Node.js 执行生成的 JavaScript 模块")
	}
	const fixture = `const api$={finderSearch(){return "native"}};export{api$ as nativeAPI};globalThis.nativeBooted=true;`
	handler := &ScriptHandler{}
	generated, handled := handler.handleVirtualSvgIcons("/t/wx_fed/finder/web/web-finder/res/js/virtual_svg-icons-register.test.js", fixture)
	if !handled {
		t.Fatal("核心模块未经过实际重写函数")
	}
	for _, scenario := range []struct {
		name   string
		setup  string
		verify string
	}{
		{
			name: "success",
			setup: `globalThis.WXU={Events:{APILoaded:"APILoaded"},emit(event,methods){
				if(event!=="APILoaded"||methods.api$.finderSearch()!=="native")throw Error("wrong event");
				globalThis.published=methods.api$;
			}};`,
			verify: `if(globalThis.published!==api$)throw Error("API exports not published");`,
		},
		{name: "missing_utils"},
		{name: "missing_events", setup: `globalThis.WXU={emit(){throw Error("must be isolated")}};`},
		{name: "listener_throws", setup: `globalThis.WXU={Events:{APILoaded:"APILoaded"},emit(){throw Error("collector failed")}};`},
		{
			name: "error_reporting_also_throws",
			setup: `globalThis.WXU={Events:{APILoaded:"APILoaded"},emit(){throw Error("collector failed")}};
				globalThis.console={warn(){throw Error("logging failed")},error(){throw Error("logging failed")}};`,
		},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			command := exec.CommandContext(ctx, node, "--input-type=module")
			command.Stdin = strings.NewReader(scenario.setup + generated + `
if(!globalThis.nativeBooted||api$.finderSearch()!=="native")throw Error("native module initialization interrupted");
` + scenario.verify)
			if output, err := command.CombinedOutput(); err != nil {
				t.Fatalf("微信核心模块未能继续初始化: %v\n%s", err, output)
			}
		})
	}
}
