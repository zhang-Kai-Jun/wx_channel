package router

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/qtgolang/SunnyNet/SunnyNet"
)

func TestExternalAPIRequestsPassThrough(t *testing.T) {
	router := &APIRouter{mux: http.NewServeMux()}
	for _, host := range []string{"www.tapd.cn", "channels.weixin.qq.com", "localhost.attacker.test"} {
		conn := &SunnyNet.HttpConn{Request: httptest.NewRequest(http.MethodGet, "https://"+host+"/api/basic/custom_npc/get_list", nil)}
		if router.Handle(conn) {
			t.Errorf("external /api/ intercepted: %s", host)
		}
	}
}
