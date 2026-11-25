package device

import (
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
)

func savedWindowsPath() string {
	// An installer can update the system or user PATH after Lever has started.
	env, err := windows.GetCurrentProcessToken().Environ(false)
	if err != nil {
		return ""
	}
	for _, entry := range env {
		if name, value, _ := strings.Cut(entry, "="); strings.EqualFold(name, "PATH") {
			return value
		}
	}
	return ""
}

func joinSearchPath(paths []string) string {
	seen := make(map[string]struct{}, len(paths))
	for _, dir := range paths {
		seen[strings.ToLower(filepath.Clean(dir))] = struct{}{}
	}
	for _, dir := range filepath.SplitList(savedWindowsPath()) {
		dir = strings.TrimSpace(dir)
		if !filepath.IsAbs(dir) {
			continue
		}
		key := strings.ToLower(filepath.Clean(dir))
		if _, exists := seen[key]; !exists {
			paths = append(paths, dir)
			seen[key] = struct{}{}
		}
	}
	for i, dir := range paths {
		if strings.ContainsRune(dir, filepath.ListSeparator) {
			paths[i] = `"` + dir + `"`
		}
	}
	return strings.Join(paths, string(filepath.ListSeparator))
}

func configure(cmd *exec.Cmd) { cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true} }
func ownProcess(cmd *exec.Cmd) (func() error, func(), error) {
	job, err := windows.CreateJobObject(nil, nil)
	if err != nil {
		return nil, nil, err
	}
	info := windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION{}
	info.BasicLimitInformation.LimitFlags = windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
	_, err = windows.SetInformationJobObject(job, windows.JobObjectExtendedLimitInformation, uintptr(unsafe.Pointer(&info)), uint32(unsafe.Sizeof(info)))
	if err != nil {
		windows.CloseHandle(job)
		return nil, nil, err
	}
	h, err := windows.OpenProcess(windows.PROCESS_SET_QUOTA|windows.PROCESS_TERMINATE, false, uint32(cmd.Process.Pid))
	if err != nil {
		windows.CloseHandle(job)
		return nil, nil, err
	}
	defer windows.CloseHandle(h)
	if err = windows.AssignProcessToJobObject(job, h); err != nil {
		windows.CloseHandle(job)
		return nil, nil, err
	}
	return func() error { return windows.TerminateJobObject(job, 1) }, func() { windows.CloseHandle(job) }, nil
}
