package remoteproto

import (
	"mime"
	"net/http"
	"path/filepath"
)

// Documents are only accepted on file and preview routes. The controller owns
// the sandbox policy even when the request crosses multiple transports.
func copyPeerHeaders(dst, src http.Header, asset bool) {
	kind, _, _ := mime.ParseMediaType(src.Get("Content-Type"))
	disposition, params, _ := mime.ParseMediaType(src.Get("Content-Disposition"))
	switch kind {
	case "application/json", "text/event-stream", "text/plain":
		dst.Set("Content-Type", kind+"; charset=utf-8")
	case "image/png", "image/jpeg", "image/gif", "image/webp", "image/avif", "image/bmp", "image/x-icon", "image/tiff",
		"audio/mpeg", "audio/wav", "audio/ogg", "audio/flac", "audio/aac", "audio/mp4", "audio/webm",
		"video/mp4", "video/quicktime", "video/webm", "video/ogg":
		dst.Set("Content-Type", kind)
	case "text/html", "image/svg+xml", "application/pdf":
		if asset {
			dst.Set("Content-Type", kind)
		}
	}
	if dst.Get("Content-Type") == "" || disposition == "attachment" {
		dst.Set("Content-Type", "application/octet-stream")
		name := params["filename"]
		if filepath.IsLocal(name) && filepath.Base(name) == name {
			dst.Set("Content-Disposition", mime.FormatMediaType("attachment", map[string]string{"filename": name}))
		} else {
			dst.Set("Content-Disposition", "attachment")
		}
	}
	for _, key := range []string{"Content-Range", "Accept-Ranges"} {
		if value := src.Get(key); value != "" {
			dst.Set(key, value)
		}
	}
	dst.Set("Content-Security-Policy", "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:; form-action 'none'; base-uri 'none'; frame-ancestors 'self'")
	dst.Set("Referrer-Policy", "no-referrer")
	dst.Set("X-Content-Type-Options", "nosniff")
	dst.Set("Cache-Control", "no-store")
}
