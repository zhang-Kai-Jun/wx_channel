package handlers

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
)

func TestValidateVideoPlayTargetURL(t *testing.T) {
	tests := []struct {
		name      string
		rawURL    string
		wantError bool
	}{
		{
			name:      "valid https url",
			rawURL:    "https://93.184.216.34/video.mp4",
			wantError: false,
		},
		{
			name:      "invalid scheme",
			rawURL:    "file:///tmp/video.mp4",
			wantError: true,
		},
		{
			name:      "localhost blocked",
			rawURL:    "http://localhost/video.mp4",
			wantError: true,
		},
		{
			name:      "private ipv4 blocked",
			rawURL:    "http://192.168.1.20/video.mp4",
			wantError: true,
		},
		{
			name:      "loopback ipv6 blocked",
			rawURL:    "http://[::1]/video.mp4",
			wantError: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, err := validateVideoPlayTargetURL(tt.rawURL)
			gotError := err != nil
			if gotError != tt.wantError {
				t.Fatalf("validateVideoPlayTargetURL(%q) error = %v, wantError=%v", tt.rawURL, err, tt.wantError)
			}
		})
	}
}

func TestHandleVideoPlay_BlockedLocalAddress(t *testing.T) {
	handler := &ConsoleAPIHandler{}
	req := httptest.NewRequest(http.MethodGet, "/api/video/play?url=http://127.0.0.1/video.mp4", nil)
	rr := httptest.NewRecorder()

	handler.HandleVideoPlay(rr, req)

	if rr.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want %d", rr.Code, http.StatusBadRequest)
	}

	var resp APIResponse
	if err := json.Unmarshal(rr.Body.Bytes(), &resp); err != nil {
		t.Fatalf("failed to decode response: %v", err)
	}
	if resp.Success {
		t.Fatalf("success = true, want false")
	}
	if !strings.Contains(resp.Error, "local/private") {
		t.Fatalf("error = %q, want contains %q", resp.Error, "local/private")
	}
}

func TestParseJSON_BodyTooLarge(t *testing.T) {
	handler := &ConsoleAPIHandler{}
	var payload struct {
		Data string `json:"data"`
	}

	tooLarge := `{"data":"` + strings.Repeat("a", maxJSONBodyBytes) + `"}`
	req := httptest.NewRequest(http.MethodPost, "/api/test", strings.NewReader(tooLarge))

	err := handler.parseJSON(req, &payload)
	if err == nil {
		t.Fatalf("expected error for oversized body, got nil")
	}
	if !strings.Contains(err.Error(), "request body too large") {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestVideoProxyHTTPClient_CheckRedirect(t *testing.T) {
	client := newVideoProxyHTTPClient()
	if client.CheckRedirect == nil {
		t.Fatalf("CheckRedirect should not be nil")
	}

	blockedURL, _ := url.Parse("http://127.0.0.1/video.mp4")
	blockedReq := &http.Request{URL: blockedURL}
	if err := client.CheckRedirect(blockedReq, nil); err == nil {
		t.Fatalf("expected redirect validation error for localhost target")
	}

	// 使用公开 IP，避免本机 DNS 或代理影响这个纯校验测试。
	allowedURL, _ := url.Parse("https://93.184.216.34/video.mp4")
	allowedReq := &http.Request{URL: allowedURL}
	if err := client.CheckRedirect(allowedReq, nil); err != nil {
		t.Fatalf("unexpected redirect validation error: %v", err)
	}
}
