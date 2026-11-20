package app

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"wx_channel/internal/router"

	"github.com/qtgolang/SunnyNet/SunnyNet"
	"github.com/qtgolang/SunnyNet/public"
)

type countingInterceptor struct{ calls int }

func (i *countingInterceptor) Handle(*SunnyNet.HttpConn) bool {
	i.calls++
	return false
}

func TestExternalTrafficBypassesCallbacks(t *testing.T) {
	for _, event := range []int{public.HttpSendRequest, public.HttpResponseOK} {
		i := &countingInterceptor{}
		app := &App{requestInterceptors: []router.Interceptor{i}, responseInterceptors: []router.Interceptor{i}}
		request := httptest.NewRequest(http.MethodGet, "https://www.tapd.cn/api/basic/custom_npc/get_list", nil)
		request.Header.Set("Accept-Encoding", "br, zstd")
		conn := &SunnyNet.HttpConn{Type: event, Request: request, Response: &http.Response{StatusCode: 200}}
		app.HandleRequest(conn)
		if i.calls != 0 || request.Header.Get("Accept-Encoding") != "br, zstd" {
			t.Fatalf("external traffic intercepted: event=%d calls=%d headers=%v", event, i.calls, request.Header)
		}
	}
}

func TestRequestHeadersChangeOnlyForRewriteCandidates(t *testing.T) {
	for _, scenario := range []struct {
		url     string
		rewrite bool
	}{
		{"https://channels.weixin.qq.com/web/pages/home", true},
		{"https://res.wx.qq.com/t/wx_fed/finder/web/web-finder/res/js/app.js", true},
		{"https://res.wx.qq.com/other/app.js", false},
		{"https://channels.weixin.qq.com/cgi-bin/feed", false},
		{"http://127.0.0.1:2025/__wx_channels_api/health", false},
	} {
		request := httptest.NewRequest(http.MethodGet, scenario.url, nil)
		request.Header.Set("Accept-Encoding", "br")
		request.Header.Set("If-None-Match", "upstream-etag")
		(&App{}).HandleRequest(&SunnyNet.HttpConn{Type: public.HttpSendRequest, Request: request})
		if scenario.rewrite {
			if request.Header.Get("Accept-Encoding") != "gzip, deflate" || request.Header.Get("If-None-Match") != "" {
				t.Fatal(request.Header)
			}
		} else if request.Header.Get("Accept-Encoding") != "br" || request.Header.Get("If-None-Match") != "upstream-etag" {
			t.Fatal(request.Header)
		}
	}
}
