package processproxy

import (
	"fmt"
	"strings"
)

// 只识别旧 SunnyNet 确实写入过的双协议代理，不处理其他代理或混合配置。
func legacyProxyFlags(server string, flags uint32, port int) (uint32, bool) {
	endpoint := fmt.Sprintf("127.0.0.1:%d", port)
	entries := strings.Split(strings.ToLower(strings.TrimSpace(server)), ";")
	seen := make(map[string]bool)
	for _, entry := range entries {
		protocol, address, ok := strings.Cut(strings.TrimSpace(entry), "=")
		if !ok || (protocol != "http" && protocol != "https") || address != endpoint || seen[protocol] {
			return flags, false
		}
		seen[protocol] = true
	}
	if len(seen) != 2 || flags&2 == 0 {
		return flags, false
	}
	// 清除固定代理；PAC（4）和自动发现（8）保持原样。
	return flags&^2 | 1, true
}
