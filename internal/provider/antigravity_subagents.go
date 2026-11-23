package provider

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"time"
)

const (
	maxAntigravityChildren    = 64
	maxAntigravityMessages    = 256
	maxAntigravityRecordBytes = 1 << 20
)

// AGY 1.5 acknowledges invoke_subagent as soon as it creates the child. The
// child's inbox records the launching tool call ID (and any later send_message
// handoff), while the parent's inbox records the child's report.
type antigravityChildRecord struct {
	ConversationID string `json:"conversationId"`
	State          string `json:"state"`
}

type antigravityInboxMessage struct {
	Sender         string `json:"sender"`
	Recipient      string `json:"recipient"`
	Timestamp      string `json:"timestamp"`
	Content        string `json:"content"`
	SourceMetadata *struct {
		Tool *struct {
			ConversationID string `json:"conversationId"`
			ToolCall       *struct {
				ID   string `json:"id"`
				Name string `json:"name"`
			} `json:"toolCall"`
		} `json:"tool"`
	} `json:"sourceMetadata"`
}

type antigravityMessageRecord struct {
	antigravityInboxMessage
	parsedTime time.Time
	hasTime    bool
	modTime    time.Time
	name       string
}

type antigravityChildOutcome struct {
	status string
	report string
}

type antigravityChildProbe func(context.Context, map[string]int) (map[string]antigravityChildOutcome, error)

func (s *antigravitySessionDB) watchSubagents(parent string) antigravityChildProbe {
	before := s.regular()
	dbAllowed := before != nil
	startStep := -1
	if before != nil {
		if idx, ok := s.latestStepIndex(); ok {
			startStep = idx
		}
	} else if s != nil {
		if _, err := os.Lstat(s.path); errors.Is(err, os.ErrNotExist) {
			dbAllowed = true
		}
	}
	return func(ctx context.Context, calls map[string]int) (map[string]antigravityChildOutcome, error) {
		if s == nil || !antigravitySessionID.MatchString(parent) {
			return nil, nil
		}
		if dbAllowed {
			if err := s.providerFailureAfter(ctx, before, startStep); err != nil {
				return nil, err
			}
		}
		return s.subagentOutcomes(parent, calls), nil
	}
}

func (s *antigravitySessionDB) latestStepIndex() (int, bool) {
	db, err := s.open()
	if err != nil {
		return -1, false
	}
	defer db.Close()
	ctx, cancel := context.WithTimeout(context.Background(), antigravitySettleTimeout)
	defer cancel()
	var idx int
	if err := db.QueryRowContext(ctx, "SELECT COALESCE(MAX(idx), -1) FROM steps").Scan(&idx); err != nil {
		return -1, false
	}
	return idx, true
}

func (s *antigravitySessionDB) providerFailureAfter(ctx context.Context, before os.FileInfo, startStep int) error {
	after := s.regular()
	if after == nil || (before != nil && !os.SameFile(before, after)) {
		return nil
	}
	db, err := s.open()
	if err != nil {
		return nil
	}
	defer db.Close()
	readCtx, cancel := context.WithTimeout(ctx, antigravitySettleTimeout)
	defer cancel()
	const latest = " FROM steps WHERE idx > ? ORDER BY idx DESC LIMIT 1"
	var stepType int
	var payload []byte
	err = db.QueryRowContext(readCtx, "SELECT step_type, CASE WHEN step_type = 17 THEN "+antigravityErrorPayload+" END"+latest, startStep).Scan(&stepType, &payload)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		err = db.QueryRowContext(readCtx, "SELECT step_type"+latest, startStep).Scan(&stepType)
	}
	if err == nil && stepType == 17 {
		return antigravityStepError(payload, errAntigravityProvider)
	}
	return nil
}

// Returns outcomes only for calls with proven native child records under this
// parent's managed directory. Missing or unreadable records fail open (omitted)
// so a healthy turn is never locked behind manual confirmation.
func (s *antigravitySessionDB) subagentOutcomes(parent string, calls map[string]int) map[string]antigravityChildOutcome {
	if len(calls) == 0 {
		return nil
	}
	root, err := os.OpenRoot(s.dataDir)
	if err != nil {
		return nil
	}
	defer root.Close()
	subagentsDir, err := openManagedSubdir(root, "brain", parent, ".system_generated", "subagents")
	if err != nil {
		return nil
	}
	defer subagentsDir.Close()
	entries, err := fs.ReadDir(subagentsDir.FS(), ".")
	if err != nil {
		return nil
	}
	var childIDs []string
	for _, entry := range entries {
		id, ok := strings.CutSuffix(entry.Name(), ".json")
		if !ok || !antigravitySessionID.MatchString(id) || !entry.Type().IsRegular() {
			continue
		}
		childIDs = append(childIDs, id)
		if len(childIDs) > maxAntigravityChildren {
			return nil
		}
	}
	if len(childIDs) == 0 {
		return nil
	}
	parentMessages, ok := readAntigravityInbox(root, parent)
	if !ok {
		return nil
	}
	type senderSummary struct {
		count  int
		latest antigravityMessageRecord
	}
	parentReports := map[string]senderSummary{}
	for _, msg := range parentMessages {
		if msg.Sender == "" || (msg.Recipient != "" && msg.Recipient != parent) {
			continue
		}
		summary := parentReports[msg.Sender]
		if summary.count == 0 || antigravityMessageAfter(msg, summary.latest) {
			summary.latest = msg
		}
		summary.count++
		parentReports[msg.Sender] = summary
	}

	type groupedState struct {
		statuses []string
		reports  []string
	}
	grouped := map[string]*groupedState{}
	for _, childID := range childIDs {
		child := readAntigravityChild(subagentsDir, childID)
		if child == nil {
			continue
		}
		childMessages, ok := readAntigravityInbox(root, childID)
		if !ok {
			continue
		}
		var launchCallID string
		var sentCount int
		var latestFollowup antigravityMessageRecord
		var hasFollowup bool
		for _, msg := range childMessages {
			if msg.Sender != parent || msg.SourceMetadata == nil || msg.SourceMetadata.Tool == nil || msg.SourceMetadata.Tool.ToolCall == nil {
				continue
			}
			tool := msg.SourceMetadata.Tool
			if tool.ConversationID != "" && tool.ConversationID != parent {
				continue
			}
			switch tool.ToolCall.Name {
			case "invoke_subagent":
				sentCount++
				if calls[tool.ToolCall.ID] > 0 {
					launchCallID = tool.ToolCall.ID
				}
			case "send_message":
				sentCount++
				if !hasFollowup || antigravityMessageAfter(msg, latestFollowup) {
					latestFollowup = msg
					hasFollowup = true
				}
			}
		}
		if launchCallID == "" {
			continue
		}
		group := grouped[launchCallID]
		if group == nil {
			group = &groupedState{}
			grouped[launchCallID] = group
		}
		rep := parentReports[childID]
		switch child.State {
		case "SUBAGENT_STATE_KILLED":
			group.statuses = append(group.statuses, "interrupted")
		case "", "SUBAGENT_STATE_ALIVE":
			if rep.count == 0 || (hasFollowup && antigravityFollowupPending(latestFollowup, rep.latest, sentCount, rep.count)) {
				group.statuses = append(group.statuses, "running")
			} else {
				group.statuses = append(group.statuses, "reported")
				if text := strings.TrimSpace(rep.latest.Content); text != "" {
					group.reports = append(group.reports, text)
				}
			}
		default:
			group.statuses = append(group.statuses, "reported")
			if text := strings.TrimSpace(rep.latest.Content); text != "" {
				group.reports = append(group.reports, text)
			}
		}
	}

	outcomes := make(map[string]antigravityChildOutcome, len(grouped))
	for call, group := range grouped {
		for _, status := range []string{"running", "reported", "interrupted"} {
			if slices.Contains(group.statuses, status) {
				outcomes[call] = antigravityChildOutcome{
					status: status,
					report: strings.Join(group.reports, "\n\n"),
				}
				break
			}
		}
	}
	return outcomes
}

func openManagedSubdir(root *os.Root, parts ...string) (*os.Root, error) {
	var directory string
	for _, part := range parts {
		directory = filepath.Join(directory, part)
		info, err := root.Lstat(directory)
		if err != nil {
			return nil, err
		}
		if !info.IsDir() {
			return nil, os.ErrInvalid
		}
	}
	return root.OpenRoot(directory)
}

func readAntigravityChild(dir *os.Root, id string) *antigravityChildRecord {
	name := id + ".json"
	info, err := dir.Lstat(name)
	if err != nil || !info.Mode().IsRegular() || info.Size() > maxAntigravityRecordBytes {
		return nil
	}
	f, err := dir.Open(name)
	if err != nil {
		return nil
	}
	defer f.Close()
	var child antigravityChildRecord
	if json.NewDecoder(io.LimitReader(f, maxAntigravityRecordBytes)).Decode(&child) != nil {
		return nil
	}
	if child.ConversationID != "" && child.ConversationID != id {
		return nil
	}
	child.ConversationID = id
	return &child
}

func readAntigravityInbox(root *os.Root, conversationID string) ([]antigravityMessageRecord, bool) {
	if !antigravitySessionID.MatchString(conversationID) {
		return nil, false
	}
	dir, err := openManagedSubdir(root, "brain", conversationID, ".system_generated", "messages")
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, true
		}
		return nil, false
	}
	defer dir.Close()
	entries, err := fs.ReadDir(dir.FS(), ".")
	if err != nil {
		return nil, false
	}
	var messages []antigravityMessageRecord
	for _, entry := range entries {
		name := entry.Name()
		if !strings.HasSuffix(name, ".json") || name == "read.json" || !entry.Type().IsRegular() {
			continue
		}
		if len(messages) >= maxAntigravityMessages {
			return nil, false
		}
		info, err := dir.Lstat(name)
		if err != nil || !info.Mode().IsRegular() || info.Size() > maxAntigravityRecordBytes {
			return nil, false
		}
		f, err := dir.Open(name)
		if err != nil {
			return nil, false
		}
		var msg antigravityInboxMessage
		decodeErr := json.NewDecoder(io.LimitReader(f, maxAntigravityRecordBytes)).Decode(&msg)
		_ = f.Close()
		if decodeErr != nil {
			return nil, false
		}
		rec := antigravityMessageRecord{
			antigravityInboxMessage: msg,
			modTime:                 info.ModTime(),
			name:                    name,
		}
		if ts, err := time.Parse(time.RFC3339Nano, msg.Timestamp); err == nil {
			rec.parsedTime = ts
			rec.hasTime = true
		}
		messages = append(messages, rec)
	}
	return messages, true
}

func antigravityMessageAfter(a, b antigravityMessageRecord) bool {
	if a.hasTime && b.hasTime && !a.parsedTime.Equal(b.parsedTime) {
		return a.parsedTime.After(b.parsedTime)
	}
	if !a.modTime.Equal(b.modTime) {
		return a.modTime.After(b.modTime)
	}
	return a.name > b.name
}

func antigravityFollowupPending(followup, report antigravityMessageRecord, sentCount, reportCount int) bool {
	if followup.hasTime && report.hasTime {
		return followup.parsedTime.After(report.parsedTime)
	}
	if !followup.modTime.Equal(report.modTime) {
		return followup.modTime.After(report.modTime)
	}
	return sentCount > reportCount
}
