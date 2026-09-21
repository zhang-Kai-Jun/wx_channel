package websocket

import (
	"errors"
	"time"

	json "github.com/json-iterator/go"
)

// CallManualOpenLink is isolated from task navigation and its load balancer.
func (h *Hub) CallManualOpenLink(url string, timeout time.Duration) (json.RawMessage, error) {
	client, err := h.manualNavigationClient()
	if err != nil {
		return nil, err
	}
	return h.callAPIOnClient(client, "key:channels:dom_action", DOMActionBody{
		Action: "open_link", Target: "page", URL: url,
	}, timeout)
}

func (h *Hub) manualNavigationClient() (*Client, error) {
	h.mu.RLock()
	defer h.mu.RUnlock()
	// Older pages may remain connected after navigation. Only manual opens use registration order.
	var latest *Client
	for client := range h.clients {
		client.mu.Lock()
		closed := client.closed
		client.mu.Unlock()
		if !closed && (latest == nil || client.registeredSequence > latest.registeredSequence) {
			latest = client
		}
	}
	// A loading latest page must not send the command back to an older page.
	if latest == nil || !latest.SupportsKey("key:channels:dom_action") {
		return nil, errors.New("manual navigation page is not ready")
	}
	return latest, nil
}
