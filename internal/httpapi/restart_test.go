package httpapi_test

import (
	"context"
	"database/sql"
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"testing"
	"testing/fstest"

	"lever/internal/app"
	"lever/internal/httpapi"
	"lever/internal/model"
	"lever/internal/store"
)

func TestBackendRestartRecoversCodexTurn(t *testing.T) {
	cases := []struct {
		name, leverStatus, nativeStatus, wantStatus string
		legacy, shutdown, pendingRequest            bool
		missingMatch, uncertainDelivery             bool
		writerBusy, writerAdvanced                  bool
		wantContinuation                            bool
	}{
		{name: "legacy interrupted", leverStatus: "running", nativeStatus: "interrupted", legacy: true, wantStatus: "completed", wantContinuation: true},
		{name: "graceful shutdown", leverStatus: "interrupted", nativeStatus: "interrupted", shutdown: true, wantStatus: "completed", wantContinuation: true},
		{name: "writer releases interrupted turn", leverStatus: "interrupted", nativeStatus: "interrupted", shutdown: true, writerBusy: true, wantStatus: "completed", wantContinuation: true},
		{name: "writer advances before releasing", leverStatus: "running", nativeStatus: "interrupted", legacy: true, writerBusy: true, writerAdvanced: true, wantStatus: "unknown"},
		{name: "completed before restart", leverStatus: "running", nativeStatus: "completed", wantStatus: "completed"},
		{name: "legacy result already marked unconfirmed", leverStatus: "unknown", nativeStatus: "completed", legacy: true, wantStatus: "completed"},
		{name: "explicit stop", leverStatus: "cancelling", nativeStatus: "interrupted", wantStatus: "interrupted"},
		{name: "pending approval", leverStatus: "waiting_user", nativeStatus: "interrupted", pendingRequest: true, wantStatus: "interrupted"},
		{name: "different turn", leverStatus: "running", nativeStatus: "interrupted", missingMatch: true, wantStatus: "unknown"},
		{name: "unconfirmed continuation delivery", leverStatus: "starting", nativeStatus: "interrupted", uncertainDelivery: true, wantStatus: "unknown"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			f := newFixture(t)
			chat := f.chat(f.agent("codex"))
			run := f.send(chat.ID, "main", "", "original prompt")
			run = f.wait(run.ID, "completed")
			ctx := t.Context()
			session, err := store.Get[model.Session](ctx, f.a.Store.DB, "SELECT data FROM sessions WHERE id=?", run.SessionID)
			if err != nil || run.NativeTurnID == nil {
				t.Fatalf("missing Codex binding: %v", err)
			}
			turnID := *run.NativeTurnID
			if tc.legacy {
				turnID = "native-turn-from-legacy-history"
			}
			if tc.missingMatch {
				turnID = "newer-native-turn"
			}
			saved := map[string]any{
				"threadId": session.NativeID, "writerBusy": tc.writerBusy, "turns": []map[string]any{{
					"id": turnID, "status": tc.nativeStatus, "completedAt": 123,
					"items": []map[string]any{
						{"type": "userMessage", "id": "user-1", "clientId": run.ID},
						{"type": "agentMessage", "id": "saved-answer", "text": "Saved native output"},
					},
				}},
			}
			if tc.writerAdvanced {
				saved["turnsAfterResume"] = []map[string]any{{"id": "another-clients-turn", "status": "completed", "completedAt": 234}}
			}
			history, err := json.Marshal(saved)
			if err != nil {
				t.Fatal(err)
			}
			if err = os.WriteFile(filepath.Join(f.root, "codex-restart-history.json"), history, 0600); err != nil {
				t.Fatal(err)
			}
			run.Status, run.FinishedAt, run.ResumeAfterShutdown = tc.leverStatus, "", tc.shutdown
			if tc.leverStatus == "unknown" {
				run.Error = "The backend stopped before the runtime confirmed a result. Verify that the previous execution has stopped before continuing."
			}
			run.Items = []model.Item{}
			if tc.legacy {
				run.NativeTurnID = nil
			}
			if tc.uncertainDelivery {
				empty := ""
				run.NativeTurnID = &empty
			}
			if err := f.a.Store.Write(ctx, func(tx *sql.Tx) error {
				if err := store.SaveRun(tx, run); err != nil {
					return err
				}
				if tc.pendingRequest {
					return store.SaveRequest(tx, model.Request{ID: "old-approval", RunID: run.ID, ChatID: chat.ID, SessionID: session.ID, Kind: "approval", Status: "pending"})
				}
				return nil
			}); err != nil {
				t.Fatal(err)
			}
			f.s.HTTP.Close()
			if err := f.a.Close(); err != nil {
				t.Fatal(err)
			}
			reopened, err := app.Open(f.a.Store.Dir)
			if err != nil {
				t.Fatal(err)
			}
			defer reopened.Close()
			srv, err := httpapi.New(reopened, "127.0.0.1:0", "", fstest.MapFS{})
			if err != nil {
				t.Fatal(err)
			}
			go srv.Serve()
			defer srv.Close(context.Background())
			after := &fixture{t: t, a: reopened, s: srv}
			// Wait for the server's startup reservations, including an unknown
			// outcome that may return to the same status after inspecting Codex.
			var overview model.Overview
			after.request("GET", "/overview", nil, 200, &overview)
			result := after.wait(run.ID, tc.wantStatus)
			continued := slices.ContainsFunc(result.Items, func(i model.Item) bool { return i.Text == "Continued from the saved native turn" })
			if continued != tc.wantContinuation {
				t.Fatalf("continuation %t, want %t", continued, tc.wantContinuation)
			}
			if tc.wantStatus != "unknown" && !slices.ContainsFunc(result.Items, func(i model.Item) bool { return i.Text == "Saved native output" }) {
				t.Fatal("missing output from the original turn")
			}
			var count int
			if err := reopened.Store.DB.QueryRow("SELECT COUNT(*) FROM runs WHERE session_id=?", session.ID).Scan(&count); err != nil || count != 1 {
				t.Fatalf("restart duplicated the Run: %d %v", count, err)
			}
		})
	}
}
