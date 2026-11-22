package device

import (
	"context"
	"os"
	"os/exec"
	"strconv"
	"sync"
)

// PreventIdleSleep leaves display sleep enabled. Binding caffeinate to this
// process also releases its assertion if the provider worker is killed.
func PreventIdleSleep(_ context.Context) (func(), error) {
	cmd := exec.Command("/usr/bin/caffeinate", "-i", "-w", strconv.Itoa(os.Getpid()))
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	return sync.OnceFunc(func() {
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
	}), nil
}
