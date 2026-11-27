//go:build darwin

package app

import (
	"context"
	"os/exec"
	"strings"
	"time"
)

func isHostScreenLocked() bool {
	ctx, cancel := context.WithTimeout(context.Background(), 500*time.Millisecond)
	defer cancel()
	out, err := exec.CommandContext(ctx, "ioreg", "-n", "Root", "-d1").Output()
	if err != nil {
		return false
	}
	text := string(out)
	return strings.Contains(text, `"CGSSessionScreenIsLocked"=Yes`) ||
		strings.Contains(text, `"CGSSessionScreenIsLocked" = Yes`)
}
