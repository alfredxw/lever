package device

import (
	"fmt"
	"golang.org/x/sys/windows"
	"os"
	"os/exec"
	"path/filepath"
)

func LoginEnabled(dir string) bool {
	return exec.Command("schtasks", "/Query", "/TN", loginID(dir)).Run() == nil
}
func SetLogin(dir string, enabled bool) error {
	var args []string
	if enabled {
		exe, err := os.Executable()
		if err != nil {
			return err
		}
		dir, err = filepath.Abs(dir)
		if err != nil {
			return err
		}
		cmd := windows.ComposeCommandLine([]string{exe, "--serve-desktop", "--data-dir", dir})
		args = []string{"/Create", "/TN", loginID(dir), "/SC", "ONLOGON", "/IT", "/RL", "LIMITED", "/TR", cmd, "/F"}
	} else {
		if !LoginEnabled(dir) {
			return nil
		}
		args = []string{"/Delete", "/TN", loginID(dir), "/F"}
	}
	if out, err := exec.Command("schtasks", args...).CombinedOutput(); err != nil {
		return fmt.Errorf("login task: %w: %s", err, out)
	}
	return nil
}
