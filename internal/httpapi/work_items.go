package httpapi

import (
	"net/http"

	"lever/internal/model"
)

func (s *Server) workItemRoutes(mux *http.ServeMux) {
	a := s.App
	mux.HandleFunc("GET /api/tasks/work-items", func(w http.ResponseWriter, r *http.Request) {
		items, err := a.WorkItems(r.Context())
		respond(w, items, err)
	})
	mux.HandleFunc("POST /api/tasks/work-items", func(w http.ResponseWriter, r *http.Request) {
		var input model.UserWorkItemCreate
		if err := read(w, r, &input); err != nil {
			respond(w, nil, err)
			return
		}
		item, err := a.CreateUserWorkItem(r.Context(), input)
		respond(w, item, err)
	})
	mux.HandleFunc("GET /api/tasks/work-items/{id}", func(w http.ResponseWriter, r *http.Request) {
		item, err := a.WorkItem(r.Context(), r.PathValue("id"))
		respond(w, item, err)
	})
	mux.HandleFunc("POST /api/tasks/work-items/{id}/dispatch", func(w http.ResponseWriter, r *http.Request) {
		var input model.ExternalTaskDispatch
		if err := read(w, r, &input); err != nil {
			respond(w, nil, err)
			return
		}
		run, err := a.DispatchWorkItem(r.Context(), r.PathValue("id"), input)
		respond(w, run, err)
	})
	mux.HandleFunc("PATCH /api/tasks/work-items/{id}", func(w http.ResponseWriter, r *http.Request) {
		var input model.WorkItemUpdate
		if err := read(w, r, &input); err != nil {
			respond(w, nil, err)
			return
		}
		item, err := a.UpdateWorkItem(r.Context(), r.PathValue("id"), input)
		respond(w, item, err)
	})
}
