package websocket

import (
	"testing"
	"time"

	json "github.com/json-iterator/go"
)

func TestSnapshotStopRequiresPageAcknowledgement(t *testing.T) {
	for _, tc := range []struct {
		name string
		ack  string
		want bool
	}{
		{"confirmed", `{"success":true,"stopped":true}`, true},
		{"success_without_stop", `{"success":true}`, false},
		{"rejected", `{"success":false,"stopped":true}`, false},
		{"malformed", `{`, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h := NewHub(nil)
			feed := navigationClient(h, "/web/pages/feed", 1, 0)
			feed.href = "https://channels.weixin.qq.com/web/pages/feed?oid=a"
			h.clients[feed] = true
			h.SetCommentSnapshotStatus("snap", &CommentSnapshotStatus{
				CollectionID: "collection", PageInstanceID: feed.pageInstanceID, URL: feed.href,
			})
			done := make(chan error, 1)
			go func() { done <- h.StopCommentSnapshot("snap") }()
			select {
			case data := <-feed.send:
				var message WSMessage
				var request APICallRequest
				if err := json.Unmarshal(data, &message); err != nil {
					t.Fatal(err)
				}
				if err := json.Unmarshal(message.Data, &request); err != nil {
					t.Fatal(err)
				}
				body := request.Body.(map[string]interface{})
				if body["action"] != "stop_comment_snapshot" || body["task_id"] != "snap" || body["page_instance_id"] != feed.pageInstanceID {
					t.Fatalf("incorrect stop target: %+v", body)
				}
				h.SubmitResponse(APICallResponse{ID: request.ID, Data: json.RawMessage(tc.ack)})
			case err := <-done:
				t.Fatalf("stop ended without page dispatch: %v", err)
			case <-time.After(time.Second):
				t.Fatal("stop was not dispatched")
			}
			if err := <-done; (err == nil) != tc.want {
				t.Fatalf("stop result: %v, want acknowledged=%v", err, tc.want)
			}
			status := h.GetCommentSnapshotStatus("snap")
			if status.Stopped != tc.want || status.Done != tc.want || status.Success {
				t.Fatalf("incorrect terminal state: %+v", status)
			}
			if tc.want {
				if err := h.StopCommentSnapshot("snap"); err != nil {
					t.Fatal(err)
				}
				select {
				case <-feed.send:
					t.Fatal("confirmed stop dispatched twice")
				default:
				}
			}
		})
	}
}
