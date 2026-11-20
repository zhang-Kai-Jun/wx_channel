package websocket

import (
	"testing"
	"time"
)

func callDOM(h *Hub, req DOMActionBody) error {
	_, err := h.CallAPI(domActionKey, req, time.Second)
	return err
}

func TestExpectedWorkCannotMatchMissingWork(t *testing.T) {
	st := ClientStatus{PagePath: feedPagePath, PageInstanceID: "doc"}
	if matchesClientIdentity(st, feedPagePath, "doc", "", "expected", true) {
		t.Fatal("unknown work must not satisfy an explicit work binding")
	}
}

func TestFeedActionsGoToNewestFeedPageAndStaySticky(t *testing.T) {
	h := NewHub(nil)
	profile := navigationClient(h, profilePagePath, 3, 0)
	oldFeed := navigationClient(h, feedPagePath, 1, 0)
	newFeed := navigationClient(h, feedPagePath, 2, 9) // 负载高也不影响
	h.clients[profile], h.clients[oldFeed], h.clients[newFeed] = true, true, true

	for _, action := range []string{"get_status", "do_like", "do_follow", "do_comment"} {
		a := action
		checkNavigationDispatch(t, h, newFeed, a, func() error { return callDOM(h, DOMActionBody{Action: a}) })
	}
	// 又出现更新的作品页前，绑定页面仍然有效，不能漂移
	later := navigationClient(h, feedPagePath, 4, 0)
	h.clients[later] = true
	checkNavigationDispatch(t, h, newFeed, "do_like", func() error { return callDOM(h, DOMActionBody{Action: "do_like"}) })
	// 新一轮导航清除绑定后，重新选择最新页面
	h.ClearPageBindings()
	checkNavigationDispatch(t, h, later, "get_status", func() error { return callDOM(h, DOMActionBody{Action: "get_status"}) })
}

func TestProfileActionsIncludeGetVideoCardsAndNeverGoToFeed(t *testing.T) {
	h := NewHub(nil)
	oldProfile := navigationClient(h, profilePagePath, 1, 0)
	newProfile := navigationClient(h, profilePagePath, 2, 5)
	feed := navigationClient(h, feedPagePath, 3, 0)
	h.clients[oldProfile], h.clients[newProfile], h.clients[feed] = true, true, true
	for _, action := range []string{"get_video_cards", "get_profile_status", "do_follow_on_profile", "scroll_author_to_bottom", "fetch_author_video_cards"} {
		a := action
		checkNavigationDispatch(t, h, newProfile, a, func() error {
			return callDOM(h, DOMActionBody{Action: a})
		})
	}
	// 主页绑定后，enter_video 同样发给该绑定主页，不会回退到 oldProfile 或 feed
	checkNavigationDispatch(t, h, newProfile, "enter_video", func() error {
		return callDOM(h, DOMActionBody{Action: "enter_video", Target: "video"})
	})
}

func TestSearchActionsRouteToBoundSearchPage(t *testing.T) {
	h := NewHub(nil)
	oldSearch := navigationClient(h, searchPagePath, 1, 0)
	newSearch := navigationClient(h, searchPagePath, 2, 5)
	feed := navigationClient(h, feedPagePath, 3, 0)
	h.clients[oldSearch], h.clients[newSearch], h.clients[feed] = true, true, true
	for _, action := range []string{"scroll_search_to_bottom", "fetch_search_video_cards", "click_search_video_card"} {
		a := action
		checkNavigationDispatch(t, h, newSearch, a, func() error {
			return callDOM(h, DOMActionBody{Action: a, Target: "search"})
		})
	}
}

func TestOpenProfileWithTargetURLPrefersVisibleAndAvoidsStaleHiddenPage(t *testing.T) {
	h := NewHub(nil)
	hiddenOld := navigationClient(h, "/web/pages/home", 3, 0)
	hiddenOld.hiddenSince = time.Now().Add(-time.Minute)
	visibleHost := navigationClient(h, profilePagePath, 2, 5)
	visibleHost.visible = true
	visibleHost.hiddenSince = time.Time{}
	h.clients[hiddenOld], h.clients[visibleHost] = true, true

	checkNavigationDispatch(t, h, visibleHost, "open_profile", func() error {
		return callDOM(h, DOMActionBody{
			Action: "open_profile",
			Target: "profile",
			URL:    "https://channels.weixin.qq.com/web/pages/profile?username=target_author",
		})
	})
}

func TestBoundPageIdentityMismatchAndInvalidationNeverFallbackToOtherPage(t *testing.T) {
	oldWait := pageResolveWait
	pageResolveWait = 200 * time.Millisecond
	defer func() { pageResolveWait = oldWait }()

	h := NewHub(nil)
	otherFeed := navigationClient(h, feedPagePath, 1, 0)
	otherFeed.href = "https://channels.weixin.qq.com/web/pages/feed?oid=other_work"
	otherFeed.workID = "work-other"

	boundFeed := navigationClient(h, feedPagePath, 2, 0)
	boundFeed.href = "https://channels.weixin.qq.com/web/pages/feed?oid=target_work"
	boundFeed.workID = "work-target"
	h.clients[otherFeed], h.clients[boundFeed] = true, true

	checkNavigationDispatch(t, h, boundFeed, "get_status", func() error {
		return callDOM(h, DOMActionBody{Action: "get_status", URL: boundFeed.href, WorkID: "work-target"})
	})

	// 同一 WebView 内作品跳转到其他作品（work_id 变化），后续动作必须立即失败，绝不发给 boundFeed 或 otherFeed
	boundFeed.mu.Lock()
	boundFeed.href = "https://channels.weixin.qq.com/web/pages/feed?oid=drifted_work"
	boundFeed.workID = "work-drifted"
	boundFeed.mu.Unlock()

	if err := callDOM(h, DOMActionBody{Action: "do_like"}); err == nil {
		t.Fatal("expected error when bound feed page drifted to another work")
	}
	// 绑定页面关闭后，也不得自动切换到 otherFeed
	delete(h.clients, boundFeed)
	if err := callDOM(h, DOMActionBody{Action: "do_follow"}); err == nil {
		t.Fatal("expected error when bound feed page disconnected")
	}
	select {
	case <-otherFeed.send:
		t.Fatal("command leaked to another feed page after bound page invalidated")
	default:
	}
}

func TestPageInstanceIDRoutesExactly(t *testing.T) {
	h := NewHub(nil)
	a := navigationClient(h, feedPagePath, 1, 0) // page-1
	b := navigationClient(h, feedPagePath, 2, 0) // page-2
	h.clients[a], h.clients[b] = true, true
	checkNavigationDispatch(t, h, a, "do_like", func() error {
		return callDOM(h, DOMActionBody{Action: "do_like", PageInstanceID: "page-1"})
	})
}

func TestWaitsForTargetPageInsteadOfUsingWrongPage(t *testing.T) {
	old := pageResolveWait
	pageResolveWait = 3 * time.Second
	defer func() { pageResolveWait = old }()

	h := NewHub(nil)
	profile := navigationClient(h, profilePagePath, 1, 0)
	h.clients[profile] = true
	go func() {
		time.Sleep(400 * time.Millisecond)
		feed := navigationClient(h, feedPagePath, 2, 0)
		h.mu.Lock()
		h.clients[feed] = true
		h.mu.Unlock()
	}()
	done := make(chan error, 1)
	go func() { done <- callDOM(h, DOMActionBody{Action: "do_like"}) }()
	select {
	case <-profile.send:
		t.Fatal("do_like must not be sent to the profile page")
	case <-time.After(1500 * time.Millisecond):
	}
	<-done
}

func TestNoTargetPageReturnsReadableErrorAfterWait(t *testing.T) {
	old := pageResolveWait
	pageResolveWait = 300 * time.Millisecond
	defer func() { pageResolveWait = old }()

	h := NewHub(nil)
	profile := navigationClient(h, profilePagePath, 1, 0)
	h.clients[profile] = true
	err := callDOM(h, DOMActionBody{Action: "do_like"})
	if err == nil {
		t.Fatal("expected error when no feed page exists")
	}
	select {
	case <-profile.send:
		t.Fatal("request leaked to the profile page")
	default:
	}
}

func TestUnrestrictedActionsKeepOriginalSelector(t *testing.T) {
	h := NewHub(nil)
	c := navigationClient(h, "/web/pages/s", 1, 0)
	h.clients[c] = true
	checkNavigationDispatch(t, h, c, "go_back", func() error {
		return callDOM(h, DOMActionBody{Action: "go_back"})
	})
}
