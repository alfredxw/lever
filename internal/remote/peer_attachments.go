package remote

import (
	"errors"
	"io"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"lever/internal/app"
	"lever/internal/model"
)

func (q *peerRequest) upload(w http.ResponseWriter, r *http.Request) (any, error) {
	r.Body = http.MaxBytesReader(w, r.Body, app.MaxAttachmentBytes+(64<<10))
	reader, err := r.MultipartReader()
	if err != nil {
		return nil, &app.Error{Status: 400, Message: "Expected a file upload"}
	}
	part, err := reader.NextPart()
	if err != nil || part.FormName() != "file" || part.FileName() == "" {
		return nil, &app.Error{Status: 400, Message: "Expected one file"}
	}
	var file model.Attachment
	if r.Pattern == "POST /peer/v1/agents/{id}/attachments" {
		file, err = q.host.App.UploadDraft(r.Context(), r.PathValue("id"), part.FileName(), part)
	} else {
		file, err = q.host.App.Upload(r.Context(), r.PathValue("id"), part.FileName(), part)
	}
	if err != nil {
		return nil, err
	}
	if _, err = reader.NextPart(); !errors.Is(err, io.EOF) {
		_ = q.host.App.DeleteAttachment(r.Context(), file.ID)
		return nil, &app.Error{Status: 400, Message: "Upload one file at a time"}
	}
	return file, nil
}
func (q *peerRequest) attachment(w http.ResponseWriter, r *http.Request) (any, error) {
	file, err := q.host.App.Attachment(r.Context(), r.PathValue("id"))
	if err != nil {
		return nil, err
	}
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Content-Disposition", mime.FormatMediaType("attachment", map[string]string{"filename": file.Name}))
	switch file.MediaType {
	case "image/png", "image/jpeg", "image/gif", "image/webp":
		if r.URL.Query().Get("download") != "true" {
			w.Header().Set("Content-Type", file.MediaType)
			w.Header().Del("Content-Disposition")
		}
	}
	w.Header().Set("X-Content-Type-Options", "nosniff")
	if r.Pattern == "GET /peer/v1/attachments/{id}/preview" {
		query := r.URL.Query()
		ext := strings.ToLower(filepath.Ext(file.Name))
		if query.Get("kind") != "html" || query.Get("path") != file.Name || (ext != ".html" && ext != ".htm") {
			return nil, os.ErrNotExist
		}
		if query.Get("info") == "true" {
			return map[string]string{"path": file.Name}, nil
		}
		if query.Get("download") != "true" {
			w.Header().Set("Content-Type", "text/html")
			w.Header().Del("Content-Disposition")
			w.Header().Set("Content-Security-Policy", "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:")
		}
	}
	http.ServeFile(w, r, q.host.App.AttachmentPath(file))
	return nil, nil
}
