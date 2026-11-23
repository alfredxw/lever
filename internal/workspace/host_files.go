package workspace

import (
	"fmt"
	"os"
	"path/filepath"

	"lever/internal/model"
)

func openHostFile(canonical string) (*os.File, error) {
	if !filepath.IsAbs(canonical) {
		return nil, fmt.Errorf("%w: expected an absolute file path", ErrInvalidFile)
	}
	name := filepath.Base(canonical)
	if !filepath.IsLocal(name) || name == "." {
		return nil, fmt.Errorf("%w: invalid file name", ErrInvalidFile)
	}
	root, err := os.OpenRoot(filepath.Dir(canonical))
	if err != nil {
		return nil, err
	}
	defer root.Close()
	return root.OpenFile(name, hostOpenFlags, 0)
}

// ReadHost reads a canonical host file for read-only preview. Callers must first
// validate and canonicalize the path against blocked host/internal locations.
func ReadHost(canonical string) (model.FileContent, error) {
	f, err := openHostFile(canonical)
	if err != nil {
		return model.FileContent{}, err
	}
	defer f.Close()
	return readFile(f, filepath.ToSlash(canonical))
}

// OpenHostAsset opens a canonical host file for read-only raw/download/HTML preview.
func OpenHostAsset(canonical string) (*os.File, string, error) {
	f, err := openHostFile(canonical)
	if err != nil {
		return nil, "", err
	}
	return assetFromFile(f, canonical)
}

// ReadHostImage reads and validates an image file at a canonical host path.
func ReadHostImage(canonical string) ([]byte, string, error) {
	f, err := openHostFile(canonical)
	if err != nil {
		return nil, "", err
	}
	defer f.Close()
	return readImage(f, canonical)
}
