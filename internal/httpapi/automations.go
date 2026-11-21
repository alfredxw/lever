package httpapi

import (
	"encoding/json"
	"net/http"
	"strings"

	"lever/internal/app"
	"lever/internal/model"
)

const automationHook = "/hooks/automations/"

func (s *Server) receiveAutomationEvent(w http.ResponseWriter, r *http.Request) {
	token, ok := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
	if !ok || token == "" {
		respond(w, nil, &app.Error{Status: http.StatusUnauthorized, Message: "Send the automation event token as a bearer token"})
		return
	}
	var payload json.RawMessage
	if err := readLimit(w, r, &payload, app.MaxAutomationEventBytes); err != nil {
		respond(w, nil, err)
		return
	}
	err := s.App.AppendAutomationEvent(r.Context(), r.PathValue("id"), token, r.Header.Get("Idempotency-Key"), payload)
	respond(w, map[string]bool{"accepted": true}, err)
}

func (s *Server) automationRoutes(mux *http.ServeMux) {
	a := s.App
	mux.HandleFunc("GET /api/tasks/automations", func(w http.ResponseWriter, r *http.Request) {
		plans, err := a.Automations(r.Context())
		for i := range plans {
			s.setAutomationEventURL(&plans[i])
		}
		respond(w, plans, err)
	})
	save := func(w http.ResponseWriter, r *http.Request) {
		var input model.AutomationInput
		if err := read(w, r, &input); err != nil {
			respond(w, nil, err)
			return
		}
		plan, err := a.SaveAutomation(r.Context(), r.PathValue("id"), input)
		s.setAutomationEventURL(&plan)
		respond(w, plan, err)
	}
	mux.HandleFunc("POST /api/tasks/automations", save)
	mux.HandleFunc("PUT /api/tasks/automations/{id}", save)
	mux.HandleFunc("PATCH /api/tasks/automations/{id}", func(w http.ResponseWriter, r *http.Request) {
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
		respond(w, nil, a.SetAutomationEnabled(r.Context(), r.PathValue("id"), *input.Enabled))
	})
	mux.HandleFunc("DELETE /api/tasks/automations/{id}", func(w http.ResponseWriter, r *http.Request) {
		respond(w, nil, a.ArchiveAutomation(r.Context(), r.PathValue("id")))
	})
	mux.HandleFunc("POST /api/tasks/automations/{id}/run", func(w http.ResponseWriter, r *http.Request) {
		var input struct {
			CommandID string `json:"commandId"`
		}
		if err := read(w, r, &input); err != nil {
			respond(w, nil, err)
			return
		}
		respond(w, nil, a.RunAutomationNow(r.Context(), r.PathValue("id"), input.CommandID))
	})
	mux.HandleFunc("GET /api/tasks/automations/{id}/history", func(w http.ResponseWriter, r *http.Request) {
		history, err := a.AutomationRuns(r.Context(), r.PathValue("id"))
		respond(w, history, err)
	})
	mux.HandleFunc("PATCH /api/tasks/automation-runs/{id}", func(w http.ResponseWriter, r *http.Request) {
		var input struct {
			Done bool `json:"done"`
		}
		if err := read(w, r, &input); err != nil {
			respond(w, nil, err)
			return
		}
		respond(w, nil, a.SetAutomationRunDone(r.Context(), r.PathValue("id"), input.Done))
	})
}

func (s *Server) setAutomationEventURL(plan *model.Automation) {
	if plan.EventToken != "" {
		plan.EventURL = s.URL + automationHook + plan.ID
	}
}
