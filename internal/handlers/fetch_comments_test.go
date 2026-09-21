package handlers

import (
	"encoding/json"
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

func TestFetchCommentsDispatchFailurePublishesResult(t *testing.T) {
	hub := websocket.NewHub(nil)
	h := NewAPIHandler(&config.Config{}, hub)
	conn := &SunnyNet.HttpConn{
		Type:    public.HttpSendRequest,
		Request: httptest.NewRequest("POST", "/__wx_channels_api/action", strings.NewReader(`{"action":"fetch_video_comments","task_id":"fetch-test"}`)),
	}
	h.Handle(conn)
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		if result := hub.GetFetchCommentsResult("fetch-test"); result != nil {
			if result.Success || result.Message == "" || !result.RequiresReset {
				t.Fatalf("missing failure reason/reset: %+v", result)
			}
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatal("dispatch failure left request pending forever")
}

func TestFetchCommentsCallbackPreservesDisabledReason(t *testing.T) {
	hub := websocket.NewHub(nil)
	h := NewAPIHandler(&config.Config{}, hub)
	post := &SunnyNet.HttpConn{Type: public.HttpSendRequest,
		Request: httptest.NewRequest("POST", "/__wx_channels_api/fetch_comments_callback", strings.NewReader(`{"task_id":"closed","success":false,"message":"作者已关闭评论","result":{"reason":"comments_disabled","comment_count":0}}`)),
	}
	h.Handle(post)
	get := &SunnyNet.HttpConn{Type: public.HttpSendRequest,
		Request: httptest.NewRequest("GET", "/__wx_channels_api/fetch_comments_result?task_id=closed", nil),
	}
	h.Handle(get)
	data, err := io.ReadAll(get.Response.Body)
	if err != nil {
		t.Fatal(err)
	}
	get.Response.Body.Close()
	var result map[string]interface{}
	if err := json.Unmarshal(data, &result); err != nil {
		t.Fatal(err)
	}
	if result["reason"] != "comments_disabled" || result["success"] != false || result["requires_reset"] != false {
		t.Fatalf("lost terminal result: %s", data)
	}
}
