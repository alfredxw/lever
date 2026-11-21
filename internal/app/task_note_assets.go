package app

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"lever/internal/model"
	"lever/internal/notes"
	"lever/internal/workspace"
)

const MaxNoteAssetBytes = 20 << 20

type NoteAsset struct {
	Path  string `json:"path"`
	Name  string `json:"name"`
	Image bool   `json:"image"`
}

func noteImageType(data []byte) string {
	switch contentType := http.DetectContentType(data); contentType {
	case "image/png", "image/jpeg", "image/gif", "image/webp":
		return contentType
	}
	return ""
}

func (a *App) SaveNoteAsset(ctx context.Context, id, name string, data []byte) (NoteAsset, error) {
	var asset NoteAsset
	if !notes.IDPattern.MatchString(id) || len(data) == 0 || len(data) > MaxNoteAssetBytes {
		return asset, invalid("Select a nonempty attachment up to 20 MiB")
	}
	// Use a content-addressed name so copies can always refer to the same asset.
	name = filepath.Base(strings.ReplaceAll(name, "\\", "/"))
	contentType := noteImageType(data)
	filename := fmt.Sprintf("%x", sha256.Sum256(data))
	a.notesMu.Lock()
	defer a.notesMu.Unlock()
	if _, err := a.taskNote(ctx, id); err != nil {
		return asset, err
	}
	root, err := os.OpenRoot(a.notesDir)
	if err != nil {
		return asset, err
	}
	defer root.Close()
	if err = root.MkdirAll(".assets", 0700); err != nil {
		return asset, err
	}
	assets, err := root.OpenRoot(".assets")
	if err != nil {
		return asset, err
	}
	defer assets.Close()
	// A reader only sees the asset after all bytes have been written.
	if err := workspace.CreateFile(assets, filename, data); err != nil && !errors.Is(err, os.ErrExist) {
		return asset, err
	}
	return NoteAsset{Path: ".assets/" + filename, Name: name, Image: contentType != ""}, nil
}

func (a *App) OpenNoteAsset(name string) (*os.File, string, error) {
	a.notesMu.Lock()
	defer a.notesMu.Unlock()
	return openNoteAsset(a.notesDir, name)
}

func openNoteAsset(dir, name string) (*os.File, string, error) {
	if !noteAssetName(name) {
		return nil, "", os.ErrNotExist
	}
	root, err := os.OpenRoot(dir)
	if err != nil {
		return nil, "", err
	}
	defer root.Close()
	f, err := root.Open(filepath.Join(".assets", name))
	if err != nil {
		return nil, "", err
	}
	info, err := f.Stat()
	if err != nil || !info.Mode().IsRegular() {
		f.Close()
		return nil, "", os.ErrNotExist
	}
	var head [512]byte
	n, _ := f.ReadAt(head[:], 0)
	return f, noteImageType(head[:n]), nil
}

func noteAssetName(name string) bool {
	if len(name) != 64 || !filepath.IsLocal(name) {
		return false
	}
	for _, c := range name {
		if !strings.ContainsRune("0123456789abcdef", c) {
			return false
		}
	}
	return true
}

// Snapshot the task body and its direct images together at dispatch or enqueue.
func noteDispatch(note model.TaskNote, taskID string) (taskDelivery, error) {
	var doc notes.Node
	if err := json.Unmarshal(note.Content, &doc); err != nil {
		return taskDelivery{}, err
	}
	body := notes.TaskBlocks(doc.Content, taskID)
	if len(body) == 0 {
		return taskDelivery{}, conflict("The dispatched task is no longer in this note")
	}
	delivery := taskDelivery{Task: &model.RunTask{
		ID: taskID, Record: model.TaskRecordNote, NoteID: note.ID,
		Directory: note.Directory, Version: hash(body),
	}}
	for _, block := range body {
		if block.Type != "noteAsset" || len(block.Attrs) == 0 {
			continue
		}
		var asset NoteAsset
		if err := json.Unmarshal(block.Attrs, &asset); err != nil {
			return taskDelivery{}, invalid("Invalid attachment in task note")
		}
		if asset.Image {
			delivery.Images = append(delivery.Images, asset)
		}
	}
	return delivery, nil
}

// Return every file written so sendLocked can clean up if its transaction rolls back.
func (a *App) addTaskImages(ctx context.Context, tx *sql.Tx, chatID string, images []NoteAsset) ([]model.Attachment, error) {
	if len(images) > MaxAttachments {
		return nil, invalid(fmt.Sprintf("A message can have up to %d attachments", MaxAttachments))
	}
	var files []model.Attachment
	for _, image := range images {
		file, err := a.copyTaskImage(chatID, image)
		if err != nil {
			return files, fmt.Errorf("Task image %q: %w", image.Name, err)
		}
		files = append(files, file)
		if !isImage(file) {
			return files, invalid(fmt.Sprintf("Task image %q has an unsupported format", image.Name))
		}
		if err := insertAttachment(ctx, tx, file); err != nil {
			return files, err
		}
	}
	return files, nil
}

func (a *App) copyTaskImage(chatID string, image NoteAsset) (model.Attachment, error) {
	file, err := newAttachment(chatID, image.Name)
	if err != nil {
		return file, err
	}
	name, ok := strings.CutPrefix(image.Path, ".assets/")
	if !ok {
		return file, invalid("Invalid note image path")
	}
	// Dispatch holds notesMu while resolving the note and its attachments.
	source, _, err := openNoteAsset(a.notesDir, name)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return file, invalid("Image is no longer available in Notes")
		}
		return file, err
	}
	defer source.Close()
	return a.writeAttachment(file, io.LimitReader(source, maxAttachmentImageBytes+1))
}
