package processproxy

import "testing"

func TestLegacyCleanupPreservesOtherProxySettings(t *testing.T) {
	for _, scenario := range []struct {
		server  string
		flags   uint32
		want    uint32
		changed bool
	}{
		{"http=127.0.0.1:2025;https=127.0.0.1:2025", 3, 1, true},
		// 企业 PAC / 自动检测必须保留，仅删除本服务的固定代理标志。
		{"http=127.0.0.1:2025;https=127.0.0.1:2025", 15, 13, true},
		{"http=127.0.0.1:2025;https=127.0.0.1:2025", 13, 13, false},
		{"127.0.0.1:7890", 3, 3, false},
		{"http=corp:8080;https=corp:8080", 3, 3, false},
		{"http=127.0.0.1:2025;https=corp:8080", 3, 3, false},
		{"http=127.0.0.1:2025;https=127.0.0.1:2025;socks=corp:1080", 3, 3, false},
		{"http=127.0.0.1:2026;https=127.0.0.1:2026", 3, 3, false},
	} {
		got, changed := legacyProxyFlags(scenario.server, scenario.flags, 2025)
		if got != scenario.want || changed != scenario.changed {
			t.Errorf("server=%s flags=%d: got %d/%v, want %d/%v", scenario.server, scenario.flags, got, changed, scenario.want, scenario.changed)
		}
	}
}
