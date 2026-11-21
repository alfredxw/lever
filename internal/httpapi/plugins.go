package httpapi

import (
	"net/http"

	"lever/internal/model"
)

func (s *Server) pluginRoutes(mux *http.ServeMux) {
	a := s.App
	mux.HandleFunc("GET /api/plugins", func(w http.ResponseWriter, r *http.Request) { v, err := a.Plugins(r.Context()); respond(w, v, err) })
	mux.HandleFunc("POST /api/plugins", func(w http.ResponseWriter, r *http.Request) {
		var input struct {
			Manifest  model.PluginManifest `json:"manifest"`
			Directory string               `json:"directory"`
		}
		if err := read(w, r, &input); err != nil {
			respond(w, nil, err)
			return
		}
		v, err := a.InstallPlugin(r.Context(), input.Manifest, input.Directory)
		respond(w, v, err)
	})
	mux.HandleFunc("PUT /api/plugins/{id}", func(w http.ResponseWriter, r *http.Request) {
		var input struct {
			Enabled bool `json:"enabled"`
		}
		if err := read(w, r, &input); err != nil {
			respond(w, nil, err)
			return
		}
		respond(w, map[string]bool{"updated": true}, a.UpdatePlugin(r.Context(), r.PathValue("id"), input.Enabled, false))
	})
	mux.HandleFunc("DELETE /api/plugins/{id}", func(w http.ResponseWriter, r *http.Request) {
		respond(w, map[string]bool{"uninstalled": true}, a.UpdatePlugin(r.Context(), r.PathValue("id"), false, true))
	})

	preview := func(w http.ResponseWriter, r *http.Request) {
		var input model.PluginPreviewInput
		if err := read(w, r, &input); err != nil {
			respond(w, nil, err)
			return
		}
		v, err := a.PreviewPlugin(r.Context(), r.PathValue("id"), input)
		respond(w, v, err)
	}
	mux.HandleFunc("POST /api/plugins/preview", preview)
	mux.HandleFunc("POST /api/plugins/{id}/preview", preview)
	mux.HandleFunc("GET /api/plugins/{id}/update", func(w http.ResponseWriter, r *http.Request) {
		v, err := a.CheckPluginUpdate(r.Context(), r.PathValue("id"))
		respond(w, v, err)
	})
	mux.HandleFunc("POST /api/plugin-previews/{preview}/apply", func(w http.ResponseWriter, r *http.Request) {
		v, err := a.ApplyPluginPreview(r.Context(), r.PathValue("preview"))
		respond(w, v, err)
	})
	mux.HandleFunc("DELETE /api/plugin-previews/{preview}", func(w http.ResponseWriter, r *http.Request) {
		a.DiscardPluginPreview(r.PathValue("preview"))
		respond(w, nil, nil)
	})
	mux.HandleFunc("POST /api/plugins/{id}/rollback", func(w http.ResponseWriter, r *http.Request) {
		var input struct{ Revision int64 }
		if err := read(w, r, &input); err != nil {
			respond(w, nil, err)
			return
		}
		v, err := a.RollbackPlugin(r.Context(), r.PathValue("id"), input.Revision)
		respond(w, v, err)
	})
	mux.HandleFunc("POST /api/plugins/{id}/reload", func(w http.ResponseWriter, r *http.Request) {
		v, err := a.ReloadPlugin(r.Context(), r.PathValue("id"))
		respond(w, v, err)
	})
}
