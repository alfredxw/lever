package httpapi

import (
	"net/http"
	"strings"

	"lever/internal/app"
	"lever/internal/model"
)

func skillRoutes(mux *http.ServeMux, a *app.App) {
	mux.HandleFunc("PATCH /api/agents/{id}/skills", func(w http.ResponseWriter, r *http.Request) {
		var input struct {
			UpdatedAt      string    `json:"updatedAt"`
			DisabledSkills *[]string `json:"disabledSkills"`
		}
		if err := read(w, r, &input); err != nil {
			respond(w, nil, err)
			return
		}
		if input.DisabledSkills == nil {
			respond(w, nil, &app.Error{Status: 400, Message: "Provide a list of disabled skill names"})
			return
		}
		agent, err := a.SaveAgentDisabledSkills(r.Context(), r.PathValue("id"), input.UpdatedAt, *input.DisabledSkills)
		respond(w, agent, err)
	})
	mux.HandleFunc("GET /api/skills", func(w http.ResponseWriter, r *http.Request) {
		skills, err := a.Skills(r.Context())
		respond(w, skills, err)
	})
	mux.HandleFunc("GET /api/skills/reference", func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		skill, err := a.ResolveSkillReference(r.Context(), skillReferenceScope(r), model.Reference{
			Name: q.Get("name"), Path: q.Get("path"), Provider: q.Get("provider"),
		})
		respond(w, skill, err)
	})
	mux.HandleFunc("POST /api/skills/scope", func(w http.ResponseWriter, r *http.Request) {
		var input struct {
			Scope    model.Scope `json:"scope"`
			Provider string      `json:"provider"`
		}
		if err := read(w, r, &input); err != nil {
			respond(w, nil, err)
			return
		}
		sources, err := a.SkillSources(r.Context(), input.Scope, input.Provider)
		respond(w, sources, err)
	})
	mux.HandleFunc("POST /api/skills", func(w http.ResponseWriter, r *http.Request) {
		var input struct {
			Name      string `json:"name"`
			Directory string `json:"directory"`
		}
		if err := read(w, r, &input); err != nil {
			respond(w, nil, err)
			return
		}
		hasName := strings.TrimSpace(input.Name) != ""
		hasDirectory := strings.TrimSpace(input.Directory) != ""
		switch {
		case hasName && !hasDirectory:
			skill, err := a.CreateSkill(input.Name)
			respond(w, skill, err)
		case hasDirectory && !hasName:
			skill, err := a.AddSkillDirectory(r.Context(), input.Directory)
			respond(w, skill, err)
		default:
			respond(w, nil, &app.Error{Status: 400, Message: "Enter a skill name or choose an existing directory"})
		}
	})
	fileRoutes(mux, "/api/skills/{id}", func(r *http.Request, write bool) (model.Scope, func(), error) {
		dirs, err := a.SkillScope(r.Context(), r.PathValue("id"), write, skillReferenceScope(r))
		return dirs, func() {}, err
	}, model.SkillEntry)
}

func skillReferenceScope(r *http.Request) app.SkillReferenceScope {
	q := r.URL.Query()
	return app.SkillReferenceScope{AgentID: q.Get("agentId"), SessionID: q.Get("sessionId"), WorkingCopyID: q.Get("workingCopyId")}
}
