//go:build !unix

package host

import "os"

func writeRawStdout(s string) {
	_, _ = os.Stdout.WriteString(s)
}
