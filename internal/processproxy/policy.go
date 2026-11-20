// Package processproxy 只接管经路径和父进程归属核验的微信进程。
package processproxy

import (
	"path"
	"strings"
)

type processInfo struct {
	pid, parent uint32
	name, image string
	created     uint64
	release     func()
}

func normalizeImage(image string) string {
	if image == "" {
		return ""
	}
	return strings.ToLower(path.Clean(strings.ReplaceAll(image, `\`, "/")))
}

func isCandidate(name string) bool {
	switch strings.ToLower(name) {
	case "weixin.exe", "wechat.exe", "wechatappex.exe":
		return true
	}
	return false
}

func mainDirectory(process processInfo) string {
	image := normalizeImage(process.image)
	name := strings.ToLower(process.name)
	if (name != "weixin.exe" && name != "wechat.exe") || path.Base(image) != name || process.created == 0 {
		return ""
	}
	directory := path.Dir(image)
	base := path.Base(directory)
	if base == "weixin" || base == "wechat" {
		return directory
	}
	// 微信 3.x 把可执行文件放在安装目录下的版本子目录中。
	parent := path.Dir(directory)
	if (path.Base(parent) == "wechat" || path.Base(parent) == "weixin") && strings.Trim(base, "0123456789.") == "" {
		return parent
	}
	return ""
}

func isWithin(image, directory string) bool {
	return directory != "" && strings.HasPrefix(image, directory+"/")
}

func selectWeChat(processes []processInfo, appData string) map[uint32]processInfo {
	all := make(map[uint32]processInfo, len(processes))
	roots := make(map[uint32]string)
	selected := make(map[uint32]processInfo)
	for _, process := range processes {
		all[process.pid] = process
		if directory := mainDirectory(process); directory != "" {
			roots[process.pid] = directory
			selected[process.pid] = process
		}
	}
	appData = normalizeImage(appData)
	for _, process := range processes {
		image := normalizeImage(process.image)
		if !strings.EqualFold(process.name, "WeChatAppEx.exe") || path.Base(image) != "wechatappex.exe" || process.created == 0 {
			continue
		}
		ancestor := process
		// 上限同时防御异常快照中的父进程环。
		for depth := 0; depth < 32; depth++ {
			parent, ok := all[ancestor.parent]
			if !ok || parent.pid == ancestor.pid || parent.created == 0 || parent.created > ancestor.created {
				break
			}
			if directory, ok := roots[parent.pid]; ok {
				if isWithin(image, directory) || (appData != "" &&
					(isWithin(image, appData+"/tencent/xwechat/xplugin") || isWithin(image, appData+"/tencent/wechat"))) {
					selected[process.pid] = process
				}
				break
			}
			ancestor = parent
		}
	}
	return selected
}
