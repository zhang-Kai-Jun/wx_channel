package handlers

import (
	"encoding/json"
	"io"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/qtgolang/SunnyNet/SunnyNet"
	"github.com/qtgolang/SunnyNet/public"
	"wx_channel/internal/config"
	"wx_channel/internal/websocket"
)

func TestManualNavigationIsIsolatedFromTaskResponseContract(t *testing.T) {
	h := NewAPIHandler(&config.Config{}, websocket.NewHub(nil))
	for _, action := range []string{"open_link", "open_profile", "enter_video"} {
		conn := &SunnyNet.HttpConn{
			Type:    public.HttpSendRequest,
			Request: httptest.NewRequest("POST", "/__wx_channels_api/action", strings.NewReader(`{"action":"`+action+`","url":"https://channels.weixin.qq.com/web/pages/profile"}`)),
		}
		if !h.Handle(conn) || conn.Response == nil {
			t.Fatal("missing response")
		}
		data, err := io.ReadAll(conn.Response.Body)
		conn.Response.Body.Close()
		if err != nil {
			t.Fatal(err)
		}
		var result map[string]interface{}
		if err := json.Unmarshal(data, &result); err != nil {
			t.Fatal(err)
		}
		if action == "open_link" {
			if result["success"] != false || result["message"] == "" {
				t.Fatalf("unconfirmed manual navigation: %s", data)
			}
		} else if result["success"] != true || result["message"] != "navigating" {
			t.Fatalf("task navigation response contract changed: %s", data)
		}
	}
}

func TestManualNavigationLeavesLinkValidationToFrontend(t *testing.T) {
	for _, tc := range []struct {
		name, link, taskID, message string
	}{
		{"video", "https://channels.weixin.qq.com/web/pages/feed?oid=a", "", "视频号页面未就绪或打开链接回执超时，请稍后重试"},
		{"profile", "https://channels.weixin.qq.com/web/pages/profile?username=a", "", "视频号页面未就绪或打开链接回执超时，请稍后重试"},
		{"short", "https://weixin.qq.com/sph/A8atiaxJu3", "", "视频号页面未就绪或打开链接回执超时，请稍后重试"},
		{"short-trim", " https://weixin.qq.com/sph/AnGty8n5qt ", "", "视频号页面未就绪或打开链接回执超时，请稍后重试"},
		{"task", "https://channels.weixin.qq.com/web/pages/feed?oid=a", "task-a", "手动打开链接不能携带任务编号"},
		{"short-task", "https://weixin.qq.com/sph/A8atiaxJu3", "task-a", "手动打开链接不能携带任务编号"},
		{"no-domain-validation", "https://example.com/video", "", "视频号页面未就绪或打开链接回执超时，请稍后重试"},
		{"no-path-validation", "https://weixin.qq.com/other", "", "视频号页面未就绪或打开链接回执超时，请稍后重试"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			body, err := json.Marshal(map[string]string{"action": "open_link", "url": tc.link, "task_id": tc.taskID})
			if err != nil {
				t.Fatal(err)
			}
			h := NewAPIHandler(&config.Config{}, websocket.NewHub(nil))
			conn := &SunnyNet.HttpConn{Type: public.HttpSendRequest, Request: httptest.NewRequest("POST", "/__wx_channels_api/action", strings.NewReader(string(body)))}
			h.Handle(conn)
			defer conn.Response.Body.Close()
			var result struct {
				Success bool   `json:"success"`
				Message string `json:"message"`
			}
			if err := json.NewDecoder(conn.Response.Body).Decode(&result); err != nil {
				t.Fatal(err)
			}
			if result.Success || result.Message != tc.message {
				t.Fatalf("unexpected result: %+v", result)
			}
		})
	}
}
