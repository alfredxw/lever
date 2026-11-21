package device

import (
	"golang.org/x/sys/windows"
	"os/exec"
	"syscall"
	"unsafe"
)

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
