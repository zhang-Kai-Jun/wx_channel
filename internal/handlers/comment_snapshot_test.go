package handlers

import (
	"encoding/json"
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
	"wx_channel/internal/websocket"
)

func TestSnapshotStatusRetainsTerminalOwnership(t *testing.T) {
	for _, reason := range []string{"completed", "no_growth", "timeout"} {
		t.Run(reason, func(t *testing.T) {
			h := NewAPIHandler(&config.Config{}, websocket.NewHub(nil))
			complete := reason == "completed"
			payload, err := json.Marshal(map[string]interface{}{
				"task_id": "snapshot", "collection_id": "collection", "page_instance_id": "page",
				"url":  "https://channels.weixin.qq.com/web/pages/feed?oid=a",
				"done": true, "success": complete, "complete": complete, "stopped": true, "stop_reason": reason,
				"error": "disk unavailable", "loaded_count": 7280, "total_count": 15702,
			})
			if err != nil {
				t.Fatal(err)
			}
			post := &SunnyNet.HttpConn{Type: public.HttpSendRequest, Request: httptest.NewRequest("POST", "/__wx_channels_api/comment_snapshot_callback", strings.NewReader(string(payload)))}
			h.Handle(post)
			post.Response.Body.Close()
			get := &SunnyNet.HttpConn{Type: public.HttpSendRequest, Request: httptest.NewRequest("GET", "/__wx_channels_api/comment_snapshot_status?task_id=snapshot", nil)}
			h.Handle(get)
			defer get.Response.Body.Close()
			var result map[string]interface{}
			if err := json.NewDecoder(get.Response.Body).Decode(&result); err != nil {
				t.Fatal(err)
			}
			for _, key := range []string{"collection_id", "page_instance_id", "url", "done", "success", "complete", "stopped", "stop_reason", "error", "loaded_count", "total_count"} {
				var expected map[string]interface{}
				if err := json.Unmarshal(payload, &expected); err != nil {
					t.Fatal(err)
				}
				if result[key] != expected[key] {
					t.Fatalf("status lost %s: got %v, want %v", key, result[key], expected[key])
				}
			}
		})
	}
}

func TestSnapshotFileRetainsCollectionAndCompleteness(t *testing.T) {
	base, err := utils.GetBaseDir()
	if err != nil {
		t.Fatal(err)
	}
	rel, err := filepath.Rel(base, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	cfg := config.Get()
	previous := cfg.DataDir
	cfg.DataDir = rel
	t.Cleanup(func() { cfg.DataDir = previous })
	h := NewCommentHandler(cfg)
	conn := &SunnyNet.HttpConn{Type: public.HttpSendRequest, Request: httptest.NewRequest("POST", "/__wx_channels_api/dump_pinia_store", strings.NewReader(`{"stores":{"home":{}},"page":"feed","url":"https://channels.weixin.qq.com/web/pages/feed?oid=a","collection_id":"a","page_instance_id":"doc-a","complete":true,"stop_reason":"completed"}`))}
	if !h.Handle(conn) {
		t.Fatal("snapshot not handled")
	}
	data, err := io.ReadAll(conn.Response.Body)
	if err != nil {
		t.Fatal(err)
	}
	conn.Response.Body.Close()
	var response struct {
		Path string `json:"path"`
	}
	if err := json.Unmarshal(data, &response); err != nil {
		t.Fatal(err)
	}
	data, err = os.ReadFile(response.Path)
	if err != nil {
		t.Fatal(err)
	}
	var snapshot map[string]interface{}
	if err := json.Unmarshal(data, &snapshot); err != nil {
		t.Fatal(err)
	}
	if snapshot["collection_id"] != "a" || snapshot["page_instance_id"] != "doc-a" || snapshot["complete"] != true || snapshot["stop_reason"] != "completed" {
		t.Fatalf("snapshot metadata lost: %s", data)
	}
}
