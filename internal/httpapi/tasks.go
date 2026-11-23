package httpapi

import (
	"errors"
	"io"
	"mime"
	"net/http"
	"strings"
	"time"

	"lever/internal/app"
	"lever/internal/model"
)

func (s *Server) taskRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/tasks/notes/references", func(w http.ResponseWriter, r *http.Request) {
		refs, err := s.App.NoteReferences(r.Context())
		respond(w, refs, err)
	})
	mux.HandleFunc("GET /api/tasks/board/references", func(w http.ResponseWriter, r *http.Request) {
		refs, err := s.App.BoardReferences(r.Context())
		respond(w, refs, err)
	})
	mux.HandleFunc("GET /api/tasks/views", func(w http.ResponseWriter, r *http.Request) {
		views, err := s.App.TaskViews(r.Context())
		respond(w, views, err)
	})
	mux.HandleFunc("PUT /api/tasks/views/{id}", func(w http.ResponseWriter, r *http.Request) {
		var input model.TaskView
		if err := read(w, r, &input); err != nil {
			respond(w, nil, err)
			return
		}
		view, err := s.App.SaveTaskView(r.Context(), r.PathValue("id"), input)
		respond(w, view, err)
	})
	mux.HandleFunc("DELETE /api/tasks/views/{id}", func(w http.ResponseWriter, r *http.Request) {
		var input struct {
			Revision int64 `json:"revision"`
		}
		if err := read(w, r, &input); err != nil {
			respond(w, nil, err)
			return
		}
		respond(w, nil, s.App.DeleteTaskView(r.Context(), r.PathValue("id"), input.Revision))
	})
	mux.HandleFunc("GET /api/tasks/notes", func(w http.ResponseWriter, r *http.Request) {
		notes, err := s.App.TaskNotes(r.Context())
		respond(w, notes, err)
	})
	mux.HandleFunc("GET /api/tasks/notes-directory", func(w http.ResponseWriter, r *http.Request) {
		respond(w, s.App.TaskNotesDirectory(), nil)
	})
	mux.HandleFunc("PUT /api/tasks/notes-directory", func(w http.ResponseWriter, r *http.Request) {
		var input model.TaskNotesDirectoryUpdate
		if err := read(w, r, &input); err != nil {
			respond(w, nil, err)
			return
		}
		dir, err := s.App.SetTaskNotesDirectory(r.Context(), input)
		respond(w, dir, err)
	})
	mux.HandleFunc("POST /api/tasks/notes", func(w http.ResponseWriter, r *http.Request) {
		var input model.TaskNote
		if err := read(w, r, &input); err != nil {
			respond(w, nil, err)
			return
		}
		note, err := s.App.CreateTaskNote(r.Context(), input)
		respond(w, note, err)
	})
	mux.HandleFunc("GET /api/tasks/notes/{id}", func(w http.ResponseWriter, r *http.Request) {
		note, err := s.App.TaskNote(r.Context(), r.PathValue("id"))
		respond(w, note, err)
	})
	mux.HandleFunc("GET /api/tasks/notes/{id}/handover", func(w http.ResponseWriter, r *http.Request) {
		settings, err := s.App.NoteHandover(r.Context(), r.PathValue("id"))
		respond(w, settings, err)
	})
	mux.HandleFunc("PUT /api/tasks/notes/{id}/handover", func(w http.ResponseWriter, r *http.Request) {
		var input model.NoteHandover
		if err := read(w, r, &input); err != nil {
			respond(w, nil, err)
			return
		}
		settings, err := s.App.SaveNoteHandover(r.Context(), r.PathValue("id"), input)
		respond(w, settings, err)
	})
	mux.HandleFunc("PUT /api/tasks/notes/{id}", func(w http.ResponseWriter, r *http.Request) {
		var input model.TaskNote
		if err := readLimit(w, r, &input, 2<<20); err != nil {
			respond(w, nil, err)
			return
		}
		note, err := s.App.SaveTaskNote(r.Context(), r.PathValue("id"), input)
		respond(w, note, err)
	})
	mux.HandleFunc("PATCH /api/tasks/notes/{id}", func(w http.ResponseWriter, r *http.Request) {
		var input struct {
			State     model.TaskNoteState `json:"state"`
			Directory string              `json:"directory"`
		}
		if err := read(w, r, &input); err != nil {
			respond(w, nil, err)
			return
		}
		note, err := s.App.SetTaskNoteState(r.Context(), r.PathValue("id"), input.State, input.Directory)
		respond(w, note, err)
	})
	mux.HandleFunc("POST /api/tasks/notes/{id}/assets", func(w http.ResponseWriter, r *http.Request) {
		r.Body = http.MaxBytesReader(w, r.Body, app.MaxNoteAssetBytes+(64<<10))
		reader, err := r.MultipartReader()
		if err != nil {
			respond(w, nil, &app.Error{Status: 400, Message: "Expected a file upload"})
			return
		}
		part, err := reader.NextPart()
		if err != nil || part.FormName() != "file" || part.FileName() == "" {
			respond(w, nil, &app.Error{Status: 400, Message: "Expected one attachment"})
			return
		}
		data, err := io.ReadAll(io.LimitReader(part, app.MaxNoteAssetBytes+1))
		if err != nil || len(data) > app.MaxNoteAssetBytes {
			respond(w, nil, &app.Error{Status: 400, Message: "Attachments are limited to 20 MiB"})
			return
		}
		if _, err := reader.NextPart(); !errors.Is(err, io.EOF) {
			respond(w, nil, &app.Error{Status: 400, Message: "Upload one attachment at a time"})
			return
		}
		asset, err := s.App.SaveNoteAsset(r.Context(), r.PathValue("id"), part.FileName(), data)
		respond(w, asset, err)
	})
	mux.HandleFunc("GET /api/tasks/note-assets/{asset}", func(w http.ResponseWriter, r *http.Request) {
		file, imageType, err := s.App.OpenNoteAsset(r.PathValue("asset"))
		if err != nil {
			respond(w, nil, err)
			return
		}
		defer file.Close()
		name := strings.TrimSpace(r.URL.Query().Get("name"))
		if name == "" {
			name = r.PathValue("asset")
		}
		disposition := "attachment"
		if imageType == "" {
			imageType = "application/octet-stream"
		} else {
			disposition = "inline"
		}
		w.Header().Set("Content-Type", imageType)
		w.Header().Set("Content-Disposition", mime.FormatMediaType(disposition, map[string]string{"filename": name}))
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Content-Security-Policy", "sandbox; default-src 'none'")
		http.ServeContent(w, r, "", time.Time{}, file)
	})
	mux.HandleFunc("GET /api/tasks/executions", func(w http.ResponseWriter, r *http.Request) {
		tasks, err := s.App.TaskExecutions(r.Context())
		respond(w, tasks, err)
	})
	mux.HandleFunc("GET /api/tasks/workflows", func(w http.ResponseWriter, r *http.Request) {
		tasks, err := s.App.TaskWorkflows(r.Context())
		respond(w, tasks, err)
	})
	mux.HandleFunc("PATCH /api/tasks/workflows/{id}", func(w http.ResponseWriter, r *http.Request) {
		var input model.TaskWorkflowUpdate
		if err := read(w, r, &input); err != nil {
			respond(w, nil, err)
			return
		}
		respond(w, nil, s.App.UpdateTaskWorkflow(r.Context(), r.PathValue("id"), input))
	})
	mux.HandleFunc("POST /api/tasks/queue", func(w http.ResponseWriter, r *http.Request) {
		var input model.TaskQueueInput
		if err := readLimit(w, r, &input, 2<<20); err != nil {
			respond(w, nil, err)
			return
		}
		respond(w, nil, s.App.EnqueueTask(r.Context(), input))
	})
	mux.HandleFunc("PUT /api/tasks/queue/order", func(w http.ResponseWriter, r *http.Request) {
		var input struct {
			AgentID string   `json:"agentId"`
			IDs     []string `json:"ids"`
		}
		if err := read(w, r, &input); err != nil {
			respond(w, nil, err)
			return
		}
		respond(w, nil, s.App.ReorderTaskQueue(r.Context(), input.AgentID, input.IDs))
	})
	mux.HandleFunc("PATCH /api/agents/{id}/task-queue", func(w http.ResponseWriter, r *http.Request) {
		var input model.AgentTaskQueueSettings
		if err := read(w, r, &input); err != nil {
			respond(w, nil, err)
			return
		}
		agent, err := s.App.UpdateAgentTaskQueue(r.Context(), r.PathValue("id"), input)
		respond(w, agent, err)
	})
	mux.HandleFunc("GET /api/tasks/locate/{id}", func(w http.ResponseWriter, r *http.Request) {
		note, err := s.App.LocateTask(r.Context(), r.PathValue("id"))
		respond(w, note, err)
	})
	mux.HandleFunc("POST /api/tasks/dispatch", func(w http.ResponseWriter, r *http.Request) {
		var input model.TaskDispatch
		if err := read(w, r, &input); err != nil {
			respond(w, nil, err)
			return
		}
		run, err := s.App.DispatchTask(r.Context(), input)
		respond(w, run, err)
	})
	mux.HandleFunc("GET /api/tasks/sources", func(w http.ResponseWriter, r *http.Request) {
		sources, err := s.App.TaskSources(r.Context())
		respond(w, sources, err)
	})
	mux.HandleFunc("POST /api/tasks/sources", func(w http.ResponseWriter, r *http.Request) {
		var input model.TaskSourceCreate
		if err := read(w, r, &input); err != nil {
			respond(w, nil, err)
			return
		}
		source, err := s.App.AddTaskSource(r.Context(), input)
		respond(w, source, err)
	})
	mux.HandleFunc("GET /api/tasks/sources/lark-preview", func(w http.ResponseWriter, r *http.Request) {
		preview, err := s.App.LarkTaskPreview(r.Context(), r.URL.Query().Get("sourceId"))
		respond(w, preview, err)
	})
	mux.HandleFunc("PUT /api/tasks/sources/{id}", func(w http.ResponseWriter, r *http.Request) {
		var input model.TaskSourceUpdate
		if err := read(w, r, &input); err != nil {
			respond(w, nil, err)
			return
		}
		respond(w, nil, s.App.UpdateTaskSource(r.Context(), r.PathValue("id"), input))
	})
	mux.HandleFunc("POST /api/tasks/sources/{id}/sync", func(w http.ResponseWriter, r *http.Request) {
		respond(w, nil, s.App.RequestTaskSync(r.Context(), r.PathValue("id")))
	})
	mux.HandleFunc("DELETE /api/tasks/sources/{id}", func(w http.ResponseWriter, r *http.Request) {
		respond(w, nil, s.App.RemoveTaskSource(r.Context(), r.PathValue("id")))
	})
	mux.HandleFunc("GET /api/tasks/external", func(w http.ResponseWriter, r *http.Request) {
		tasks, err := s.App.ExternalTasks(r.Context())
		respond(w, tasks, err)
	})
	mux.HandleFunc("GET /api/tasks/external/{id}", func(w http.ResponseWriter, r *http.Request) {
		task, err := s.App.ExternalTask(r.Context(), r.PathValue("id"))
		respond(w, task, err)
	})
	mux.HandleFunc("POST /api/tasks/external/{id}/dispatch", func(w http.ResponseWriter, r *http.Request) {
		var input model.ExternalTaskDispatch
		if err := read(w, r, &input); err != nil {
			respond(w, nil, err)
			return
		}
		run, err := s.App.DispatchExternalTask(r.Context(), r.PathValue("id"), input)
		respond(w, run, err)
	})
	mux.HandleFunc("PUT /api/tasks/external/{id}", func(w http.ResponseWriter, r *http.Request) {
		var input struct {
			Done bool `json:"done"`
		}
		if err := read(w, r, &input); err != nil {
			respond(w, nil, err)
			return
		}
		respond(w, nil, s.App.SetExternalTaskDone(r.Context(), r.PathValue("id"), input.Done))
	})
	mux.HandleFunc("GET /api/tasks/deadlines", func(w http.ResponseWriter, r *http.Request) {
		deadlines, err := s.App.TaskDeadlines(r.Context())
		respond(w, deadlines, err)
	})
	mux.HandleFunc("PUT /api/tasks/deadlines/{id}", func(w http.ResponseWriter, r *http.Request) {
		var input model.TaskDeadlineInput
		if err := read(w, r, &input); err != nil {
			respond(w, nil, err)
			return
		}
		saved, err := s.App.SetTaskDeadline(r.Context(), r.PathValue("id"), input)
		respond(w, saved, err)
	})
	mux.HandleFunc("DELETE /api/tasks/deadlines/{id}", func(w http.ResponseWriter, r *http.Request) {
		respond(w, nil, s.App.ClearTaskDeadline(r.Context(), r.PathValue("id")))
	})
	mux.HandleFunc("POST /api/tasks/deadlines/{id}/snooze", func(w http.ResponseWriter, r *http.Request) {
		var input struct {
			Minutes int `json:"minutes"`
		}
		if err := read(w, r, &input); err != nil {
			respond(w, nil, err)
			return
		}
		saved, err := s.App.SnoozeTaskDeadline(r.Context(), r.PathValue("id"), input.Minutes)
		respond(w, saved, err)
	})
	mux.HandleFunc("GET /api/settings/task-reminders", func(w http.ResponseWriter, r *http.Request) {
		settings, err := s.App.TaskReminderSettings(r.Context())
		respond(w, settings, err)
	})
	mux.HandleFunc("PUT /api/settings/task-reminders", func(w http.ResponseWriter, r *http.Request) {
		var input model.TaskReminderSettings
		if err := read(w, r, &input); err != nil {
			respond(w, nil, err)
			return
		}
		saved, err := s.App.SaveTaskReminderSettings(r.Context(), input)
		respond(w, saved, err)
	})
	mux.HandleFunc("GET /api/settings/task-dispatch", func(w http.ResponseWriter, r *http.Request) {
		settings, err := s.App.TaskDispatchSettings(r.Context())
		respond(w, settings, err)
	})
	mux.HandleFunc("PUT /api/settings/task-dispatch", func(w http.ResponseWriter, r *http.Request) {
		var input model.TaskDispatchSettings
		if err := read(w, r, &input); err != nil {
			respond(w, nil, err)
			return
		}
		saved, err := s.App.SaveTaskDispatchSettings(r.Context(), input)
		respond(w, saved, err)
	})
}
