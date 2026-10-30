package handlers

import (
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/qtgolang/SunnyNet/SunnyNet"
	"github.com/qtgolang/SunnyNet/public"
	"wx_channel/internal/config"
	"wx_channel/internal/websocket"
)

func TestAuthorCommentPageBindingHTTPUsesLatestOnlyForFirstBind(t *testing.T) {
	hub := websocket.NewHub(nil)
	go hub.Run()
	register := func(index int) {
		t.Helper()
		client := websocket.NewClient(nil, hub)
		client.UpdateState(websocket.ClientStateBody{
			PagePath: "/web/pages/feed", APIReady: true,
			Methods:        map[string]bool{"finderUserPage": true},
			Href:           "https://channels.weixin.qq.com/web/pages/feed?oid=work",
			PageInstanceID: fmt.Sprintf("page-%d", index),
		})
		hub.RegisterClient(client)
		deadline := time.Now().Add(time.Second)
		for hub.ClientCount() != index {
			if time.Now().After(deadline) {
				t.Fatal("client registration timed out")
			}
			time.Sleep(time.Millisecond)
		}
	}
	register(1)
	register(2)
	h := NewAPIHandler(&config.Config{}, hub)
	bind := func(body string, wantStatus int, wantInstance string) {
		t.Helper()
		conn := &SunnyNet.HttpConn{Type: public.HttpSendRequest,
			Request: httptest.NewRequest("POST", "/__wx_channels_api/action", strings.NewReader(body))}
		if !h.Handle(conn) || conn.Response == nil {
			t.Fatal("missing binding response")
		}
		defer conn.Response.Body.Close()
		var result struct {
			Success        bool   `json:"success"`
			PageInstanceID string `json:"page_instance_id"`
		}
		if err := json.NewDecoder(conn.Response.Body).Decode(&result); err != nil {
			t.Fatal(err)
		}
		if conn.Response.StatusCode != wantStatus || result.PageInstanceID != wantInstance || result.Success != (wantStatus == 200) {
			t.Fatalf("unexpected binding: HTTP %d, %+v", conn.Response.StatusCode, result)
		}
	}
	bind(`{"action":"bind_comment_page","collection_id":"strict"}`, 409, "")
	body := `{"action":"bind_comment_page","collection_id":"author","prefer_latest":true}`
	bind(body, 200, "page-2")
	register(3)
	bind(body, 200, "page-2")
	bind(`{"action":"bind_comment_page","collection_id":"next-video","prefer_latest":true}`, 200, "page-3")
	if hub.ClientCount() != 3 {
		t.Fatal("binding closed other pages")
	}
}
