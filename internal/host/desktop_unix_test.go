//go:build unix

package host

import "golang.org/x/sys/unix"

func writeRawStdout(s string) {
	_, _ = unix.Write(1, []byte(s))
}
