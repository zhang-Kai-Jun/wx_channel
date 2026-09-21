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
