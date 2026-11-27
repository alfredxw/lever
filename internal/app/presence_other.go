//go:build !darwin

package app

func isHostScreenLocked() bool {
	return false
}
