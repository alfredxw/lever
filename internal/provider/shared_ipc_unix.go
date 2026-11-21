//go:build !windows

package provider

import (
	"context"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"syscall"
)

func dialSharedCodex(ctx context.Context, dir string) (net.Conn, error) {
	return dialSharedSocket(ctx, filepath.Join(dir, "ipc", "ipc.sock"))
}

func dialSharedSocket(ctx context.Context, path string) (net.Conn, error) {
	var dialer net.Dialer
	return dialer.DialContext(ctx, "unix", path)
}

func sharedClaudeSocket(path string, pid string) (string, bool) {
	if !filepath.IsAbs(path) || filepath.Base(path) != pid+".sock" {
		return "", false
	}
	info, err := os.Stat(path)
	return filepath.Clean(path), err == nil && info.Mode()&os.ModeSocket != 0
}

const sharedClaudeAuthRequired = false

func sharedClaudeProcessAlive(pid int) bool {
	return syscall.Kill(pid, 0) == nil
}

func openSharedNative(ctx context.Context, link string, background bool) error {
	if runtime.GOOS != "darwin" {
		return ErrSharedUnavailable
	}
	if background {
		return exec.CommandContext(ctx, "/usr/bin/open", "-g", link).Run()
	}
	return exec.CommandContext(ctx, "/usr/bin/open", link).Run()
}
