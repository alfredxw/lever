package httpapi

import (
	"bytes"
	"net/http"
	"strconv"
	"time"
)

func (s *Server) sharedConversationRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/shared-conversations", func(w http.ResponseWriter, r *http.Request) {
		v, err := s.App.SharedConversations(r.Context())
		respond(w, v, err)
	})
	mux.HandleFunc("GET /api/shared-conversations/{provider}/{id}", func(w http.ResponseWriter, r *http.Request) {
		limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
		v, err := s.App.SharedHistory(r.Context(), r.PathValue("provider"), r.PathValue("id"), limit)
		respond(w, v, err)
	})
	mux.HandleFunc("GET /api/shared-conversations/{provider}/{id}/images/{image}", func(w http.ResponseWriter, r *http.Request) {
		data, mediaType, err := s.App.SharedImage(r.Context(), r.PathValue("provider"), r.PathValue("id"), r.PathValue("image"))
		if err != nil {
			respond(w, nil, err)
			return
		}
		w.Header().Set("Content-Type", mediaType)
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Content-Security-Policy", "sandbox; default-src 'none'")
		w.Header().Set("Cache-Control", "private, no-cache")
		http.ServeContent(w, r, "", time.Time{}, bytes.NewReader(data))
	})
	mux.HandleFunc("GET /api/shared-conversations/{provider}/{id}/details/{entry}", func(w http.ResponseWriter, r *http.Request) {
		text, err := s.App.SharedDetail(r.Context(), r.PathValue("provider"), r.PathValue("id"), r.PathValue("entry"))
		respond(w, text, err)
	})
	mux.HandleFunc("POST /api/shared-conversations/{provider}/{id}", func(w http.ResponseWriter, r *http.Request) {
		var input struct {
			Text string `json:"text"`
		}
		if err := readLimit(w, r, &input, 1<<20); err != nil {
			respond(w, nil, err)
			return
		}
		err := s.App.SendSharedMessage(r.Context(), r.PathValue("provider"), r.PathValue("id"), input.Text)
		respond(w, struct{}{}, err)
	})
}
