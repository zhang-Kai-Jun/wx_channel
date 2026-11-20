package websocket

import (
	"fmt"
	"net/url"
	"time"

	"wx_channel/internal/utils"
)

const (
	domActionKey           = "key:channels:dom_action"
	feedPagePath           = "/web/pages/feed"
	profilePagePath        = "/web/pages/profile"
	searchPagePath         = "/web/pages/s"
	staleHiddenThresholdMs = int64(30000)
)

var (
	pageResolveWait   = 8 * time.Second
	pageResolvePeriod = 100 * time.Millisecond
)

// 这些动作只能在作品页执行，发到主页、搜索页、首页等其他页面一定是错误派发。
var feedPageActions = map[string]bool{
	"get_status": true, "do_like": true, "do_follow": true, "do_comment": true,
	"do_like_comment": true, "do_reply_comment": true, "get_comment_count": true,
	"pause_video": true, "open_comment_panel": true,
}

// 这些动作只能在作者主页执行。
var profilePageActions = map[string]bool{
	"get_video_cards": true, "get_profile_status": true, "do_follow_on_profile": true,
	"fetch_author_video_cards": true, "scroll_author_to_bottom": true,
}

// 这些动作只能在搜索结果页执行。
var searchPageActions = map[string]bool{
	"scroll_search_to_bottom": true, "fetch_search_video_cards": true, "click_search_video_card": true,
}

type pageBinding struct {
	client   *Client
	instance string
	href     string
	workID   string
}

func isNavigationAction(action string) bool {
	return action == "open_profile" || action == "enter_video"
}

func requiredPagePath(action string) string {
	switch {
	case feedPageActions[action]:
		return feedPagePath
	case profilePageActions[action]:
		return profilePagePath
	case searchPageActions[action]:
		return searchPagePath
	}
	return ""
}

func pagePathMatches(actual, expected string) bool {
	if expected == "" {
		return true
	}
	if expected == searchPagePath && actual == "/pages/s" {
		return true
	}
	return actual == expected
}

// sameTargetURL 校验作者主页、搜索页或作品详情页的身份参数是否一致。
func sameTargetURL(expected, actual string) bool {
	if expected == "" || actual == "" {
		return true
	}
	a, e1 := url.Parse(expected)
	b, e2 := url.Parse(actual)
	if e1 != nil || e2 != nil {
		return expected == actual
	}
	if a.Host == "channels.weixin.qq.com" && b.Host == "channels.weixin.qq.com" && a.Path != "" && b.Path != "" && !pagePathMatches(b.Path, a.Path) {
		return false
	}
	known, matched := false, false
	for _, key := range []string{"objectId", "feedId", "oid", "encryptedId", "finderfeedid", "id", "username", "finderUsername", "q"} {
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
	return a.Host != "channels.weixin.qq.com" || a.String() == b.String()
}

func matchesClientIdentity(st ClientStatus, path, instanceID, targetURL, workID string, checkURL bool) bool {
	if !pagePathMatches(st.PagePath, path) {
		return false
	}
	if instanceID != "" && st.PageInstanceID != instanceID {
		return false
	}
	if checkURL && targetURL != "" && st.Href != "" && !sameTargetURL(targetURL, st.Href) {
		return false
	}
	if workID != "" && st.WorkID != workID {
		return false
	}
	return true
}

func (h *Hub) clientUsable(c *Client, key string) bool {
	c.mu.Lock()
	closed := c.closed
	c.mu.Unlock()
	return !closed && c.SupportsKey(key)
}

func isStaleHidden(st ClientStatus) bool {
	return !st.Visible && st.HiddenForMs >= staleHiddenThresholdMs
}

func betterCandidate(c *Client, cSt ClientStatus, best *Client, bestSt ClientStatus) bool {
	if best == nil {
		return true
	}
	// 淘汰长期隐藏的旧页面（当存在非长期隐藏的候选时）
	cStale, bStale := isStaleHidden(cSt), isStaleHidden(bestSt)
	if cStale != bStale {
		return !cStale
	}
	if cSt.Visible != bestSt.Visible {
		return cSt.Visible
	}
	return c.registeredSequence > best.registeredSequence
}

// ClearPageBindings 在新的导航开始或会话重置时释放页面绑定，避免沿用上一个客户的页面。
func (h *Hub) ClearPageBindings() {
	h.mu.Lock()
	h.pageBindings = nil
	h.mu.Unlock()
}

func (h *Hub) clearFeedBinding() {
	h.mu.Lock()
	if h.pageBindings != nil {
		delete(h.pageBindings, feedPagePath)
	}
	h.mu.Unlock()
}

// pickOpenProfileClient 为首次 open_profile 选择导航宿主：优先可见、未过期的宿主窗口，最新注册者优先。
func (h *Hub) pickOpenProfileClient(req DOMActionBody) (*Client, uint64) {
	h.mu.Lock()
	defer h.mu.Unlock()

	var bestHost, bestAny *Client
	var bestHostSt, bestAnySt ClientStatus
	for c := range h.clients {
		if !h.clientUsable(c, domActionKey) {
			continue
		}
		st := c.Status()
		if req.PageInstanceID != "" && st.PageInstanceID != req.PageInstanceID {
			continue
		}
		if betterCandidate(c, st, bestAny, bestAnySt) {
			bestAny, bestAnySt = c, st
		}
		if st.PagePath != feedPagePath && betterCandidate(c, st, bestHost, bestHostSt) {
			bestHost, bestHostSt = c, st
		}
	}
	chosen := bestHost
	if chosen == nil || (!bestHostSt.Visible && bestAny != nil && bestAnySt.Visible) {
		chosen = bestAny
	}
	if chosen == nil {
		return nil, 0
	}
	return chosen, chosen.registeredSequence
}

// pickEnterVideoClient 优先使用已绑定的主页或搜索页执行 enter_video。
func (h *Hub) pickEnterVideoClient(req DOMActionBody) (*Client, uint64) {
	h.mu.Lock()
	defer h.mu.Unlock()

	if req.PageInstanceID != "" {
		for c := range h.clients {
			st := c.Status()
			if st.PageInstanceID == req.PageInstanceID && h.clientUsable(c, domActionKey) &&
				matchesClientIdentity(st, "", req.PageInstanceID, req.URL, req.WorkID, true) {
				return c, c.registeredSequence
			}
		}
		return nil, 0
	}
	for _, listPath := range []string{profilePagePath, searchPagePath} {
		if b, ok := h.pageBindings[listPath]; ok {
			if h.clients[b.client] && h.clientUsable(b.client, domActionKey) {
				st := b.client.Status()
				if matchesClientIdentity(st, listPath, b.instance, b.href, b.workID, true) &&
					matchesClientIdentity(st, listPath, "", req.URL, req.WorkID, true) {
					return b.client, b.client.registeredSequence
				}
			}
			// 已有列表页绑定但已失效时，禁止回退到其他任意页面。
			return nil, 0
		}
	}
	return nil, 0
}

// pickPageClient 按“实例 ID + 身份 -> 已绑定页面 + 身份 -> 同类型最新可用页面”选择目标；绑定失效时禁止回退其他页面。
func (h *Hub) pickPageClient(req DOMActionBody, path string) (*Client, uint64, bool) {
	h.mu.Lock()
	defer h.mu.Unlock()

	checkURL := req.Action != "open_profile"
	if req.PageInstanceID != "" {
		for c := range h.clients {
			st := c.Status()
			if !h.clientUsable(c, domActionKey) || !matchesClientIdentity(st, path, req.PageInstanceID, req.URL, req.WorkID, checkURL) {
				continue
			}
			if b, ok := h.pageBindings[st.PagePath]; ok && b.instance == st.PageInstanceID {
				if !matchesClientIdentity(st, path, b.instance, b.href, b.workID, checkURL) {
					return nil, 0, true
				}
			}
			if h.pageBindings == nil {
				h.pageBindings = make(map[string]pageBinding)
			}
			href := st.Href
			if href == "" {
				href = req.URL
			}
			workID := st.WorkID
			if workID == "" {
				workID = req.WorkID
			}
			h.pageBindings[st.PagePath] = pageBinding{client: c, instance: st.PageInstanceID, href: href, workID: workID}
			return c, c.registeredSequence, false
		}
		// 指定了 page_instance_id 时，若当前存在其他同类型页面但实例或身份不匹配，标记为绑定冲突。
		for c := range h.clients {
			st := c.Status()
			if st.PageInstanceID == req.PageInstanceID && !matchesClientIdentity(st, path, req.PageInstanceID, req.URL, req.WorkID, checkURL) {
				return nil, 0, true
			}
		}
		return nil, 0, false
	}

	if b, ok := h.pageBindings[path]; ok {
		if h.clients[b.client] && h.clientUsable(b.client, domActionKey) {
			st := b.client.Status()
			if matchesClientIdentity(st, path, b.instance, b.href, b.workID, checkURL) &&
				matchesClientIdentity(st, path, "", req.URL, req.WorkID, checkURL) {
				if b.href == "" && st.Href != "" {
					b.href = st.Href
				}
				if b.workID == "" && st.WorkID != "" {
					b.workID = st.WorkID
				}
				h.pageBindings[path] = b
				return b.client, b.client.registeredSequence, false
			}
		}
		// 已建立页面绑定但目标实例已关闭或跳转到了其他作者/作品：禁止切换到其他页面。
		return nil, 0, true
	}

	var best *Client
	var bestSt ClientStatus
	for c := range h.clients {
		st := c.Status()
		if !h.clientUsable(c, domActionKey) || !matchesClientIdentity(st, path, "", req.URL, req.WorkID, checkURL) {
			continue
		}
		if betterCandidate(c, st, best, bestSt) {
			best, bestSt = c, st
		}
	}
	if best == nil {
		return nil, 0, false
	}
	if h.pageBindings == nil {
		h.pageBindings = make(map[string]pageBinding)
	}
	href := bestSt.Href
	if href == "" {
		href = req.URL
	}
	workID := bestSt.WorkID
	if workID == "" {
		workID = req.WorkID
	}
	h.pageBindings[path] = pageBinding{client: best, instance: bestSt.PageInstanceID, href: href, workID: workID}
	return best, best.registeredSequence, false
}

func (h *Hub) shouldWaitForTargetPage() bool {
	h.mu.RLock()
	hasClients := len(h.clients) > 0
	h.mu.RUnlock()
	if hasClients {
		return true
	}
	h.navigatingClientMu.RLock()
	navigating := h.navigatingClient != nil
	h.navigatingClientMu.RUnlock()
	return navigating
}

func (h *Hub) hasListPageBinding() bool {
	h.mu.RLock()
	defer h.mu.RUnlock()
	if h.pageBindings == nil {
		return false
	}
	_, hasProfile := h.pageBindings[profilePagePath]
	_, hasSearch := h.pageBindings[searchPagePath]
	return hasProfile || hasSearch
}

// resolveDOMActionClient 返回 handled=false 表示该请求不受页面路由约束，沿用原选择器。
// 目标页面暂未就绪时会等待它注册，绑定失效或身份不匹配时立即返回错误，绝不退化为发给其他页面。
func (h *Hub) resolveDOMActionClient(req DOMActionBody) (*Client, bool, error) {
	if req.Action == "open_profile" {
		h.ClearPageBindings()
		if req.PageInstanceID == "" && req.URL == "" && !req.PreferLatest {
			return nil, false, nil
		}
		c, seq := h.pickOpenProfileClient(req)
		if c == nil {
			h.logPageCandidates(req, "")
			return nil, true, fmt.Errorf("no ready client for key: %s", domActionKey)
		}
		st := c.Status()
		utils.LogInfo("[PageRoute] action=open_profile target_url=%s expected_instance=%s -> client=%s page=%s instance=%s visible=%t seq=%d",
			req.URL, req.PageInstanceID, c.RemoteAddr, st.PagePath, st.PageInstanceID, st.Visible, seq)
		return c, true, nil
	}

	if req.Action == "enter_video" {
		h.clearFeedBinding()
		if req.PageInstanceID == "" && !h.hasListPageBinding() && !req.PreferLatest {
			return nil, false, nil
		}
		c, seq := h.pickEnterVideoClient(req)
		if c == nil {
			h.logPageCandidates(req, profilePagePath)
			return nil, true, fmt.Errorf("bound list page unavailable for enter_video (instance=%s)", req.PageInstanceID)
		}
		st := c.Status()
		utils.LogInfo("[PageRoute] action=enter_video expected_instance=%s -> client=%s page=%s instance=%s seq=%d",
			req.PageInstanceID, c.RemoteAddr, st.PagePath, st.PageInstanceID, seq)
		return c, true, nil
	}

	if req.Action == "click_search_video_card" {
		h.clearFeedBinding()
	}

	path := requiredPagePath(req.Action)
	routed := path != "" || (req.Action == "get_url" && req.PageInstanceID != "")
	if !routed {
		return nil, false, nil
	}
	deadline := time.Now().Add(pageResolveWait)
	for {
		c, seq, conflict := h.pickPageClient(req, path)
		if c != nil {
			st := c.Status()
			utils.LogInfo("[PageRoute] action=%s expected_path=%s expected_instance=%s -> client=%s page=%s instance=%s href=%s work_id=%s seq=%d",
				req.Action, path, req.PageInstanceID, c.RemoteAddr, st.PagePath, st.PageInstanceID, st.Href, st.WorkID, seq)
			return c, true, nil
		}
		if conflict || !h.shouldWaitForTargetPage() || time.Now().After(deadline) {
			break
		}
		time.Sleep(pageResolvePeriod)
	}
	h.logPageCandidates(req, path)
	return nil, true, fmt.Errorf("no ready client for page %s (action=%s instance=%s url=%s work_id=%s)", path, req.Action, req.PageInstanceID, req.URL, req.WorkID)
}

func (h *Hub) logPageCandidates(req DOMActionBody, path string) {
	h.mu.RLock()
	defer h.mu.RUnlock()
	utils.LogWarn("[PageRoute] 未找到目标页面 action=%s expected_path=%s expected_instance=%s expected_url=%s expected_work=%s 当前客户端数=%d",
		req.Action, path, req.PageInstanceID, req.URL, req.WorkID, len(h.clients))
	for c := range h.clients {
		st := c.Status()
		utils.LogWarn("[PageRoute]   候选 client=%s page=%s instance=%s href=%s work_id=%s visible=%t hidden_ms=%d api_ready=%t seq=%d",
			c.RemoteAddr, st.PagePath, st.PageInstanceID, st.Href, st.WorkID, st.Visible, st.HiddenForMs, st.APIReady, c.registeredSequence)
	}
}
