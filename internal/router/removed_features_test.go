package router

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestRemovedFeatureRoutes(t *testing.T) {
	router := newTestRouter()
	for _, path := range []string{
		"/api/downloads", "/api/v1/downloads", "/api/queue", "/api/v1/queue",
		"/api/export/downloads", "/api/files/play", "/api/files/open-folder", "/api/video/stream", "/api/stats/chart",
		"/api/v1/version/check", "/api/auth/login", "/api/device/list", "/api/admin/users",
	} {
		t.Run(path, func(t *testing.T) {
			for _, method := range []string{http.MethodGet, http.MethodPost} {
				w := httptest.NewRecorder()
				router.ServeHTTP(w, httptest.NewRequest(method, path, nil))
				if w.Code != http.StatusNotFound {
					t.Fatalf("%s status=%d", method, w.Code)
				}
			}
		})
	}
}
