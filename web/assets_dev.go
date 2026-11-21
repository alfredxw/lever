//go:build dev

package web

import (
	"io/fs"
	"os"
)

// Development serves Vite through the backend; no bundle is needed to compile.
// A local bundle remains available when running without --dev-origin.
func Assets() fs.FS { return os.DirFS("web/dist") }
