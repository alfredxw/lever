package terminal

import (
	"os/exec"
	"sync"
	"syscall"
	"unsafe"

	"github.com/charmbracelet/x/xpty"
	"golang.org/x/sys/windows"

	"lever/internal/device"
)

func shellCommand() *exec.Cmd {
	for _, name := range []string{"pwsh.exe", "powershell.exe"} {
		if path, err := device.Executable(name); err == nil {
			return exec.Command(path, "-NoLogo")
		}
	}
	return exec.Command("cmd.exe")
}

func setupCommand(script string) *exec.Cmd {
	for _, name := range []string{"pwsh.exe", "powershell.exe"} {
		if path, err := device.Executable(name); err == nil {
			return exec.Command(path, "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script)
		}
	}
	return exec.Command("cmd.exe", "/d", "/s", "/c", script)
}

func prepareCommand(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
}

func ownPTY(_ xpty.Pty, cmd *exec.Cmd, _ <-chan struct{}) (func(), error) {
	job, err := windows.CreateJobObject(nil, nil)
	if err != nil {
		return nil, err
	}
	info := windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION{}
	info.BasicLimitInformation.LimitFlags = windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
	_, err = windows.SetInformationJobObject(job, windows.JobObjectExtendedLimitInformation, uintptr(unsafe.Pointer(&info)), uint32(unsafe.Sizeof(info)))
	if err == nil {
		var process windows.Handle
		process, err = windows.OpenProcess(windows.PROCESS_SET_QUOTA|windows.PROCESS_TERMINATE, false, uint32(cmd.Process.Pid))
		if err == nil {
			err = windows.AssignProcessToJobObject(job, process)
			_ = windows.CloseHandle(process)
		}
	}
	if err != nil {
		_ = windows.CloseHandle(job)
		return nil, err
	}
	var once sync.Once
	return func() { once.Do(func() { _ = windows.CloseHandle(job) }) }, nil
}

func finishPTY(s *Session) {
	s.stop()
	_ = s.Pty.Close()
}

func closePTY(p xpty.Pty) {
	// On cancellation the output relay may already be stopped. Break the
	// pipes before ClosePseudoConsole, which otherwise waits for a reader.
	pty := p.(*xpty.ConPty)
	_ = pty.InPipe().Close()
	_ = pty.OutPipe().Close()
	_ = p.Close()
}
