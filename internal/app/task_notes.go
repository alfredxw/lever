package app

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"unicode"
	"unicode/utf8"

	"lever/internal/model"
	"lever/internal/notes"
	"lever/internal/store"
	"lever/internal/workspace"
)

var ErrTaskNoteVersion = errors.New("The task note has a newer version")

type noteCatalog struct {
	summaries   []model.TaskNoteSummary
	notes       map[string]model.TaskNote
	tasks       map[string]noteTask
	broken      map[string]error
	conflicts   map[string]error
	unavailable error
}

type parsedNote struct {
	note    model.TaskNote
	markers map[string]notes.Marker
}

type noteTask struct {
	Title   string `json:"-"`
	NoteID  string `json:"noteId"`
	Done    bool   `json:"done"`
	Deleted bool   `json:"deleted,omitempty"`
}

// The file library is authoritative. Every snapshot can be rebuilt after an
// external move or edit without updating the Chat database.
func (a *App) readNotes(ctx context.Context) (noteCatalog, error) {
	catalog := noteCatalog{
		summaries: []model.TaskNoteSummary{},
		notes:     map[string]model.TaskNote{},
		tasks:     map[string]noteTask{},
		broken:    map[string]error{},
		conflicts: map[string]error{},
	}
	root := a.notesDir
	files := make(map[string]parsedNote)
	err := filepath.WalkDir(root, func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			if path == root {
				return fmt.Errorf("%w: %w", ErrTaskNotesUnavailable, err)
			}
			if !errors.Is(err, os.ErrNotExist) && catalog.unavailable == nil {
				catalog.unavailable = fmt.Errorf("%w: %w", ErrTaskNotesUnavailable, err)
			}
			return nil
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		if path == root {
			if !entry.IsDir() {
				return ErrTaskNotesUnavailable
			}
			return nil
		}
		if entry.IsDir() {
			if filepath.Dir(path) == root && taskNoteState(entry.Name()) != model.TaskNoteActive {
				return nil
			}
			if strings.HasPrefix(entry.Name(), ".") || strings.HasSuffix(entry.Name(), ".assets") {
				return fs.SkipDir
			}
			return nil
		}
		if !entry.Type().IsRegular() || strings.HasPrefix(entry.Name(), ".") || !strings.EqualFold(filepath.Ext(path), ".xml") {
			return nil
		}
		rel, err := filepath.Rel(root, path)
		if err != nil {
			return err
		}
		rel = filepath.ToSlash(rel)
		file, err := workspace.Read(root, rel)
		if err != nil {
			catalog.broken[rel] = fmt.Errorf("%w: %w", ErrTaskNotesUnavailable, err)
			if catalog.unavailable == nil {
				catalog.unavailable = catalog.broken[rel]
			}
			return nil
		}
		parsed, ok := a.noteFiles[file.Version]
		if !ok {
			parsed, err = decodeTaskNote(file)
			if err != nil {
				catalog.broken[rel] = &Error{409, fmt.Sprintf("%s: %s", rel, err)}
				return nil
			}
		}
		files[file.Version] = parsed
		note := parsed.note
		note.Path = rel
		note.Directory = root
		note.State = taskNoteState(rel)
		if previous, exists := catalog.notes[note.ID]; exists {
			catalog.conflicts[note.ID] = conflict(fmt.Sprintf("Resolve the duplicate note files %q and %q in the Notes folder, then retry.", previous.Path, rel))
		} else {
			catalog.notes[note.ID] = note
			catalog.summaries = append(catalog.summaries, model.TaskNoteSummary{
				ID: note.ID, Title: note.Title, State: note.State, Directory: root,
			})
		}
		for id, marker := range parsed.markers {
			if previous, exists := catalog.tasks[id]; exists {
				if previous.NoteID != note.ID {
					other := catalog.notes[previous.NoteID]
					issue := conflict(fmt.Sprintf("Resolve the duplicate task in %q and %q, then retry.", other.Path, rel))
					for _, noteID := range []string{other.ID, note.ID} {
						if catalog.conflicts[noteID] == nil {
							catalog.conflicts[noteID] = issue
						}
					}
				}
				continue
			}
			catalog.tasks[id] = noteTask{NoteID: note.ID, Title: marker.Title, Done: marker.Done, Deleted: note.State == model.TaskNoteDeleted}
		}
		return nil
	})
	if err == nil {
		a.noteFiles = files
	}
	for i := range catalog.summaries {
		summary := &catalog.summaries[i]
		if issue := catalog.conflicts[summary.ID]; issue != nil {
			// Conflicted copies have no authoritative lifecycle state.
			summary.State, summary.Conflict = model.TaskNoteActive, issue.Error()
		}
	}
	return catalog, err
}

func (catalog noteCatalog) lookupNote(id string) (model.TaskNote, error) {
	if err := catalog.conflicts[id]; err != nil {
		return model.TaskNote{}, err
	}
	if note, ok := catalog.notes[id]; ok {
		return note, nil
	}
	if catalog.unavailable != nil {
		return model.TaskNote{}, catalog.unavailable
	}
	return model.TaskNote{}, os.ErrNotExist
}

func decodeTaskNote(file model.FileContent) (parsedNote, error) {
	if file.Truncated {
		return parsedNote{}, errors.New("note exceeds the file size limit")
	}
	doc, err := notes.Decode(file.Content)
	if err != nil {
		return parsedNote{}, err
	}
	body, err := notes.Content(doc.Blocks)
	if err != nil {
		return parsedNote{}, err
	}
	if len(body) > notes.MaxContent {
		return parsedNote{}, errors.New("note content exceeds 1 MiB")
	}
	markers, err := notes.Markers(doc.Blocks)
	return parsedNote{
		note:    model.TaskNote{ID: doc.ID, Title: doc.Title, Project: doc.Project, Version: file.Version, Content: body},
		markers: markers,
	}, err
}

func (a *App) TaskNotes(ctx context.Context) ([]model.TaskNoteSummary, error) {
	a.notesMu.Lock()
	defer a.notesMu.Unlock()
	catalog, err := a.readNotes(ctx)
	if err == nil && len(catalog.summaries) == 0 {
		err = catalog.unavailable
	}
	return catalog.summaries, err
}

func (a *App) TaskNote(ctx context.Context, id string) (model.TaskNote, error) {
	a.notesMu.Lock()
	defer a.notesMu.Unlock()
	return a.taskNote(ctx, id)
}

// The caller holds notesMu for the complete operation on this directory.
func (a *App) taskNote(ctx context.Context, id string) (model.TaskNote, error) {
	catalog, err := a.readNotes(ctx)
	if err != nil {
		return model.TaskNote{}, err
	}
	note, err := catalog.lookupNote(id)
	if note.State == model.TaskNoteDeleted {
		return model.TaskNote{}, os.ErrNotExist
	}
	return note, err
}

func validTaskLabel(title string) bool {
	return utf8.RuneCountInString(title) <= 100 && !strings.ContainsAny(title, "\r\n\x00")
}

func noteFilename(title string) string {
	name := strings.Map(func(r rune) rune {
		if unicode.IsControl(r) || strings.ContainsRune(`/\:*?"<>|`, r) {
			return '-'
		}
		return r
	}, title)
	name = strings.Trim(name, ". ")
	for len(name) > 200 {
		_, size := utf8.DecodeLastRuneInString(name)
		name = name[:len(name)-size]
	}
	if name == "" || !filepath.IsLocal(name+".xml") {
		name = "Note"
	}
	return name
}

func (a *App) CreateTaskNote(ctx context.Context, input model.TaskNote) (model.TaskNote, error) {
	input.Title = strings.TrimSpace(input.Title)
	input.Project = strings.TrimSpace(input.Project)
	if input.Title == "" {
		return model.TaskNote{}, invalid("Enter a note title up to 100 characters")
	}
	if len(input.Content) == 0 {
		input.Content = json.RawMessage(`{"type":"doc","content":[{"type":"paragraph"}]}`)
	}
	return a.writeTaskNote(ctx, input.ID, input, true)
}

func (a *App) SaveTaskNote(ctx context.Context, id string, input model.TaskNote) (model.TaskNote, error) {
	input.Project = strings.TrimSpace(input.Project)
	return a.writeTaskNote(ctx, id, input, false)
}

func (a *App) writeTaskNote(ctx context.Context, id string, input model.TaskNote, create bool) (model.TaskNote, error) {
	var result model.TaskNote
	if input.ID != id || !notes.IDPattern.MatchString(id) || !validTaskLabel(input.Title) || !validTaskLabel(input.Project) {
		return result, invalid("Enter a valid note ID, title and project name")
	}
	blocks, markers, err := notes.ParseContent(input.Content)
	if err != nil {
		return result, invalid(err.Error())
	}
	input.Content, err = notes.Content(blocks)
	if err != nil {
		return result, invalid(err.Error())
	}
	source, err := notes.Encode(notes.Document{ID: id, Title: input.Title, Project: input.Project, Blocks: blocks})
	if err != nil {
		return result, invalid(err.Error())
	}
	if len(source) > workspace.MaxFileBytes {
		return result, invalid("The serialized note exceeds 2 MiB")
	}

	a.notesMu.Lock()
	defer a.notesMu.Unlock()
	if input.Directory != "" && input.Directory != a.notesDir {
		return result, ErrTaskNotesDirectoryChanged
	}
	catalog, err := a.readNotes(ctx)
	if err != nil {
		return result, err
	}
	if err := catalog.conflicts[id]; err != nil {
		return result, err
	}
	current, exists := catalog.notes[id]
	if current.State == model.TaskNoteDeleted {
		if create {
			return result, conflict("This note ID is already in use")
		}
		return result, conflict("Restore the deleted note before saving changes")
	}
	if exists && current.Title == input.Title && current.Project == input.Project && string(current.Content) == string(input.Content) {
		return current, nil
	}
	if create && exists {
		return result, conflict("This note ID is already in use")
	}
	if !create {
		if !exists {
			if err := catalog.broken[input.Path]; err != nil {
				return result, err
			}
			if catalog.unavailable != nil {
				return result, catalog.unavailable
			}
			return result, os.ErrNotExist
		}
		if input.Version != current.Version {
			return result, ErrTaskNoteVersion
		}
	}
	for taskID, marker := range markers {
		if task := catalog.tasks[taskID]; task.NoteID != "" && task.NoteID != id {
			return result, conflict("This task is already in another note")
		}
		if marker.Done && !catalog.tasks[taskID].Done {
			if err := checkTaskInBoard(ctx, a.Store.DB, taskID); errors.Is(err, sql.ErrNoRows) {
				continue // Removed from Works. The original note is still editable.
			} else if err != nil {
				return result, err
			}
			if err := checkTaskNotClosed(ctx, a.Store.DB, taskID); err != nil {
				return result, err
			}
			if err := checkTaskNotQueued(ctx, a.Store.DB, taskID); err != nil {
				return result, err
			}
		}
	}
	sum := sha256.Sum256([]byte(source))
	input.Version = hex.EncodeToString(sum[:])
	input.Directory = a.notesDir
	if create {
		input.State = model.TaskNoteActive
		name := noteFilename(input.Title)
		for n := 1; ; n++ {
			input.Path = name + ".xml"
			if n > 1 {
				input.Path = fmt.Sprintf("%s %d.xml", name, n)
			}
			err = workspace.CreateText(a.notesDir, input.Path, source)
			if !errors.Is(err, os.ErrExist) {
				break
			}
		}
	} else {
		input.Path = current.Path
		input.State = current.State
		_, err = workspace.Write(a.notesDir, current.Path, source, current.Version)
		if errors.Is(err, workspace.ErrFileConflict) {
			return result, ErrTaskNoteVersion
		}
	}
	if err != nil {
		return result, err
	}
	a.notifyTaskNote(ctx, id)
	return input, nil
}

func (a *App) notifyTaskNote(ctx context.Context, id string) {
	// The notification is a hint to refresh from disk. A failed event write
	// cannot roll back a file change.
	_ = a.Store.Write(ctx, func(tx *sql.Tx) error {
		return store.Event(tx, model.Event{Type: "task-note", TaskNoteID: id})
	})
}
