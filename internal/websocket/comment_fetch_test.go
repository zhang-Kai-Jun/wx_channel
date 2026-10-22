package websocket

import (
	"testing"
	"time"
)

func TestCommentFetchBindsFeedAndReconnectsOnlySameWork(t *testing.T) {
	h := NewHub(nil)
	home := navigationClient(h, "/web/pages/home", 1, 0)
	feed := navigationClient(h, "/web/pages/feed", 2, 5)
	href := "https://channels.weixin.qq.com/web/pages/feed?objectId=work-a"
	feed.href = href
	h.clients[home], h.clients[feed] = true, true
	req := DOMActionBody{Action: "fetch_video_comments", CollectionID: "collection-a", URL: href, TaskID: "fetch-a"}
	checkNavigationDispatch(t, h, feed, req.Action, func() error { _, err := h.CallCommentFetch(req, time.Second); return err })
	other := navigationClient(h, "/web/pages/feed", 3, 0)
	other.href = "https://channels.weixin.qq.com/web/pages/feed?objectId=work-b"
	h.clients[other] = true
	checkNavigationDispatch(t, h, feed, req.Action, func() error { _, err := h.CallCommentFetch(req, time.Second); return err })
	delete(h.clients, feed)
	feed.cancel()
	if _, err := h.CallCommentFetch(req, time.Millisecond); err == nil {
		t.Fatal("disconnected work must not fall back to home or another feed")
	}
	replacement := navigationClient(h, "/web/pages/feed", 4, 0)
	replacement.href = href
	replacement.pageInstanceID = feed.pageInstanceID
	h.clients[replacement] = true
	checkNavigationDispatch(t, h, replacement, req.Action, func() error { _, err := h.CallCommentFetch(req, time.Second); return err })
}

func TestCommentFetchRejectsAmbiguousShortLink(t *testing.T) {
	h := NewHub(nil)
	for i, href := range []string{"work-a", "work-b"} {
		c := navigationClient(h, "/web/pages/feed", uint64(i+1), 0)
		c.href = "https://channels.weixin.qq.com/web/pages/feed?objectId=" + href
		h.clients[c] = true
	}
	if _, err := h.CallCommentFetch(DOMActionBody{CollectionID: "collection", URL: "https://weixin.qq.com/sph/test"}, time.Millisecond); err == nil {
		t.Fatal("must not guess among multiple works")
	}
}

func TestFetchTimeoutCannotOverwriteConfirmedResult(t *testing.T) {
	h := NewHub(nil)
	h.SetFetchCommentsResult("task", &FetchCommentsData{Success: true, CommentCount: 1})
	h.SetFetchCommentsResult("task", &FetchCommentsData{RequiresReset: true})
	if !h.GetFetchCommentsResult("task").Success {
		t.Fatal("late timeout overwrote completed comments")
	}
}

func TestCommentFetchDisconnectWakesPendingCall(t *testing.T) {
	h := NewHub(nil)
	feed := navigationClient(h, "/web/pages/feed", 1, 0)
	feed.href = "https://channels.weixin.qq.com/web/pages/feed?objectId=work"
	h.clients[feed] = true
	done := make(chan error, 1)
	go func() {
		_, err := h.CallCommentFetch(DOMActionBody{CollectionID: "collection", URL: feed.href}, time.Second)
		done <- err
	}()
	select {
	case <-feed.send:
	case <-time.After(time.Second):
		t.Fatal("request not dispatched")
	}
	feed.cancel()
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("disconnect must return an error")
		}
	case <-time.After(100 * time.Millisecond):
		t.Fatal("disconnect still waits for timeout")
	}
	if feed.GetActiveRequests() != 0 {
		t.Fatal("request slot not released")
	}
}

func TestUnscopedCommentFetchKeepsOriginalRouting(t *testing.T) {
	h := NewHub(nil)
	home := navigationClient(h, "/web/pages/home", 1, 0)
	feed := navigationClient(h, "/web/pages/feed", 2, 5)
	h.clients[home], h.clients[feed] = true, true
	checkNavigationDispatch(t, h, home, "fetch_video_comments", func() error {
		_, err := h.CallCommentFetch(DOMActionBody{Action: "fetch_video_comments"}, time.Second)
		return err
	})
}

func TestCommentFetchRejectsWrongOID(t *testing.T) {
	h := NewHub(nil)
	feed := navigationClient(h, "/web/pages/feed", 1, 0)
	feed.href = "https://channels.weixin.qq.com/web/pages/feed?oid=b"
	h.clients[feed] = true
	if _, err := h.commentFetchClient(DOMActionBody{CollectionID: "a", URL: "https://channels.weixin.qq.com/web/pages/feed?oid=a"}); err == nil {
		t.Fatal("wrong oid selected")
	}
}

func TestSnapshotTerminalCannotBeReopenedByLateCallback(t *testing.T) {
	h := NewHub(nil)
	h.SetCommentSnapshotStatus("sph_7_task", &CommentSnapshotStatus{Done: true, Success: false, Error: "cancelled"})
	h.SetCommentSnapshotStatus("sph_7_task", &CommentSnapshotStatus{Done: true, Success: true})
	if h.GetCommentSnapshotStatus("sph_7_task").Success {
		t.Fatal("late result replaced cancellation")
	}
}

func TestCommentFetchRejectsNewDocumentAtSameURL(t *testing.T) {
	h := NewHub(nil)
	feed := navigationClient(h, "/web/pages/feed", 1, 0)
	feed.href = "https://channels.weixin.qq.com/web/pages/feed?oid=a"
	h.clients[feed] = true
	req := DOMActionBody{CollectionID: "a", URL: feed.href}
	if _, err := h.commentFetchClient(req); err != nil {
		t.Fatal(err)
	}
	delete(h.clients, feed)
	feed.cancel()
	replacement := navigationClient(h, "/web/pages/feed", 2, 0)
	replacement.href = feed.href
	h.clients[replacement] = true
	if _, err := h.commentFetchClient(req); err == nil {
		t.Fatal("new document reused old request")
	}
}

func TestSnapshotStartIsIdempotentAndScoped(t *testing.T) {
	h := NewHub(nil)
	feed := navigationClient(h, "/web/pages/feed", 1, 0)
	feed.href = "https://channels.weixin.qq.com/web/pages/feed?oid=a"
	h.clients[feed] = true
	req := DOMActionBody{CollectionID: "a", TaskID: "snap", URL: feed.href}
	checkNavigationDispatch(t, h, feed, "start_comment_snapshot", func() error { return h.StartCommentSnapshot(req) })
	if err := h.StartCommentSnapshot(req); err != nil {
		t.Fatal(err)
	}
	select {
	case <-feed.send:
		t.Fatal("duplicate snapshot dispatched")
	default:
	}
	status := h.GetCommentSnapshotStatus("snap")
	if status.PageInstanceID != feed.pageInstanceID || status.URL != feed.href {
		t.Fatal("missing owner metadata")
	}
}

func TestSnapshotRejectsForeignCallback(t *testing.T) {
	h := NewHub(nil)
	h.SetCommentSnapshotStatus("snap", &CommentSnapshotStatus{CollectionID: "a", PageInstanceID: "doc-a", URL: "a"})
	h.SetCommentSnapshotStatus("snap", &CommentSnapshotStatus{CollectionID: "a", PageInstanceID: "doc-b", URL: "a", Done: true, Success: true})
	if h.GetCommentSnapshotStatus("snap").Done {
		t.Fatal("foreign page completed the snapshot")
	}
}

func TestCommentWorkIdentityNamespaces(t *testing.T) {
	base := "https://channels.weixin.qq.com/web/pages/feed?"
	for _, key := range []string{"objectId", "feedId", "oid", "encryptedId", "finderfeedid", "id"} {
		if !sameCommentWork(base+key+"=a", base+key+"=a&extra=x") || sameCommentWork(base+key+"=a", base+key+"=b") {
			t.Fatalf("wrong match for %s", key)
		}
	}
	if sameCommentWork(base+"oid=a", base+"objectId=a") {
		t.Fatal("different ID namespaces treated as equivalent")
	}
	if sameCommentWork(base+"oid=a&objectId=b", base+"oid=a&objectId=c") {
		t.Fatal("conflicting identity accepted")
	}
}
