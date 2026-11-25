//go:build !windows

package device

import (
	"os"
	"os/exec"
	"strings"
	"syscall"
)

func joinSearchPath(paths []string) string {
	return strings.Join(paths, string(os.PathListSeparator))
}

func configure(cmd *exec.Cmd) { cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true} }
func ownProcess(cmd *exec.Cmd) (func() error, func(), error) {
	return func() error { return syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL) }, func() {}, nil
}
