package httpapi_test

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"image"
	"image/color"
	"image/png"
	"io"
	"mime/multipart"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"testing/fstest"

	"lever/internal/app"
	"lever/internal/httpapi"
	"lever/internal/model"
	"lever/internal/store"
)

func TestAgentAvatarDefaultsOnlyOnCreate(t *testing.T) {
	f := newFixture(t)
	agent := f.agent("codex")
	want := model.Avatar{Kind: "emoji", Value: model.DefaultAvatarEmoji, Color: model.DefaultAvatarColor}
	if agent.Avatar == nil || *agent.Avatar != want {
		t.Fatalf("default avatar = %+v, want %+v", agent.Avatar, want)
	}

	// An existing Agent may have a custom icon and a legacy automatic background.
	agent.Avatar = &model.Avatar{Kind: "lucide", Value: "Moon"}
	var edited model.Agent
	f.request("PUT", "/agents/"+agent.ID, agent, 200, &edited)
	if edited.Avatar == nil || *edited.Avatar != *agent.Avatar {
		t.Fatalf("editing changed the avatar to %+v", edited.Avatar)
	}

	for _, color := range []string{"", "black"} {
		draft := model.Agent{Name: "Moon", Profile: agent.Profile, Avatar: &model.Avatar{Kind: "lucide", Value: "Moon", Color: color}}
		var created model.Agent
		f.request("POST", "/agents", draft, 200, &created)
		want := *draft.Avatar
		if want.Color == "" {
			want.Color = model.DefaultAvatarColor
		}
		if created.Avatar == nil || *created.Avatar != want {
			t.Fatalf("creating with color %q got %+v, want %+v", color, created.Avatar, want)
		}
	}
}

func testPNGBytes(t *testing.T, c color.RGBA) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, 8, 8))
	for y := 0; y < 8; y++ {
		for x := 0; x < 8; x++ {
			img.SetRGBA(x, y, c)
		}
	}
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func uploadAvatarPart(t *testing.T, f *fixture, field, filename string, data []byte, extraPart bool) *http.Response {
	t.Helper()
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	part, err := writer.CreateFormFile(field, filename)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := part.Write(data); err != nil {
		t.Fatal(err)
	}
	if extraPart {
		second, err := writer.CreateFormFile("file", "second.png")
		if err != nil {
			t.Fatal(err)
		}
		if _, err := second.Write(data); err != nil {
			t.Fatal(err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	req, err := http.NewRequest("POST", f.s.URL+"/api/avatars", &body)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer "+f.s.Token)
	req.Header.Set("Content-Type", writer.FormDataContentType())
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	return resp
}

func TestAgentAvatarImageUploadAndValidation(t *testing.T) {
	f := newFixture(t)
	agent := f.agent("codex")
	pngData := testPNGBytes(t, color.RGBA{R: 32, G: 120, B: 220, A: 255})

	// Reject non-image, empty, oversized, and multi-file uploads.
	for _, tc := range []struct {
		name      string
		filename  string
		data      []byte
		extraPart bool
	}{
		{name: "text", filename: "notes.txt", data: []byte("plain text")},
		{name: "svg", filename: "icon.svg", data: []byte(`<svg xmlns="http://www.w3.org/2000/svg"></svg>`)},
		{name: "empty", filename: "empty.png", data: nil},
		{name: "oversized", filename: "huge.png", data: append(append([]byte{}, pngData...), make([]byte, app.MaxAvatarBytes)...)},
		{name: "multiple", filename: "a.png", data: pngData, extraPart: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			resp := uploadAvatarPart(t, f, "file", tc.filename, tc.data, tc.extraPart)
			resp.Body.Close()
			if resp.StatusCode != 400 {
				t.Fatalf("upload %s status = %d, want 400", tc.name, resp.StatusCode)
			}
		})
	}

	// Upload a valid PNG and verify deduplication and secure serving headers.
	resp := uploadAvatarPart(t, f, "file", "avatar.png", pngData, false)
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("upload status = %d, want 200", resp.StatusCode)
	}
	var uploaded model.Avatar
	if err := json.NewDecoder(resp.Body).Decode(&uploaded); err != nil {
		t.Fatal(err)
	}
	if uploaded.Kind != "image" || len(uploaded.Value) != 64 || uploaded.Color != "" {
		t.Fatalf("unexpected uploaded avatar: %+v", uploaded)
	}

	respDup := uploadAvatarPart(t, f, "file", "same.png", pngData, false)
	defer respDup.Body.Close()
	var dup model.Avatar
	if respDup.StatusCode != 200 || json.NewDecoder(respDup.Body).Decode(&dup) != nil || dup != uploaded {
		t.Fatalf("duplicate upload = (%d, %+v), want %+v", respDup.StatusCode, dup, uploaded)
	}

	getReq, err := http.NewRequest("GET", f.s.URL+"/api/avatars/"+uploaded.Value, nil)
	if err != nil {
		t.Fatal(err)
	}
	getReq.Header.Set("Authorization", "Bearer "+f.s.Token)
	getResp, err := http.DefaultClient.Do(getReq)
	if err != nil {
		t.Fatal(err)
	}
	defer getResp.Body.Close()
	body, err := io.ReadAll(getResp.Body)
	if err != nil {
		t.Fatal(err)
	}
	if getResp.StatusCode != 200 || !bytes.Equal(body, pngData) ||
		getResp.Header.Get("Content-Type") != "image/png" ||
		getResp.Header.Get("X-Content-Type-Options") != "nosniff" ||
		!strings.Contains(getResp.Header.Get("Content-Security-Policy"), "sandbox") ||
		!strings.Contains(getResp.Header.Get("Cache-Control"), "immutable") {
		t.Fatalf("unexpected GET /api/avatars response: status=%d headers=%v len=%d", getResp.StatusCode, getResp.Header, len(body))
	}

	// Reject unknown IDs and path-like IDs.
	for _, bad := range []string{"not-a-hash", strings.Repeat("a", 64)} {
		req, _ := http.NewRequest("GET", f.s.URL+"/api/avatars/"+bad, nil)
		req.Header.Set("Authorization", "Bearer "+f.s.Token)
		r, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		r.Body.Close()
		if r.StatusCode != 404 {
			t.Fatalf("GET /api/avatars/%s status = %d, want 404", bad, r.StatusCode)
		}
	}

	// Creating with an uploaded image leaves Color empty and persists the image.
	draft := model.Agent{
		Name:    "Photo Agent",
		Profile: agent.Profile,
		Avatar:  &model.Avatar{Kind: "image", Value: uploaded.Value, Color: "black"},
	}
	var created model.Agent
	f.request("POST", "/agents", draft, 200, &created)
	if created.Avatar == nil || *created.Avatar != uploaded {
		t.Fatalf("created image avatar = %+v, want %+v", created.Avatar, uploaded)
	}

	// Reject missing image hashes and unknown presets.
	f.request("POST", "/agents", model.Agent{
		Name:    "Missing Image",
		Profile: agent.Profile,
		Avatar:  &model.Avatar{Kind: "image", Value: strings.Repeat("b", 64)},
	}, 400, nil)
	f.request("POST", "/agents", model.Agent{
		Name:    "Bad Preset",
		Profile: agent.Profile,
		Avatar:  &model.Avatar{Kind: "preset", Value: "unknown"},
	}, 400, nil)

	// Built-in Lever preset avatar is accepted and clears Color.
	var presetAgent model.Agent
	f.request("POST", "/agents", model.Agent{
		Name:    "Lever Copy",
		Profile: agent.Profile,
		Avatar:  &model.Avatar{Kind: "preset", Value: model.StarterAvatarPreset, Color: "red"},
	}, 200, &presetAgent)
	wantPreset := model.Avatar{Kind: "preset", Value: model.StarterAvatarPreset}
	if presetAgent.Avatar == nil || *presetAgent.Avatar != wantPreset {
		t.Fatalf("preset avatar = %+v, want %+v", presetAgent.Avatar, wantPreset)
	}

	// Editing other fields still succeeds even if the image file was removed from disk.
	if err := os.Remove(filepath.Join(f.a.Store.Dir, "avatars", uploaded.Value)); err != nil {
		t.Fatal(err)
	}
	created.Name = "Renamed Photo Agent"
	var renamed model.Agent
	f.request("PUT", "/agents/"+created.ID, created, 200, &renamed)
	if renamed.Name != "Renamed Photo Agent" || renamed.Avatar == nil || *renamed.Avatar != uploaded {
		t.Fatalf("editing agent with unchanged missing image avatar failed: %+v", renamed)
	}
}

func TestAgentCreationToolUsesSessionScopeAndIsIdempotent(t *testing.T) {
	f := newFixture(t)
	parent := f.agent("codex")
	parent.Profile.Roots = append(parent.Profile.Roots, model.Root{ID: "second", Path: t.TempDir()})
	parent.Profile.PrimaryRootID = "second"
	parent.Profile.Permission = "full_access"
	f.request("PUT", "/agents/"+parent.ID, parent, 200, &parent)
	chat := f.chat(parent)
	first := f.wait(f.send(chat.ID, "main", "", "Start the conversation").ID, "completed")
	session := f.waitNative(first.SessionID)
	parent.Profile.Scope = model.Scope{Roots: []model.Root{{ID: "new", Path: t.TempDir()}}, PrimaryRootID: "new"}
	f.request("PUT", "/agents/"+parent.ID, parent, 200, &parent)

	create := historyCall{Name: "agent_create", Arguments: map[string]any{
		"name": "Release Notes", "instructions": "Summarize merged changes.", "requestKey": "release-notes",
	}}
	changed := historyCall{Name: create.Name, Arguments: map[string]any{
		"name": "Different Agent", "requestKey": "release-notes",
	}}
	run, results, _ := historyTurn(f, chat.ID, "main", create, create, changed)
	if len(run.CreatedAgents) != 1 {
		t.Fatalf("unexpected creation receipts: %+v", run.CreatedAgents)
	}
	id := run.CreatedAgents[0].AgentID
	if results[0].Error != "" || results[1].Error != "" || results[2].Error == "" || results[0].Body.AgentID != id || results[1].Body.AgentID != id {
		t.Fatalf("unexpected tool results: %+v", results)
	}
	created, err := store.Get[model.Agent](context.Background(), f.a.Store.DB, "SELECT data FROM agents WHERE id=?", id)
	if err != nil {
		t.Fatal(err)
	}
	profile := created.Profile
	if created.ID == parent.ID || created.Name != "Release Notes" || profile.Instructions != "Summarize merged changes." ||
		profile.Provider != "codex" || profile.Permission != "auto_review" || len(profile.Roots) != len(session.Roots) {
		t.Fatalf("unexpected created Agent: %+v", created)
	}
	for i, root := range profile.Roots {
		original := session.Roots[i]
		if root.Path != original.Path || root.ID == original.ID || (root.ID == profile.PrimaryRootID) != (original.ID == session.PrimaryRootID) {
			t.Fatalf("created Agent scope = %+v, want the session directories and default from %+v", profile.Scope, session.Scope)
		}
	}

	var readOnly model.Run
	f.request("POST", "/messages", model.SendInput{
		CommandID: app.ID(), ChatID: chat.ID, Operation: "main",
		Text:      `[chat-context] [{"name":"agent_create","arguments":{"name":"Read-only Agent","requestKey":"read-only"}}]`,
		Selection: &model.Selection{Provider: "codex", Permission: "read_only"},
	}, 200, &readOnly)
	readOnly = f.wait(readOnly.ID, "completed")
	var overview model.Overview
	f.request("GET", "/overview", nil, 200, &overview)
	if len(readOnly.CreatedAgents) != 0 || len(overview.Agents) != 2 || len(overview.Chats) != 1 {
		t.Fatalf("unexpected Agents or Chats after creating an Agent: %+v %+v", overview.Agents, overview.Chats)
	}
}

func TestQueuedRunsReadCurrentInstructionsWithoutChangingActiveRuns(t *testing.T) {
	for _, runtime := range []string{"codex", "claude"} {
		t.Run(runtime, func(t *testing.T) {
			f := newFixture(t)
			agent := f.agent(runtime)
			chat := f.chat(agent)
			active := f.send(chat.ID, "main", "", "[hang] keep current instructions")
			bound := f.waitNative(active.SessionID)
			var queued model.Run
			f.request("POST", "/messages", model.SendInput{CommandID: app.ID(), ChatID: chat.ID, Operation: "main", Text: "[wire] next instructions", Delivery: "queue"}, 200, &queued)
			agent.Profile.Instructions = "updated while queued"
			f.request("PUT", "/agents/"+agent.ID, agent, 200, &agent)
			f.request("POST", "/messages", model.SendInput{CommandID: app.ID(), ChatID: chat.ID, Operation: "main", Text: "[wire] finish current run", Delivery: "steer"}, 200, nil)
			finished := f.wait(active.ID, "completed")
			if text := store.JSON(finished.Items); !strings.Contains(text, "profile-v1") || strings.Contains(text, "updated while queued") {
				t.Fatal("Agent edit changed the active execution or its steer", text)
			}
			finished = f.wait(queued.ID, "completed")
			var receipt map[string]any
			if len(finished.Items) != 1 || json.Unmarshal([]byte(strings.TrimPrefix(finished.Items[0].Text, "wire:")), &receipt) != nil {
				t.Fatal("queued execution did not report its native settings")
			}
			if receipt["instructions"] != agent.Profile.Instructions || receipt["native"] != bound.NativeID || finished.Handoff {
				t.Fatal("queued execution did not apply new instructions to the same native session", receipt)
			}
		})
	}
}

func TestLegacyProfilesUpgradeWithoutChangingSessionSettings(t *testing.T) {
	for _, runtime := range []string{"codex", "claude"} {
		t.Run(runtime, func(t *testing.T) {
			f := newFixture(t)
			agent := f.agent(runtime)
			agent.Profile.Permission = "read_only"
			if runtime == "claude" {
				agent.Profile.Permission = "accept_edits"
			}
			f.request("PUT", "/agents/"+agent.ID, agent, 200, &agent)
			original := agent.Profile
			chat := f.chat(agent)
			var first model.Run
			selection := model.Selection{Provider: runtime, Model: "session-model", Permission: original.Permission, Effort: "high", Fast: true}
			f.request("POST", "/messages", model.SendInput{CommandID: app.ID(), ChatID: chat.ID, Operation: "main", Text: "[wire] original", Selection: &selection}, 200, &first)
			f.wait(first.ID, "completed")
			bound := f.waitNative(first.SessionID)
			queued := model.Run{ID: app.ID(), SessionID: bound.ID, ChatID: chat.ID, AgentID: agent.ID, Input: "[wire] queued before upgrade", Selection: selection, Status: "queued", Items: []model.Item{}, CreatedAt: bound.CreatedAt}
			queued.Selection.Permission = ""
			if err := f.a.Store.Write(context.Background(), func(tx *sql.Tx) error {
				return store.InsertRun(tx, &queued, app.ID(), "legacy")
			}); err != nil {
				t.Fatal(err)
			}
			agent.Profile.Instructions = "current Agent instructions"
			agent.Profile.Model = "new-default-model"
			agent.Profile.Permission = "ask"
			agent.Profile.Scope = model.Scope{Roots: []model.Root{{ID: "new-root", Path: t.TempDir()}}, PrimaryRootID: "new-root"}
			f.request("PUT", "/agents/"+agent.ID, agent, 200, &agent)
			// Recreate the old persisted shape, including an omitted permission.
			if _, err := f.a.Store.DB.Exec(`UPDATE sessions SET data=json_remove(json_set(data,'$.revision',1,'$.profile',json(?)),'$.roots','$.primaryRootId','$.selection.permission') WHERE id=?`, store.JSON(original), first.SessionID); err != nil {
				t.Fatal(err)
			}
			if _, err := f.a.Store.DB.Exec(`UPDATE agents SET data=json_set(data,'$.revision',3) WHERE id=?`, agent.ID); err != nil {
				t.Fatal(err)
			}
			other := "claude"
			if runtime == "claude" {
				other = "codex"
			}
			legacy := []model.Selection{{}, {Provider: other, Model: "other-model"}}
			ids := []string{app.ID(), app.ID()}
			for i, value := range legacy {
				data := map[string]any{"id": ids[i], "chatId": chat.ID, "agentId": agent.ID, "kind": "topic", "revision": 1, "profile": original, "selection": value, "nativeId": "", "createdAt": bound.CreatedAt}
				if _, err := f.a.Store.DB.Exec("INSERT INTO sessions(id,chat_id,kind,data) VALUES(?,?,'topic',?)", ids[i], chat.ID, store.JSON(data)); err != nil {
					t.Fatal(err)
				}
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
			server, err := httpapi.New(reopened, "127.0.0.1:0", "", fstest.MapFS{"index.html": {Data: []byte("Lever")}})
			if err != nil {
				t.Fatal(err)
			}
			defer server.HTTP.Close()
			go server.Serve()
			f.a, f.s = reopened, server
			ctx := context.Background()
			upgraded, err := store.Get[model.Session](ctx, reopened.Store.DB, "SELECT data FROM sessions WHERE id=?", first.SessionID)
			if err != nil {
				t.Fatal(err)
			}
			if upgraded.NativeID != bound.NativeID || upgraded.Selection != selection || store.JSON(upgraded.Scope) != store.JSON(original.Scope) {
				t.Fatal("upgrade changed the existing session", upgraded)
			}
			for i, id := range ids {
				value, err := store.Get[model.Session](ctx, reopened.Store.DB, "SELECT data FROM sessions WHERE id=?", id)
				if err != nil {
					t.Fatal(err)
				}
				want := model.Selection{Provider: runtime, Permission: original.Permission}
				if i == 1 {
					want = model.Selection{Provider: other, Model: "other-model", Permission: "ask"}
				}
				if value.Selection != want {
					t.Fatal("upgrade did not preserve legacy selection defaults", value.Selection)
				}
			}
			var obsolete int
			if err := reopened.Store.DB.QueryRow(`SELECT (SELECT COUNT(*) FROM sessions WHERE json_type(data,'$.profile') IS NOT NULL OR json_type(data,'$.revision') IS NOT NULL) + (SELECT COUNT(*) FROM agents WHERE json_type(data,'$.revision') IS NOT NULL)`).Scan(&obsolete); err != nil || obsolete != 0 {
				t.Fatal("upgrade retained Profile versions", obsolete, err)
			}
			f.request("POST", "/sessions/"+bound.ID+"/queue/resume", map[string]bool{}, 200, nil)
			next := f.wait(queued.ID, "completed")
			var receipt map[string]any
			if len(next.Items) != 1 || json.Unmarshal([]byte(strings.TrimPrefix(next.Items[0].Text, "wire:")), &receipt) != nil {
				t.Fatal("resumed execution did not report its native settings")
			}
			if receipt["native"] != bound.NativeID || receipt["cwd"] != original.Roots[0].Path || receipt["instructions"] != agent.Profile.Instructions || next.Selection != selection || next.Handoff {
				t.Fatal("upgraded conversation did not resume with current instructions and its original settings", receipt)
			}
		})
	}
}
