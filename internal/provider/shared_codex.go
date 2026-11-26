package provider

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/binary"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"time"

	"lever/internal/model"

	_ "modernc.org/sqlite"
)

type sharedCodexThread struct {
	model.SharedConversation
	mode string
	path string
}

func (thread sharedCodexThread) usesProjection() bool {
	// A continuation segment after rollback needs the public history API.
	base := strings.TrimSuffix(filepath.Base(thread.path), ".jsonl")
	return thread.mode == "paginated" && !(len(base) > 36 && base[len(base)-37] == '_')
}

func listSharedCodex(ctx context.Context, config model.Provider, managed map[string]bool) ([]model.SharedConversation, error) {
	threads, err := sharedCodexThreads(ctx, config, "")
	if err != nil {
		return nil, err
	}
	threads = slices.DeleteFunc(threads, func(thread sharedCodexThread) bool { return managed[thread.ID] })
	states := sharedCodexSummaries(ctx, SharedStore(config), threads)
	list := make([]model.SharedConversation, 0, len(threads))
	for _, thread := range threads {
		state := states[thread.ID]
		if thread.usesProjection() {
			thread.Preview = state.preview
		} else if thread.path != "" {
			if state.turn == "" {
				state = sharedCodexRolloutState(ctx, thread.path)
			}
			thread.Preview = sharedCodexRolloutPreview(ctx, thread.path)
		}
		thread.Activity = state.activity()
		list = append(list, thread.SharedConversation)
	}
	return list, ctx.Err()
}

func sharedCodexThreads(ctx context.Context, config model.Provider, id string) ([]sharedCodexThread, error) {
	dir := SharedStore(config)
	db, err := openSharedCodexDB(dir, "state_")
	if errors.Is(err, os.ErrNotExist) && id == "" {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	defer db.Close()
	// The desktop index also identifies older chats whose originator is NULL
	// after migration. The desktop writer owns only interactive threads here.
	var index struct {
		Projectless []string                   `json:"projectless-thread-ids"`
		Assigned    map[string]json.RawMessage `json:"thread-project-assignments"`
	}
	_ = readSharedJSON(filepath.Join(dir, ".codex-global-state.json"), &index)
	var desktopIDs = make([]string, 0, len(index.Projectless)+len(index.Assigned))
	for _, item := range index.Projectless {
		if sharedUUID.MatchString(item) {
			desktopIDs = append(desktopIDs, item)
		}
	}
	for item := range index.Assigned {
		if sharedUUID.MatchString(item) {
			desktopIDs = append(desktopIDs, item)
		}
	}
	keys, _ := json.Marshal(desktopIDs)
	q := `SELECT id, COALESCE(NULLIF(name,''),title,''), COALESCE(cwd,''), COALESCE(recency_at_ms,updated_at_ms,updated_at*1000,0),
		COALESCE(history_mode,''), COALESCE(rollout_path,'') FROM threads
		WHERE archived=0 AND source IN ('vscode','cli','appServer')
		AND (originator IN ('Codex Desktop','codex_work_desktop','persona_codex_app') OR id IN (SELECT value FROM json_each(?)))`
	args := []any{string(keys)}
	if id != "" {
		q += ` AND id=?`
		args = append(args, id)
	}
	rows, err := db.QueryContext(ctx, q+` ORDER BY 4 DESC LIMIT ?`, append(args, SharedListLimit)...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var result []sharedCodexThread
	for rows.Next() {
		var item sharedCodexThread
		var ms int64
		if err := rows.Scan(&item.ID, &item.Title, &item.Cwd, &ms, &item.mode, &item.path); err != nil {
			return nil, err
		}
		if sharedUUID.MatchString(item.ID) {
			item.Runtime, item.Provider = "codex", config.ID
			item.Title, item.UpdatedAt = sharedSnippet(item.Title), sharedTime(ms)
			result = append(result, item)
		}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if id != "" && len(result) == 0 {
		return nil, os.ErrNotExist
	}
	return result, nil
}

func openSharedCodexDB(dir, prefix string) (*sql.DB, error) {
	if dir == "" {
		return nil, os.ErrNotExist
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	name, version := "", -1
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasPrefix(entry.Name(), prefix) || !strings.HasSuffix(entry.Name(), ".sqlite") {
			continue
		}
		if v, err := strconv.Atoi(strings.TrimSuffix(strings.TrimPrefix(entry.Name(), prefix), ".sqlite")); err == nil && v > version {
			name, version = entry.Name(), v
		}
	}
	if name == "" {
		return nil, os.ErrNotExist
	}
	path := filepath.Join(dir, name)
	uri := url.URL{Scheme: "file", Path: filepath.ToSlash(path)}
	if !strings.HasPrefix(uri.Path, "/") {
		uri.Path = "/" + uri.Path
	}
	query := url.Values{"mode": {"ro"}, "_pragma": {"busy_timeout(1500)"}}
	// SQLite needs the WAL index in read-only mode. Closing the desktop app
	// can remove it. An absent or empty WAL has no commit that could be lost.
	if _, err := os.Stat(path + "-shm"); errors.Is(err, os.ErrNotExist) {
		if wal, walErr := os.Stat(path + "-wal"); errors.Is(walErr, os.ErrNotExist) || walErr == nil && wal.Size() <= 32 {
			query.Set("immutable", "1")
		}
	}
	uri.RawQuery = query.Encode()
	return sql.Open("sqlite", uri.String())
}

func readSharedCodex(ctx context.Context, config model.Provider, id string, limit int) (model.SharedHistory, error) {
	threads, err := sharedCodexThreads(ctx, config, id)
	if err != nil {
		return model.SharedHistory{}, err
	}
	thread := threads[0]
	state, messages, more, err := sharedCodexHistory(ctx, config, thread, limit)
	thread.Activity = state.activity()
	return model.SharedHistory{Conversation: thread.SharedConversation, Messages: messages, More: more, Busy: state.busy(), CanSend: true}, err
}

func sharedCodexHistory(ctx context.Context, config model.Provider, thread sharedCodexThread, limit int) (codexSharedState, []model.SharedMessage, bool, error) {
	// The public API resolves continuation segments after a rollback and
	// reads legacy rollouts. Ordinary paginated threads can be read directly
	// without starting a second app-server against the desktop's database.
	if !thread.usesProjection() {
		return readCodexSharedAPI(ctx, config, thread, limit)
	}
	var state codexSharedState
	db, err := openSharedCodexDB(SharedStore(config), "thread_history_")
	if err != nil {
		return state, nil, false, err
	}
	defer db.Close()
	view, err := db.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return state, nil, false, err
	}
	defer view.Rollback()
	err = view.QueryRowContext(ctx, `SELECT turn_id, status, COALESCE(started_at,0) FROM thread_turns WHERE thread_id=? ORDER BY rollout_ordinal DESC LIMIT 1`, thread.ID).Scan(&state.turn, &state.status, &state.startedAt)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return state, nil, false, err
	}
	if limit == 0 {
		return state, nil, false, nil
	}
	// Generated images already have a file path. Keep their base64 copies out
	// of the polling query; the image endpoint reads the original item on demand.
	rows, err := view.QueryContext(ctx, `SELECT turn_id, item_id, COALESCE(created_at_ms,0),
		CASE WHEN item_type='imageGeneration' AND json_extract(item_json,'$.savedPath') <> ''
		THEN json_object('type',item_type,'savedPath',json_extract(item_json,'$.savedPath')) ELSE item_json END
		FROM thread_items WHERE thread_id=? AND item_type IN ('userMessage','agentMessage','reasoning','commandExecution',
		'fileChange','mcpToolCall','dynamicToolCall','collabAgentToolCall','webSearch','plan','imageView','imageGeneration')
		ORDER BY rollout_ordinal DESC`, thread.ID)
	if err != nil {
		return state, nil, false, err
	}
	defer rows.Close()
	page := sharedPage{remaining: limit}
	turnCitations := map[string]codexCitationIndex{}
	for rows.Next() {
		var turn, id string
		var ms int64
		var raw []byte
		if err := rows.Scan(&turn, &id, &ms, &raw); err != nil {
			return state, nil, false, err
		}
		item, err := decode(raw)
		if err != nil {
			return state, nil, false, err
		}
		recordCodexSharedCitations(turnCitations, turn, item)
		if entry, ok := codexSharedEntry(item, turn, id, sharedTime(ms)); ok && !page.add(entry) {
			break
		}
	}
	if err := rows.Err(); err != nil {
		return state, nil, false, err
	}
	return state, applyCodexSharedCitations(page.messages(), turnCitations), page.more, nil
}

func readCodexSharedAPI(ctx context.Context, config model.Provider, thread sharedCodexThread, limit int) (codexSharedState, []model.SharedMessage, bool, error) {
	var state codexSharedState
	client, err := openDiscovery(ctx, config, "", nil)
	if err != nil {
		return state, nil, false, err
	}
	defer client.close()
	page := sharedPage{remaining: limit}
	turnCitations := map[string]codexCitationIndex{}
	addTurns := func(turns []any) {
		if state.turn == "" && len(turns) > 0 {
			last := obj(turns[0])
			startedAt, _ := last["startedAt"].(float64)
			state = codexSharedState{turn: str(last["id"]), status: str(last["status"]), startedAt: int64(startedAt)}
		}
		if limit == 0 {
			return
		}
		for _, value := range turns {
			turn := obj(value)
			turnID := str(turn["id"])
			items := arr(turn["items"])
			for index := len(items) - 1; index >= 0; index-- {
				item := obj(items[index])
				recordCodexSharedCitations(turnCitations, turnID, item)
				if entry, ok := codexSharedEntry(item, turnID, str(item["id"]), ""); ok && !page.add(entry) {
					return
				}
			}
		}
	}
	if thread.mode == "paginated" {
		params := object{"threadId": thread.ID, "limit": min(max(1, limit), 20), "itemsView": "full", "sortDirection": "desc"}
		if limit == 0 {
			params["itemsView"] = "notLoaded"
		}
		for {
			result, err := client.call("thread/turns/list", params)
			if err != nil {
				return state, nil, false, err
			}
			addTurns(arr(result["data"]))
			cursor := str(result["nextCursor"])
			if limit == 0 || page.more || cursor == "" {
				break
			}
			params["cursor"] = cursor
		}
	} else {
		turns, err := codexLegacySharedTurns(client, thread.ID)
		if err != nil {
			return state, nil, false, err
		}
		slices.Reverse(turns)
		addTurns(turns)
	}
	return state, applyCodexSharedCitations(page.messages(), turnCitations), page.more, nil
}

func recordCodexSharedCitations(turns map[string]codexCitationIndex, turnID string, item object) {
	if !strings.EqualFold(str(item["type"]), "mcptoolcall") || item["result"] == nil {
		return
	}
	index := turns[turnID]
	if index == nil {
		index = codexCitationIndex{}
		turns[turnID] = index
	}
	index.addMCPResult(item["result"])
}

func applyCodexSharedCitations(messages []model.SharedMessage, turns map[string]codexCitationIndex) []model.SharedMessage {
	for i := range messages {
		msg := &messages[i]
		if msg.Role != "assistant" || msg.Kind == "tool" || msg.Kind == "reasoning" {
			continue
		}
		msg.Text, msg.Citations = resolveCodexCitations(msg.Text, turns[msg.TurnID], false)
	}
	return messages
}

func codexLegacySharedTurns(client *nativeClient, id string) ([]any, error) {
	result, err := client.call("thread/read", object{"threadId": id, "includeTurns": true})
	return arr(obj(result["thread"])["turns"]), err
}

// Codex Desktop's owning window runs the turn. A second app-server must never
// resume a thread that the window can be writing.
type codexSharedFrame struct {
	Type      string `json:"type"`
	ID        string `json:"requestId,omitempty"`
	Method    string `json:"method,omitempty"`
	Version   int    `json:"version,omitempty"`
	Target    string `json:"targetClientId,omitempty"`
	Params    any    `json:"params,omitempty"`
	Response  any    `json:"response,omitempty"`
	Result    string `json:"resultType,omitempty"`
	HandledBy string `json:"handledByClientId,omitempty"`
}

func writeCodexShared(conn net.Conn, frame codexSharedFrame) error {
	data, err := json.Marshal(frame)
	if err != nil {
		return err
	}
	buf := make([]byte, 4, 4+len(data))
	binary.LittleEndian.PutUint32(buf, uint32(len(data)))
	_, err = conn.Write(append(buf, data...))
	return err
}

func readCodexShared(conn net.Conn) (codexSharedFrame, error) {
	var frame codexSharedFrame
	var size uint32
	if err := binary.Read(conn, binary.LittleEndian, &size); err != nil {
		return frame, err
	}
	if size == 0 || size > 64<<20 {
		return frame, errors.New("invalid Codex Desktop frame length")
	}
	data := make([]byte, size)
	if _, err := io.ReadFull(conn, data); err != nil {
		return frame, err
	}
	err := json.Unmarshal(data, &frame)
	return frame, err
}

func requestCodexShared(conn net.Conn, id, method string, version int, target string, params object) (codexSharedFrame, error) {
	if err := writeCodexShared(conn, codexSharedFrame{Type: "request", ID: id, Method: method, Version: version, Target: target, Params: params}); err != nil {
		return codexSharedFrame{}, err
	}
	for {
		frame, err := readCodexShared(conn)
		if err != nil {
			return frame, err
		}
		switch frame.Type {
		case "client-discovery-request":
			if err := writeCodexShared(conn, codexSharedFrame{Type: "client-discovery-response", ID: frame.ID, Response: object{"canHandle": false}}); err != nil {
				return frame, err
			}
		case "response":
			if frame.ID == id {
				if frame.Result != "success" {
					return frame, ErrSharedUnavailable
				}
				return frame, nil
			}
		}
	}
}

func sharedCodexOwner(ctx context.Context, dir, id string) (net.Conn, string, error) {
	ctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	conn, err := dialSharedCodex(ctx, dir)
	if err != nil {
		return nil, "", err
	}
	deadline, _ := ctx.Deadline()
	_ = conn.SetDeadline(deadline)
	_, err = requestCodexShared(conn, rand.Text(), "initialize", 0, "", object{"clientType": "lever"})
	if err == nil {
		owner, err := requestCodexShared(conn, rand.Text(), "thread-owner-discovery", 1, "", object{"hostId": "local", "conversationId": id})
		if err == nil && owner.HandledBy != "" {
			return conn, owner.HandledBy, nil
		}
	}
	_ = conn.Close()
	return nil, "", ErrSharedUnavailable
}

func sendSharedCodex(ctx context.Context, config model.Provider, id, commandID, text string) error {
	threads, err := sharedCodexThreads(ctx, config, id)
	if err != nil {
		return err
	}
	thread, dir := threads[0], SharedStore(config)
	conn, owner, err := sharedCodexOwner(ctx, dir, id)
	if err != nil {
		if openSharedNative(ctx, "codex://threads/"+id, false) != nil {
			return ErrSharedUnavailable
		}
		openCtx, cancel := context.WithTimeout(ctx, 20*time.Second)
		defer cancel()
		for err != nil {
			select {
			case <-openCtx.Done():
				return ErrSharedUnavailable
			case <-time.After(400 * time.Millisecond):
				conn, owner, err = sharedCodexOwner(openCtx, dir, id)
			}
		}
	}
	defer conn.Close()
	stop := context.AfterFunc(ctx, func() { _ = conn.Close() })
	defer stop()
	before, _, _, err := sharedCodexHistory(ctx, config, thread, 0)
	if err != nil {
		return err
	}
	if before.busy() {
		return ErrSharedBusy
	}
	_ = conn.SetDeadline(time.Now().Add(15 * time.Second))
	_, err = requestCodexShared(conn, commandID, "thread-follower-start-turn", 2, owner, object{
		"conversationId": id,
		"turnStart": object{"context": object{}, "request": object{
			"threadId": id, "clientUserMessageId": commandID,
			"input": []object{{"type": "text", "text": text, "text_elements": []any{}}},
		}},
	})
	if err != nil {
		return ErrSharedUnconfirmed
	}
	// Keep a second Lever sender out until the owning window has recorded its
	// turn. A start delivered to a busy window can otherwise be processed twice.
	wait, cancel := context.WithTimeout(ctx, 8*time.Second)
	defer cancel()
	for wait.Err() == nil {
		state, _, _, err := sharedCodexHistory(wait, config, thread, 0)
		if err == nil && (state.turn != before.turn || state.status != before.status) {
			return nil
		}
		select {
		case <-wait.Done():
		case <-time.After(300 * time.Millisecond):
		}
	}
	return ErrSharedUnconfirmed
}
