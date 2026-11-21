package provider

import (
	"context"
	"net"
	"regexp"
	"runtime"
	"strings"

	"github.com/Microsoft/go-winio"
	"golang.org/x/sys/windows"
)

func dialSharedCodex(ctx context.Context, _ string) (net.Conn, error) {
	return dialSharedSocket(ctx, `\\.\pipe\codex-ipc`)
}

func dialSharedSocket(ctx context.Context, path string) (net.Conn, error) {
	return winio.DialPipeContext(ctx, path)
}

var sharedClaudePipe = regexp.MustCompile(`(?i)^\\\\\.\\pipe\\(?:LOCAL\\)?cc-msg-[0-9a-f]{32}$`)

func sharedClaudeSocket(path string, _ string) (string, bool) {
	return strings.ToLower(path), sharedClaudePipe.MatchString(path)
}

const sharedClaudeAuthRequired = true

func sharedClaudeProcessAlive(pid int) bool {
	handle, err := windows.OpenProcess(windows.SYNCHRONIZE, false, uint32(pid))
	if err != nil {
		return false
	}
	defer windows.CloseHandle(handle)
	status, err := windows.WaitForSingleObject(handle, 0)
	return err == nil && status == uint32(windows.WAIT_TIMEOUT)
}

func openSharedNative(ctx context.Context, link string, background bool) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if background {
		return ErrSharedUnavailable
	}
	open, err := windows.UTF16PtrFromString("open")
	if err != nil {
		return err
	}
	uri, err := windows.UTF16PtrFromString(link)
	if err != nil {
		return err
	}
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	if err := windows.CoInitializeEx(0, windows.COINIT_APARTMENTTHREADED|windows.COINIT_DISABLE_OLE1DDE); err == nil {
		defer windows.CoUninitialize()
	}
	return windows.ShellExecute(0, open, uri, nil, nil, windows.SW_SHOWNORMAL)
}
