package device

import (
	"crypto/sha256"
	"encoding/hex"
	"path/filepath"
)

func loginID(dir string) string {
	path, _ := filepath.Abs(dir)
	sum := sha256.Sum256([]byte(path))
	return "app.lever.host." + hex.EncodeToString(sum[:8])
}
