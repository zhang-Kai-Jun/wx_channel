package processproxy

import (
	"fmt"
	"unsafe"

	"golang.org/x/sys/windows"
)

var (
	wininet             = windows.NewLazySystemDLL("wininet.dll")
	internetQueryOption = wininet.NewProc("InternetQueryOptionW")
	internetSetOption   = wininet.NewProc("InternetSetOptionW")
	globalFree          = windows.NewLazySystemDLL("kernel32.dll").NewProc("GlobalFree")
)

// value 对应原生 union（DWORD、字符串指针或 FILETIME），32/64 位均占 8 字节。
type perConnectionOption struct {
	option uint32
	value  uint64
}

type perConnectionOptions struct {
	size               uint32
	connection         *uint16
	count, optionError uint32
	options            *perConnectionOption
}

func querySystemProxy() (string, uint32, error) {
	options := []perConnectionOption{{option: 1}, {option: 2}}
	list := perConnectionOptions{count: uint32(len(options)), options: &options[0]}
	list.size = uint32(unsafe.Sizeof(list))
	size := list.size
	result, _, err := internetQueryOption.Call(0, 75, uintptr(unsafe.Pointer(&list)), uintptr(unsafe.Pointer(&size)))
	server := *(**uint16)(unsafe.Pointer(&options[1].value))
	if server != nil {
		defer globalFree.Call(uintptr(unsafe.Pointer(server)))
	}
	if result == 0 {
		return "", 0, fmt.Errorf("读取 WinINet 代理失败: %w", err)
	}
	return windows.UTF16PtrToString(server), uint32(options[0].value), nil
}

// CleanupLegacySystemProxy 只取消本端口旧双协议固定代理，保留 PAC、自动发现及绕过列表。
// 不调用 SunnyNet.SetIeProxy(true)，因为该接口会同时关闭用户已有的 PAC。
func CleanupLegacySystemProxy(port int) (bool, error) {
	server, flags, err := querySystemProxy()
	if err != nil {
		return false, err
	}
	updated, changed := legacyProxyFlags(server, flags, port)
	if !changed {
		return false, nil
	}
	// 修改前再读一次，避免覆盖启动期间用户或其他代理软件刚切换的配置。
	currentServer, currentFlags, err := querySystemProxy()
	if err != nil {
		return false, err
	}
	if currentServer != server || currentFlags != flags {
		return false, fmt.Errorf("系统代理在检查期间已变化，请重新启动服务")
	}
	option := perConnectionOption{option: 1, value: uint64(updated)}
	list := perConnectionOptions{count: 1, options: &option}
	list.size = uint32(unsafe.Sizeof(list))
	result, _, err := internetSetOption.Call(0, 75, uintptr(unsafe.Pointer(&list)), uintptr(list.size))
	if result == 0 {
		return false, fmt.Errorf("清理本服务旧系统代理失败: %w", err)
	}
	for _, option := range []uintptr{95, 37} {
		result, _, err := internetSetOption.Call(0, option, 0, 0)
		if result == 0 {
			return true, fmt.Errorf("刷新系统代理失败: %w", err)
		}
	}
	return true, nil
}
