package main

import (
	"runtime/debug"
	"wx_channel/cmd"
)

func main() {
	debug.SetGCPercent(200)

	cmd.Execute()
}
