//go:build !windows

package diagnostics

func StartSessionMonitor(report func(SessionSample)) func() {
	return func() {}
}
