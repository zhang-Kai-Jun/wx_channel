package processproxy

import (
	"errors"
	"unsafe"

	"golang.org/x/sys/windows"
)

func scanProcesses() ([]processInfo, error) {
	snapshot, err := windows.CreateToolhelp32Snapshot(windows.TH32CS_SNAPPROCESS, 0)
	if err != nil {
		return nil, err
	}
	defer windows.CloseHandle(snapshot)
	entry := windows.ProcessEntry32{Size: uint32(unsafe.Sizeof(windows.ProcessEntry32{}))}
	err = windows.Process32First(snapshot, &entry)
	var processes []processInfo
	for err == nil {
		process := processInfo{pid: entry.ProcessID, parent: entry.ParentProcessID, name: windows.UTF16ToString(entry.ExeFile[:])}
		if isCandidate(process.name) {
			readProcessImage(&process)
		}
		processes = append(processes, process)
		err = windows.Process32Next(snapshot, &entry)
	}
	if !errors.Is(err, windows.ERROR_NO_MORE_FILES) {
		releaseProcesses(processes)
		return nil, err
	}
	return processes, nil
}

func readProcessImage(process *processInfo) {
	handle, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, process.pid)
	if err != nil {
		return
	}
	defer func() {
		if process.release == nil {
			windows.CloseHandle(handle)
		}
	}()
	var created, exited, kernel, user windows.Filetime
	if windows.GetProcessTimes(handle, &created, &exited, &kernel, &user) != nil {
		return
	}
	buffer := make([]uint16, 32768)
	size := uint32(len(buffer))
	if windows.QueryFullProcessImageName(handle, 0, &buffer[0], &size) != nil {
		return
	}
	process.image = windows.UTF16ToString(buffer[:size])
	process.created = uint64(created.HighDateTime)<<32 | uint64(created.LowDateTime)
	// 持有句柄直至取消接管，防止进程退出后 PID 被其他软件复用。
	process.release = func() { windows.CloseHandle(handle) }
}
