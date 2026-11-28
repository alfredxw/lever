// Package larkx contains Lever's personal channel adapter. Its Python runtime
// is prepared by the launcher when the user connects an account.
package larkx

import (
	"embed"
	"os"
	"path/filepath"
	"runtime"
)

const PluginID = "lever.larkx"
const LegacyID = "inhouse.larkx"
const DefaultSignature = "[Lever](https://github.com/alfredxw/lever)"

func Supported() bool {
	return (runtime.GOOS == "darwin" || runtime.GOOS == "linux") &&
		(runtime.GOARCH == "amd64" || runtime.GOARCH == "arm64")
}

//go:embed bridge bridge.py pyproject.toml uv.lock
var files embed.FS

// Unpack writes the bundled adapter into a new host-owned package directory.
func Unpack(dir string) error {
	if err := os.CopyFS(dir, files); err != nil {
		return err
	}
	return os.Chmod(filepath.Join(dir, "bridge"), 0700)
}
