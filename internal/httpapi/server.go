package httpapi

import (
	"context"
	"crypto/subtle"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"mime"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"strconv"
	"strings"
	"sync/atomic"
	"time"

	"lever/internal/app"
	"lever/internal/localstats"
	"lever/internal/model"
	"lever/internal/plugin"
	"lever/internal/provider"
	"lever/internal/remote"
	"lever/internal/store"
	"lever/internal/workspace"
)

type Server struct {
	OnStop     context.CancelFunc
	Remote     *remote.Host
	App        *app.App
	HTTP       *http.Server
	URL, Token string
	listener   net.Listener
	renderer   atomic.Pointer[devRenderer]
	localCLI   *http.Server
}

type devRenderer struct {
	origin string
	host   string
	proxy  *httputil.ReverseProxy
}

// SetDevOrigin updates Vite's address when a development desktop reconnects.
func (s *Server) SetDevOrigin(origin string) error {
	if origin == "" {
		s.renderer.Store(nil)
		return nil
	}
	u, err := url.Parse(origin)
	if err != nil || u.Scheme != "http" || !net.ParseIP(u.Hostname()).IsLoopback() || u.User != nil || u.Path != "" || u.RawQuery != "" || u.Fragment != "" {
		return errors.New("development origin must be a loopback HTTP origin")
	}
	s.renderer.Store(&devRenderer{origin: origin, host: u.Host, proxy: &httputil.ReverseProxy{Rewrite: func(p *httputil.ProxyRequest) {
		p.SetURL(u)
		p.Out.Header.Del("Cookie")
		p.Out.Header.Del("Authorization")
	}}})
	return nil
}

func (s *Server) allowsOrigin(origin string) bool {
	renderer := s.renderer.Load()
	return origin == "" || origin == s.URL || (renderer != nil && origin == renderer.origin)
}

func New(a *app.App, address, devOrigin string, assets fs.FS) (*Server, error) {
	s := &Server{App: a, Token: app.ID() + app.ID()}
	if err := s.SetDevOrigin(devOrigin); err != nil {
		return nil, err
	}
	host, _, err := net.SplitHostPort(address)
	if err != nil {
		return nil, err
	}
	ip := net.ParseIP(host)
	if ip == nil || !ip.IsLoopback() {
		return nil, errors.New("Lever currently listens only on a loopback address")
	}
	l, err := net.Listen("tcp", address)
	if err != nil {
		return nil, err
	}
	s.Remote = remote.Start(a)
	a.SetRemoteCollaborator(s.Remote)
	s.URL, s.listener = "http://"+l.Addr().String(), l
	a.URL = s.URL
	a.StartChannels()
	mux := http.NewServeMux()
	mux.HandleFunc("POST /api/pair", func(w http.ResponseWriter, r *http.Request) {
		var input struct {
			Token string `json:"token"`
		}
		if err := read(w, r, &input); err != nil {
			respond(w, nil, err)
			return
		}
		if subtle.ConstantTimeCompare([]byte(input.Token), []byte(s.Token)) != 1 {
			http.Error(w, "Invalid pairing token", 401)
			return
		}
		http.SetCookie(w, &http.Cookie{Name: "lever_session", Value: s.Token, Path: "/", HttpOnly: true, SameSite: http.SameSiteStrictMode})
		respond(w, map[string]bool{"paired": true}, nil)
	})
	api := http.NewServeMux()
	api.Handle("POST /api/remote", s.Remote.Handler())
	s.routes(api)
	s.channelRoutes(api)
	mux.Handle("/api/", s.auth(api))
	mux.HandleFunc("POST "+automationHook+"{id}", s.receiveAutomationEvent)
	mux.HandleFunc("/mcp", a.MCP)
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		// Keep the desktop's origin, cookies and native bridge stable while
		// forwarding frontend resources and the HMR WebSocket to Vite.
		if renderer := s.renderer.Load(); renderer != nil {
			renderer.proxy.ServeHTTP(w, r)
			return
		}
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Content-Security-Policy", "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data: https:; font-src 'self' data:; connect-src 'self'; worker-src 'self' blob:; frame-ancestors 'none'")
		path := strings.TrimPrefix(r.URL.Path, "/")
		if path == "" {
			path = "index.html"
		}
		if _, err := fs.Stat(assets, path); err != nil {
			r.URL.Path = "/"
		}
		http.FileServerFS(assets).ServeHTTP(w, r)
	})
	s.HTTP = &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Host validation prevents DNS rebinding. Native runtimes omit Origin.
		renderer := s.renderer.Load()
		if r.Host != l.Addr().String() && (renderer == nil || r.Host != renderer.host) {
			http.Error(w, "Unexpected host", 403)
			return
		}
		if !s.allowsOrigin(r.Header.Get("Origin")) {
			http.Error(w, "Unexpected origin", 403)
			return
		}
		mux.ServeHTTP(w, r)
	}), ReadHeaderTimeout: 5 * time.Second, IdleTimeout: 60 * time.Second, MaxHeaderBytes: 32 << 10}
	return s, nil
}

func (s *Server) Serve() error {
	s.App.StartRestartRecovery()
	s.App.StartAutomations()
	s.App.StartRemoteDelegationFollower()
	return s.HTTP.Serve(s.listener)
}
func (s *Server) Close(ctx context.Context) error {
	if s.Remote != nil {
		s.Remote.Close()
	}
	err := s.HTTP.Shutdown(ctx)
	// The listener may already be bound before Serve registers it with HTTP.
	if closeErr := s.listener.Close(); closeErr != nil && !errors.Is(closeErr, net.ErrClosed) {
		err = errors.Join(err, closeErr)
	}
	return err
}
func (s *Server) PairURL() string { return s.URL + "/#token=" + s.Token }

func (s *Server) auth(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		token := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
		if c, err := r.Cookie("lever_session"); err == nil && token == "" {
			token = c.Value
		}
		if subtle.ConstantTimeCompare([]byte(token), []byte(s.Token)) != 1 {
			http.Error(w, "Open Lever using the local pairing link", 401)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func read(w http.ResponseWriter, r *http.Request, v any) error {
	return readLimit(w, r, v, 2<<20)
}

func readLimit(w http.ResponseWriter, r *http.Request, v any, limit int64) error {
	r.Body = http.MaxBytesReader(w, r.Body, limit)
	d := json.NewDecoder(r.Body)
	d.DisallowUnknownFields()
	if err := d.Decode(v); err != nil {
		return &app.Error{Status: 400, Message: err.Error()}
	}
	if err := d.Decode(new(any)); !errors.Is(err, io.EOF) {
		return &app.Error{Status: 400, Message: "Expected one JSON object"}
	}
	return nil
}
func respond(w http.ResponseWriter, v any, err error) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	if err != nil {
		status := 500
		body := map[string]string{"error": err.Error()}
		var e *app.Error
		var sourceError *plugin.TaskSourceError
		if errors.As(err, &e) {
			status = e.Status
		} else if errors.As(err, &sourceError) {
			status = sourceError.Status
			body["code"] = "task_source_" + sourceError.Code
		} else if errors.Is(err, provider.ErrAntigravityCLIAuthRequired) {
			status = http.StatusConflict
			body["code"] = "antigravity_cli_auth_required"
		} else if errors.Is(err, app.ErrTaskNoteVersion) {
			status = http.StatusConflict
			body["code"] = "task_note_version"
		} else if errors.Is(err, app.ErrTaskNotesDirectoryChanged) {
			status = http.StatusConflict
			body["code"] = "task_notes_directory_changed"
		} else if errors.Is(err, app.ErrTaskNotesUnavailable) {
			status = http.StatusServiceUnavailable
			if errors.Is(err, os.ErrNotExist) {
				status = http.StatusNotFound
			}
			body["code"] = "task_notes_unavailable"
		} else if errors.Is(err, workspace.ErrFileConflict) {
			status = http.StatusConflict
			body["code"] = "file_conflict"
		} else if errors.Is(err, sql.ErrNoRows) || errors.Is(err, os.ErrNotExist) {
			status = 404
		}
		w.WriteHeader(status)
		_ = json.NewEncoder(w).Encode(body)
		return
	}
	_ = json.NewEncoder(w).Encode(v)
}

func (s *Server) routes(mux *http.ServeMux) {
	a := s.App
	s.taskRoutes(mux)
	s.workItemRoutes(mux)
	s.automationRoutes(mux)
	s.sharedConversationRoutes(mux)
	mux.HandleFunc("GET /api/visualizations", func(w http.ResponseWriter, r *http.Request) {
		s.serveChatPreview(w, r, r.URL.Query().Get("run"), "visualization")
	})
	mux.HandleFunc("GET /api/runs/{run}/preview", s.chatPreview)
	mux.HandleFunc("GET /api/shared-conversations/{provider}/{id}/preview", s.chatPreview)
	mux.HandleFunc("GET /api/attachments/{attachment}/preview", s.chatPreview)
	s.pluginRoutes(mux)
	mux.HandleFunc("GET /api/agents/{id}/terminal", s.terminal)
	mux.HandleFunc("DELETE /api/agents/{id}/terminal", s.closeTerminal)
	mux.HandleFunc("GET /api/overview", func(w http.ResponseWriter, r *http.Request) { v, err := a.Overview(r.Context()); respond(w, v, err) })
	mux.HandleFunc("GET /api/providers", func(w http.ResponseWriter, r *http.Request) {
		v, err := a.Providers(r.Context(), r.URL.Query().Get("login") == "true")
		respond(w, v, err)
	})
	mux.HandleFunc("GET /api/provider-candidates", func(w http.ResponseWriter, r *http.Request) {
		v, err := a.ProviderCandidates(r.Context())
		respond(w, v, err)
	})
	mux.HandleFunc("POST /api/provider-candidates/scan", func(w http.ResponseWriter, r *http.Request) {
		connected, err := a.ConnectLocalProviders(r.Context())
		respond(w, map[string]bool{"connected": connected}, err)
	})
	mux.HandleFunc("POST /api/provider-candidates/{plugin}/{contribution}", func(w http.ResponseWriter, r *http.Request) {
		v, err := a.UseLocalProvider(r.Context(), r.PathValue("plugin"), r.PathValue("contribution"))
		respond(w, v, err)
	})
	mux.HandleFunc("GET /api/provider-types", func(w http.ResponseWriter, r *http.Request) { respond(w, provider.Types(), nil) })
	mux.HandleFunc("POST /api/providers", func(w http.ResponseWriter, r *http.Request) {
		var config app.ProviderInput
		if err := read(w, r, &config); err != nil {
			respond(w, nil, err)
			return
		}
		v, err := a.SaveProvider(r.Context(), config)
		respond(w, v, err)
	})
	mux.HandleFunc("DELETE /api/providers/{id}", func(w http.ResponseWriter, r *http.Request) {
		respond(w, map[string]bool{"deleted": true}, a.DeleteProvider(r.Context(), r.PathValue("id")))
	})
	mux.HandleFunc("GET /api/providers/{id}/models", func(w http.ResponseWriter, r *http.Request) {
		value, err := a.Catalog(r.Context(), r.PathValue("id"), r.URL.Query().Get("cwd"), r.URL.Query().Get("refresh") == "true")
		respond(w, value, err)
	})
	mux.HandleFunc("PATCH /api/providers/{id}/models/visibility", func(w http.ResponseWriter, r *http.Request) {
		var input struct {
			Models  []string `json:"models"`
			Visible *bool    `json:"visible"`
		}
		if err := read(w, r, &input); err != nil {
			respond(w, nil, err)
			return
		}
		if input.Visible == nil {
			respond(w, nil, &app.Error{Status: 400, Message: "Model visibility is required"})
			return
		}
		config, err := a.SetProviderModelVisibility(r.Context(), r.PathValue("id"), input.Models, *input.Visible)
		respond(w, config, err)
	})
	mux.HandleFunc("POST /api/providers/{id}/terminal/{terminal}", s.startProviderTerminal)
	mux.HandleFunc("GET /api/providers/{id}/terminal/{terminal}", s.providerTerminal)
	mux.HandleFunc("DELETE /api/providers/{id}/terminal/{terminal}", s.closeProviderTerminal)
	mux.HandleFunc("GET /api/providers/{id}/usage", func(w http.ResponseWriter, r *http.Request) {
		value, err := a.ProviderUsage(r.Context(), r.PathValue("id"), r.URL.Query().Get("refresh") == "true")
		respond(w, value, err)
	})
	mux.HandleFunc("GET /api/stats/local", func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		value, err := a.LocalStats(r.Context(), localstats.Query{
			Period:   q.Get("period"),
			Scope:    q.Get("scope"),
			TimeZone: q.Get("tz"),
			Refresh:  q.Get("refresh") == "true",
		})
		respond(w, value, err)
	})
	mux.HandleFunc("GET /api/stats/local/summary", func(w http.ResponseWriter, r *http.Request) {
		value, err := a.LocalStatsSummary(r.Context(), r.URL.Query().Get("tz"))
		respond(w, value, err)
	})
	mux.HandleFunc("PUT /api/providers/{id}/api-key", func(w http.ResponseWriter, r *http.Request) {
		var input struct {
			Key *string `json:"key"`
		}
		if err := read(w, r, &input); err != nil {
			respond(w, nil, err)
			return
		}
		if input.Key == nil {
			respond(w, nil, &app.Error{Status: 400, Message: "Expected an API key"})
			return
		}
		respond(w, map[string]bool{"updated": true}, a.SetProviderAPIKey(r.Context(), r.PathValue("id"), *input.Key))
	})
	mux.HandleFunc("GET /api/providers/{id}/setup", func(w http.ResponseWriter, r *http.Request) {
		value, err := a.ProviderSetup(r.Context(), r.PathValue("id"))
		respond(w, value, err)
	})
	mux.HandleFunc("POST /api/providers/{id}/setup", func(w http.ResponseWriter, r *http.Request) {
		var input struct {
			Action string `json:"action"`
		}
		if err := read(w, r, &input); err != nil {
			respond(w, nil, err)
			return
		}
		value, err := a.SetupProvider(r.Context(), r.PathValue("id"), input.Action)
		respond(w, value, err)
	})
	upload := func(w http.ResponseWriter, r *http.Request) {
		r.Body = http.MaxBytesReader(w, r.Body, app.MaxAttachmentBytes+(64<<10))
		reader, err := r.MultipartReader()
		if err != nil {
			respond(w, nil, &app.Error{Status: 400, Message: "Expected a file upload"})
			return
		}
		part, err := reader.NextPart()
		if err != nil || part.FormName() != "file" || part.FileName() == "" {
			respond(w, nil, &app.Error{Status: 400, Message: "Expected one file"})
			return
		}
		var file model.Attachment
		if agentID := r.PathValue("agentId"); agentID != "" {
			file, err = a.UploadDraft(r.Context(), agentID, part.FileName(), part)
		} else {
			file, err = a.Upload(r.Context(), r.PathValue("id"), part.FileName(), part)
		}
		if err == nil {
			if _, nextErr := reader.NextPart(); !errors.Is(nextErr, io.EOF) {
				_ = a.DeleteAttachment(r.Context(), file.ID)
				err = &app.Error{Status: 400, Message: "Upload one file at a time"}
			}
		}
		respond(w, file, err)
	}
	mux.HandleFunc("POST /api/chats/{id}/attachments", upload)
	mux.HandleFunc("POST /api/agents/{agentId}/attachments", upload)
	mux.HandleFunc("GET /api/attachments/{id}", func(w http.ResponseWriter, r *http.Request) {
		file, err := a.Attachment(r.Context(), r.PathValue("id"))
		if err != nil {
			respond(w, nil, err)
			return
		}
		disposition := "attachment"
		switch file.MediaType {
		case "image/png", "image/jpeg", "image/webp", "image/gif":
			disposition = "inline"
		}
		w.Header().Set("Content-Type", file.MediaType)
		w.Header().Set("Content-Disposition", mime.FormatMediaType(disposition, map[string]string{"filename": file.Name}))
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Content-Security-Policy", "sandbox; default-src 'none'")
		w.Header().Set("Cache-Control", "private, max-age=31536000, immutable")
		http.ServeFile(w, r, a.AttachmentPath(file))
	})
	mux.HandleFunc("DELETE /api/attachments/{id}", func(w http.ResponseWriter, r *http.Request) {
		respond(w, map[string]bool{"deleted": true}, a.DeleteAttachment(r.Context(), r.PathValue("id")))
	})
	mux.HandleFunc("POST /api/avatars", func(w http.ResponseWriter, r *http.Request) {
		r.Body = http.MaxBytesReader(w, r.Body, app.MaxAvatarBytes+(64<<10))
		reader, err := r.MultipartReader()
		if err != nil {
			respond(w, nil, &app.Error{Status: 400, Message: "Expected a file upload"})
			return
		}
		part, err := reader.NextPart()
		if err != nil || part.FormName() != "file" || part.FileName() == "" {
			respond(w, nil, &app.Error{Status: 400, Message: "Expected one image"})
			return
		}
		data, err := io.ReadAll(io.LimitReader(part, app.MaxAvatarBytes+1))
		if err != nil || len(data) > app.MaxAvatarBytes {
			respond(w, nil, &app.Error{Status: 400, Message: "Avatar images are limited to 5 MiB"})
			return
		}
		if _, err := reader.NextPart(); !errors.Is(err, io.EOF) {
			respond(w, nil, &app.Error{Status: 400, Message: "Upload one image at a time"})
			return
		}
		avatar, err := a.SaveAvatarImage(data)
		respond(w, avatar, err)
	})
	mux.HandleFunc("GET /api/avatars/{id}", func(w http.ResponseWriter, r *http.Request) {
		file, mediaType, err := a.OpenAvatarImage(r.PathValue("id"))
		if err != nil {
			respond(w, nil, err)
			return
		}
		defer file.Close()
		w.Header().Set("Content-Type", mediaType)
		w.Header().Set("Content-Disposition", "inline")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Content-Security-Policy", "sandbox; default-src 'none'")
		w.Header().Set("Cache-Control", "private, max-age=31536000, immutable")
		http.ServeContent(w, r, "", time.Time{}, file)
	})
	mux.HandleFunc("POST /api/agents", func(w http.ResponseWriter, r *http.Request) {
		var v model.Agent
		if err := read(w, r, &v); err != nil {
			respond(w, nil, err)
			return
		}
		if v.ID != "" {
			respond(w, nil, &app.Error{Status: 400, Message: "Use PUT to edit an agent"})
			return
		}
		v, err := a.SaveAgent(r.Context(), v)
		respond(w, v, err)
	})
	mux.HandleFunc("PUT /api/agents/{id}", func(w http.ResponseWriter, r *http.Request) {
		var v model.Agent
		if err := read(w, r, &v); err != nil {
			respond(w, nil, err)
			return
		}
		v.ID = r.PathValue("id")
		v, err := a.SaveAgent(r.Context(), v)
		respond(w, v, err)
	})
	mux.HandleFunc("PUT /api/agents/{id}/selection", func(w http.ResponseWriter, r *http.Request) {
		var sel model.Selection
		if err := read(w, r, &sel); err != nil {
			respond(w, nil, err)
			return
		}
		v, err := a.SaveAgentSelection(r.Context(), r.PathValue("id"), sel)
		respond(w, v, err)
	})
	mux.HandleFunc("POST /api/chats", func(w http.ResponseWriter, r *http.Request) {
		var in struct {
			AgentID string `json:"agentId"`
			Title   string `json:"title"`
		}
		if err := read(w, r, &in); err != nil {
			respond(w, nil, err)
			return
		}
		v, err := a.CreateChat(r.Context(), in.AgentID, in.Title)
		respond(w, v, err)
	})
	mux.HandleFunc("GET /api/search/messages", func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
		defer cancel()
		v, err := a.SearchMessages(ctx, q.Get("query"), q.Get("agentId"), q.Get("chatId"), q.Get("kind"))
		respond(w, v, err)
	})
	mux.HandleFunc("PUT /api/chats/{id}/title", func(w http.ResponseWriter, r *http.Request) {
		var in struct {
			Title   string `json:"title"`
			TopicID string `json:"topicId,omitempty"`
		}
		if err := read(w, r, &in); err != nil {
			respond(w, nil, err)
			return
		}
		respond(w, nil, a.RenameConversation(r.Context(), r.PathValue("id"), in.TopicID, in.Title))
	})
	mux.HandleFunc("GET /api/chats/{id}", func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		before, _ := strconv.ParseInt(q.Get("before"), 10, 64)
		limit, _ := strconv.Atoi(q.Get("limit"))
		v, err := a.Store.ChatPage(r.Context(), r.PathValue("id"), before, limit)
		respond(w, v, err)
	})
	mux.HandleFunc("GET /api/chats/{id}/delegations", func(w http.ResponseWriter, r *http.Request) {
		v, err := a.Store.ChatDelegations(r.Context(), r.PathValue("id"))
		respond(w, v, err)
	})
	mux.HandleFunc("GET /api/settings/delegation", func(w http.ResponseWriter, r *http.Request) {
		v, err := a.DelegationSettings(r.Context())
		respond(w, v, err)
	})
	mux.HandleFunc("PUT /api/settings/delegation", func(w http.ResponseWriter, r *http.Request) {
		var in model.DelegationSettings
		if err := read(w, r, &in); err != nil {
			respond(w, nil, err)
			return
		}
		v, err := a.SaveDelegationSettings(r.Context(), in)
		respond(w, v, err)
	})
	mux.HandleFunc("GET /api/settings/permissions", func(w http.ResponseWriter, r *http.Request) {
		v, err := a.PermissionSettings(r.Context())
		respond(w, v, err)
	})
	mux.HandleFunc("PUT /api/settings/permissions", func(w http.ResponseWriter, r *http.Request) {
		var in model.PermissionSettings
		if err := read(w, r, &in); err != nil {
			respond(w, nil, err)
			return
		}
		v, err := a.SavePermissionSettings(r.Context(), in)
		respond(w, v, err)
	})
	mux.HandleFunc("GET /api/settings/starred-models", func(w http.ResponseWriter, r *http.Request) {
		out := map[string][]string{}
		var raw string
		if err := a.Store.DB.QueryRowContext(r.Context(), "SELECT value FROM settings WHERE key='starred_models'").Scan(&raw); err == nil && raw != "" {
			_ = json.Unmarshal([]byte(raw), &out)
		}
		respond(w, out, nil)
	})
	mux.HandleFunc("PUT /api/settings/starred-models", func(w http.ResponseWriter, r *http.Request) {
		var in map[string][]string
		if err := read(w, r, &in); err != nil {
			respond(w, nil, err)
			return
		}
		cleaned := map[string][]string{}
		for prov, ids := range in {
			if prov == "" || len(cleaned) >= 64 {
				continue
			}
			seen := map[string]bool{}
			list := make([]string, 0, len(ids))
			for _, id := range ids {
				if id != "" && !seen[id] && len(list) < 128 {
					seen[id] = true
					list = append(list, id)
				}
			}
			if len(list) > 0 {
				cleaned[prov] = list
			}
		}
		err := a.Store.Write(r.Context(), func(tx *sql.Tx) error {
			_, err := tx.Exec("INSERT INTO settings(key,value) VALUES('starred_models',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", store.JSON(cleaned))
			return err
		})
		respond(w, cleaned, err)
	})
	mux.HandleFunc("GET /api/delegation/remote-targets", func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
		defer cancel()
		v, err := a.RemoteDelegationTargets(ctx, q.Get("chatId"), q.Get("agentId"))
		respond(w, v, err)
	})
	mux.HandleFunc("POST /api/delegations/remote/{id}/answer", func(w http.ResponseWriter, r *http.Request) {
		var in struct {
			RequestID string        `json:"requestId"`
			Answer    *model.Answer `json:"answer,omitempty"`
			AllowRun  bool          `json:"allowRun,omitempty"`
		}
		if err := read(w, r, &in); err != nil {
			respond(w, nil, err)
			return
		}
		respond(w, map[string]bool{"accepted": true}, a.AnswerRemoteDelegationRequest(r.Context(), r.PathValue("id"), in.RequestID, in.Answer, in.AllowRun))
	})
	mux.HandleFunc("POST /api/delegations/remote/{id}/stop", func(w http.ResponseWriter, r *http.Request) {
		respond(w, map[string]bool{"accepted": true}, a.StopRemoteDelegation(r.Context(), r.PathValue("id")))
	})
	mux.HandleFunc("POST /api/delegations/{id}/stop", func(w http.ResponseWriter, r *http.Request) {
		respond(w, map[string]bool{"accepted": true}, a.StopDelegation(r.Context(), r.PathValue("id")))
	})
	mux.HandleFunc("GET /api/chats/{id}/topics", func(w http.ResponseWriter, r *http.Request) {
		v, err := a.Store.ChatTopics(r.Context(), r.PathValue("id"), -1)
		respond(w, v, err)
	})
	mux.HandleFunc("GET /api/chats/{id}/topics/page", func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		before, _ := strconv.ParseInt(q.Get("before"), 10, 64)
		limit, _ := strconv.Atoi(q.Get("limit"))
		page, err := a.Store.ChatTopicsPage(r.Context(), r.PathValue("id"), before, limit)
		respond(w, page, err)
	})
	mux.HandleFunc("POST /api/chats/{id}/topics", func(w http.ResponseWriter, r *http.Request) {
		var in struct {
			SourceRunID string `json:"sourceRunId"`
		}
		if err := read(w, r, &in); err != nil {
			respond(w, nil, err)
			return
		}
		v, err := a.CreateTopicFromRun(r.Context(), r.PathValue("id"), in.SourceRunID)
		respond(w, v, err)
	})
	suggestions := func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
		defer cancel()
		v, err := a.Suggestions(ctx, r.PathValue("id"), r.PathValue("agentId"), q.Get("sessionId"), q.Get("workingCopyId"), q.Get("kind"), q.Get("provider"), q.Get("query"))
		respond(w, v, err)
	}
	mux.HandleFunc("GET /api/chats/{id}/suggestions", suggestions)
	mux.HandleFunc("GET /api/agents/{agentId}/suggestions", suggestions)
	mux.HandleFunc("GET /api/sessions/{id}", func(w http.ResponseWriter, r *http.Request) {
		v, err := a.Store.SessionView(r.Context(), r.PathValue("id"))
		respond(w, v, err)
	})
	mux.HandleFunc("GET /api/sessions/{id}/runs", func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		before, _ := strconv.ParseInt(q.Get("before"), 10, 64)
		limit, _ := strconv.Atoi(q.Get("limit"))
		v, err := a.Store.SessionRunPage(r.Context(), r.PathValue("id"), before, limit)
		respond(w, v, err)
	})
	mux.HandleFunc("POST /api/sessions/read", func(w http.ResponseWriter, r *http.Request) {
		var in struct {
			Items []model.ReadMark `json:"items"`
		}
		if err := read(w, r, &in); err != nil {
			respond(w, nil, err)
			return
		}
		respond(w, map[string]bool{"ok": true}, a.MarkSessionsRead(r.Context(), in.Items))
	})
	mux.HandleFunc("POST /api/sessions/cleared", func(w http.ResponseWriter, r *http.Request) {
		var in struct {
			Items []model.ClearMark `json:"items"`
		}
		if err := read(w, r, &in); err != nil {
			respond(w, nil, err)
			return
		}
		respond(w, map[string]bool{"ok": true}, a.MarkSessionsCleared(r.Context(), in.Items))
	})
	mux.HandleFunc("POST /api/desktop/presence", func(w http.ResponseWriter, r *http.Request) {
		var in struct {
			Active bool `json:"active"`
		}
		if err := read(w, r, &in); err != nil {
			respond(w, nil, err)
			return
		}
		a.SetDesktopPresence(in.Active)
		respond(w, map[string]bool{"active": a.DesktopActive()}, nil)
	})
	mux.HandleFunc("POST /api/messages", func(w http.ResponseWriter, r *http.Request) {
		var in model.SendInput
		if err := read(w, r, &in); err != nil {
			respond(w, nil, err)
			return
		}
		v, err := a.Send(r.Context(), in)
		respond(w, v, err)
	})
	mux.HandleFunc("POST /api/comparisons", func(w http.ResponseWriter, r *http.Request) {
		var in model.ComparisonInput
		if err := read(w, r, &in); err != nil {
			respond(w, nil, err)
			return
		}
		v, err := a.SendComparison(r.Context(), in)
		respond(w, v, err)
	})
	mux.HandleFunc("GET /api/comparisons/{id}", func(w http.ResponseWriter, r *http.Request) {
		v, err := a.Store.ComparisonResults(r.Context(), r.PathValue("id"))
		respond(w, v, err)
	})
	mux.HandleFunc("GET /api/runs/{id}", func(w http.ResponseWriter, r *http.Request) {
		run, err := store.Get[model.Run](r.Context(), a.Store.DB, `SELECT `+store.RunWithWaitingOn+` FROM runs r
LEFT JOIN channel_deliveries d ON d.run_id=r.id AND d.part='answer' WHERE r.id=?`, r.PathValue("id"))
		respond(w, run, err)
	})
	mux.HandleFunc("POST /api/runs/{id}/stop", func(w http.ResponseWriter, r *http.Request) {
		respond(w, map[string]bool{"accepted": true}, a.Stop(r.Context(), r.PathValue("id")))
	})
	mux.HandleFunc("POST /api/runs/{id}/pause", func(w http.ResponseWriter, r *http.Request) {
		respond(w, map[string]bool{"accepted": true}, a.Pause(r.Context(), r.PathValue("id")))
	})
	mux.HandleFunc("POST /api/runs/{id}/resume", func(w http.ResponseWriter, r *http.Request) {
		var in struct {
			NativeTurnID string `json:"nativeTurnId"`
		}
		if err := read(w, r, &in); err != nil {
			respond(w, nil, err)
			return
		}
		respond(w, map[string]bool{"accepted": true}, a.Resume(r.Context(), r.PathValue("id"), in.NativeTurnID))
	})
	mux.HandleFunc("POST /api/runs/{id}/retry", func(w http.ResponseWriter, r *http.Request) {
		var in struct {
			CommandID string `json:"commandId"`
		}
		if err := read(w, r, &in); err != nil {
			respond(w, nil, err)
			return
		}
		v, err := a.Retry(r.Context(), r.PathValue("id"), in.CommandID)
		respond(w, v, err)
	})
	mux.HandleFunc("POST /api/runs/{id}/permission", func(w http.ResponseWriter, r *http.Request) {
		var in struct {
			Permission string `json:"permission"`
		}
		if err := read(w, r, &in); err != nil {
			respond(w, nil, err)
			return
		}
		respond(w, map[string]bool{"applied": true}, a.SetRunPermission(r.Context(), r.PathValue("id"), in.Permission))
	})
	mux.HandleFunc("POST /api/runs/{id}/approvals", func(w http.ResponseWriter, r *http.Request) {
		var in struct {
			Allow *bool `json:"allow"`
		}
		if err := read(w, r, &in); err != nil {
			respond(w, nil, err)
			return
		}
		if in.Allow == nil {
			respond(w, nil, &app.Error{Status: 400, Message: "Choose whether to allow approvals for this execution"})
			return
		}
		respond(w, map[string]bool{"applied": true}, a.SetRunApprovals(r.Context(), r.PathValue("id"), *in.Allow))
	})
	mux.HandleFunc("POST /api/runs/{id}/queue", func(w http.ResponseWriter, r *http.Request) {
		var in struct {
			Action     string `json:"action"`
			SteerRunID string `json:"steerRunId,omitempty"`
		}
		if err := read(w, r, &in); err != nil {
			respond(w, nil, err)
			return
		}
		respond(w, map[string]bool{"accepted": true}, a.QueueAction(r.Context(), r.PathValue("id"), in.Action, in.SteerRunID))
	})
	mux.HandleFunc("POST /api/sessions/{id}/queue/resume", func(w http.ResponseWriter, r *http.Request) {
		respond(w, map[string]bool{"accepted": true}, a.ResumeQueue(r.Context(), r.PathValue("id")))
	})
	mux.HandleFunc("POST /api/sessions/{id}/delegations/stop", func(w http.ResponseWriter, r *http.Request) {
		respond(w, map[string]bool{"accepted": true}, a.StopSessionDelegations(r.Context(), r.PathValue("id")))
	})
	mux.HandleFunc("POST /api/sessions/{id}/typing", func(w http.ResponseWriter, r *http.Request) {
		var in struct {
			Active bool `json:"active"`
		}
		if err := read(w, r, &in); err != nil {
			respond(w, nil, err)
			return
		}
		a.SetSessionTyping(r.PathValue("id"), in.Active)
		respond(w, map[string]bool{"ok": true}, nil)
	})
	mux.HandleFunc("POST /api/runs/{id}/resolve", func(w http.ResponseWriter, r *http.Request) {
		var v struct {
			ConfirmedStopped bool `json:"confirmedStopped"`
		}
		if err := read(w, r, &v); err != nil {
			respond(w, nil, err)
			return
		}
		if !v.ConfirmedStopped {
			respond(w, nil, &app.Error{Status: 400, Message: "Confirm the external execution has stopped first"})
			return
		}
		respond(w, map[string]bool{"resolved": true}, a.Resolve(r.Context(), r.PathValue("id")))
	})
	mux.HandleFunc("POST /api/requests/{id}/answer", func(w http.ResponseWriter, r *http.Request) {
		var v model.Answer
		if err := read(w, r, &v); err != nil {
			respond(w, nil, err)
			return
		}
		respond(w, map[string]bool{"accepted": true}, a.Answer(r.Context(), r.PathValue("id"), v))
	})
	s.workingCopyRoutes(mux, a)
	s.projectRoutes(mux, a)
	fileRoutes(mux, "/api/agents/{id}", agentFileScope(a), "")
	hostFileRoute(mux, a)
	skillRoutes(mux, a)
	mux.HandleFunc("GET /api/agents/{id}/git-roots", func(w http.ResponseWriter, r *http.Request) {
		ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
		defer cancel()
		dirs, release, err := a.UseScope(ctx, r.PathValue("id"), r.URL.Query().Get("sessionId"), "", false)
		if err != nil {
			respond(w, nil, err)
			return
		}
		defer release()
		roots := make([]model.Root, 0, len(dirs.Roots))
		for _, root := range dirs.Roots {
			if _, err := workspace.CheckoutRoot(ctx, root.Path); err == nil {
				roots = append(roots, root)
			} else if !errors.Is(err, workspace.ErrNotRepository) {
				respond(w, nil, err)
				return
			}
		}
		respond(w, roots, ctx.Err())
	})
	mux.HandleFunc("GET /api/agents/{id}/git-summary", func(w http.ResponseWriter, r *http.Request) {
		ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
		defer cancel()
		dirs, release, err := a.UseScope(ctx, r.PathValue("id"), r.URL.Query().Get("sessionId"), "", false)
		if err != nil {
			respond(w, nil, err)
			return
		}
		defer release()
		summaries := make([]model.GitRootSummary, 0, len(dirs.Roots))
		for _, root := range dirs.Roots {
			summary, err := workspace.GitSummary(ctx, root)
			if errors.Is(err, workspace.ErrNotRepository) {
				continue
			}
			if err != nil {
				if ctx.Err() != nil {
					respond(w, nil, ctx.Err())
					return
				}
				summaries = append(summaries, model.GitRootSummary{Root: root, Error: err.Error()})
				continue
			}
			summaries = append(summaries, summary)
		}
		respond(w, summaries, ctx.Err())
	})
	mux.HandleFunc("GET /api/agents/{id}/diff", func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		opts := workspace.DiffOptions{Full: q.Get("full") == "true", IgnoreWhitespace: q.Get("ignoreWhitespace") == "true", Path: q.Get("path")}
		ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
		defer cancel()
		if mode := q.Get("mode"); mode == "turn" || mode == "snapshot" {
			review, err := a.RunReview(ctx, r.PathValue("id"), q.Get("sessionId"), q.Get("run"))
			if err != nil {
				respond(w, nil, err)
				return
			}
			v, err := a.ReviewDiff(ctx, review, q.Get("root"), mode == "snapshot", opts)
			respond(w, v, err)
			return
		}
		root, release, err := scope(r, a, r.Method != http.MethodGet)
		if err != nil {
			respond(w, nil, err)
			return
		}
		defer release()
		v, err := workspace.Diff(ctx, root, q.Get("mode"), q.Get("base"), q.Get("head"), opts)
		respond(w, v, err)
	})
	mux.HandleFunc("GET /api/agents/{id}/changes", func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		v, err := a.RunReview(r.Context(), r.PathValue("id"), q.Get("sessionId"), q.Get("run"))
		respond(w, v, err)
	})
	mux.HandleFunc("GET /api/agents/{id}/commits", func(w http.ResponseWriter, r *http.Request) {
		root, release, err := scope(r, a, r.Method != http.MethodGet)
		if err != nil {
			respond(w, nil, err)
			return
		}
		defer release()
		ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
		defer cancel()
		v, err := workspace.RecentCommits(ctx, root)
		respond(w, v, err)
	})
	mux.HandleFunc("GET /api/agents/{id}/branches", func(w http.ResponseWriter, r *http.Request) {
		root, release, err := scope(r, a, r.Method != http.MethodGet)
		if err != nil {
			respond(w, nil, err)
			return
		}
		defer release()
		ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
		defer cancel()
		v, err := workspace.Branches(ctx, root)
		respond(w, v, err)
	})
	mux.HandleFunc("GET /api/events", s.events)
}

func (s *Server) events(w http.ResponseWriter, r *http.Request) {
	f, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "Streaming unavailable", 500)
		return
	}
	cursor, _ := strconv.ParseInt(r.URL.Query().Get("after"), 10, 64)
	if h := r.Header.Get("Last-Event-ID"); h != "" {
		cursor, _ = strconv.ParseInt(h, 10, 64)
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("X-Accel-Buffering", "no")
	ch, unsubscribe := s.App.Store.Subscribe()
	defer unsubscribe()
	ticker := time.NewTicker(15 * time.Second)
	defer ticker.Stop()
	for {
		var min, max int64
		if err := s.App.Store.DB.QueryRowContext(r.Context(), "SELECT COALESCE(MIN(sequence),0),COALESCE(MAX(sequence),0) FROM events").Scan(&min, &max); err != nil {
			return
		}
		if cursor < min-1 || cursor > max {
			fmt.Fprintf(w, "id: %d\nevent: reset\ndata: {}\n\n", max)
			cursor = max
			f.Flush()
		}
		events, err := s.App.Store.Events(r.Context(), cursor)
		if err != nil {
			return
		}
		for _, event := range events {
			if _, err = fmt.Fprintf(w, "id: %d\ndata: %s\n\n", event.Sequence, store.JSON(event)); err != nil {
				return
			}
			cursor = event.Sequence
		}
		f.Flush()
		if len(events) == 100 {
			continue
		}
		select {
		case <-r.Context().Done():
			return
		case <-ch:
		case <-ticker.C:
			if _, err = fmt.Fprint(w, ": heartbeat\n\n"); err != nil {
				return
			}
			f.Flush()
		}
	}
}
