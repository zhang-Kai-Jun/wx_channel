package websocket

import (
	"testing"
	"time"

	json "github.com/json-iterator/go"
)

func navigationClient(h *Hub, page string, order uint64, load int) *Client {
	c := NewClient(nil, h)
	c.UpdateState(ClientStateBody{PagePath: page, APIReady: true, Methods: map[string]bool{"finderUserPage": true}})
	c.registeredSequence = order
	c.activeRequests = int32(load)
	return c
}

func checkNavigationDispatch(t *testing.T, h *Hub, expected *Client, action string, call func() error) {
	t.Helper()
	done := make(chan error, 1)
	go func() { done <- call() }()
	select {
	case data := <-expected.send:
		var msg WSMessage
		var req APICallRequest
		if err := json.Unmarshal(data, &msg); err != nil {
			t.Fatal(err)
		}
		if err := json.Unmarshal(msg.Data, &req); err != nil {
			t.Fatal(err)
		}
		body, ok := req.Body.(map[string]interface{})
		if !ok || body["action"] != action {
			t.Fatalf("wrong action: %+v", req.Body)
		}
		h.SubmitResponse(APICallResponse{ID: req.ID, Data: json.RawMessage(`{"success":true}`)})
	case err := <-done:
		t.Fatalf("call ended without dispatch: %v", err)
	case <-time.After(2 * time.Second):
		t.Fatal("command was not sent to expected page")
	}
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}

func TestManualNavigationAndTaskNavigationUseSeparateSelectors(t *testing.T) {
	h := NewHub(nil)
	old := navigationClient(h, "/web/pages/profile", 1, 0)
	latest := navigationClient(h, "/web/pages/profile", 2, 5)
	h.clients[old], h.clients[latest], h.lastClient = true, true, old
	for _, action := range []string{"open_profile", "enter_video"} {
		checkNavigationDispatch(t, h, old, action, func() error {
			_, err := h.CallAPI("key:channels:dom_action", DOMActionBody{Action: action}, time.Second)
			return err
		})
	}
	for i := 0; i < 12; i++ {
		checkNavigationDispatch(t, h, latest, "open_link", func() error {
			_, err := h.CallManualOpenLink("https://channels.weixin.qq.com/web/pages/profile", time.Second)
			return err
		})
	}
}

func TestTaskNavigationReturnsToExistingListAfterDetailDisconnects(t *testing.T) {
	for _, page := range []string{"/web/pages/profile", "/web/pages/s"} {
		t.Run(page, func(t *testing.T) {
			h := NewHub(nil)
			go h.Run()
			register := func(path string) *Client {
				c := navigationClient(h, path, 0, 0)
				h.RegisterClient(c)
				waitNavigationState(t, h, func() bool { return h.lastClient == c })
				return c
			}
			remove := func(c *Client) {
				// Exercise Hub unregister without a real socket.
				c.mu.Lock()
				c.closed = true
				c.mu.Unlock()
				h.unregister <- c
				waitNavigationState(t, h, func() bool { return !h.clients[c] })
			}
			list := register(page)
			for i := 0; i < 3; i++ {
				checkNavigationDispatch(t, h, list, "enter_video", func() error {
					_, err := h.CallAPI("key:channels:dom_action", DOMActionBody{Action: "enter_video", Target: "video"}, time.Second)
					return err
				})
				detail := register("/web/pages/feed")
				remove(detail)
				h.mu.RLock()
				restored := h.lastClient == list
				h.mu.RUnlock()
				if !restored {
					t.Fatal("original list reference was not restored")
				}
			}
			remove(list)
		})
	}
}

func waitNavigationState(t *testing.T, h *Hub, ready func() bool) {
	t.Helper()
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		h.mu.RLock()
		ok := ready()
		h.mu.RUnlock()
		if ok {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatal("Hub state did not settle")
}

func TestManualNavigationWaitsForNewestPageAndIgnoresClosedConnections(t *testing.T) {
	h := NewHub(nil)
	old := navigationClient(h, "/web/pages/profile", 1, 0)
	latest := navigationClient(h, "/web/pages/profile", 2, 0)
	latest.apiReady = false
	h.clients[old], h.clients[latest] = true, true
	if _, err := h.manualNavigationClient(); err == nil {
		t.Fatal("loading page must not fall back to old page")
	}
	client, err := h.GetClientForKey("key:channels:dom_action")
	if err != nil || client != old {
		t.Fatal("task selector was changed")
	}
	latest.closed = true
	client, err = h.manualNavigationClient()
	if err != nil || client != old {
		t.Fatal("closed page should not block manual navigation")
	}
	old.closed = true
	if _, err := h.manualNavigationClient(); err == nil {
		t.Fatal("all pages are closed")
	}
}
