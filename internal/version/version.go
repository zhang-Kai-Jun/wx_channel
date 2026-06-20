package version

import "fmt"

// Current is the current application version
// This value can be overridden at build time using:
//   go build -ldflags "-X wx_channel/internal/version.Current=1.2.0"
var Current = "1.2.0"

// Repo is the GitHub repository path
const Repo = "video_channel"

// BuildInfo contains build-time information
var BuildInfo struct {
	Date   string
	Commit string
}

// GetVersionString returns formatted version string
func GetVersionString() string {
	if BuildInfo.Date != "" {
		return fmt.Sprintf("%s (%s)", Current, BuildInfo.Date)
	}
	return Current
}
