package app

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"lever/internal/model"
	"lever/internal/notes"
	"lever/internal/store"
	"lever/internal/workspace"
)

var (
	ErrTaskNotesUnavailable      = errors.New("The Notes folder or its files are unavailable")
	ErrTaskNotesDirectoryChanged = errors.New("The Notes folder changed. Reopen the original folder to save these edits")
)

func (a *App) initNotes(ctx context.Context) error {
	err := a.Store.DB.QueryRowContext(ctx, `SELECT value FROM settings WHERE key='notes_directory'`).Scan(&a.notesDir)
	if !errors.Is(err, sql.ErrNoRows) {
		// Notes checks custom directory availability when accessed.
		return err
	}
	dataDir, err := workspace.Canonical(a.Store.Dir)
	if err != nil {
		return err
	}
	a.notesDir = filepath.Join(dataDir, "notes")
	if err := os.Mkdir(a.notesDir, 0700); err != nil {
		if errors.Is(err, os.ErrExist) {
			if dir, err := workspace.Canonical(a.notesDir); err == nil {
				a.notesDir = dir
			}
			return nil
		}
		return err
	}
	source, err := notes.Encode(notes.Document{ID: ID(), Blocks: []notes.Node{{Type: "paragraph"}}})
	if err != nil {
		return err
	}
	return workspace.CreateText(a.notesDir, "Work note.xml", source)
}

func (a *App) TaskNotesDirectory() model.TaskNotesDirectory {
	a.notesMu.Lock()
	defer a.notesMu.Unlock()
	return model.TaskNotesDirectory{Path: a.notesDir}
}

func (a *App) SetTaskNotesDirectory(ctx context.Context, input model.TaskNotesDirectoryUpdate) (model.TaskNotesDirectory, error) {
	var result model.TaskNotesDirectory
	if !filepath.IsAbs(input.Path) && input.Path != "~" && !strings.HasPrefix(input.Path, "~/") {
		return result, invalid("Enter an absolute folder path")
	}
	dir, err := workspace.Canonical(input.Path)
	if err != nil {
		return result, invalid(fmt.Sprintf("Could not open the selected folder (%v)", err))
	}
	a.notesMu.Lock()
	defer a.notesMu.Unlock()
	if input.CurrentPath != a.notesDir {
		return result, ErrTaskNotesDirectoryChanged
	}
	parent := dir
	if input.NewFolder != "" {
		name := input.NewFolder
		if !filepath.IsLocal(name) || name == "." || strings.ContainsAny(name, "/\\:\x00") {
			return result, invalid("Enter a folder name")
		}
		dir = filepath.Join(parent, name)
	}
	if input.NewFolder == "" && dir == a.notesDir {
		return model.TaskNotesDirectory{Path: dir}, nil
	}
	dataDir, err := workspace.Canonical(a.Store.Dir)
	if err != nil {
		return result, err
	}
	if containsDirectory(dir, dataDir) {
		return result, invalid("Choose a separate folder for Notes")
	}
	if input.NewFolder != "" {
		if containsDirectory(a.notesDir, parent) {
			return result, invalid("Choose a destination outside the current Notes folder")
		}
		if err := copyNotesDirectory(ctx, a.notesDir, parent, input.NewFolder); err != nil {
			return result, err
		}
	}
	err = a.Store.Write(ctx, func(tx *sql.Tx) error {
		if _, err := tx.ExecContext(ctx, `INSERT INTO settings(key,value) VALUES('notes_directory',?)
ON CONFLICT(key) DO UPDATE SET value=excluded.value`, dir); err != nil {
			return err
		}
		return store.Event(tx, model.Event{Type: "task-notes-directory"})
	})
	if err != nil {
		return result, err
	}
	a.notesDir = dir
	a.noteFiles = nil
	return model.TaskNotesDirectory{Path: dir}, nil
}

func containsDirectory(root, path string) bool {
	if workspace.Contains(root, path) {
		return true
	}
	// Finder and manually entered paths can differ in case on the same volume.
	rootInfo, err := os.Stat(root)
	if err != nil {
		return false
	}
	for {
		if info, err := os.Stat(path); err == nil && os.SameFile(rootInfo, info) {
			return true
		}
		parent := filepath.Dir(path)
		if parent == path {
			return false
		}
		path = parent
	}
}

func copyNotesDirectory(ctx context.Context, source, parent, name string) error {
	// Stage on the destination volume and publish the complete tree with a no-replace move.
	if err := ctx.Err(); err != nil {
		return err
	}
	nameInUse := conflict("A folder or file already has that name. Choose a new name or open the existing folder")
	if _, err := os.Lstat(filepath.Join(parent, name)); !errors.Is(err, os.ErrNotExist) {
		if err == nil {
			return nameInUse
		}
		return err
	}
	info, err := os.Lstat(source)
	if err != nil {
		return fmt.Errorf("%w: %w", ErrTaskNotesUnavailable, err)
	}
	if !info.IsDir() {
		return ErrTaskNotesUnavailable
	}
	root, err := os.OpenRoot(source)
	if err != nil {
		return fmt.Errorf("%w: %w", ErrTaskNotesUnavailable, err)
	}
	defer root.Close()
	stage, err := os.MkdirTemp(parent, ".lever-notes-copy-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(stage)
	if err := os.CopyFS(stage, root.FS()); err != nil {
		return fmt.Errorf("Copy Notes: %w", err)
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	_, err = workspace.ChangeEntry(parent, filepath.Base(stage), "move", name)
	if errors.Is(err, os.ErrExist) {
		return nameInUse
	}
	return err
}
