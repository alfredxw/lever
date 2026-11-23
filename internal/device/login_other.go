//go:build !darwin && !windows

package device

import "errors"

func LoginEnabled(string) bool { return false }
func SetLogin(string, bool) error {
	return errors.New("manage this headless Host with the operating system service manager")
}
