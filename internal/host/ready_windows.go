//go:build windows

package host

import (
	"io"
	"os"
	"sync"

	"golang.org/x/sys/windows"
)

func detachReadyWriter(ready io.Writer) (io.Writer, func()) {
	file, ok := ready.(*os.File)
	if !ok || file != os.Stdout {
		return ready, func() {}
	}
	proc := windows.CurrentProcess()
	var dup windows.Handle
	if err := windows.DuplicateHandle(proc, windows.Handle(os.Stdout.Fd()), proc, &dup, 0, false, windows.DUPLICATE_SAME_ACCESS); err != nil {
		return ready, func() {}
	}
	_ = windows.SetStdHandle(windows.STD_OUTPUT_HANDLE, windows.Handle(os.Stderr.Fd()))
	os.Stdout = os.Stderr
	_ = file.Close()
	detached := os.NewFile(uintptr(dup), "desktop-ready")
	var once sync.Once
	return detached, func() { once.Do(func() { _ = detached.Close() }) }
}
