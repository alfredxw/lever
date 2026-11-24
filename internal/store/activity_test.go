package store

import (
	"context"
	"database/sql"
	"strings"
	"testing"
	"time"

	"lever/internal/model"
)

func activityStore(t *testing.T) *Store {
	t.Helper()
	s, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.Close() })
	if err := s.Write(context.Background(), func(tx *sql.Tx) error {
		for _, query := range []string{
			`INSERT INTO agents(id,data) VALUES ('agent','{"id":"agent"}')`,
			`INSERT INTO chats(id,agent_id,data) VALUES ('chat','agent','{"id":"chat","agentId":"agent","title":"First message"}')`,
			`INSERT INTO sessions(id,chat_id,kind,data) VALUES ('main','chat','main','{}'),('topic','chat','topic','{}')`,
		} {
			if _, err := tx.Exec(query); err != nil {
				return err
			}
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	return s
}

func activity(t *testing.T, s *Store, sessionID string) model.Conversation {
	t.Helper()
	value, err := Get[model.Conversation](context.Background(), s.DB, "SELECT activity FROM sessions WHERE id=?", sessionID)
	if err != nil || value.ID == "" {
		t.Fatalf("missing session activity: %+v, %v", value, err)
	}
	return value
}

func TestActivityTracksMessagesAcrossConcurrentSessions(t *testing.T) {
	s := activityStore(t)
	ctx := context.Background()
	save := func(run *model.Run) {
		t.Helper()
		if err := s.Write(ctx, func(tx *sql.Tx) error {
			if run.Sequence == 0 {
				return InsertRun(tx, run, run.ID, run.ID)
			}
			return SaveRun(tx, *run)
		}); err != nil {
			t.Fatal(err)
		}
	}
	main := model.Run{ID: "first", AgentID: "agent", ChatID: "chat", SessionID: "main", Status: "running", Input: "First message", CreatedAt: time.Now().UTC().Format(time.RFC3339Nano)}
	save(&main)
	if got := activity(t, s, "main"); got.Preview != main.Input || got.UnreadSequence != 0 {
		t.Fatalf("initial message: %+v", got)
	}
	main.Items = []model.Item{{ID: "answer", Kind: "text", Text: "First reply"}}
	save(&main)
	topic := model.Run{ID: "second", AgentID: "agent", ChatID: "chat", SessionID: "topic", Status: "running", Input: "Newer topic", CreatedAt: time.Now().UTC().Format(time.RFC3339Nano)}
	save(&topic)
	main.Items = append(main.Items, model.Item{ID: "tool", Kind: "command", Text: "Tool output must not replace the newer message"})
	save(&main)
	if got := activity(t, s, "topic"); got.Preview != topic.Input {
		t.Fatalf("tool activity replaced the latest message: %+v", got)
	}
	// A reply with the same text is still a new assistant message.
	previous := activity(t, s, "topic")
	topic.Items = []model.Item{{ID: "answer", Kind: "text", Text: topic.Input}}
	save(&topic)
	if got := activity(t, s, "topic"); got.MessageAt <= previous.MessageAt {
		t.Fatalf("same-text reply did not advance message time: %+v", got)
	}
	main.Items = append(main.Items, model.Item{ID: "final", Kind: "text", Text: "Latest reply\n\nwith details"})
	main.Status, main.FinishedAt = "completed", time.Now().UTC().Format(time.RFC3339Nano)
	var before int64
	if err := s.DB.QueryRow("SELECT MAX(sequence) FROM events").Scan(&before); err != nil {
		t.Fatal(err)
	}
	save(&main)
	finished := activity(t, s, "main")
	if finished.Preview != "Latest reply with details" || finished.UnreadSequence <= before || finished.FinishedAt != main.FinishedAt {
		t.Fatalf("out-of-order completion missing: %+v", finished)
	}
	view, err := s.View(ctx, "chat", 0)
	if err != nil || view.Cursor < finished.UnreadSequence {
		t.Fatalf("view cannot acknowledge its result: %+v, %v", view, err)
	}
	if len(view.Runs) == 0 || view.Runs[0].UnreadSequence != finished.UnreadSequence {
		t.Fatalf("finished run unreadSequence = %+v, want %d", view.Runs, finished.UnreadSequence)
	}
	save(&main)
	if got := activity(t, s, "main"); got != finished {
		t.Fatalf("repeated terminal snapshot generated new activity: %+v", got)
	}
	if savedRun, err := Get[model.Run](ctx, s.DB, "SELECT data FROM runs WHERE id=?", main.ID); err != nil || savedRun.UnreadSequence != finished.UnreadSequence {
		t.Fatalf("repeated terminal snapshot lost run unreadSequence: %+v, %v", savedRun, err)
	}
	events, err := s.Events(ctx, before)
	if err != nil || len(events) == 0 || events[0].Conversation == nil || *events[0].Conversation != finished {
		t.Fatalf("replay omitted durable activity: %+v, %v", events, err)
	}
	topic.Status, topic.FinishedAt = "failed", time.Now().UTC().Format(time.RFC3339Nano)
	save(&topic)
	if got := activity(t, s, "topic"); got.Preview != topic.Input || got.UnreadSequence <= view.Cursor || got.FinishedAt != topic.FinishedAt {
		t.Fatalf("failure must notify without replacing the latest message: %+v", got)
	}
	if topicRuns, err := s.SessionRuns(ctx, "topic", 0); err != nil || len(topicRuns.Runs) != 1 || topicRuns.Runs[0].UnreadSequence != activity(t, s, "topic").UnreadSequence {
		t.Fatalf("failed topic run unreadSequence = %+v, %v", topicRuns, err)
	}
}

func TestQuietActivityPreservesMixedSessionsAndSurfacesAttention(t *testing.T) {
	s := activityStore(t)
	save := func(run *model.Run, status string) {
		t.Helper()
		run.Status = status
		if !model.Active(status) {
			run.FinishedAt = time.Now().UTC().Format(time.RFC3339Nano)
		}
		if err := s.Write(t.Context(), func(tx *sql.Tx) error {
			if run.Sequence == 0 {
				return InsertRun(tx, run, run.ID, run.ID)
			}
			return SaveRun(tx, *run)
		}); err != nil {
			t.Fatal(err)
		}
	}
	normal := model.Run{ID: "message", ChatID: "chat", SessionID: "main", AgentID: "agent", Input: "Human reply"}
	save(&normal, "completed")
	before := activity(t, s, "main")
	mixed := model.Run{ID: "mixed", ChatID: "chat", SessionID: "main", AgentID: "agent", Input: "Daily check", Quiet: true}
	save(&mixed, "running")
	save(&mixed, "completed")
	if got := activity(t, s, "main"); got != before {
		t.Fatalf("quiet run overwrote a human conversation: %+v", got)
	}
	background := model.Run{ID: "background", ChatID: "chat", SessionID: "topic", AgentID: "agent", Input: "Check", Quiet: true}
	save(&background, "queued")
	save(&background, "running")
	save(&background, "completed")
	if err := s.backfillActivity(); err != nil {
		t.Fatal(err)
	}
	if v := activity(t, s, "topic"); !v.BackgroundOnly || v.UnreadSequence != 0 || v.MessageAt != "" {
		t.Fatalf("routine activity was promoted: %+v", v)
	}
	asking := model.Run{ID: "asking", ChatID: "chat", SessionID: "topic", AgentID: "agent", Input: "Check again", Quiet: true}
	save(&asking, "running")
	request := model.Request{ID: "approval", ChatID: "chat", SessionID: "topic", RunID: asking.ID, Title: "Approve the check?", Status: "pending"}
	if err := s.Write(t.Context(), func(tx *sql.Tx) error { return SaveRequest(tx, request) }); err != nil {
		t.Fatal(err)
	}
	save(&asking, "waiting_user")
	v := activity(t, s, "topic")
	if v.BackgroundOnly || v.Preview != request.Title || v.UnreadSequence == 0 {
		t.Fatalf("pending action was hidden: %+v", v)
	}
	if savedAsking, err := Get[model.Run](t.Context(), s.DB, "SELECT data FROM runs WHERE id=?", asking.ID); err != nil || savedAsking.UnreadSequence != v.UnreadSequence {
		t.Fatalf("waiting_user save lost pending request unreadSequence: %+v, %v", savedAsking, err)
	}
	if savedMixed, err := Get[model.Run](t.Context(), s.DB, "SELECT data FROM runs WHERE id=?", mixed.ID); err != nil || savedMixed.UnreadSequence != 0 {
		t.Fatalf("quiet completed run should not record unreadSequence: %+v, %v", savedMixed, err)
	}
	failed := model.Run{ID: "failed", ChatID: "chat", SessionID: "main", AgentID: "agent", Input: "Check again", Quiet: true}
	save(&failed, "running")
	failed.Error = "Connection failed"
	save(&failed, "failed")
	if v := activity(t, s, "main"); v.UnreadSequence <= before.UnreadSequence || v.Preview != failed.Error || v.MessageAt <= before.MessageAt {
		t.Fatalf("failure did not surface: %+v", v)
	}
}

func TestActivityBackfillsExistingHistoryOnce(t *testing.T) {
	s := activityStore(t)
	ctx := context.Background()
	for _, run := range []model.Run{
		{ID: "older", SessionID: "main", CreatedAt: "2026-11-06T00:00:00Z", FinishedAt: "2026-11-06T00:00:02.1Z", Items: []model.Item{{ID: "answer", Kind: "text", Text: "Finished last"}}},
		{ID: "newer", SessionID: "topic", CreatedAt: "2026-11-06T00:00:01Z", FinishedAt: "2026-11-06T00:00:02Z", Items: []model.Item{{ID: "answer", Kind: "text", Text: "Finished first"}}},
	} {
		run.AgentID, run.ChatID, run.Status = "agent", "chat", "completed"
		if err := s.Write(ctx, func(tx *sql.Tx) error { return InsertRun(tx, &run, run.ID, run.ID) }); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := s.DB.Exec("UPDATE sessions SET activity=NULL"); err != nil {
		t.Fatal(err)
	}
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
	reopened, err := Open(s.Dir)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	got := activity(t, reopened, "main")
	if got.Preview != "Finished last" || got.UnreadSequence == 0 || got.MessageAt != "2026-11-06T00:00:02.100000000Z" {
		t.Fatalf("history backfill: %+v", got)
	}
	if err := reopened.backfillActivity(); err != nil {
		t.Fatal(err)
	}
	if again := activity(t, reopened, "main"); again != got {
		t.Fatalf("backfill changed existing projection: %+v", again)
	}
}

func TestActivityPreviewBoundsUnicodeAndNonTextInput(t *testing.T) {
	text := strings.Repeat("你🙂", 90)
	if got := messagePreview(text); len([]rune(got)) != 161 || !strings.HasSuffix(got, "…") {
		t.Fatalf("invalid bounded preview: %q", got)
	}
	for _, run := range []model.Run{
		{Attachments: []model.Attachment{{Name: "diagram.png"}}},
		{References: []model.Reference{{Name: "diagram.png"}}},
		{Quote: &model.MessageQuote{Text: "diagram.png"}},
	} {
		if got := lastMessage(run).text; got != "diagram.png" {
			t.Fatalf("missing attachment/reference/quote preview: %q", got)
		}
	}
}

func TestActivityRepairsLegacyMessageTitles(t *testing.T) {
	s := activityStore(t)
	input := "[文档](https://example.com/" + strings.Repeat("long/", 40) + ") `\\[code]` \\[路径\\]"
	const label = `文档 \[code] [路径]`
	const namedTitle = `手动标题 \[名称]`
	if err := s.Write(context.Background(), func(tx *sql.Tx) error {
		if _, err := tx.Exec("INSERT INTO sessions(id,chat_id,kind,data) VALUES ('named','chat','topic',?)", JSON(model.Session{Title: namedTitle})); err != nil {
			return err
		}
		for _, sessionID := range []string{"main", "topic", "named"} {
			run := model.Run{ID: sessionID + "-run", SessionID: sessionID, ChatID: "chat", AgentID: "agent", Status: "completed", Input: input}
			if err := InsertRun(tx, &run, run.ID, run.ID); err != nil {
				return err
			}
		}
		if _, err := tx.Exec("UPDATE chats SET data=json_set(data,'$.source','user','$.title',?) WHERE id='chat'", clipChatTitle(input)); err != nil {
			return err
		}
		if _, err := tx.Exec("UPDATE sessions SET activity=json_set(activity,'$.title',?) WHERE id IN ('main','topic')", messagePreview(input)); err != nil {
			return err
		}
		_, err := tx.Exec("PRAGMA user_version=5")
		return err
	}); err != nil {
		t.Fatal(err)
	}
	before := activity(t, s, "topic")
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
	reopened, err := Open(s.Dir)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	chat, err := Get[model.Chat](context.Background(), reopened.DB, "SELECT data FROM chats WHERE id='chat'")
	if err != nil || chat.Title != label {
		t.Fatalf("legacy Chat title = %q (%v), want %q", chat.Title, err, label)
	}
	before.Title = label
	if got := activity(t, reopened, "topic"); got != before {
		t.Fatalf("Topic activity after title repair = %+v, want %+v", got, before)
	}
	if got := activity(t, reopened, "main").Title; got != label {
		t.Fatalf("legacy main session title = %q, want %q", got, label)
	}
	if got := activity(t, reopened, "named").Title; got != namedTitle {
		t.Fatalf("explicit title changed from %q to %q", namedTitle, got)
	}
}
