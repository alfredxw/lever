package app

import (
	"bytes"
	"context"
	"database/sql"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"lever/internal/model"
	"lever/internal/store"
)

const (
	MaxAttachmentBytes      = model.MaxAttachmentBytes
	MaxAttachments          = 8
	maxAttachmentImageBytes = 5 << 20
)

func (a *App) AttachmentPath(file model.Attachment) string {
	return filepath.Join(a.Store.Dir, "attachments", file.ID, file.Name)
}

func (a *App) Attachment(ctx context.Context, id string) (model.Attachment, error) {
	return store.Get[model.Attachment](ctx, a.Store.DB, "SELECT data FROM attachments WHERE id=? UNION ALL SELECT data FROM draft_attachments WHERE id=?", id, id)
}

func (a *App) Upload(ctx context.Context, chatID, name string, reader io.Reader) (model.Attachment, error) {
	return a.upload(ctx, chatID, "", name, reader)
}

func (a *App) UploadDraft(ctx context.Context, agentID, name string, reader io.Reader) (model.Attachment, error) {
	return a.upload(ctx, "", agentID, name, reader)
}

func (a *App) upload(ctx context.Context, chatID, agentID, name string, reader io.Reader) (model.Attachment, error) {
	file, err := newAttachment(chatID, name)
	if err != nil {
		return file, err
	}
	if agentID != "" {
		agent, err := store.Get[model.Agent](ctx, a.Store.DB, "SELECT data FROM agents WHERE id=?", agentID)
		if err != nil {
			return file, err
		}
		if agent.Archived {
			return file, conflict("Agent is archived")
		}
	} else {
		if _, err := store.Get[model.Chat](ctx, a.Store.DB, "SELECT data FROM chats WHERE id=?", chatID); err != nil {
			return file, err
		}
	}
	file, err = a.writeAttachment(file, reader)
	if err != nil {
		return file, err
	}
	err = a.Store.Write(ctx, func(tx *sql.Tx) error {
		if agentID != "" {
			_, err := tx.Exec("INSERT INTO draft_attachments(id,agent_id,data) VALUES(?,?,?)", file.ID, agentID, store.JSON(file))
			return err
		}
		return insertAttachment(ctx, tx, file)
	})
	if err != nil {
		_ = a.removeAttachmentFile(file)
	}
	return file, err
}

func newAttachment(chatID, name string) (model.Attachment, error) {
	file := model.Attachment{ID: ID(), ChatID: chatID, Name: filepath.Base(strings.ReplaceAll(name, "\\", "/"))}
	if file.Name == "." || !filepath.IsLocal(file.Name) || len(file.Name) > 240 || strings.ContainsAny(file.Name, "\x00\r\n") {
		return file, invalid("Invalid attachment name")
	}
	return file, nil
}

func insertAttachment(ctx context.Context, tx *sql.Tx, file model.Attachment) error {
	_, err := tx.ExecContext(ctx, "INSERT INTO attachments(id,chat_id,data) VALUES(?,?,?)", file.ID, file.ChatID, store.JSON(file))
	return err
}

func (a *App) removeAttachmentFile(file model.Attachment) error {
	return os.RemoveAll(filepath.Dir(a.AttachmentPath(file)))
}

// The caller publishes the attachment and removes its file if publication fails.
func (a *App) writeAttachment(file model.Attachment, reader io.Reader) (model.Attachment, error) {
	dir := filepath.Dir(a.AttachmentPath(file))
	if err := os.MkdirAll(dir, 0700); err != nil {
		return file, err
	}
	written := false
	defer func() {
		if !written {
			_ = a.removeAttachmentFile(file)
		}
	}()
	out, err := os.OpenFile(a.AttachmentPath(file), os.O_CREATE|os.O_EXCL|os.O_RDWR, 0600)
	if err != nil {
		return file, err
	}
	defer out.Close()
	file.Size, err = io.Copy(out, io.LimitReader(reader, MaxAttachmentBytes+1))
	if err != nil {
		return file, err
	}
	if file.Size > MaxAttachmentBytes {
		return file, invalid("Each attachment must be at most 20 MiB")
	}
	header := make([]byte, 512)
	n, err := out.ReadAt(header, 0)
	if err != nil && !errors.Is(err, io.EOF) {
		return file, err
	}
	file.MediaType = attachmentMediaType(file.Name, header[:n])
	if isImage(file) && file.Size > maxAttachmentImageBytes {
		return file, invalid("Images must be at most 5 MiB")
	}
	if err = out.Sync(); err != nil {
		return file, err
	}
	written = true
	return file, nil
}

func attachmentMediaType(name string, header []byte) string {
	mediaType := http.DetectContentType(header)
	switch mediaType {
	case "audio/wave", "audio/x-wav":
		return "audio/wav"
	case "application/ogg":
		if bytes.Contains(header, []byte("OpusHead")) || bytes.Contains(header, []byte("\x01vorbis")) {
			return "audio/ogg"
		}
	case "video/mp4", "application/octet-stream":
		if (mediaType == "video/mp4" && strings.EqualFold(filepath.Ext(name), ".m4a")) || (len(header) >= 12 && string(header[4:12]) == "ftypM4A ") {
			return "audio/mp4"
		}
		if bytes.HasPrefix(header, []byte("fLaC")) {
			return "audio/flac"
		}
		if strings.EqualFold(filepath.Ext(name), ".aac") && len(header) >= 7 && header[0] == 0xff && header[1]&0xf6 == 0xf0 {
			return "audio/aac"
		}
		if strings.EqualFold(filepath.Ext(name), ".mp3") && len(header) >= 4 && header[0] == 0xff && header[1]&0xe6 == 0xe2 && header[1]&0x18 != 0x08 && header[2]>>4 != 0xf && header[2]&0x0c != 0x0c {
			return "audio/mpeg"
		}
	case "video/webm":
		if strings.EqualFold(filepath.Ext(name), ".weba") {
			return "audio/webm"
		}
	}
	return mediaType
}

func isImage(file model.Attachment) bool {
	switch file.MediaType {
	case "image/png", "image/jpeg", "image/webp", "image/gif":
		return true
	}
	return false
}

func (a *App) DeleteAttachment(ctx context.Context, id string) error {
	var file model.Attachment
	err := a.Store.Write(ctx, func(tx *sql.Tx) error {
		var err error
		file, err = store.Get[model.Attachment](ctx, tx, "SELECT data FROM attachments WHERE id=? UNION ALL SELECT data FROM draft_attachments WHERE id=?", id, id)
		if err != nil {
			return err
		}
		var used int
		if err = tx.QueryRowContext(ctx, "SELECT COUNT(*) FROM run_attachments WHERE attachment_id=?", id).Scan(&used); err != nil {
			return err
		}
		if used > 0 {
			return conflict("Attachment is already part of a sent message")
		}
		if file.ChatID == "" {
			_, err = tx.Exec("DELETE FROM draft_attachments WHERE id=?", id)
		} else {
			_, err = tx.Exec("DELETE FROM attachments WHERE id=?", id)
		}
		return err
	})
	if err != nil {
		return err
	}
	return a.removeAttachmentFile(file)
}
