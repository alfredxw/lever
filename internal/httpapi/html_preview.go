package httpapi

import (
	_ "embed"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"lever/internal/workspace"
)

//go:embed visualization_head.html
var visualizationHead string

const visualizationCDNs = " https://cdnjs.cloudflare.com https://cdn.jsdelivr.net https://esm.sh https://unpkg.com"
const visualizationFonts = " https://fonts.googleapis.com https://fonts.gstatic.com https://fonts.bunny.net"
const visualizationComponents = " https://persistent.oaistatic.com/plugins/visualize/"

func htmlPreviewHeaders(w http.ResponseWriter, r *http.Request, visualization bool) {
	var scripts, styles, images, fonts string
	if visualization {
		scripts = visualizationCDNs + visualizationComponents
		styles = scripts + visualizationFonts
		images = visualizationCDNs
		fonts = images + visualizationFonts
	}
	policy := "sandbox; default-src 'none'; "
	// The desktop's main frame has a native bridge. Only embedded documents
	// can run scripts, and their sandboxed origin cannot reach the parent.
	if r.Header.Get("Sec-Fetch-Dest") == "iframe" {
		policy = "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'" + scripts + "; "
	}
	w.Header().Set("Content-Security-Policy", policy+"style-src 'unsafe-inline'"+styles+
		"; img-src data: blob:"+images+"; font-src data:"+fonts+"; media-src data: blob:"+images+
		"; base-uri 'none'; form-action 'none'; frame-ancestors 'self'")
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Referrer-Policy", "no-referrer")
	w.Header().Set("Cache-Control", "no-store")
}

func (s *Server) chatPreview(w http.ResponseWriter, r *http.Request) {
	s.serveChatPreview(w, r, r.PathValue("run"), r.URL.Query().Get("kind"))
}

func (s *Server) serveChatPreview(w http.ResponseWriter, r *http.Request, run, kind string) {
	path := r.URL.Query().Get("path")
	image := kind == "image"
	if !image {
		ext := filepath.Ext(path)
		if (kind != "html" && kind != "visualization") || (!strings.EqualFold(ext, ".html") && !strings.EqualFold(ext, ".htm")) {
			http.NotFound(w, r)
			return
		}
	}
	var root, relative string
	err := os.ErrNotExist
	if id := r.PathValue("provider"); id != "" {
		root, relative, err = s.App.SharedPreviewPath(r.Context(), id, r.PathValue("id"), path, image)
	} else if run != "" {
		root, relative, err = s.App.RunPreviewPath(r.Context(), run, path, image)
	}
	visualization := kind == "visualization"
	if visualization && err != nil {
		root, relative, err = s.App.VisualizationArtifactPath(r.Context(), path)
	}
	if image {
		if err != nil {
			http.NotFound(w, r)
			return
		}
		serveImageAsset(w, r, root, relative)
		return
	}
	htmlPreviewHeaders(w, r, visualization)
	status := http.StatusNotFound
	if err == nil {
		if visualization {
			file, err := workspace.Read(root, relative)
			if err == nil && !file.Truncated {
				_, _ = io.WriteString(w, visualizationHead)
				_, _ = io.WriteString(w, file.Content)
				return
			}
			if file.Truncated {
				status = http.StatusRequestEntityTooLarge
			}
		} else if file, _, err := workspace.OpenAsset(root, relative); err == nil {
			defer file.Close()
			http.ServeContent(w, r, "", time.Time{}, file)
			return
		}
	}
	w.WriteHeader(status)
	_, _ = io.WriteString(w, `<p role="alert">HTML preview is unavailable.</p>`)
}
