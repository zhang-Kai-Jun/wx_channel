package handlers

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/qtgolang/SunnyNet/SunnyNet"
	"github.com/qtgolang/SunnyNet/public"
	"wx_channel/internal/config"
	"wx_channel/internal/websocket"
)

func TestCommentOperationHTTPProtocol(t *testing.T) {
	h := NewAPIHandler(&config.Config{}, websocket.NewHub(nil))
	id := fmt.Sprintf("comment_%d_0123456789abcdef", time.Now().UnixMilli())
	call := func(method, path, body string) (int, map[string]interface{}) {
		t.Helper()
		conn := &SunnyNet.HttpConn{Type: public.HttpSendRequest, Request: httptest.NewRequest(method, path, strings.NewReader(body))}
		if !h.Handle(conn) || conn.Response == nil {
			t.Fatal("missing HTTP response")
		}
		defer conn.Response.Body.Close()
		data, _ := io.ReadAll(conn.Response.Body)
		var result map[string]interface{}
		if err := json.Unmarshal(data, &result); err != nil {
			t.Fatal(err)
		}
		return conn.Response.StatusCode, result
	}
	status, receipt := call("POST", "/__wx_channels_api/action", fmt.Sprintf(`{"action":"do_comment","async_comment":true,"operation_id":%q,"content":"test"}`, id))
	if status != 202 || receipt["accepted"] != true || receipt["operation_id"] != id || receipt["success"] != nil {
		t.Fatalf("bad receipt: %d %+v", status, receipt)
	}
	path := "/__wx_channels_api/comment_operation_result?operation_id=" + id
	deadline := time.Now().Add(time.Second)
	for {
		status, state := call("GET", path, "")
		if status != 200 || state["operation_id"] != id {
			t.Fatalf("bad state: %+v", state)
		}
		if state["status"] == "unknown" {
			break
		} // No browser is connected in this test.
		if time.Now().After(deadline) {
			t.Fatalf("missing terminal state: %+v", state)
		}
		time.Sleep(time.Millisecond)
	}
	if status, _ := call("POST", path, ""); status != 405 {
		t.Fatal("wrong method accepted")
	}
	if status, _ := call("GET", "/__wx_channels_api/comment_operation_result", ""); status != 400 {
		t.Fatal("missing ID accepted")
	}
	if status, _ := call("POST", "/__wx_channels_api/action", `{"action":"do_comment","async_comment":true}`); status != 400 {
		t.Fatal("missing operation ID executed")
	}
}
