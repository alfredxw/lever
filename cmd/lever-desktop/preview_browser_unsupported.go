//go:build !windows && !darwin && !linux

package main

import "errors"

func openInSystemBrowser(string) error {
	return errors.ErrUnsupported
}
