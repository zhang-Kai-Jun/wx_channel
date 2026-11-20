package app

import "wx_channel/internal/processproxy"

// 旧配置不能重新启用全局系统代理。
func configureWindowsProxy(_ string, proxy processproxy.Driver) (func(), error) {
	return processproxy.Start(proxy)
}
