package websocket

import (
	"errors"
	"fmt"
	"net/url"
	"time"

	"wx_channel/internal/utils"

	json "github.com/json-iterator/go"
)

var ErrCommentPageUnavailable = errors.New("comment work page unavailable")

type commentFetchBinding struct {
	client   *Client
	href     string
	instance string
	work     string
}

func commentWorkID(href string) string {
	u, err := url.Parse(href)
	if err != nil {
		return ""
	}
	for _, key := range []string{"objectId", "feedId", "oid", "encryptedId", "finderfeedid", "id"} {
		if id := u.Query().Get(key); id != "" {
			return id
		}
	}
	return ""
}

// Only compare identifiers in the same namespace; encrypted and plain IDs can differ.
func sameCommentWork(expected, actual string) bool {
	a, e1 := url.Parse(expected)
	b, e2 := url.Parse(actual)
	if e1 != nil || e2 != nil {
		return false
	}
	known, matched := false, false
	for _, key := range []string{"objectId", "feedId", "oid", "encryptedId", "finderfeedid", "id"} {
		if id := a.Query().Get(key); id != "" {
			known = true
			if actualID := b.Query().Get(key); actualID != "" {
				if actualID != id {
					return false
				}
				matched = true
			}
		}
	}
	if known {
		return matched
	}
	// Short links are resolved by selecting a unique feed, then pinning its document.
	return !known && (a.Host != "channels.weixin.qq.com" || expected == "" || a.String() == b.String())
}

// Comment collection has a work-page affinity; other DOM actions keep their selector.
func (h *Hub) commentFetchClient(req DOMActionBody) (*Client, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	binding, bound := h.commentFetchBindings[req.CollectionID]
	if bound && req.URL != "" && !sameCommentWork(req.URL, binding.href) {
		return nil, ErrCommentPageUnavailable
	}
	if bound && h.clients[binding.client] && binding.client.ctx.Err() == nil {
		status := binding.client.Status()
		if status.PagePath == "/web/pages/feed" && status.Href == binding.href && status.PageInstanceID == binding.instance && (binding.work == "" || status.WorkID == binding.work) && (req.PageInstanceID == "" || req.PageInstanceID == binding.instance) && binding.client.SupportsKey("key:channels:dom_action") {
			if binding.work == "" && status.WorkID != "" {
				binding.work = status.WorkID
				h.commentFetchBindings[req.CollectionID] = binding
			}
			return binding.client, nil
		}
	}
	var selected *Client
	for client := range h.clients {
		status := client.Status()
		if client.ctx.Err() != nil || !client.SupportsKey("key:channels:dom_action") || status.PagePath != "/web/pages/feed" {
			continue
		}
		if bound {
			if status.Href != binding.href || status.PageInstanceID != binding.instance || (binding.work != "" && status.WorkID != binding.work) || (req.PageInstanceID != "" && req.PageInstanceID != binding.instance) {
				continue
			}
		} else if !sameCommentWork(req.URL, status.Href) || (req.PageInstanceID != "" && status.PageInstanceID != req.PageInstanceID) {
			continue
		}
		if selected != nil {
			return nil, fmt.Errorf("%w: multiple matching work pages", ErrCommentPageUnavailable)
		}
		selected = client
	}
	if selected == nil {
		return nil, ErrCommentPageUnavailable
	}
	if selected.Status().Href == "" || selected.Status().PageInstanceID == "" {
		return nil, fmt.Errorf("%w: missing work URL", ErrCommentPageUnavailable)
	}
	if h.commentFetchBindings == nil {
		h.commentFetchBindings = make(map[string]commentFetchBinding)
	}
	status := selected.Status()
	h.commentFetchBindings[req.CollectionID] = commentFetchBinding{client: selected, href: status.Href, instance: status.PageInstanceID, work: status.WorkID}
	return selected, nil
}

func (h *Hub) BindCommentPage(req DOMActionBody) (ClientStatus, error) {
	c, err := h.commentFetchClient(req)
	if err != nil {
		return ClientStatus{}, err
	}
	return c.Status(), nil
}

func (h *Hub) CallCommentFetch(req DOMActionBody, timeout time.Duration) (json.RawMessage, error) {
	if req.CollectionID == "" {
		return h.CallAPI("key:channels:dom_action", req, timeout)
	}
	client, err := h.commentFetchClient(req)
	if err != nil {
		return nil, err
	}
	if err := h.ValidateCommentFetchOwner(req); err != nil {
		return nil, err
	}
	req.WorkID = client.Status().WorkID
	utils.LogInfo("[CommentFetch] task_id=%s collection_id=%s client=%s page=%s", req.TaskID, req.CollectionID, client.RemoteAddr, client.Status().Href)
	return h.callAPIOnClient(client, "key:channels:dom_action", req, timeout)
}

func (h *Hub) ValidateCommentFetchOwner(req DOMActionBody) error {
	if req.TaskID == "" || req.Action != "fetch_video_comments" || req.CollectionID == "" {
		return nil
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.commentFetchOwners == nil {
		h.commentFetchOwners = make(map[string]string)
	}
	if owner, exists := h.commentFetchOwners[req.TaskID]; exists && owner != req.CollectionID {
		return fmt.Errorf("comment request belongs to another collection")
	}
	h.commentFetchOwners[req.TaskID] = req.CollectionID
	return nil
}
