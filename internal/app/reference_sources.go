package app

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"slices"
	"strings"
	"unicode/utf8"

	"lever/internal/model"
	"lever/internal/notes"
	"lever/internal/store"
)

// Note-backed and SQLite-backed suggestions load independently. An offline
// Notes folder must not hide other Kanban items or workspace files.
func (a *App) NoteReferences(ctx context.Context) ([]model.Reference, error) {
	a.notesMu.Lock()
	defer a.notesMu.Unlock()
	catalog, err := a.readNotes(ctx)
	if err != nil {
		return nil, err
	}
	refs := []model.Reference{}
	for _, summary := range catalog.summaries {
		if summary.State != model.TaskNoteDeleted && summary.Conflict == "" {
			note := catalog.notes[summary.ID]
			refs = append(refs, model.Reference{Kind: "note", ID: note.ID, Name: note.Title, Description: note.Project})
		}
	}
	for id, task := range catalog.tasks {
		if !task.Deleted && task.Title != "" && catalog.conflicts[task.NoteID] == nil {
			refs = append(refs, model.Reference{Kind: "noteTask", ID: id, Name: referenceTitle(task.Title), Description: catalog.notes[task.NoteID].Title})
		}
	}
	if len(refs) == 0 && catalog.unavailable != nil {
		return nil, catalog.unavailable
	}
	slices.SortFunc(refs, func(a, b model.Reference) int {
		if a.Name == b.Name {
			return strings.Compare(a.ID, b.ID)
		}
		return strings.Compare(a.Name, b.Name)
	})
	return refs, nil
}

func referenceTitle(text string) string {
	runes := []rune(text)
	if len(runes) > 160 {
		return string(runes[:159]) + "…"
	}
	return text
}

func (a *App) BoardReferences(ctx context.Context) ([]model.Reference, error) {
	refs, err := store.List[model.Reference](ctx, a.Store.DB, `SELECT json_object(
		'kind','workItem','id',w.id,'name',json_extract(w.data,'$.title'),'description',json_extract(a.data,'$.name'))
		FROM work_items w LEFT JOIN agents a ON a.id=json_extract(w.data,'$.assigneeAgentId') ORDER BY w.rowid DESC`)
	if err != nil {
		return nil, err
	}
	external, err := a.ExternalTasks(ctx)
	if err != nil {
		return nil, err
	}
	for _, task := range external {
		refs = append(refs, model.Reference{Kind: "externalTask", ID: task.ID, Name: referenceTitle(task.Title), Description: strings.TrimSpace(task.Project + " " + task.Reference)})
	}
	automations, err := store.List[model.Reference](ctx, a.Store.DB, `SELECT json_object('kind','automationTask','id',id,'name',name)
		FROM automation_runs WHERE work_item=1 AND run_id IS NOT NULL ORDER BY rowid DESC`)
	return append(refs, automations...), err
}

func isNoteReference(ref model.Reference) bool { return ref.Kind == "note" || ref.Kind == "noteTask" }

func isDocumentReference(ref model.Reference) bool {
	return isNoteReference(ref) || ref.Kind == "workItem" || ref.Kind == "externalTask" || ref.Kind == "automationTask"
}

func (catalog noteCatalog) referencedNote(ref model.Reference) (model.TaskNote, error) {
	id := ref.ID
	if ref.Kind == "noteTask" {
		id = catalog.tasks[id].NoteID
	}
	note, err := catalog.lookupNote(id)
	if err != nil || note.State == model.TaskNoteDeleted {
		return model.TaskNote{}, invalid("Referenced note or task is unavailable: " + ref.Name)
	}
	return note, nil
}

// Take the filesystem snapshot before the message's SQLite transaction. Note
// saves take notesMu before writing SQLite. An accepted command can be replayed
// even after its note has been deleted.
func (a *App) validateNoteReferences(ctx context.Context, refs []model.Reference) error {
	if !slices.ContainsFunc(refs, isNoteReference) {
		return nil
	}
	a.notesMu.Lock()
	defer a.notesMu.Unlock()
	catalog, err := a.readNotes(ctx)
	if err != nil {
		return err
	}
	for _, ref := range refs {
		if isNoteReference(ref) {
			if _, err := catalog.referencedNote(ref); err != nil {
				return err
			}
		}
	}
	return nil
}

type readReferenceInput struct {
	Kind   string `json:"kind" jsonschema:"Reference kind supplied in the current message"`
	ID     string `json:"id" jsonschema:"Reference ID supplied in the current message"`
	Offset int    `json:"offset,omitempty" jsonschema:"UTF-8 byte offset returned as nextOffset"`
}

type referencePage struct {
	Title           string `json:"title"`
	Text            string `json:"text"`
	Done            *bool  `json:"done,omitempty"`
	AssigneeAgentID string `json:"assigneeAgentId,omitempty"`
	State           string `json:"state,omitempty"`
	NextOffset      int    `json:"nextOffset,omitempty"`
}

func (a *App) readReference(ctx context.Context, refs []model.Reference, in readReferenceInput) (referencePage, error) {
	i := slices.IndexFunc(refs, func(ref model.Reference) bool {
		return ref.ID == in.ID && ref.Kind == in.Kind && isDocumentReference(ref)
	})
	if i < 0 {
		return referencePage{}, invalid("This source was not referenced in the current message")
	}
	page, err := a.referenceContent(ctx, refs[i])
	if errors.Is(err, sql.ErrNoRows) {
		return referencePage{}, invalid("The referenced source is unavailable")
	}
	if err != nil {
		return referencePage{}, err
	}
	body := page.Text
	if in.Offset < 0 || in.Offset > len(body) || (in.Offset < len(body) && !utf8.RuneStart(body[in.Offset])) {
		return referencePage{}, invalid("Invalid reference offset")
	}
	end := contextTextEnd(body, in.Offset, contextTextBytes)
	page.Title = referenceTitle(page.Title)
	page.Text = body[in.Offset:end]
	if end < len(body) {
		page.NextOffset = end
	}
	return page, nil
}

func (a *App) referenceContent(ctx context.Context, ref model.Reference) (referencePage, error) {
	switch ref.Kind {
	case "workItem":
		item, err := a.WorkItem(ctx, ref.ID)
		return referencePage{Title: item.Title, Text: item.Body, Done: &item.Done, AssigneeAgentID: item.AssigneeAgentID}, err
	case "externalTask":
		item, err := a.ExternalTask(ctx, ref.ID)
		return referencePage{Title: item.Title, Text: taskMessage(item.Body, item.URL), Done: &item.Done, State: item.State}, err
	case "automationTask":
		var page referencePage
		err := a.Store.DB.QueryRowContext(ctx, "SELECT ar.name,r.status,ar.done,r.agent_id"+automationRunJoin+" WHERE ar.id=? AND ar.work_item=1 AND r.id IS NOT NULL", ref.ID).Scan(&page.Title, &page.State, &page.Done, &page.AssigneeAgentID)
		return page, err
	}
	a.notesMu.Lock()
	defer a.notesMu.Unlock()
	catalog, err := a.readNotes(ctx)
	if err != nil {
		return referencePage{}, err
	}
	note, err := catalog.referencedNote(ref)
	if err != nil {
		return referencePage{}, err
	}
	var doc notes.Node
	if err := json.Unmarshal(note.Content, &doc); err != nil {
		return referencePage{}, err
	}
	if ref.Kind == "noteTask" {
		blocks := notes.TaskBlocks(doc.Content, ref.ID)
		task := catalog.tasks[ref.ID]
		return referencePage{Title: task.Title, Text: notes.Text(blocks, ref.ID), Done: &task.Done}, nil
	}
	return referencePage{Title: note.Title, Text: notes.Text(doc.Content, "")}, nil
}
