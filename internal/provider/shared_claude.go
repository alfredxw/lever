package provider

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"slices"
	"strconv"
	"strings"
	"time"

	"lever/internal/model"
)

type claudeSharedThread struct {
	model.SharedConversation
	transcript string
	path       string
}

type claudeDesktopRecord struct {
	ID       string   `json:"sessionId"`
	CLI      string   `json:"cliSessionId"`
	Cwd      string   `json:"cwd"`
	Title    string   `json:"title"`
	Prior    []string `json:"priorCliSessionIds"`
	Archived bool     `json:"isArchived"`
	updated  time.Time
}

type claudeSharedFile struct {
	path    string
	updated time.Time
}

func listSharedClaude(ctx context.Context, config model.Provider, managed map[string]bool) ([]model.SharedConversation, error) {
	threads, err := sharedClaudeThreads(ctx, config, "")
	sessions := sharedClaudeSessions(SharedStore(config))
	items := make([]model.SharedConversation, 0, len(threads))
	for _, thread := range threads {
		if !managed[thread.transcript] {
			thread.Activity = claudeSharedActivity(sessions[thread.transcript])
			thread.Preview = sharedClaudePreview(ctx, thread.path)
			items = append(items, thread.SharedConversation)
		}
	}
	return items, err
}

func sharedClaudeThreads(ctx context.Context, config model.Provider, id string) ([]claudeSharedThread, error) {
	dir := SharedStore(config)
	if dir == "" {
		return nil, os.ErrNotExist
	}
	files := map[string]claudeSharedFile{}
	projects := filepath.Join(dir, "projects")
	entries, err := os.ReadDir(projects)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	for _, entry := range entries {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		if !entry.IsDir() {
			continue
		}
		project := filepath.Join(projects, entry.Name())
		items, _ := os.ReadDir(project)
		for _, item := range items {
			nativeID, ok := strings.CutSuffix(item.Name(), ".jsonl")
			if !ok || !sharedUUID.MatchString(nativeID) || !item.Type().IsRegular() {
				continue
			}
			if info, err := item.Info(); err == nil && info.ModTime().After(files[nativeID].updated) {
				files[nativeID] = claudeSharedFile{filepath.Join(project, item.Name()), info.ModTime()}
			}
		}
	}
	thread := func(key, transcript, title, cwd string, file claudeSharedFile) claudeSharedThread {
		return claudeSharedThread{SharedConversation: model.SharedConversation{
			ID: key, Provider: config.ID, Runtime: "claude", Title: sharedSnippet(title), Cwd: cwd, UpdatedAt: sharedTime(file.updated.UnixMilli()),
		}, transcript: transcript, path: file.path}
	}
	items := []claudeSharedThread{}
	for _, desktop := range readSharedClaudeDesktop(ctx) {
		file := files[desktop.CLI]
		delete(files, desktop.CLI)
		for _, prior := range desktop.Prior {
			delete(files, prior)
		}
		if desktop.Archived || id != "" && id != desktop.ID {
			continue
		}
		if file.path == "" {
			// The App can replace its CLI session on reopen. The new
			// transcript may only exist after the first input is received.
			if _, ok := findSharedClaudePeer(dir, desktop.CLI); !ok {
				continue
			}
			file.updated = desktop.updated
		}
		items = append(items, thread(desktop.ID, desktop.CLI, desktop.Title, desktop.Cwd, file))
	}
	if !strings.HasPrefix(id, "local_") {
		keys := make([]string, 0, len(files))
		for key := range files {
			if id == "" || id == key {
				keys = append(keys, key)
			}
		}
		slices.SortFunc(keys, func(a, b string) int { return files[b].updated.Compare(files[a].updated) })
		for _, key := range keys {
			if len(items) >= SharedListLimit || ctx.Err() != nil {
				break
			}
			file := files[key]
			title, cwd, interactive := sharedClaudeMeta(file.path)
			if interactive {
				if named := sharedClaudeTitle(ctx, file.path); named != "" {
					title = named
				}
				items = append(items, thread(key, key, title, cwd, file))
			}
		}
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if id != "" && len(items) == 0 {
		return nil, os.ErrNotExist
	}
	slices.SortFunc(items, func(a, b claudeSharedThread) int { return strings.Compare(b.UpdatedAt, a.UpdatedAt) })
	return items[:min(len(items), SharedListLimit)], nil
}

func readSharedClaudeDesktop(ctx context.Context) []claudeDesktopRecord {
	home, err := os.UserHomeDir()
	if err != nil {
		return nil
	}
	var base string
	switch runtime.GOOS {
	case "darwin":
		base = filepath.Join(home, "Library", "Application Support")
	case "windows":
		base = os.Getenv("LOCALAPPDATA")
		if base == "" {
			base = filepath.Join(home, "AppData", "Local")
		}
	default:
		return nil
	}
	var result []claudeDesktopRecord
	for _, variant := range []string{"Claude", "Claude-3p"} {
		root := filepath.Join(base, variant, "claude-code-sessions")
		// Desktop stores an index entry two directories below this root.
		matches, _ := filepath.Glob(filepath.Join(root, "*", "*", "local_*.json"))
		for _, path := range matches {
			if ctx.Err() != nil {
				return result
			}
			var entry claudeDesktopRecord
			if readSharedJSON(path, &entry) == nil && sharedUUID.MatchString(entry.CLI) &&
				entry.ID+".json" == filepath.Base(path) && sharedUUID.MatchString(strings.TrimPrefix(entry.ID, "local_")) {
				if info, err := os.Stat(path); err == nil {
					entry.updated = info.ModTime()
				}
				result = append(result, entry)
			}
		}
	}
	return result
}

func readSharedJSON(path string, value any) error {
	file, err := os.Open(path)
	if err != nil {
		return err
	}
	defer file.Close()
	return json.NewDecoder(io.LimitReader(file, 16<<20)).Decode(value)
}

type claudeSharedOrigin struct {
	Kind string `json:"kind"`
	Body string `json:"body"`
}

type claudeSharedEvent struct {
	Type       string `json:"type"`
	ID         string `json:"uuid"`
	Timestamp  string `json:"timestamp"`
	Cwd        string `json:"cwd"`
	Entrypoint string `json:"entrypoint"`
	Side       bool   `json:"isSidechain"`
	Meta       bool   `json:"isMeta"`
	Summary    bool   `json:"isCompactSummary"`
	Content    string `json:"content"`
	Message    struct {
		Content    json.RawMessage `json:"content"`
		StopReason string          `json:"stop_reason"`
	} `json:"message"`
	Origin     *claudeSharedOrigin `json:"origin"`
	Attachment *struct {
		Type        string              `json:"type"`
		CommandMode string              `json:"commandMode"`
		Prompt      json.RawMessage     `json:"prompt"`
		Origin      *claudeSharedOrigin `json:"origin"`
	} `json:"attachment"`
}

func sharedClaudeMeta(path string) (title, cwd string, interactive bool) {
	f, err := os.Open(path)
	if err != nil {
		return "", "", false
	}
	defer f.Close()
	scan := bufio.NewScanner(io.LimitReader(f, maxSharedLine+1))
	scan.Buffer(make([]byte, 4096), maxSharedLine+1)
	for scan.Scan() {
		var event claudeSharedEvent
		if json.Unmarshal(scan.Bytes(), &event) != nil {
			continue
		}
		if event.Side || strings.HasPrefix(event.Entrypoint, "claude-desktop") || strings.HasPrefix(event.Entrypoint, "sdk-") || event.Entrypoint == claudeEntrypoint {
			return "", "", false
		}
		if cwd == "" {
			cwd = event.Cwd
		}
		for _, entry := range claudeSharedEntries(event) {
			if entry.Role == "user" {
				return entry.Text, cwd, true
			}
		}
	}
	return "", cwd, cwd != ""
}

const claudeSharedPreamble = "The following message is from the user through Lever. Answer in this conversation.\n\n"

var claudeSharedClose = regexp.MustCompile(`(?i)</cross-session-message`)

func accessibleSharedClaudeThread(ctx context.Context, config model.Provider, id string, managed map[string]bool) (claudeSharedThread, error) {
	threads, err := sharedClaudeThreads(ctx, config, id)
	if err != nil {
		return claudeSharedThread{}, err
	}
	if managed[threads[0].transcript] {
		return claudeSharedThread{}, os.ErrNotExist
	}
	return threads[0], nil
}

func readSharedClaude(ctx context.Context, config model.Provider, id string, limit int, managed map[string]bool) (model.SharedHistory, error) {
	thread, err := accessibleSharedClaudeThread(ctx, config, id, managed)
	if err != nil {
		return model.SharedHistory{}, err
	}
	dir := SharedStore(config)
	sessions := sharedClaudeSessions(dir)[thread.transcript]
	_, reachable := sharedClaudePeerFor(dir, sessions)
	thread.Activity = claudeSharedActivity(sessions)
	view := model.SharedHistory{Conversation: thread.SharedConversation, Messages: []model.SharedMessage{},
		CanSend: reachable || runtime.GOOS == "darwin" && strings.HasPrefix(id, "local_"),
		Busy:    thread.Activity != nil}
	if thread.path == "" {
		return view, nil
	}
	seen := make(map[string]bool)
	page := sharedPage{remaining: limit}
	err = readSharedLinesBackwards(ctx, thread.path, 0, func(line []byte) bool {
		var event claudeSharedEvent
		if json.Unmarshal(line, &event) == nil && event.ID != "" && !seen[event.ID] {
			seen[event.ID] = true
			entries := claudeSharedEntries(event)
			for i := len(entries) - 1; i >= 0; i-- {
				if !page.add(entries[i]) {
					return true
				}
			}
		}
		return false
	})
	view.Messages, view.More = page.messages(), page.more
	return view, err
}

type claudeSharedPeer struct {
	ID          string `json:"sessionId"`
	Status      string `json:"status"`
	Socket      string `json:"messagingSocketPath"`
	Protocol    int    `json:"peerProtocol"`
	ParkedJobID string `json:"parkedJobId"`
	Token       string `json:"-"`
	pid         string
}

var claudePeerToken = regexp.MustCompile(`^[0-9a-f]{32}$`)

// Status is published by the Claude process even when its peer inbox is absent.
func sharedClaudeSessions(dir string) map[string][]claudeSharedPeer {
	if dir == "" {
		return nil
	}
	root := filepath.Join(dir, "sessions")
	entries, _ := os.ReadDir(root)
	sessions := map[string][]claudeSharedPeer{}
	for _, entry := range entries {
		name, ok := strings.CutSuffix(entry.Name(), ".json")
		pid, err := strconv.ParseInt(name, 10, 32)
		if !ok || err != nil || pid <= 0 || !entry.Type().IsRegular() {
			continue
		}
		var peer claudeSharedPeer
		if readSharedJSON(filepath.Join(root, entry.Name()), &peer) != nil || !sharedUUID.MatchString(peer.ID) || !sharedClaudeProcessAlive(int(pid)) {
			continue
		}
		peer.pid = name
		sessions[peer.ID] = append(sessions[peer.ID], peer)
	}
	return sessions
}

func claudeSharedActivity(sessions []claudeSharedPeer) *model.SharedActivity {
	var status string
	for _, session := range sessions {
		if session.ParkedJobID != "" {
			continue
		}
		switch session.Status {
		case "waiting":
			return &model.SharedActivity{Status: "waiting_user"}
		case "busy":
			status = "running"
		}
	}
	if status != "" {
		return &model.SharedActivity{Status: status}
	}
	return nil
}

func findSharedClaudePeer(dir, transcript string) (claudeSharedPeer, bool) {
	return sharedClaudePeerFor(dir, sharedClaudeSessions(dir)[transcript])
}

func sharedClaudePeerFor(dir string, sessions []claudeSharedPeer) (claudeSharedPeer, bool) {
	root := filepath.Join(dir, "sessions")
	for _, peer := range sessions {
		if peer.Protocol != 1 {
			continue
		}
		canonicalSocket, usable := sharedClaudeSocket(peer.Socket, peer.pid)
		if !usable {
			continue
		}
		var key struct {
			PeerToken string `json:"peerToken"`
		}
		keyName := fmt.Sprintf("%s.%x.key", peer.pid, sha256.Sum256([]byte(canonicalSocket)))
		if readSharedJSON(filepath.Join(root, keyName), &key) == nil && claudePeerToken.MatchString(key.PeerToken) {
			peer.Token = key.PeerToken
		} else if sharedClaudeAuthRequired {
			continue
		}
		return peer, true
	}
	return claudeSharedPeer{}, false
}

// Forward via the native Claude Code peer inbox, which does not return a send receipt.
func sendSharedClaude(ctx context.Context, config model.Provider, id, commandID, text string, managed map[string]bool) error {
	threads, err := sharedClaudeThreads(ctx, config, id)
	if err != nil {
		return err
	}
	thread, dir := threads[0], SharedStore(config)
	if managed[thread.transcript] {
		return os.ErrNotExist
	}
	peer, ok := findSharedClaudePeer(dir, thread.transcript)
	if !ok && strings.HasPrefix(id, "local_") && openSharedNative(ctx, "claude://claude.ai/epitaxy/"+id, true) == nil {
		wait, cancel := context.WithTimeout(ctx, 20*time.Second)
		defer cancel()
		for !ok && wait.Err() == nil {
			if current, err := sharedClaudeThreads(wait, config, id); err == nil {
				thread = current[0]
				if managed[thread.transcript] {
					return os.ErrNotExist
				}
				peer, ok = findSharedClaudePeer(dir, thread.transcript)
			}
			if !ok {
				select {
				case <-wait.Done():
				case <-time.After(400 * time.Millisecond):
				}
			}
		}
	}
	if !ok {
		return ErrSharedUnavailable
	}
	var offset int64
	if thread.path != "" {
		info, err := os.Stat(thread.path)
		if err != nil {
			return err
		}
		offset = info.Size()
	}
	body := claudeSharedPreamble + claudeSharedClose.ReplaceAllString(text, `<\/cross-session-message`)
	message := `<cross-session-message from-name="Lever">` + "\n" + body + "\n</cross-session-message>"
	var data bytes.Buffer
	encoder := json.NewEncoder(&data)
	encoder.SetEscapeHTML(false)
	if peer.Token != "" {
		if err := encoder.Encode(object{"type": "auth", "token": peer.Token}); err != nil {
			return err
		}
	}
	if err := encoder.Encode(object{
		"type": "user", "message": object{"role": "user", "content": message},
		"priority": "next", "msgV": 1, "msg_id": commandID, "session_id": thread.transcript,
	}); err != nil {
		return err
	}
	dial, cancel := context.WithTimeout(ctx, 4*time.Second)
	defer cancel()
	conn, err := dialSharedSocket(dial, peer.Socket)
	if err != nil {
		return ErrSharedUnavailable
	}
	deadline, _ := dial.Deadline()
	_ = conn.SetWriteDeadline(deadline)
	n, err := conn.Write(data.Bytes())
	_ = conn.Close()
	if err != nil || n != data.Len() {
		return ErrSharedUnconfirmed
	}
	confirm, done := context.WithTimeout(ctx, 6*time.Second)
	defer done()
	for confirm.Err() == nil {
		if thread.path == "" {
			if current, err := sharedClaudeThreads(confirm, config, id); err == nil && current[0].transcript == thread.transcript {
				thread.path = current[0].path
			}
		}
		found := false
		_ = readSharedLinesBackwards(confirm, thread.path, offset, func(line []byte) bool {
			var event claudeSharedEvent
			if json.Unmarshal(line, &event) == nil {
				origin := event.Origin
				if event.Attachment != nil {
					origin = event.Attachment.Origin
				}
				found = event.Type == "queue-operation" && strings.Contains(event.Content, body) ||
					origin != nil && origin.Kind == "peer" && strings.Contains(origin.Body, body)
			}
			return found
		})
		if found {
			return nil
		}
		select {
		case <-confirm.Done():
		case <-time.After(200 * time.Millisecond):
		}
	}
	return ErrSharedUnconfirmed
}
