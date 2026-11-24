//go:build !unix && !windows

package host

import "io"

func detachReadyWriter(ready io.Writer) (io.Writer, func()) {
	return ready, func() {}
}
