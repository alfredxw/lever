package workspace

import (
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

const MaxImageBytes = 32 << 20

// ReadImage uses the same root-confined access as the text editor. Images are
// binary and have their own size limit; they must never pass through Read.
func ReadImage(root, path string) ([]byte, string, error) {
	f, err := open(root, path)
	if err != nil {
		return nil, "", err
	}
	defer f.Close()
	return readImage(f, path)
}

func readImage(f *os.File, path string) ([]byte, string, error) {
	info, err := f.Stat()
	if err != nil {
		return nil, "", err
	}
	if !info.Mode().IsRegular() || info.Size() > MaxImageBytes {
		return nil, "", fmt.Errorf("%w: expected an image up to 32 MiB", ErrInvalidFile)
	}
	data, err := io.ReadAll(io.LimitReader(f, MaxImageBytes+1))
	if err != nil {
		return nil, "", err
	}
	if len(data) > MaxImageBytes {
		return nil, "", fmt.Errorf("%w: image exceeds 32 MiB", ErrInvalidFile)
	}
	mediaType := http.DetectContentType(data)
	// SVG is XML rather than a sniffable raster format. The HTTP handler must
	// sandbox it, including when the image URL is opened as a document.
	if strings.EqualFold(filepath.Ext(path), ".svg") {
		mediaType = "image/svg+xml"
	}
	switch mediaType {
	case "image/png", "image/jpeg", "image/gif", "image/webp", "image/bmp", "image/x-icon", "image/svg+xml":
		return data, mediaType, nil
	default:
		return nil, "", fmt.Errorf("%w: unsupported image format", ErrInvalidFile)
	}
}
