package app

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"lever/internal/model"
	"lever/internal/workspace"
)

const (
	noteArchiveDir = ".lever-archive"
	noteTrashDir   = ".lever-trash"
)

func taskNoteState(path string) model.TaskNoteState {
	dir, _, _ := strings.Cut(path, "/")
	switch strings.ToLower(dir) {
	case noteArchiveDir:
		return model.TaskNoteArchived
	case noteTrashDir:
		return model.TaskNoteDeleted
	default:
		return model.TaskNoteActive
	}
}

func (a *App) SetTaskNoteState(ctx context.Context, id string, state model.TaskNoteState, expectedDirectory string) (model.TaskNote, error) {
	var directory string
	switch state {
	case model.TaskNoteActive:
	case model.TaskNoteArchived:
		directory = noteArchiveDir
	case model.TaskNoteDeleted:
		directory = noteTrashDir
	default:
		return model.TaskNote{}, invalid("Select a valid note state")
	}

	a.notesMu.Lock()
	defer a.notesMu.Unlock()
	if expectedDirectory != "" && expectedDirectory != a.notesDir {
		return model.TaskNote{}, ErrTaskNotesDirectoryChanged
	}
	catalog, err := a.readNotes(ctx)
	if err != nil {
		return model.TaskNote{}, err
	}
	note, err := catalog.lookupNote(id)
	if err != nil {
		return model.TaskNote{}, err
	}
	if markdownPath(note.Path) {
		return model.TaskNote{}, invalid("Manage the Markdown file in its folder")
	}
	if note.State == state {
		return note, nil
	}
	if note.State == model.TaskNoteDeleted && state != model.TaskNoteActive {
		return model.TaskNote{}, conflict("Restore the deleted note first")
	}

	root := a.notesDir
	relative := note.Path
	if note.State != model.TaskNoteActive {
		_, relative, _ = strings.Cut(relative, "/")
	}
	base := filepath.Join(directory, relative)
	parent := filepath.Dir(base)
	if err := createNoteDirectory(root, parent); err != nil {
		return model.TaskNote{}, err
	}
	ext := filepath.Ext(base)
	name := noteFilename(strings.TrimSuffix(filepath.Base(base), ext))
	for n := 1; ; n++ {
		target := base
		if n > 1 {
			target = filepath.Join(parent, fmt.Sprintf("%s %d%s", name, n, ext))
		}
		entry, err := workspace.ChangeEntry(root, note.Path, "move", filepath.ToSlash(target))
		if errors.Is(err, os.ErrExist) {
			continue
		}
		if err != nil {
			return model.TaskNote{}, err
		}
		note.Path, note.State = entry.Path, state
		a.notifyTaskNote(ctx, id)
		return note, nil
	}
}

// Note discovery skips symlinked directories. Create the destination using
// real directories so the moved note stays in the catalog.
func createNoteDirectory(dir, relative string) error {
	if relative == "." {
		return nil
	}
	root, err := os.OpenRoot(dir)
	if err != nil {
		return err
	}
	defer root.Close()
	path := ""
	for _, part := range strings.Split(filepath.ToSlash(relative), "/") {
		path = filepath.Join(path, part)
		switch err := root.Mkdir(path, 0700); {
		case err == nil:
			continue
		case !errors.Is(err, os.ErrExist):
			return err
		}
		info, err := root.Lstat(path)
		if err != nil {
			return err
		}
		if !info.IsDir() {
			return conflict("A file occupies the note's destination folder")
		}
	}
	return nil
}
