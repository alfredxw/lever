//go:build !windows

package provider

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/base64"
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"testing"
	"time"

	"lever/internal/model"
)

func TestSharedCodexUsesOriginalDesktopOwner(t *testing.T) {
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	dir, err := os.MkdirTemp("/tmp", "lever-share-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	const id = "2d16dfda-dc4a-4a12-bb76-dd6f5a65ef91"
	const command = "bd3971f2-bf53-4434-9840-53dca4dd722d"
	state := sharedFixtureDB(t, dir, "state_5.sqlite", `
		CREATE TABLE threads (id TEXT, name TEXT, title TEXT, cwd TEXT, recency_at_ms INTEGER, updated_at_ms INTEGER, updated_at INTEGER,
			history_mode TEXT, rollout_path TEXT, source TEXT, originator TEXT, archived INTEGER);
		INSERT INTO threads VALUES ('`+id+`', 'Native project', '', '/fixture', 1794880100000, NULL, 0, 'paginated', '', 'vscode', NULL, 0);`)
	if err := os.WriteFile(filepath.Join(dir, ".codex-global-state.json"), []byte(`{"projectless-thread-ids":["`+id+`"]}`), 0600); err != nil {
		t.Fatal(err)
	}
	const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII="
	image, err := base64.StdEncoding.DecodeString(png)
	if err != nil {
		t.Fatal(err)
	}
	imagePath := filepath.Join(dir, "screenshot.png")
	if err := os.WriteFile(imagePath, image, 0600); err != nil {
		t.Fatal(err)
	}
	history := sharedFixtureDB(t, dir, "thread_history_1.sqlite", `
		CREATE TABLE thread_turns (thread_id TEXT, turn_id TEXT, status TEXT, rollout_ordinal INTEGER, started_at INTEGER);
		CREATE TABLE thread_items (thread_id TEXT, turn_id TEXT, item_id TEXT, item_type TEXT, created_at_ms INTEGER, item_json TEXT, rollout_ordinal INTEGER);
		INSERT INTO thread_turns VALUES ('`+id+`', 'original', 'completed', 1, 1794880000);
		INSERT INTO thread_items VALUES ('`+id+`', 'original', 'a1', 'agentMessage', NULL, '{"type":"agentMessage","phase":"commentary","text":"Checking"}', 3);
		INSERT INTO thread_items VALUES ('`+id+`', 'original', 'tool1', 'commandExecution', NULL, '{"type":"commandExecution","command":"ls -d missing","status":"failed","exitCode":1,"aggregatedOutput":"ls: missing: No such file or directory"}', 4);
		INSERT INTO thread_items VALUES ('`+id+`', 'original', 'a2', 'agentMessage', NULL, '{"type":"agentMessage","phase":"final_answer","text":"Finished"}', 6);`)
	if _, err := history.Exec(`INSERT INTO thread_items VALUES (?, 'original', 'u1', 'userMessage', 1794880000000, ?, 2)`, id,
		fmt.Sprintf(`{"type":"userMessage","content":[{"type":"text","text":"From the desktop"},{"type":"localImage","path":%q}]}`, imagePath)); err != nil {
		t.Fatal(err)
	}
	if _, err := history.Exec(`INSERT INTO thread_items VALUES (?, 'original', 'art1', 'imageGeneration', NULL, ?, 5)`, id,
		fmt.Sprintf(`{"type":"imageGeneration","savedPath":%q,"result":%q}`, imagePath, png)); err != nil {
		t.Fatal(err)
	}
	config := model.Provider{ID: "codex", Type: "codex", ConfigDir: dir}
	list, err := ListShared(ctx, config, nil)
	if err != nil || len(list) != 1 || list[0].ID != id || list[0].Preview != "Finished" {
		t.Fatalf("discover app-owned conversation: %#v %v", list, err)
	}
	if list, err := ListShared(ctx, config, map[string]bool{id: true}); err != nil || len(list) != 0 {
		t.Fatalf("duplicate Lever-owned conversation: %#v %v", list, err)
	}
	if _, err := history.Exec(`UPDATE thread_turns SET status='inProgress'`); err != nil {
		t.Fatal(err)
	}
	list, err = ListShared(ctx, config, nil)
	if err != nil || len(list) != 1 || list[0].Activity == nil || list[0].Activity.Status != "running" || list[0].Activity.StartedAt != sharedTime(1794880000000) {
		t.Fatalf("read running state from the native list: %#v %v", list, err)
	}
	view, err := ReadShared(ctx, config, id, 100, nil)
	if err != nil || len(view.Messages) != 5 || view.Messages[0].Text != "From the desktop" {
		t.Fatalf("read original desktop turn: %#v %v", view, err)
	}
	if !view.Busy || view.Conversation.Activity == nil || view.Conversation.Activity.TurnID != view.Messages[0].TurnID {
		t.Fatalf("running state did not match the native turn: %#v", view.Conversation)
	}
	if _, err := history.Exec(`UPDATE thread_turns SET status='completed'`); err != nil {
		t.Fatal(err)
	}
	list, err = ListShared(ctx, config, nil)
	if err != nil || len(list) != 1 || list[0].Activity != nil {
		t.Fatalf("completion kept an active state: %#v %v", list, err)
	}
	if view.Messages[1].Kind != "commentary" || view.Messages[2].Kind != "tool" || view.Messages[4].Kind != "final" {
		t.Fatalf("lost native message phases or tool activity: %#v", view.Messages)
	}
	tool := view.Messages[2]
	if tool.Text != "" || len(tool.DetailIDs) != 1 {
		t.Fatalf("expected a lazy tool detail: %#v", tool)
	}
	if tool.Status != "failed" || tool.ExitCode == nil || *tool.ExitCode != 1 {
		t.Fatalf("expected the command status and exit code: %#v", tool)
	}
	if detail, err := ReadSharedDetail(ctx, config, id, tool.DetailIDs[0], nil); err != nil || detail != "ls: missing: No such file or directory" {
		t.Fatalf("read native tool detail: %q %v", detail, err)
	}
	if len(view.Messages[0].Images) != 1 || len(view.Messages[3].Images) != 1 || view.Messages[3].Kind != "image" {
		t.Fatalf("lost input or generated image: %#v", view.Messages)
	}
	checkImage := func(imageID string) {
		t.Helper()
		data, media, err := ReadSharedImage(ctx, config, id, imageID, nil)
		if err != nil || media != "image/png" || !bytes.Equal(data, image) {
			t.Fatalf("read native image %s: %s %v", imageID, media, err)
		}
	}
	checkImage(view.Messages[0].Images[0].ID)
	if err := os.Remove(imagePath); err != nil {
		t.Fatal(err)
	}
	checkImage(view.Messages[3].Images[0].ID) // persisted output falls back to the original image bytes
	if _, _, err := ReadSharedImage(ctx, config, id, view.Messages[3].Images[0].ID, map[string]bool{id: true}); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("a Lever-owned image was readable: %v", err)
	}
	if err := os.Mkdir(filepath.Join(dir, "ipc"), 0700); err != nil {
		t.Fatal(err)
	}
	listener, err := net.Listen("unix", filepath.Join(dir, "ipc", "ipc.sock"))
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	workflow := make(chan error, 1)
	go func() {
		conn, err := listener.Accept()
		if err != nil {
			workflow <- err
			return
		}
		defer conn.Close()
		_ = conn.SetDeadline(time.Now().Add(5 * time.Second))
		for _, method := range []string{"initialize", "thread-owner-discovery", "thread-follower-start-turn"} {
			frame, err := readCodexShared(conn)
			if err != nil || frame.Method != method {
				workflow <- fmt.Errorf("expected %s, got %s: %v", method, frame.Method, err)
				return
			}
			if method == "thread-follower-start-turn" {
				start := obj(obj(frame.Params)["turnStart"])
				req := obj(start["request"])
				parts := arr(req["input"])
				if frame.Target != "native-window" || frame.Version != 2 || str(req["threadId"]) != id ||
					str(req["clientUserMessageId"]) != command || len(parts) != 1 || str(obj(parts[0])["text"]) != "From Lever" {
					workflow <- fmt.Errorf("incorrect native turn request: %#v", frame)
					return
				}
				if _, err := history.Exec(`INSERT INTO thread_turns VALUES (?, 'native-next', 'completed', 7, 1794880101);
					INSERT INTO thread_items VALUES (?, 'native-next', 'a2', 'agentMessage', NULL, '{"type":"agentMessage","text":"Native reply"}', 8);`, id, id); err != nil {
					workflow <- err
					return
				}
			}
			if err := writeCodexShared(conn, codexSharedFrame{Type: "response", ID: frame.ID, Result: "success", HandledBy: "native-window"}); err != nil {
				workflow <- err
				return
			}
		}
		workflow <- nil
	}()
	if err := SendShared(ctx, config, id, command, "From Lever", nil); err != nil {
		t.Fatal(err)
	}
	if err := <-workflow; err != nil {
		t.Fatal(err)
	}
	view, err = ReadShared(ctx, config, id, 100, nil)
	if err != nil || len(view.Messages) != 6 || view.Messages[5].Text != "Native reply" {
		t.Fatalf("read reply written by the desktop: %#v %v", view, err)
	}
	list, err = ListShared(ctx, config, nil)
	if err != nil || len(list) != 1 || list[0].Preview != "Native reply" {
		t.Fatalf("read latest reply from the native list: %#v %v", list, err)
	}
	if _, err := state.Exec(`UPDATE threads SET archived=1`); err != nil {
		t.Fatal(err)
	}
	if _, err := ReadShared(ctx, config, id, 100, nil); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("archived conversation was still accessible: %v", err)
	}
}

func TestSharedCodexRolloutPreview(t *testing.T) {
	path := filepath.Join(t.TempDir(), "rollout.jsonl")
	const events = `{"type":"event_msg","payload":{"type":"user_message","message":"Original prompt"}}
{"type":"event_msg","payload":{"type":"item_completed","item":{"type":"AgentMessage","content":[{"type":"Text","text":"Latest\nreply"}]}}}
{"type":"event_msg","payload":{"type":"item_completed","item":{"type":"Reasoning","content":[{"type":"Text","text":"Private reasoning"}]}}}
`
	if err := os.WriteFile(path, []byte(events), 0600); err != nil {
		t.Fatal(err)
	}
	if preview := sharedCodexRolloutPreview(t.Context(), path); preview != "Latest reply" {
		t.Fatalf("preview = %q", preview)
	}
	if err := os.WriteFile(path, []byte(events+`{"type":"event_msg","payload":{"type":"thread_rolled_back"}}`), 0600); err != nil {
		t.Fatal(err)
	}
	if preview := sharedCodexRolloutPreview(t.Context(), path); preview != "" {
		t.Fatalf("rolled-back preview = %q", preview)
	}
}

func sharedFixtureDB(t *testing.T, dir, file, seed string) *sql.DB {
	t.Helper()
	db, err := sql.Open("sqlite", filepath.Join(dir, file))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	if _, err := db.Exec("PRAGMA journal_mode=WAL; " + seed); err != nil {
		t.Fatal(err)
	}
	return db
}
