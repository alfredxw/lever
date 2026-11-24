//go:build unix

package host

import (
	"errors"
	"io"
	"os"
	"sync"

	"golang.org/x/sys/unix"
)

// detachReadyWriter moves the startup handshake off os.Stdout before the server
// starts so writes to fd 1 neither corrupt the startup JSON nor trigger SIGPIPE
// once the launcher closes its pipe reader.
func detachReadyWriter(ready io.Writer) (io.Writer, func()) {
	file, ok := ready.(*os.File)
	if !ok || file != os.Stdout {
		return ready, func() {}
	}
	dupFD, err := unix.FcntlInt(os.Stdout.Fd(), unix.F_DUPFD_CLOEXEC, 0)
	if err != nil {
		return ready, func() {}
	}
	for {
		err = unix.Dup2(int(os.Stderr.Fd()), int(os.Stdout.Fd()))
		if !errors.Is(err, unix.EINTR) {
			break
		}
	}
	if err != nil {
		_ = unix.Close(dupFD)
		return ready, func() {}
	}
	os.Stdout = os.Stderr
	detached := os.NewFile(uintptr(dupFD), "desktop-ready")
	var once sync.Once
	return detached, func() { once.Do(func() { _ = detached.Close() }) }
}
