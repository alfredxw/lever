package remote

import (
	"bytes"
	"database/sql"
	"image"
	"image/png"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"testing"

	"lever/internal/app"
	"lever/internal/model"
	"lever/internal/store"
	"lever/internal/workspace"
)

func TestPeerRunPreviewHostGeneratedImages(t *testing.T) {
	storeDir := t.TempDir()
	a, err := app.Open(storeDir)
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	s := a.Store

	workspaceDir, err := workspace.Canonical(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	var pngData bytes.Buffer
	if err := png.Encode(&pngData, image.NewRGBA(image.Rect(0, 0, 1, 1))); err != nil {
		t.Fatal(err)
	}

	// Materialized session generated image outside workspace.
	genDir := filepath.Join(storeDir, "sessions", "sess-1", "generated-images", "run-1")
	if err := os.MkdirAll(genDir, 0o700); err != nil {
		t.Fatal(err)
	}
	genImage := filepath.Join(genDir, "result.png")
	if err := os.WriteFile(genImage, pngData.Bytes(), 0o600); err != nil {
		t.Fatal(err)
	}

	// Sensitive host image (inside .ssh) even if linked by the run must stay blocked.
	sshDir := filepath.Join(t.TempDir(), ".ssh")
	if err := os.MkdirAll(sshDir, 0o700); err != nil {
		t.Fatal(err)
	}
	sshImage := filepath.Join(sshDir, "secret.png")
	if err := os.WriteFile(sshImage, pngData.Bytes(), 0o600); err != nil {
		t.Fatal(err)
	}

	// Unreferenced host image outside workspace must stay blocked.
	otherImage := filepath.Join(t.TempDir(), "other.png")
	if err := os.WriteFile(otherImage, pngData.Bytes(), 0o600); err != nil {
		t.Fatal(err)
	}

	// Non-image HTML outside workspace must stay blocked on remote peer preview.
	outsideHTML := filepath.Join(t.TempDir(), "report.html")
	if err := os.WriteFile(outsideHTML, []byte("<h1>hi</h1>"), 0o600); err != nil {
		t.Fatal(err)
	}

	agent := model.Agent{
		ID:   "agent-1",
		Name: "A",
		Profile: model.Profile{
			Scope: model.Scope{
				PrimaryRootID: "root-1",
				Roots:         []model.Root{{ID: "root-1", Path: workspaceDir}},
			},
		},
	}
	session := model.Session{ID: "sess-1", ChatID: "chat-1", AgentID: "agent-1", Kind: "main", Scope: agent.Profile.Scope}
	run := model.Run{
		ID:        "run-1",
		ChatID:    "chat-1",
		SessionID: "sess-1",
		AgentID:   "agent-1",
		Status:    "completed",
		Items: []model.Item{
			{
				ID:         "ig-1",
				Kind:       "tool",
				ToolAction: model.ToolActionImage,
				Title:      "Generate image",
				Status:     "completed",
				ImageFiles: []model.ImageFile{
					{Path: genImage, Name: "result.png"},
					{Path: sshImage, Name: "secret.png"},
				},
			},
		},
	}

	err = s.Write(t.Context(), func(tx *sql.Tx) error {
		if _, err := tx.Exec("INSERT INTO agents(id,data) VALUES(?,?)", agent.ID, store.JSON(agent)); err != nil {
			return err
		}
		if _, err := tx.Exec("INSERT INTO chats(id,agent_id,data) VALUES(?,?,?)", "chat-1", agent.ID, store.JSON(model.Chat{ID: "chat-1", AgentID: agent.ID})); err != nil {
			return err
		}
		if _, err := tx.Exec("INSERT INTO sessions(id,chat_id,kind,data) VALUES(?,?,?,?)", session.ID, session.ChatID, session.Kind, store.JSON(session)); err != nil {
			return err
		}
		_, err := tx.Exec("INSERT INTO runs(id,session_id,chat_id,agent_id,command_id,input_hash,status,data) VALUES(?,?,?,?,?,?,?,?)", run.ID, run.SessionID, run.ChatID, run.AgentID, "cmd-1", "h1", run.Status, store.JSON(run))
		return err
	})
	if err != nil {
		t.Fatal(err)
	}

	q := &peerRequest{host: &Host{App: a}}
	call := func(kind, path string) (*httptest.ResponseRecorder, error) {
		query := url.Values{"kind": {kind}, "path": {path}}
		r := httptest.NewRequest(http.MethodGet, "/peer/v1/runs/run-1/preview?"+query.Encode(), nil)
		r.SetPathValue("id", "run-1")
		w := httptest.NewRecorder()
		_, err := q.runPreview(w, r)
		return w, err
	}

	w, err := call("image", genImage)
	if err != nil || w.Code != http.StatusOK || w.Header().Get("Content-Type") != "image/png" || !bytes.Equal(w.Body.Bytes(), pngData.Bytes()) {
		t.Fatalf("generated image preview failed: err=%v status=%d headers=%v", err, w.Code, w.Header())
	}

	if _, err := call("image", sshImage); err == nil {
		t.Fatal("expected sensitive .ssh image to be rejected")
	}
	if _, err := call("image", otherImage); err == nil {
		t.Fatal("expected unreferenced host image to be rejected")
	}
	if _, err := call("html", outsideHTML); err == nil {
		t.Fatal("expected non-workspace html to be rejected")
	}
}
