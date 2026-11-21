// Package localipc connects a CLI to the local Lever instance for a data directory.
package localipc

import (
	"crypto/sha256"
	"encoding/hex"
	"path/filepath"
)

func instanceID(dataDir string) (string, error) {
	dir, err := filepath.Abs(dataDir)
	if err != nil {
		return "", err
	}
	dir, err = filepath.EvalSymlinks(dir)
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256([]byte(dir))
	return hex.EncodeToString(sum[:16]), nil
}
