//go:build !windows

package workspace

import (
	"os"
	"syscall"
)

// O_NONBLOCK prevents opening a FIFO from hanging before Stat rejects non-regular files.
// O_NOFOLLOW ensures a canonical path cannot be swapped with a symlink after resolution.
const hostOpenFlags = os.O_RDONLY | syscall.O_NONBLOCK | syscall.O_NOFOLLOW

func peerSingleLink(f *os.File, info os.FileInfo) bool {
	stat, ok := info.Sys().(*syscall.Stat_t)
	return ok && stat.Nlink == 1
}
