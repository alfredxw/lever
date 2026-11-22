package httpapi_test

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"slices"
	"strings"
	"testing"
	"unicode/utf8"

	"lever/internal/app"
	"lever/internal/cli"
	"lever/internal/model"
	"lever/internal/store"
)

type historyCall struct {
	Name      string         `json:"name"`
	Arguments map[string]any `json:"arguments"`
	Continue  bool           `json:"continue,omitempty"`
}

type historyRecord struct {
	SessionID string
	Role      string
	Text      string
	Anchor    struct {
		RunID  string
		ItemID string
		Offset int
	}
}

func historyTurn(f *fixture, chatID, operation string, calls ...historyCall) (model.Run, []historyResult, string) {
	f.t.Helper()
	return referencedHistoryTurn(f, chatID, operation, nil, calls...)
}

func referencedHistoryTurn(f *fixture, chatID, operation string, refs []model.Reference, calls ...historyCall) (model.Run, []historyResult, string) {
	f.t.Helper()
	payload, err := json.Marshal(calls)
	if err != nil {
		f.t.Fatal(err)
	}
	var run model.Run
	f.request("POST", "/messages", model.SendInput{CommandID: app.ID(), ChatID: chatID, Operation: operation,
		Text: "[chat-context] " + string(payload), References: refs}, 200, &run)
	run = f.wait(run.ID, "completed")
	var receipt struct {
		Input   string
		Tools   []string
		Results []historyResult
	}
	text := run.Items[0].Text
	if err := json.Unmarshal([]byte(strings.TrimPrefix(text, "context:")), &receipt); err != nil {
		f.t.Fatalf("runtime did not return a history receipt: %s", text)
	}
	if len(receipt.Results) != len(calls) || slices.Contains(receipt.Tools, "delegate_start") ||
		!slices.Contains(receipt.Tools, "find_chat_context") || !slices.Contains(receipt.Tools, "read_chat_context") {
		f.t.Fatalf("history tools were not exposed independently of delegation: %v", receipt.Tools)
	}
	return run, receipt.Results, receipt.Input
}

type historyResult struct {
	Body struct {
		Title      string
		Text       string
		NextOffset int
		Done       *bool
		State      string
		AgentID    string
		Topics     []model.TopicSummary
		Matches    []historyRecord
		Messages   []historyRecord
		NextCursor json.RawMessage
	}
	Error string
	Bytes int
}

func TestChatContextThroughHostedACPStdio(t *testing.T) {
	f := openFixture(t, app.OpenServer).withLocalProviders()
	f.startLocalCLI()
	source := f.chat(f.agent("codex"))
	mentioned := f.wait(f.send(source.ID, "topic", "", "Reference for the stdio worker").ID, "completed")
	private := f.wait(f.send(source.ID, "topic", "", "A different Topic").ID, "completed")
	chat := f.chat(f.acpAgent(f.acpProvider("stdio", "--limited")))
	local := f.wait(f.send(chat.ID, "topic", "", "A previous Topic in this Chat").ID, "completed")
	read := func(target string) historyCall {
		return historyCall{Name: "read_chat_context", Arguments: map[string]any{"target": target}}
	}
	refs := []model.Reference{{Kind: "topic", ID: mentioned.SessionID, Name: "Referenced Topic"}}
	first, got, _ := referencedHistoryTurn(f, chat.ID, "main", refs, historyCall{Name: "find_chat_context"}, read(mentioned.SessionID), read(private.SessionID))
	if topics := got[0].Body.Topics; len(topics) != 1 || topics[0].ID != local.SessionID {
		t.Fatalf("stdio did not find the local Topic: %+v", got[0])
	}
	if messages := got[1].Body.Messages; len(messages) == 0 || messages[0].Text != mentioned.Input || got[2].Error == "" {
		t.Fatalf("stdio did not preserve the reference scope: %+v", got)
	}
	before := f.waitNative(first.SessionID).NativeID
	second, got, _ := historyTurn(f, chat.ID, "main", read(local.SessionID), read(mentioned.SessionID))
	if second.SessionID != first.SessionID || f.waitNative(second.SessionID).NativeID != before ||
		len(got[0].Body.Messages) == 0 || got[0].Body.Messages[0].Text != local.Input || got[1].Error == "" {
		t.Fatalf("resumed stdio did not get a fresh execution scope: %+v", got)
	}
}

func TestPiChatContextThroughHostedLocalCLI(t *testing.T) {
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("LEVER_FIXTURE_PI_CLI", exe)
	f := openFixture(t, app.OpenServer).withLocalProviders()
	f.startLocalCLI()
	chat := f.chat(f.piAgent())
	previous := f.wait(f.send(chat.ID, "topic", "", "Earlier Pi decision CEIBA-31").ID, "completed")
	other := f.chat(f.agent("codex"))
	private := f.wait(f.send(other.ID, "main", "", "Different Chat decision CEIBA-31").ID, "completed")
	script, err := json.Marshal([][]string{
		{"context", "find", "--query", "Earlier Pi decision"},
		{"context", "read", "--target", previous.SessionID},
		{"context", "read", "--target", private.SessionID},
		{"context", "find", "--chat", other.ID},
		{"chat", "list"},
	})
	if err != nil {
		t.Fatal(err)
	}
	run := f.wait(f.send(chat.ID, "main", "", "[pi-context] "+string(script)).ID, "completed")
	var got []historyResult
	if len(run.Items) == 0 {
		t.Fatal("Pi did not return a CLI receipt")
	}
	text := run.Items[len(run.Items)-1].Text
	if err := json.Unmarshal([]byte(text), &got); err != nil || len(got) != 5 {
		t.Fatalf("Pi CLI receipt: %s (%v)", text, err)
	}
	if matches := got[0].Body.Matches; len(matches) == 0 || matches[0].Anchor.RunID != previous.ID {
		t.Fatalf("Pi CLI did not find the earlier Topic: %+v", got[0])
	}
	if messages := got[1].Body.Messages; len(messages) == 0 || messages[0].Text != previous.Input {
		t.Fatalf("Pi CLI did not read the earlier Topic: %+v", got[1])
	}
	if !strings.Contains(got[2].Error, "unavailable in this Chat") || !strings.Contains(got[3].Error, "Cannot combine chatId") ||
		!strings.Contains(got[4].Error, "not available with an execution capability") {
		t.Fatalf("execution commands did not stay scoped to the current Chat: %+v", got[2:])
	}
	waiting := f.wait(f.send(chat.ID, "main", "", "[pi-question]").ID, "waiting_user")
	t.Cleanup(func() {
		f.request("POST", "/runs/"+waiting.ID+"/stop", nil, 200, nil)
		f.wait(waiting.ID, "interrupted")
	})
	var token string
	if err := f.a.Store.DB.QueryRow("SELECT json_extract(input,'$.ContextToken') FROM runtime_hosts WHERE run_id=?", waiting.ID).Scan(&token); err != nil || token == "" {
		t.Fatalf("Pi worker did not have an execution capability: %v", err)
	}
	req, err := http.NewRequestWithContext(t.Context(), http.MethodGet, f.s.URL+"/mcp", nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer "+token)
	response, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != http.StatusUnauthorized {
		t.Fatalf("Pi's CLI capability could access MCP: %s", response.Status)
	}
}

func TestChatContextLocalCLIForTheHostUser(t *testing.T) {
	t.Setenv("LEVER_EXECUTION_TOKEN", "")
	f := newFixture(t)
	f.startLocalCLI()
	agent := f.agent("codex")
	chat := f.chat(agent)
	f.chat(f.agent("claude"))
	topic := f.wait(f.send(chat.ID, "topic", "", strings.Repeat("长🦥", 1500)).ID, "completed")
	command := func(out any, args ...string) error {
		t.Helper()
		var result, diagnostic bytes.Buffer
		handled, err := cli.Run(args, f.a.Store.Dir, &result, &diagnostic)
		if !handled {
			t.Fatalf("CLI did not handle %q", args)
		}
		if err == nil && out != nil {
			err = json.Unmarshal(result.Bytes(), out)
		}
		return err
	}
	var chats []struct{ ID, AgentID string }
	if err := command(&chats, "chat", "list", "--agent", agent.ID); err != nil || len(chats) != 1 || chats[0].ID != chat.ID || chats[0].AgentID != agent.ID {
		t.Fatalf("unexpected CLI Chat listing: %+v (%v)", chats, err)
	}
	var found app.FindContextResult
	if err := command(&found, "context", "find", "--chat", chat.ID); err != nil || len(found.Topics) != 1 || found.Topics[0].ID != topic.SessionID {
		t.Fatalf("unexpected CLI Topic listing: %+v (%v)", found, err)
	}
	var page, next app.ReadContextResult
	if err := command(&page, "context", "read", "--target", topic.SessionID); err != nil || page.NextCursor == nil || len(page.Messages) == 0 {
		t.Fatalf("CLI did not return a paginated dialogue: %v", err)
	}
	cursor, err := json.Marshal(page.NextCursor)
	if err != nil {
		t.Fatal(err)
	}
	if err := command(&next, "context", "read", "--target", topic.SessionID, "--cursor", string(cursor)); err != nil || len(next.Messages) == 0 || next.Messages[0].Anchor == page.Messages[0].Anchor {
		t.Fatalf("CLI did not advance the dialogue cursor: %v", err)
	}
	t.Setenv("LEVER_EXECUTION_TOKEN", "invalid-execution")
	if err := command(nil, "context", "read", "--chat", chat.ID, "--target", topic.SessionID); err == nil || !strings.Contains(err.Error(), "Invalid or expired execution capability") {
		t.Fatalf("invalid execution token fell back to the host-user scope: %v", err)
	}
}

func TestChatContextDiscoversConvertedTopicWithoutInjectingOtherSessions(t *testing.T) {
	f := newFixture(t)
	agent := f.agent("codex")
	chat := f.chat(agent)
	main := f.wait(f.send(chat.ID, "main", "", "[thinking] Architecture decision LARCH-204").ID, "completed")
	// A long persisted history must stay out of the new Topic's first input.
	err := f.a.Store.Write(context.Background(), func(tx *sql.Tx) error {
		for i := range 1000 {
			run := model.Run{ID: app.ID(), ChatID: chat.ID, AgentID: agent.ID, SessionID: main.SessionID,
				Operation: "main", Status: "completed", Input: fmt.Sprintf("Archived message %d", i), CreatedAt: main.CreatedAt}
			if err := store.InsertRun(tx, &run, app.ID(), ""); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	active := f.wait(f.send(chat.ID, "main", "", "[hang] main stays active").ID, "running")
	var queued, converted model.Run
	command := model.SendInput{CommandID: app.ID(), ChatID: chat.ID, Operation: "main", Delivery: "queue", Text: "[wire] independent Topic ROOT-827"}
	f.request("POST", "/messages", command, 200, &queued)
	command.CommandID, command.EditRunID, command.Operation = app.ID(), queued.ID, "topic"
	f.request("POST", "/messages", command, 200, &converted)
	converted = f.wait(converted.ID, "completed")
	if converted.ID != queued.ID || converted.Sequence != queued.Sequence || converted.SessionID == main.SessionID {
		t.Fatal("queued message did not move to an independent Topic")
	}
	var wire struct{ Input string }
	if err := json.Unmarshal([]byte(strings.TrimPrefix(converted.Items[0].Text, "wire:")), &wire); err != nil || wire.Input != command.Text {
		t.Fatalf("unexpected Topic input: %q, %v", wire.Input, err)
	}
	f.request("POST", "/messages", model.SendInput{CommandID: app.ID(), ChatID: chat.ID, Operation: "main", Delivery: "steer", Text: "resume main conversation"}, 200, nil)
	f.wait(active.ID, "completed")
	other := f.chat(agent)
	private := f.wait(f.send(other.ID, "topic", "", "Other Chat evidence").ID, "completed")
	restartProviderFixture(t, f)

	_, results, input := historyTurn(f, chat.ID, "main",
		historyCall{Name: "find_chat_context", Arguments: map[string]any{}},
		historyCall{Name: "read_chat_context", Arguments: map[string]any{"target": converted.SessionID}},
		historyCall{Name: "read_chat_context", Arguments: map[string]any{"target": private.SessionID}},
		historyCall{Name: "read_chat_context", Arguments: map[string]any{"target": "main", "anchor": map[string]any{"runId": private.ID}}},
	)
	topics := results[0].Body.Topics
	if strings.Contains(input, "ROOT-827") || len(topics) != 1 || topics[0].RootRunID != queued.ID || topics[0].Status != "completed" {
		t.Fatal("converted Topic did not remain discoverable through its original root")
	}
	if messages := results[1].Body.Messages; len(messages) < 1 || messages[0].Text != command.Text || messages[0].SessionID != converted.SessionID {
		t.Fatal("main could not read the converted Topic", messages)
	}
	if results[2].Error == "" || results[3].Error == "" {
		t.Fatal("history lookup accepted a target or anchor from another Chat")
	}
	_, results, input = historyTurn(f, chat.ID, "topic",
		historyCall{Name: "find_chat_context", Arguments: map[string]any{"query": "architecture decision"}},
		historyCall{Name: "read_chat_context", Arguments: map[string]any{"target": "main", "direction": "newer", "anchor": map[string]any{"runId": main.ID}}},
	)
	if strings.Contains(input, "LARCH-204") || len(results[0].Body.Matches) != 1 || results[0].Body.Matches[0].Anchor.RunID != main.ID {
		t.Fatal("new Topic did not find the prior decision on demand")
	}
	messages := results[1].Body.Messages
	if len(messages) < 2 || messages[0].Text != main.Input || messages[1].Text != "Done." {
		t.Fatal("history did not project user and assistant dialogue in order", messages)
	}
}

func TestChatContextPaginatesLongDialogueAndCapsAnExecution(t *testing.T) {
	f := newFixture(t)
	chat := f.chat(f.agent("codex"))
	active := f.wait(f.send(chat.ID, "main", "", "[hang] initial request").ID, "running")
	var steer model.Run
	f.request("POST", "/messages", model.SendInput{CommandID: app.ID(), ChatID: chat.ID, Operation: "main", Delivery: "steer", Text: "steered confirmation"}, 200, &steer)
	f.wait(active.ID, "completed")
	long := f.wait(f.send(chat.ID, "main", "", strings.Repeat("长🦥", 610)).ID, "completed")
	read := historyCall{Name: "read_chat_context", Arguments: map[string]any{"target": "main", "anchor": map[string]any{"runId": long.ID}}}
	calls := []historyCall{
		{Name: "find_chat_context", Arguments: map[string]any{"query": "steered confirmation"}},
		read,
	}
	for range 4 {
		calls = append(calls, historyCall{Name: "read_chat_context", Arguments: map[string]any{"target": "main"}, Continue: true})
	}
	for range 35 {
		calls = append(calls, read)
	}
	_, results, _ := historyTurn(f, chat.ID, "topic", calls...)
	users := 0
	for _, match := range results[0].Body.Matches {
		if match.Role == "user" {
			users++
			if match.Anchor.RunID != active.ID || match.Anchor.ItemID != steer.ID {
				t.Fatal("steer was not attributed to its delivered position", match)
			}
		}
	}
	if users != 1 {
		t.Fatal("confirmed steer should appear once in history")
	}
	var reassembled strings.Builder
	for _, result := range results[1:6] {
		for _, message := range result.Body.Messages {
			if message.Anchor.RunID == long.ID {
				if message.Anchor.Offset != reassembled.Len() || !utf8.ValidString(message.Text) {
					t.Fatal("cursor skipped bytes or split a rune")
				}
				reassembled.WriteString(message.Text)
			}
		}
	}
	if reassembled.String() != long.Input {
		t.Fatal("long message could not be read in full")
	}
	total := 0
	limited := false
	for _, result := range results {
		if result.Bytes > 8<<10 {
			t.Fatal("history response exceeded the page budget")
		}
		total += result.Bytes
		limited = limited || strings.Contains(result.Error, "byte limit reached")
	}
	if total > 32<<10 || !limited {
		t.Fatal("execution budget was not enforced", total)
	}
}
