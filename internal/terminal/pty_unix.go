//go:build !windows

package terminal

import (
	"context"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/charmbracelet/x/xpty"
	"golang.org/x/sys/unix"
)

func shellCommand() *exec.Cmd {
	shell := os.Getenv("SHELL")
	if shell == "" {
		shell = "/bin/sh"
	}
	return exec.Command(shell, "-l")
}

func setupCommand(script string) *exec.Cmd { return exec.Command("/bin/sh", "-c", script) }

func prepareCommand(cmd *exec.Cmd) {
	// Job control requires a new session with the PTY as controlling terminal.
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true, Setctty: true}
}

func ownPTY(p xpty.Pty, cmd *exec.Cmd, done <-chan struct{}) (func(), error) {
	pty := p.(*xpty.UnixPty)
	_ = pty.Slave().Close()
	var once sync.Once
	return func() {
		once.Do(func() {
			// Job control puts background jobs in separate process groups too.
			// Query only process IDs, then verify kernel session ownership before
			// signalling a group. Shell-specific hangup handlers are not sufficient.
			ctx, cancel := context.WithTimeout(context.Background(), time.Second)
			pids, _ := exec.CommandContext(ctx, "ps", "-axo", "pid=").Output()
			cancel()
			groups := map[int]bool{}
			for _, value := range strings.Fields(string(pids)) {
				pid, _ := strconv.Atoi(value)
				if pid <= 0 || pid == cmd.Process.Pid {
					continue
				}
				if session, err := unix.Getsid(pid); err == nil && session == cmd.Process.Pid {
					if group, err := unix.Getpgid(pid); err == nil && group > 0 && group != cmd.Process.Pid {
						groups[group] = true
					}
					// A freshly forked job may still be moving into its own group.
					_ = syscall.Kill(pid, syscall.SIGKILL)
				}
			}
			// Keep foreground cleanup available even when ps is unavailable.
			_ = pty.Control(func(fd uintptr) {
				if group, err := unix.IoctlGetInt(int(fd), unix.TIOCGPGRP); err == nil && group > 0 && group != cmd.Process.Pid {
					groups[group] = true
				}
			})
			for group := range groups {
				_ = syscall.Kill(-group, syscall.SIGKILL)
			}
			select {
			case <-done:
				return
			default:
			}
			_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGHUP)
			// Give an interactive shell time to hang up its background jobs. Killing
			// it immediately after SIGHUP prevents its handler from running.
			select {
			case <-done:
			case <-time.After(500 * time.Millisecond):
				_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
			}
		})
	}, nil
}

func finishPTY(s *Session) { s.stop() }
func closePTY(p xpty.Pty)  { _ = p.Close() }
