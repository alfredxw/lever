//go:build dev

package hubassets

import (
	"io/fs"
	"os"
)

func Assets() fs.FS { return os.DirFS("web/hubassets/dist") }
