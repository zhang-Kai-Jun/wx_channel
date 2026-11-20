package app

import (
	"crypto/tls"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/qtgolang/SunnyNet/SunnyNet"
	"github.com/qtgolang/SunnyNet/public"
	"wx_channel/internal/config"
	"wx_channel/internal/handlers"
	"wx_channel/internal/router"
	"wx_channel/internal/websocket"
)

// 使用真实代理监听验证路由，不安装证书、不加载驱动、不修改系统代理。
func TestProxyNetworkIsolation(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := listener.Addr().(*net.TCPAddr).Port
	_ = listener.Close()

	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Test-Upstream", "true")
		w.WriteHeader(http.StatusAccepted)
		_, _ = io.WriteString(w, "upstream:"+r.URL.Path)
	}))
	defer upstream.Close()
	upstreamURL, _ := url.Parse(upstream.URL)

	sunny := SunnyNet.NewSunny()
	cfg := &config.Config{Port: port}
	hub := websocket.NewHub(nil)
	app := &App{requestInterceptors: []router.Interceptor{
		handlers.NewStaticFileHandler(), router.NewAPIRouter(cfg, hub, sunny), handlers.NewAPIHandler(cfg, hub),
	}}
	sunny.SetGoCallback(func(conn *SunnyNet.HttpConn) {
		app.HandleRequest(conn)
		if conn.Type == public.HttpSendRequest && conn.Response == nil && conn.Request.URL.Hostname() == "www.tapd.cn" {
			// 路由判断完成后才替换目的地，使测试不依赖外网。
			conn.Request.URL.Scheme = upstreamURL.Scheme
			conn.Request.URL.Host = upstreamURL.Host
			conn.Request.Host = upstreamURL.Host
		}
	}, nil, nil, nil)
	if err := sunny.SetPort(port).Start().Error; err != nil {
		t.Fatal(err)
	}
	defer sunny.Close()

	proxyURL, _ := url.Parse("http://" + net.JoinHostPort("127.0.0.1", strconv.Itoa(port)))
	transport := &http.Transport{
		Proxy: http.ProxyURL(proxyURL),
		// 仅测试 CONNECT/TLS 和路由行为，不验证测试代理的证书信任链。
		TLSClientConfig: &tls.Config{InsecureSkipVerify: true},
	}
	defer transport.CloseIdleConnections()
	client := &http.Client{Transport: transport, Timeout: 10 * time.Second}
	for _, scheme := range []string{"http", "https"} {
		for _, path := range []string{"/api/health", "/__wx_channels_api/health"} {
			t.Run(scheme+path, func(t *testing.T) {
				response, err := client.Get(scheme + "://" + proxyURL.Host + path)
				if err != nil {
					t.Fatal(err)
				}
				defer response.Body.Close()
				body, err := io.ReadAll(response.Body)
				if err != nil || response.StatusCode != http.StatusOK || !strings.Contains(string(body), "\"success\":true") {
					t.Fatalf("local health: status=%d body=%s error=%v", response.StatusCode, body, err)
				}
			})
		}
		t.Run(scheme+" external API", func(t *testing.T) {
			response, err := client.Get(scheme + "://www.tapd.cn/api/basic/custom_npc/get_list")
			if err != nil {
				t.Fatal(err)
			}
			defer response.Body.Close()
			body, err := io.ReadAll(response.Body)
			if err != nil || response.StatusCode != http.StatusAccepted || response.Header.Get("X-Test-Upstream") != "true" || string(body) != "upstream:/api/basic/custom_npc/get_list" {
				t.Fatalf("external API intercepted: status=%d body=%s error=%v", response.StatusCode, body, err)
			}
		})
	}
}
