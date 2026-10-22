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
)

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
