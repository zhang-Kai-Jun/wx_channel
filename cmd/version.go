package cmd

import (
	"runtime"
	"wx_channel/internal/version"

	"github.com/fatih/color"
	"github.com/spf13/cobra"
)

var versionCmd = &cobra.Command{
	Use:   "version",
	Short: "打印版本信息",
	Run: func(cmd *cobra.Command, args []string) {
		color.White("wx_channel v%s", version.Current)
		color.White("Go Version: %s", runtime.Version())
		color.White("OS/Arch: %s/%s", runtime.GOOS, runtime.GOARCH)
		color.White("Build Date: %s", version.GetVersionString())
	},
}

func init() {
	rootCmd.AddCommand(versionCmd)
}
