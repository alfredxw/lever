package app

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"strings"

	"lever/internal/model"
	"lever/internal/notes"
	"lever/internal/workspace"
)

func markdownPath(path string) bool {
	ext := filepath.Ext(path)
	return strings.EqualFold(ext, ".md") || strings.EqualFold(ext, ".markdown")
}

// Source files have no Lever metadata. Their library-relative path identifies
// them across saves, including the atomic replacements made by other editors.
func decodeMarkdownNote(file model.FileContent) (parsedNote, error) {
	if file.Truncated {
		return parsedNote{}, errors.New("Markdown file exceeds the file size limit")
	}
	block := notes.Node{Type: "codeBlock"}
	if file.Content != "" {
		block.Content = []notes.Node{{Type: "text", Text: file.Content}}
	}
	body, err := notes.Content([]notes.Node{block})
	if err != nil || len(body) > notes.MaxContent {
		return parsedNote{}, errors.New("Markdown content exceeds 1 MiB")
	}
	sum := sha256.Sum256([]byte("lever:markdown:" + file.Path))
	id := fmt.Sprintf("%x-%x-%x-%x-%x", sum[:4], sum[4:6], sum[6:8], sum[8:10], sum[10:16])
	return parsedNote{note: model.TaskNote{ID: id, Path: file.Path, Title: filepath.Base(file.Path), Version: file.Version, Content: body}}, nil
}

func (a *App) saveMarkdownNote(ctx context.Context, id string, input model.TaskNote) (model.TaskNote, error) {
	a.notesMu.Lock()
	defer a.notesMu.Unlock()
	var result model.TaskNote
	if input.Directory != a.notesDir {
		return result, ErrTaskNotesDirectoryChanged
	}
	note, err := a.taskNote(ctx, id)
	if err != nil {
		return result, err
	}
	if input.ID != id || input.Path != note.Path || !markdownPath(note.Path) || input.Title != note.Title || input.Project != "" {
		return result, invalid("Reopen the Markdown source file before saving")
	}
	var doc notes.Node
	if len(input.Content) > notes.MaxContent || json.Unmarshal(input.Content, &doc) != nil || doc.Type != "doc" || len(doc.Content) != 1 || doc.Content[0].Type != "codeBlock" {
		return result, invalid("Expected Markdown source text")
	}
	var source strings.Builder
	for _, node := range doc.Content[0].Content {
		if node.Type != "text" || len(node.Marks) != 0 || len(node.Content) != 0 {
			return result, invalid("Expected Markdown source text")
		}
		source.WriteString(node.Text)
	}
	parsed, err := decodeMarkdownNote(model.FileContent{Path: note.Path, Content: source.String()})
	if err != nil {
		return result, invalid(err.Error())
	}
	file, err := workspace.Write(a.notesDir, note.Path, source.String(), input.Version)
	if errors.Is(err, workspace.ErrFileConflict) {
		delete(a.noteFiles, note.Path)
		return result, ErrTaskNoteVersion
	}
	if err != nil {
		return result, err
	}
	note.Version, note.Content = file.Version, parsed.note.Content
	a.notifyTaskNote(ctx, id)
	return note, nil
}
