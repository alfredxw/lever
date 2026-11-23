package workspace

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// Assets are streamed, including range requests, rather than copied into the
// text editor's JSON response. Keep the same root/symlink boundary as Read.
func OpenAsset(root, path string) (*os.File, string, error) {
	f, err := open(root, path)
	if err != nil {
		return nil, "", err
	}
	return assetFromFile(f, path)
}

func assetFromFile(f *os.File, path string) (*os.File, string, error) {
	info, err := f.Stat()
	if err != nil || !info.Mode().IsRegular() {
		f.Close()
		if err == nil {
			err = fmt.Errorf("%w: only regular files can be previewed", ErrInvalidFile)
		}
		return nil, "", err
	}
	mediaType := assetTypes[strings.ToLower(filepath.Ext(path))]
	if mediaType == "" {
		mediaType = "application/octet-stream"
	}
	return f, mediaType, nil
}

// Explicit MIME types avoid OS-dependent MIME databases and content sniffing.
// Active content is always sandboxed by the HTTP handler.
var assetTypes = map[string]string{
	".avif": "image/avif", ".bmp": "image/bmp", ".gif": "image/gif",
	".ico": "image/x-icon", ".heic": "image/heic", ".heif": "image/heif",
	".jpeg": "image/jpeg", ".jpg": "image/jpeg", ".png": "image/png",
	".svg": "image/svg+xml", ".tif": "image/tiff", ".tiff": "image/tiff", ".webp": "image/webp",
	".mp3": "audio/mpeg", ".wav": "audio/wav", ".ogg": "audio/ogg", ".oga": "audio/ogg",
	".flac": "audio/flac", ".aac": "audio/aac", ".m4a": "audio/mp4", ".opus": "audio/ogg",
	".aiff": "audio/aiff", ".weba": "audio/webm", ".webm-audio": "audio/webm",
	".mp4": "video/mp4", ".m4v": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm",
	".ogv": "video/ogg", ".avi": "video/x-msvideo", ".mkv": "video/x-matroska",
	".pdf": "application/pdf", ".html": "text/html", ".htm": "text/html",
	".ttf": "font/ttf", ".otf": "font/otf", ".woff": "font/woff", ".woff2": "font/woff2",
}
