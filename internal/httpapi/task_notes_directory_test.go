package httpapi_test

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"lever/internal/app"
	"lever/internal/model"
)

func TestTaskNotesDirectoryCopiesLibraryAndOpensItOnAnotherDevice(t *testing.T) {
	f := newFixture(t)
	const settingsPath = "/tasks/notes-directory"
	var original model.TaskNotesDirectory
	f.request("GET", settingsPath, nil, 200, &original)
	newNote := func(title string) model.TaskNote {
		t.Helper()
		var note model.TaskNote
		f.request("POST", "/tasks/notes", model.TaskNoteSummary{ID: app.ID(), Title: title}, 200, &note)
		return note
	}
	active, archived, deleted := newNote("Active"), newNote("Archived"), newNote("Deleted")
	taskID := app.ID()
	active.Content = json.RawMessage(`{"type":"doc","content":[{"type":"paragraph","attrs":{"taskId":"` + taskID + `","done":true},"content":[{"type":"text","text":"Done"}]}]}`)
	f.request("PUT", "/tasks/notes/"+active.ID, active, 200, &active)
	f.request("PATCH", "/tasks/notes/"+archived.ID, map[string]string{"state": "archived"}, 200, &archived)
	f.request("PATCH", "/tasks/notes/"+deleted.ID, map[string]string{"state": "deleted"}, 200, &deleted)
	image := []byte{137, 80, 78, 71, 13, 10, 26, 10}
	asset, err := f.a.SaveNoteAsset(t.Context(), active.ID, "test.png", image)
	if err != nil {
		t.Fatal(err)
	}

	parent := t.TempDir()
	if err := os.Mkdir(filepath.Join(parent, "Existing"), 0700); err != nil {
		t.Fatal(err)
	}
	var selected model.TaskNotesDirectory
	f.request("PUT", settingsPath, model.TaskNotesDirectoryUpdate{CurrentPath: original.Path, Path: original.Path, NewFolder: "Nested"}, 400, nil)
	update := model.TaskNotesDirectoryUpdate{CurrentPath: original.Path, Path: parent, NewFolder: "Existing"}
	f.request("PUT", settingsPath, update, 409, nil)
	f.request("GET", settingsPath, nil, 200, &selected)
	if selected != original {
		t.Fatalf("failed copy changed the selected folder: %+v", selected)
	}
	update.NewFolder = "Shared notes"
	f.request("PUT", settingsPath, update, 200, &selected)
	if filepath.Base(selected.Path) != update.NewFolder || selected.Path == original.Path {
		t.Fatalf("copy selected the wrong folder: %+v", selected)
	}
	for _, name := range []string{active.Path, archived.Path, deleted.Path, asset.Path} {
		old, err := os.ReadFile(filepath.Join(original.Path, filepath.FromSlash(name)))
		if err != nil {
			t.Fatal(err)
		}
		copied, err := os.ReadFile(filepath.Join(selected.Path, filepath.FromSlash(name)))
		if err != nil || !bytes.Equal(copied, old) {
			t.Fatalf("%s was not copied intact: %v", name, err)
		}
	}

	stale := active
	stale.Title = "Stale edit"
	var failure map[string]string
	f.request("PUT", "/tasks/notes/"+stale.ID, stale, 409, &failure)
	if failure["code"] != "task_notes_directory_changed" {
		t.Fatalf("got the wrong save error after switching folders: %v", failure)
	}
	f.request("PATCH", "/tasks/notes/"+stale.ID, map[string]string{"state": "archived", "directory": stale.Directory}, 409, nil)

	other := newFixture(t)
	var otherOriginal model.TaskNotesDirectory
	other.request("GET", settingsPath, nil, 200, &otherOriginal)
	other.request("PUT", settingsPath, model.TaskNotesDirectoryUpdate{CurrentPath: otherOriginal.Path, Path: selected.Path}, 200, nil)
	var before, after []model.TaskNoteSummary
	f.request("GET", "/tasks/notes", nil, 200, &before)
	other.request("GET", "/tasks/notes", nil, 200, &after)
	if !reflect.DeepEqual(before, after) {
		t.Fatalf("the second device changed the shared library: %+v, %+v", before, after)
	}
	file, _, err := other.a.OpenNoteAsset(strings.TrimPrefix(asset.Path, ".assets/"))
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	if data, err := io.ReadAll(file); err != nil || !bytes.Equal(data, image) {
		t.Fatalf("image unavailable in the shared folder: %v", err)
	}
	var location model.TaskLocation
	other.request("GET", "/tasks/locate/"+taskID, nil, 200, &location)
	if location.NoteID != active.ID {
		t.Fatalf("lost the note's task ID: %+v", location)
	}
	other.request("GET", "/tasks/notes/"+active.ID, nil, 200, &active)
	active.Title = "Edited on the other device"
	other.request("PUT", "/tasks/notes/"+active.ID, active, 200, nil)
	f.request("GET", "/tasks/notes/"+active.ID, nil, 200, &stale)
	if stale.Title != active.Title {
		t.Fatalf("did not reload the external edit: %+v", stale)
	}
}

func TestTaskNotesDirectoryPersistsWhileUnavailable(t *testing.T) {
	dataDir, dir := t.TempDir(), filepath.Join(t.TempDir(), "Shared notes")
	if err := os.Mkdir(dir, 0700); err != nil {
		t.Fatal(err)
	}
	var saved model.TaskNotesDirectory
	func() {
		a, err := app.Open(dataDir)
		if err != nil {
			t.Fatal(err)
		}
		defer a.Close()
		saved, err = a.SetTaskNotesDirectory(t.Context(), model.TaskNotesDirectoryUpdate{CurrentPath: a.TaskNotesDirectory().Path, Path: dir})
		if err != nil {
			t.Fatal(err)
		}
	}()
	if err := os.Rename(dir, dir+" offline"); err != nil {
		t.Fatal(err)
	}
	a, err := app.Open(dataDir)
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	if got := a.TaskNotesDirectory(); got != saved {
		t.Fatalf("did not retain the selected folder: %+v", got)
	}
	if _, err := a.TaskNotes(t.Context()); !errors.Is(err, app.ErrTaskNotesUnavailable) {
		t.Fatalf("expected unavailable Notes folder, got %v", err)
	}
	if err := os.Rename(dir+" offline", dir); err != nil {
		t.Fatal(err)
	}
	if notes, err := a.TaskNotes(t.Context()); err != nil || len(notes) != 0 {
		t.Fatalf("expected the original empty folder after it returned: %+v, %v", notes, err)
	}
}

func TestTaskNoteConflictIsLimitedToItsCopies(t *testing.T) {
	f := newFixture(t)
	var first, other model.TaskNote
	f.request("POST", "/tasks/notes", model.TaskNoteSummary{ID: app.ID(), Title: "Conflicted"}, 200, &first)
	f.request("POST", "/tasks/notes", model.TaskNoteSummary{ID: app.ID(), Title: "Unrelated"}, 200, &other)
	original := filepath.Join(first.Directory, first.Path)
	copy := filepath.Join(first.Directory, "Conflicted copy.xml")
	data, err := os.ReadFile(original)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(copy, data, 0600); err != nil {
		t.Fatal(err)
	}
	var notes []model.TaskNoteSummary
	f.request("GET", "/tasks/notes", nil, 200, &notes)
	found := false
	for _, note := range notes {
		if note.ID == first.ID {
			found = strings.Contains(note.Conflict, first.Path) && strings.Contains(note.Conflict, filepath.Base(copy))
		}
	}
	if !found {
		t.Fatalf("conflict did not identify both files: %+v", notes)
	}
	f.request("GET", "/tasks/notes/"+first.ID, nil, 409, nil)
	f.request("PATCH", "/tasks/notes/"+first.ID, map[string]string{"state": "deleted"}, 409, nil)
	other.Title = "Edited while the other note was conflicted"
	f.request("PUT", "/tasks/notes/"+other.ID, other, 200, &other)
	for _, path := range []string{original, copy} {
		kept, err := os.ReadFile(path)
		if err != nil || !bytes.Equal(kept, data) {
			t.Fatalf("conflict handling changed %s: %v", path, err)
		}
	}
	if err := os.Remove(copy); err != nil {
		t.Fatal(err)
	}
	f.request("GET", "/tasks/notes/"+first.ID, nil, 200, &first)
}

func TestMarkdownSourceSaveRetainsFileIdentityAndRejectsStaleDraft(t *testing.T) {
	f := newFixture(t)
	dir := f.a.TaskNotesDirectory().Path
	file := filepath.Join(dir, "existing.md")
	const original = "\ufeff---\r\ntag: keep\r\n---\r\n\r\n# One\r\n"
	if err := os.WriteFile(file, []byte(original), 0600); err != nil {
		t.Fatal(err)
	}
	var found []model.TaskNoteSummary
	f.request("GET", "/tasks/notes", nil, 200, &found)
	var id string
	for _, item := range found {
		if item.Markdown && item.Title == "existing.md" {
			id = item.ID
		}
	}
	if id == "" {
		t.Fatal("Markdown file was missing from Notes")
	}
	var note model.TaskNote
	route := "/tasks/notes/" + id
	f.request("GET", route, nil, 200, &note)
	body := func(text string) json.RawMessage {
		raw, err := json.Marshal(map[string]any{"type": "doc", "content": []any{map[string]any{"type": "codeBlock", "content": []any{map[string]string{"type": "text", "text": text}}}}})
		if err != nil {
			t.Fatal(err)
		}
		return raw
	}
	stale := note
	note.Content = body(original + "second line\r\n")
	f.request("PUT", route, note, 200, &note)
	bytes, err := os.ReadFile(file)
	if err != nil || string(bytes) != original+"second line\r\n" || note.ID != id {
		t.Fatalf("incorrect source save %q, %v", bytes, err)
	}
	if _, err := os.Stat(filepath.Join(dir, "existing.xml")); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("source save created a copy")
	}
	if err := os.WriteFile(file, []byte("external"), 0600); err != nil {
		t.Fatal(err)
	}
	stale.Content = body("local")
	f.request("PUT", route, stale, 409, nil)
	f.request("GET", route, nil, 200, &note)
	if !strings.Contains(string(note.Content), "external") {
		t.Fatalf("cached old source: %s", note.Content)
	}
}
