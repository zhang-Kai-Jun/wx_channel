package websocket

import (
	"errors"
	"fmt"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	json "github.com/json-iterator/go"
)

func commentTestID() string {
	return fmt.Sprintf("comment_%d_0123456789abcdef", time.Now().UnixMilli())
}

func awaitComment(t *testing.T, h *Hub, id string) CommentOperationResult {
	t.Helper()
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		result := h.GetCommentOperation(id)
		if result.Status != "pending" {
			return result
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatal("comment did not finish")
	return CommentOperationResult{}
}

func TestCommentOperationSubmitsOnceAndRetainsResult(t *testing.T) {
	h := NewHub(nil)
	id := commentTestID()
	body := DOMActionBody{Action: "do_comment", Content: "test"}
	release := make(chan struct{})
	var releaseOnce sync.Once
	defer releaseOnce.Do(func() { close(release) })
	var calls atomic.Int32
	run := func() (json.RawMessage, error) {
		calls.Add(1)
		<-release
		return json.RawMessage(`{"success":true,"isCommented":true}`), nil
	}
	var wg sync.WaitGroup
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if err := h.startCommentOperation(id, body, run); err != nil {
				t.Error(err)
			}
		}()
	}
	wg.Wait()
	if result := h.GetCommentOperation(id); result.Status != "pending" || len(result.Result) != 0 {
		t.Fatalf("acceptance must not imply success: %+v", result)
	}
	changed := body
	changed.Content = "different"
	if err := h.startCommentOperation(id, changed, run); err == nil {
		t.Fatal("same ID with different content accepted")
	}
	releaseOnce.Do(func() { close(release) })
	result := awaitComment(t, h, id)
	if result.Status != "completed" || string(result.Result) != `{"success":true,"isCommented":true}` {
		t.Fatalf("unexpected result: %+v", result)
	}
	// Session cleanup must not erase the duplicate guard or the polling result.
	h.ResetSession()
	if err := h.startCommentOperation(id, body, run); err != nil {
		t.Fatal(err)
	}
	if calls.Load() != 1 {
		t.Fatalf("executed %d times", calls.Load())
	}
	result.Result[0] = '!'
	if h.GetCommentOperation(id).Result[0] != '{' {
		t.Fatal("caller mutated cached result")
	}
}

func TestCommentOperationPreservesFailures(t *testing.T) {
	for _, tc := range []struct {
		name, data, status string
		err                error
		panicValue         bool
	}{
		{name: "explicit failure", data: `{"success":false,"message":"input missing"}`, status: "completed"},
		{name: "timeout", err: errors.New("request timeout after 1m0s"), status: "unknown"},
		{name: "invalid response", data: `{}`, status: "unknown"},
		{name: "null response", data: `null`, status: "unknown"},
		{name: "uncertain send", data: `{"success":false,"resultUnknown":true}`, status: "unknown"},
		{name: "panic", panicValue: true, status: "unknown"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h := NewHub(nil)
			id := commentTestID()
			err := h.startCommentOperation(id, DOMActionBody{Action: "do_comment"}, func() (json.RawMessage, error) {
				if tc.panicValue {
					panic("probe")
				}
				return json.RawMessage(tc.data), tc.err
			})
			if err != nil {
				t.Fatal(err)
			}
			result := awaitComment(t, h, id)
			if result.Status != tc.status {
				t.Fatalf("result: %+v", result)
			}
			if tc.status == "unknown" && (result.Message == "" || len(result.Result) != 0) {
				t.Fatalf("unknown must not return success: %+v", result)
			}
		})
	}
}

func TestCommentOperationExpiryAndMissing(t *testing.T) {
	h := NewHub(nil)
	id := fmt.Sprintf("comment_%d_0123456789abcdef", time.Now().Add(-time.Hour).UnixMilli())
	err := h.startCommentOperation(id, DOMActionBody{Action: "do_comment"}, func() (json.RawMessage, error) {
		t.Error("expired operation replayed")
		return nil, nil
	})
	if err == nil {
		t.Fatal("expired ID accepted")
	}
	h.commentOperations = map[string]*commentOperation{id: {
		CommentOperationResult: CommentOperationResult{OperationID: id, Status: "completed"},
		expiresAt:              time.Now().Add(-time.Second),
	}}
	if h.GetCommentOperation(id).Status != "missing" || len(h.commentOperations) != 0 {
		t.Fatal("expired result not removed")
	}
}
