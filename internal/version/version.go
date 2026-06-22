package version

import "fmt"

// ================== 版本号唯一源 (Single Source of Truth) ==================
// 整个项目里所有的版本号都从这一行读取:

var Current = "1.1.0"

var BuildDate = ""

var BuildCommit = ""

// Repo is the GitHub repository path
const Repo = "video_channel"

// GetVersionString returns formatted version string
func GetVersionString() string {
	if BuildDate != "" {
		return fmt.Sprintf("%s (%s)", Current, BuildDate)
	}
	return Current
}

// BuildDateOrUnknown returns the build date, or "unknown" if not set.
func BuildDateOrUnknown() string {
	if BuildDate != "" {
		return BuildDate
	}
	return "unknown"
}

// BuildCommitOrUnknown returns the git commit, or "unknown" if not set.
func BuildCommitOrUnknown() string {
	if BuildCommit != "" {
		return BuildCommit
	}
	return "unknown"
}
