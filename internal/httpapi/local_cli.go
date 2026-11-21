package httpapi

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	"lever/internal/app"
	"lever/internal/localipc"
	"lever/internal/model"
	"lever/internal/store"
)

// StartLocalCLI serves commands and desktop pairing over an OS-protected socket or pipe.
func (s *Server) StartLocalCLI(desktop http.Handler) error {
	if s.localCLI != nil {
		return nil
	}
	l, err := localipc.Listen(s.App.Store.Dir)
	if err != nil {
		return err
	}
	a := s.App
	mux := http.NewServeMux()
	mux.HandleFunc("/mcp", a.MCP)
	if desktop != nil {
		mux.Handle("POST /desktop/attach", desktop)
		mux.Handle("POST /desktop/restart", desktop)
	}
	mux.HandleFunc("GET /agents", func(w http.ResponseWriter, r *http.Request) {
		type agent struct {
			ID   string `json:"id"`
			Name string `json:"name"`
		}
		items, err := store.List[agent](r.Context(), a.Store.DB, `SELECT json_object('id',id,'name',json_extract(data,'$.name'))
FROM agents WHERE json_extract(data,'$.archived') IS NOT 1 ORDER BY json_extract(data,'$.name') COLLATE NOCASE,id`)
		respond(w, items, err)
	})
	mux.HandleFunc("POST /agents/{id}/work-items", func(w http.ResponseWriter, r *http.Request) {
		var input model.WorkItemInput
		if err := readLimit(w, r, &input, 256<<10); err != nil {
			respond(w, nil, err)
			return
		}
		item, err := a.CreateWorkItem(r.Context(), r.PathValue("id"), nil, input)
		respond(w, item, err)
	})
	mux.HandleFunc("GET /chats", func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "" {
			respond(w, nil, &app.Error{Status: http.StatusForbidden, Message: "Chat listing is not available with an execution capability; use lever context find"})
			return
		}
		type chat struct {
			ID        string `json:"id"`
			AgentID   string `json:"agentId"`
			AgentName string `json:"agentName,omitempty"`
			Title     string `json:"title"`
			Source    string `json:"source"`
			UpdatedAt string `json:"updatedAt"`
		}
		agentID := strings.TrimSpace(r.URL.Query().Get("agent"))
		limit := 20
		if raw := strings.TrimSpace(r.URL.Query().Get("limit")); raw != "" {
			n, err := strconv.Atoi(raw)
			if err != nil || n < 1 || n > 100 {
				respond(w, nil, &app.Error{Status: http.StatusBadRequest, Message: "limit must be between 1 and 100"})
				return
			}
			limit = n
		}
		items, err := store.List[chat](r.Context(), a.Store.DB, `SELECT json_object(
'id',c.id,
'agentId',c.agent_id,
'agentName',COALESCE(json_extract(a.data,'$.name'),''),
'title',COALESCE(json_extract(c.data,'$.title'),''),
'source',COALESCE(json_extract(c.data,'$.source'),''),
'updatedAt',COALESCE(json_extract(c.data,'$.updatedAt'),'')
) FROM chats c LEFT JOIN agents a ON a.id=c.agent_id
WHERE (?='' OR c.agent_id=?)
ORDER BY json_extract(c.data,'$.updatedAt') DESC, c.rowid DESC LIMIT ?`, agentID, agentID, limit)
		respond(w, items, err)
	})
	mux.HandleFunc("POST /context/find", func(w http.ResponseWriter, r *http.Request) {
		var input app.FindContextCLIInput
		if err := readLimit(w, r, &input, 32<<10); err != nil {
			respond(w, nil, err)
			return
		}
		out, err := a.FindChatContextCLI(r.Context(), r.Header.Get("Authorization"), input)
		respond(w, out, err)
	})
	mux.HandleFunc("POST /context/read", func(w http.ResponseWriter, r *http.Request) {
		var input app.ReadContextCLIInput
		if err := readLimit(w, r, &input, 32<<10); err != nil {
			respond(w, nil, err)
			return
		}
		out, err := a.ReadChatContextCLI(r.Context(), r.Header.Get("Authorization"), input)
		respond(w, out, err)
	})
	local := &http.Server{Handler: mux, ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 10 * time.Second, MaxHeaderBytes: 32 << 10}
	s.localCLI = local
	go func() {
		if err := local.Serve(l); err != nil && !errors.Is(err, http.ErrServerClosed) {
			slog.Error("serve local CLI", "error", err)
		}
	}()
	return nil
}

func (s *Server) CloseLocalCLI(ctx context.Context) error {
	if s.localCLI == nil {
		return nil
	}
	if err := s.localCLI.Shutdown(ctx); err != nil {
		_ = s.localCLI.Close()
		return err
	}
	return nil
}
