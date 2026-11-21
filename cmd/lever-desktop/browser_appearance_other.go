//go:build !darwin

package main

import (
	"errors"

	"github.com/egoist/mygo"
)

const browserAppearanceAvailable = false

func nativeBrowserPages(*mygo.Window) []uintptr { return nil }

func setBrowserAppearance(uintptr, string) error {
	return errors.New("per-page appearance is unavailable on this platform")
}
