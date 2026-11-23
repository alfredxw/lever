package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"slices"
	"strconv"
	"strings"
	"time"

	"lever/internal/app"
	"lever/internal/localipc"
	"lever/internal/model"
	"lever/internal/store"
)

type cliRunView struct {
	model.Run
	PendingRequests []model.Request `json:"pendingRequests,omitempty"`
}

func requireLocalOperator(w http.ResponseWriter, r *http.Request, message string) bool {
	if r.Header.Get("Authorization") != "" {
		respond(w, nil, &app.Error{Status: http.StatusForbidden, Message: message})
		return false
	}
	return true
}

func isCLIWaitDone(view cliRunView) bool {
	switch view.Status {
	case "completed", "failed", "interrupted", "paused", "cancelled", "unknown":
		return true
	case "waiting_user":
		return len(view.PendingRequests) > 0
	}
	return false
}

func (s *Server) cliRunView(ctx context.Context, id string) (cliRunView, error) {
	run, err := store.Get[model.Run](ctx, s.App.Store.DB, `SELECT `+store.RunWithWaitingOn+` FROM runs r
LEFT JOIN channel_deliveries d ON d.run_id=r.id AND d.part='answer' WHERE r.id=?`, id)
	if err != nil {
		return cliRunView{}, err
	}
	pending, err := store.List[model.Request](ctx, s.App.Store.DB, `SELECT data FROM requests WHERE run_id=? AND status='pending' ORDER BY rowid`, id)
	if err != nil {
		return cliRunView{}, err
	}
	return cliRunView{Run: run, PendingRequests: pending}, nil
}

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
		if r.URL.Query().Get("full") == "true" {
			if !requireLocalOperator(w, r, "Agent management requires a local operator") {
				return
			}
			where := " WHERE json_extract(data,'$.archived') IS NOT 1"
			if r.URL.Query().Get("archived") == "true" {
				where = ""
			}
			items, err := store.List[model.Agent](r.Context(), a.Store.DB, `SELECT data FROM agents`+where+` ORDER BY json_extract(data,'$.name') COLLATE NOCASE,id`)
			respond(w, items, err)
			return
		}
		type agent struct {
			ID   string `json:"id"`
			Name string `json:"name"`
		}
		items, err := store.List[agent](r.Context(), a.Store.DB, `SELECT json_object('id',id,'name',json_extract(data,'$.name'))
FROM agents WHERE json_extract(data,'$.archived') IS NOT 1 ORDER BY json_extract(data,'$.name') COLLATE NOCASE,id`)
		respond(w, items, err)
	})
	mux.HandleFunc("GET /agents/{id}", func(w http.ResponseWriter, r *http.Request) {
		if !requireLocalOperator(w, r, "Agent management requires a local operator") {
			return
		}
		agent, err := store.Get[model.Agent](r.Context(), a.Store.DB, "SELECT data FROM agents WHERE id=?", r.PathValue("id"))
		respond(w, agent, err)
	})
	mux.HandleFunc("POST /agents", func(w http.ResponseWriter, r *http.Request) {
		if !requireLocalOperator(w, r, "Agent management requires a local operator") {
			return
		}
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
	mux.HandleFunc("PUT /agents/{id}", func(w http.ResponseWriter, r *http.Request) {
		if !requireLocalOperator(w, r, "Agent management requires a local operator") {
			return
		}
		var v model.Agent
		if err := read(w, r, &v); err != nil {
			respond(w, nil, err)
			return
		}
		v.ID = r.PathValue("id")
		v, err := a.SaveAgent(r.Context(), v)
		respond(w, v, err)
	})
	mux.HandleFunc("GET /providers", func(w http.ResponseWriter, r *http.Request) {
		if !requireLocalOperator(w, r, "Provider queries require a local operator") {
			return
		}
		items, err := a.Providers(r.Context(), r.URL.Query().Get("login") == "true")
		respond(w, items, err)
	})
	mux.HandleFunc("GET /providers/{id}/models", func(w http.ResponseWriter, r *http.Request) {
		if !requireLocalOperator(w, r, "Provider queries require a local operator") {
			return
		}
		catalog, err := a.Catalog(r.Context(), r.PathValue("id"), r.URL.Query().Get("cwd"), r.URL.Query().Get("refresh") == "true")
		respond(w, catalog, err)
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
	mux.HandleFunc("GET /work-items", func(w http.ResponseWriter, r *http.Request) {
		if !requireLocalOperator(w, r, "Work item commands require a local operator") {
			return
		}
		items, err := a.WorkItems(r.Context())
		if err != nil {
			respond(w, nil, err)
			return
		}
		agentID := strings.TrimSpace(r.URL.Query().Get("agent"))
		doneRaw := strings.TrimSpace(r.URL.Query().Get("done"))
		var filterDone *bool
		if doneRaw != "" {
			v, err := strconv.ParseBool(doneRaw)
			if err != nil {
				respond(w, nil, &app.Error{Status: http.StatusBadRequest, Message: "done must be true or false"})
				return
			}
			filterDone = &v
		}
		if agentID != "" || filterDone != nil {
			filtered := make([]model.WorkItem, 0, len(items))
			for _, item := range items {
				if agentID != "" && item.AssigneeAgentID != agentID && item.CreatedByAgentID != agentID {
					continue
				}
				if filterDone != nil && item.Done != *filterDone {
					continue
				}
				filtered = append(filtered, item)
			}
			items = filtered
		}
		respond(w, items, nil)
	})
	mux.HandleFunc("GET /work-items/{id}", func(w http.ResponseWriter, r *http.Request) {
		if !requireLocalOperator(w, r, "Work item commands require a local operator") {
			return
		}
		item, err := a.WorkItem(r.Context(), r.PathValue("id"))
		respond(w, item, err)
	})
	mux.HandleFunc("PATCH /work-items/{id}", func(w http.ResponseWriter, r *http.Request) {
		if !requireLocalOperator(w, r, "Work item commands require a local operator") {
			return
		}
		var input model.WorkItemUpdate
		if err := read(w, r, &input); err != nil {
			respond(w, nil, err)
			return
		}
		item, err := a.UpdateWorkItem(r.Context(), r.PathValue("id"), input)
		respond(w, item, err)
	})
	mux.HandleFunc("POST /work-items/{id}/dispatch", func(w http.ResponseWriter, r *http.Request) {
		if !requireLocalOperator(w, r, "Work item commands require a local operator") {
			return
		}
		var input model.ExternalTaskDispatch
		if err := read(w, r, &input); err != nil {
			respond(w, nil, err)
			return
		}
		run, err := a.DispatchWorkItem(r.Context(), r.PathValue("id"), input)
		respond(w, run, err)
	})
	mux.HandleFunc("GET /notes", func(w http.ResponseWriter, r *http.Request) {
		if !requireLocalOperator(w, r, "Notes commands require a local operator") {
			return
		}
		notes, err := a.TaskNotes(r.Context())
		respond(w, notes, err)
	})
	mux.HandleFunc("GET /notes/{id}", func(w http.ResponseWriter, r *http.Request) {
		if !requireLocalOperator(w, r, "Notes commands require a local operator") {
			return
		}
		note, err := a.TaskNote(r.Context(), r.PathValue("id"))
		respond(w, note, err)
	})
	mux.HandleFunc("POST /notes", func(w http.ResponseWriter, r *http.Request) {
		if !requireLocalOperator(w, r, "Notes commands require a local operator") {
			return
		}
		var input model.TaskNote
		if err := read(w, r, &input); err != nil {
			respond(w, nil, err)
			return
		}
		note, err := a.CreateTaskNote(r.Context(), input)
		respond(w, note, err)
	})
	mux.HandleFunc("GET /automations", func(w http.ResponseWriter, r *http.Request) {
		if !requireLocalOperator(w, r, "Automation commands are not available inside an active Lever execution") {
			return
		}
		if r.URL.Query().Get("full") == "true" {
			plans, err := a.Automations(r.Context())
			for i := range plans {
				s.setAutomationEventURL(&plans[i])
			}
			respond(w, plans, err)
			return
		}
		type automation struct {
			ID            string `json:"id"`
			Name          string `json:"name"`
			Trigger       string `json:"trigger"`
			Enabled       bool   `json:"enabled"`
			AcceptsEvents bool   `json:"acceptsEvents"`
		}
		items, err := store.List[automation](r.Context(), a.Store.DB, `SELECT json_object(
'id',id,
'name',COALESCE(json_extract(data,'$.name'),''),
'trigger',COALESCE(json_extract(data,'$.trigger.kind'),''),
'enabled',json(CASE state WHEN 'active' THEN 'true' ELSE 'false' END),
'acceptsEvents',json(CASE WHEN event_token<>'' THEN 'true' ELSE 'false' END)
) FROM automations WHERE state<>'archived' ORDER BY rowid DESC`)
		respond(w, items, err)
	})
	mux.HandleFunc("GET /automations/{id}", func(w http.ResponseWriter, r *http.Request) {
		if !requireLocalOperator(w, r, "Automation commands are not available inside an active Lever execution") {
			return
		}
		plan, err := a.Automation(r.Context(), r.PathValue("id"))
		if err == nil {
			s.setAutomationEventURL(&plan)
		}
		respond(w, plan, err)
	})
	saveAutomation := func(w http.ResponseWriter, r *http.Request) {
		if !requireLocalOperator(w, r, "Automation commands are not available inside an active Lever execution") {
			return
		}
		var input model.AutomationInput
		if err := read(w, r, &input); err != nil {
			respond(w, nil, err)
			return
		}
		plan, err := a.SaveAutomation(r.Context(), r.PathValue("id"), input)
		if err == nil {
			s.setAutomationEventURL(&plan)
		}
		respond(w, plan, err)
	}
	mux.HandleFunc("POST /automations", saveAutomation)
	mux.HandleFunc("PUT /automations/{id}", saveAutomation)
	mux.HandleFunc("PATCH /automations/{id}", func(w http.ResponseWriter, r *http.Request) {
		if !requireLocalOperator(w, r, "Automation commands are not available inside an active Lever execution") {
			return
		}
		var input struct {
			Enabled *bool `json:"enabled"`
		}
		if err := read(w, r, &input); err != nil {
			respond(w, nil, err)
			return
		}
		if input.Enabled == nil {
			respond(w, nil, &app.Error{Status: 400, Message: "Choose whether the automation is enabled"})
			return
		}
		err := a.SetAutomationEnabled(r.Context(), r.PathValue("id"), *input.Enabled)
		respond(w, map[string]bool{"enabled": *input.Enabled}, err)
	})
	mux.HandleFunc("DELETE /automations/{id}", func(w http.ResponseWriter, r *http.Request) {
		if !requireLocalOperator(w, r, "Automation commands are not available inside an active Lever execution") {
			return
		}
		err := a.ArchiveAutomation(r.Context(), r.PathValue("id"))
		respond(w, map[string]bool{"archived": true}, err)
	})
	mux.HandleFunc("POST /automations/{id}/run", func(w http.ResponseWriter, r *http.Request) {
		if !requireLocalOperator(w, r, "Automation commands are not available inside an active Lever execution") {
			return
		}
		var input struct {
			CommandID string `json:"commandId"`
			TargetID  string `json:"targetId"`
		}
		if err := read(w, r, &input); err != nil {
			respond(w, nil, err)
			return
		}
		err := a.RunAutomationNow(r.Context(), r.PathValue("id"), input.CommandID, input.TargetID)
		respond(w, map[string]bool{"started": true}, err)
	})
	mux.HandleFunc("GET /automations/{id}/history", func(w http.ResponseWriter, r *http.Request) {
		if !requireLocalOperator(w, r, "Automation commands are not available inside an active Lever execution") {
			return
		}
		history, err := a.AutomationRuns(r.Context(), r.PathValue("id"))
		respond(w, history, err)
	})
	mux.HandleFunc("GET /automation-runs", func(w http.ResponseWriter, r *http.Request) {
		if !requireLocalOperator(w, r, "Automation commands are not available inside an active Lever execution") {
			return
		}
		limit := 50
		if raw := strings.TrimSpace(r.URL.Query().Get("limit")); raw != "" {
			n, err := strconv.Atoi(raw)
			if err != nil || n < 1 || n > 300 {
				respond(w, nil, &app.Error{Status: http.StatusBadRequest, Message: "limit must be between 1 and 300"})
				return
			}
			limit = n
		}
		runs, err := a.AllAutomationRuns(r.Context(), limit)
		respond(w, runs, err)
	})
	mux.HandleFunc("POST /automations/{id}/events", func(w http.ResponseWriter, r *http.Request) {
		if !requireLocalOperator(w, r, "Automation commands are not available inside an active Lever execution") {
			return
		}
		var payload json.RawMessage
		if err := readLimit(w, r, &payload, app.MaxAutomationEventBytes); err != nil {
			respond(w, nil, err)
			return
		}
		err := a.AppendLocalAutomationEvent(r.Context(), r.PathValue("id"), r.Header.Get("Idempotency-Key"), payload)
		respond(w, map[string]bool{"accepted": true}, err)
	})
	mux.HandleFunc("GET /chats", func(w http.ResponseWriter, r *http.Request) {
		if !requireLocalOperator(w, r, "Chat listing is not available with an execution capability; use lever context find") {
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
	mux.HandleFunc("POST /chats", func(w http.ResponseWriter, r *http.Request) {
		if !requireLocalOperator(w, r, "Chat management requires a local operator") {
			return
		}
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
	mux.HandleFunc("POST /messages", func(w http.ResponseWriter, r *http.Request) {
		if !requireLocalOperator(w, r, "Sending messages via CLI requires a local operator") {
			return
		}
		var in model.SendInput
		if err := read(w, r, &in); err != nil {
			respond(w, nil, err)
			return
		}
		v, err := a.Send(r.Context(), in)
		respond(w, v, err)
	})
	mux.HandleFunc("GET /runs/{id}", func(w http.ResponseWriter, r *http.Request) {
		if !requireLocalOperator(w, r, "Run commands require a local operator") {
			return
		}
		view, err := s.cliRunView(r.Context(), r.PathValue("id"))
		respond(w, view, err)
	})
	mux.HandleFunc("GET /runs/{id}/wait", func(w http.ResponseWriter, r *http.Request) {
		if !requireLocalOperator(w, r, "Run commands require a local operator") {
			return
		}
		_ = http.NewResponseController(w).SetReadDeadline(time.Time{})
		runID := r.PathValue("id")
		var timeoutCh <-chan time.Time
		if raw := strings.TrimSpace(r.URL.Query().Get("timeout")); raw != "" {
			dur, err := time.ParseDuration(raw)
			if err != nil || dur < 0 {
				respond(w, nil, &app.Error{Status: http.StatusBadRequest, Message: "Invalid timeout duration"})
				return
			}
			if dur > 0 {
				timer := time.NewTimer(dur)
				defer timer.Stop()
				timeoutCh = timer.C
			}
		}
		ch, unsubscribe := a.Store.Subscribe()
		defer unsubscribe()
		for {
			view, err := s.cliRunView(r.Context(), runID)
			if err != nil {
				respond(w, nil, err)
				return
			}
			if isCLIWaitDone(view) {
				respond(w, view, nil)
				return
			}
			select {
			case <-ch:
			case <-timeoutCh:
				respond(w, nil, &app.Error{Status: http.StatusRequestTimeout, Message: "Timed out waiting for run " + runID})
				return
			case <-r.Context().Done():
				return
			}
		}
	})
	mux.HandleFunc("POST /runs/{id}/stop", func(w http.ResponseWriter, r *http.Request) {
		if !requireLocalOperator(w, r, "Run commands require a local operator") {
			return
		}
		respond(w, map[string]bool{"accepted": true}, a.Stop(r.Context(), r.PathValue("id")))
	})
	mux.HandleFunc("POST /runs/{id}/pause", func(w http.ResponseWriter, r *http.Request) {
		if !requireLocalOperator(w, r, "Run commands require a local operator") {
			return
		}
		respond(w, map[string]bool{"accepted": true}, a.Pause(r.Context(), r.PathValue("id")))
	})
	mux.HandleFunc("POST /runs/{id}/resume", func(w http.ResponseWriter, r *http.Request) {
		if !requireLocalOperator(w, r, "Run commands require a local operator") {
			return
		}
		var in struct {
			NativeTurnID string `json:"nativeTurnId"`
		}
		if err := read(w, r, &in); err != nil {
			respond(w, nil, err)
			return
		}
		respond(w, map[string]bool{"accepted": true}, a.Resume(r.Context(), r.PathValue("id"), in.NativeTurnID))
	})
	mux.HandleFunc("POST /requests/{id}/answer", func(w http.ResponseWriter, r *http.Request) {
		if !requireLocalOperator(w, r, "Request approval commands require a local operator") {
			return
		}
		var v model.Answer
		if err := read(w, r, &v); err != nil {
			respond(w, nil, err)
			return
		}
		respond(w, map[string]bool{"accepted": true}, a.Answer(r.Context(), r.PathValue("id"), v))
	})
	mux.HandleFunc("GET /events", func(w http.ResponseWriter, r *http.Request) {
		if !requireLocalOperator(w, r, "Event streaming requires a local operator") {
			return
		}
		_ = http.NewResponseController(w).SetReadDeadline(time.Time{})
		flusher, ok := w.(http.Flusher)
		if !ok {
			respond(w, nil, &app.Error{Status: http.StatusInternalServerError, Message: "Streaming unavailable"})
			return
		}
		q := r.URL.Query()
		var cursor int64
		if raw := strings.TrimSpace(q.Get("after")); raw != "" {
			v, err := strconv.ParseInt(raw, 10, 64)
			if err != nil || v < 0 {
				respond(w, nil, &app.Error{Status: http.StatusBadRequest, Message: "after must be a non-negative integer"})
				return
			}
			cursor = v
		} else {
			if err := a.Store.DB.QueryRowContext(r.Context(), "SELECT COALESCE(MAX(sequence),0) FROM events").Scan(&cursor); err != nil {
				respond(w, nil, err)
				return
			}
		}
		var limit int
		if raw := strings.TrimSpace(q.Get("limit")); raw != "" {
			v, err := strconv.Atoi(raw)
			if err != nil || v < 1 {
				respond(w, nil, &app.Error{Status: http.StatusBadRequest, Message: "limit must be a positive integer"})
				return
			}
			limit = v
		}
		var timeoutCh <-chan time.Time
		if raw := strings.TrimSpace(q.Get("timeout")); raw != "" {
			dur, err := time.ParseDuration(raw)
			if err != nil || dur < 0 {
				respond(w, nil, &app.Error{Status: http.StatusBadRequest, Message: "Invalid timeout duration"})
				return
			}
			if dur > 0 {
				timer := time.NewTimer(dur)
				defer timer.Stop()
				timeoutCh = timer.C
			}
		}
		var types []string
		if raw := strings.TrimSpace(q.Get("type")); raw != "" {
			for _, part := range strings.Split(raw, ",") {
				if part = strings.TrimSpace(part); part != "" {
					types = append(types, part)
				}
			}
		}
		chatFilter := strings.TrimSpace(q.Get("chat"))
		ch, unsubscribe := a.Store.Subscribe()
		defer unsubscribe()
		w.Header().Set("Content-Type", "application/x-ndjson; charset=utf-8")
		w.Header().Set("Cache-Control", "no-store")
		w.WriteHeader(http.StatusOK)
		flusher.Flush()
		sent := 0
		for {
			events, err := a.Store.Events(r.Context(), cursor)
			if err != nil {
				return
			}
			for _, event := range events {
				cursor = event.Sequence
				if len(types) > 0 && !slices.Contains(types, event.Type) {
					continue
				}
				if chatFilter != "" && event.ChatID != chatFilter {
					continue
				}
				if _, err := fmt.Fprintln(w, store.JSON(event)); err != nil {
					return
				}
				flusher.Flush()
				sent++
				if limit > 0 && sent >= limit {
					return
				}
			}
			if len(events) == 100 {
				continue
			}
			select {
			case <-ch:
			case <-timeoutCh:
				return
			case <-r.Context().Done():
				return
			}
		}
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
