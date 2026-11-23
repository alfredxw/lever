package httpapi

import (
	"context"
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
			Attach         string    `json:"attach"`
			Detach         string    `json:"detach"`
		}
		if err := read(w, r, &input); err != nil {
			respond(w, nil, err)
			return
		}
		if input.DisabledSkills == nil && strings.TrimSpace(input.Attach) == "" && strings.TrimSpace(input.Detach) == "" {
			respond(w, nil, &app.Error{Status: 400, Message: "Provide disabledSkills, attach, or detach"})
			return
		}
		agent, err := a.SaveAgentSkillPreferences(r.Context(), r.PathValue("id"), input.UpdatedAt, input.DisabledSkills, input.Attach, input.Detach)
		respond(w, agent, err)
	})
	mux.HandleFunc("GET /api/skills", func(w http.ResponseWriter, r *http.Request) {
		skills, err := a.Skills(r.Context())
		respond(w, skills, err)
	})
	skillRemovalRoutes(mux, "/api/skills/{id}", a.DeleteSkill)
	mux.HandleFunc("GET /api/skill-update-settings", func(w http.ResponseWriter, r *http.Request) {
		v, err := a.SkillUpdateSettings(r.Context())
		respond(w, v, err)
	})
	mux.HandleFunc("PUT /api/skill-update-settings", func(w http.ResponseWriter, r *http.Request) {
		var input model.UpdateSettings
		if err := read(w, r, &input); err != nil {
			respond(w, nil, err)
			return
		}
		v, err := a.SaveSkillUpdateSettings(r.Context(), input)
		respond(w, v, err)
	})
	mux.HandleFunc("GET /api/skill-subscriptions", func(w http.ResponseWriter, r *http.Request) {
		v, err := a.SkillSubscriptions(r.Context())
		respond(w, v, err)
	})
	mux.HandleFunc("POST /api/skill-subscriptions", func(w http.ResponseWriter, r *http.Request) {
		var input model.SkillSubscriptionInput
		if err := read(w, r, &input); err != nil {
			respond(w, nil, err)
			return
		}
		v, err := a.CreateSkillSubscription(r.Context(), input)
		respond(w, v, err)
	})
	mux.HandleFunc("PUT /api/skill-subscriptions/{id}", func(w http.ResponseWriter, r *http.Request) {
		var input struct {
			Name         *string `json:"name"`
			UpdatePolicy *string `json:"updatePolicy"`
		}
		if err := read(w, r, &input); err != nil {
			respond(w, nil, err)
			return
		}
		v, err := a.UpdateSkillSubscription(r.Context(), r.PathValue("id"), input.Name, input.UpdatePolicy)
		respond(w, v, err)
	})
	skillRemovalRoutes(mux, "/api/skill-subscriptions/{id}", a.DeleteSkillSubscription)
	mux.HandleFunc("POST /api/skill-subscriptions/{id}/check", func(w http.ResponseWriter, r *http.Request) {
		v, err := a.CheckSkillSubscription(r.Context(), r.PathValue("id"))
		respond(w, v, err)
	})
	mux.HandleFunc("POST /api/skill-subscriptions/{id}/sync", func(w http.ResponseWriter, r *http.Request) {
		v, err := a.SyncSkillSubscription(r.Context(), r.PathValue("id"))
		respond(w, v, err)
	})
	mux.HandleFunc("POST /api/skills/{id}/resolve-update", func(w http.ResponseWriter, r *http.Request) {
		var input struct {
			Strategy string `json:"strategy"`
		}
		if err := read(w, r, &input); err != nil {
			respond(w, nil, err)
			return
		}
		v, err := a.ResolveSkillUpdate(r.Context(), r.PathValue("id"), input.Strategy)
		respond(w, v, err)
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
			Name        string `json:"name"`
			Directory   string `json:"directory"`
			Description string `json:"description"`
			Template    string `json:"template"`
		}
		if err := read(w, r, &input); err != nil {
			respond(w, nil, err)
			return
		}
		hasName := strings.TrimSpace(input.Name) != ""
		hasDirectory := strings.TrimSpace(input.Directory) != ""
		switch {
		case hasName && !hasDirectory:
			skill, err := a.CreateSkillWithOptions(input.Name, input.Description, input.Template)
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

func skillRemovalRoutes(mux *http.ServeMux, path string, remove func(context.Context, string, bool) (model.SkillRemovalResult, error)) {
	mux.HandleFunc("DELETE "+path, func(w http.ResponseWriter, r *http.Request) {
		result, err := remove(r.Context(), r.PathValue("id"), r.URL.Query().Get("deleteFiles") == "true")
		respond(w, result, err)
	})
	mux.HandleFunc("POST "+path+"/remove", func(w http.ResponseWriter, r *http.Request) {
		var input struct {
			DeleteFiles bool `json:"deleteFiles"`
		}
		if err := read(w, r, &input); err != nil {
			respond(w, nil, err)
			return
		}
		result, err := remove(r.Context(), r.PathValue("id"), input.DeleteFiles)
		respond(w, result, err)
	})
}

func skillReferenceScope(r *http.Request) app.SkillReferenceScope {
	q := r.URL.Query()
	return app.SkillReferenceScope{AgentID: q.Get("agentId"), SessionID: q.Get("sessionId"), WorkingCopyID: q.Get("workingCopyId")}
}
