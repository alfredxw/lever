package provider

import (
	"context"
	"database/sql"
	"encoding/json"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"slices"
	"strings"

	"github.com/segmentio/encoding/proto"
)

// AGY 1.5 acknowledges invoke_subagent as soon as it creates the child. The
// parent's child records identify the launch step. Its trajectory records when
// a report actually reaches the planner, even when it races with end_turn.
type antigravityChildRecord struct {
	ConversationID string `json:"conversationId"`
	SpawnStepIndex *int   `json:"spawnStepIndex"`
	State          string `json:"state"`
}

// Only the fields used from AGY's native StepMetadata and CortexStep messages.
type antigravityStepMetadata struct {
	ToolCall struct {
		ID        string `protobuf:"bytes,1,opt"`
		Name      string `protobuf:"bytes,2,opt"`
		Arguments string `protobuf:"bytes,3,opt"`
	} `protobuf:"bytes,4,opt"`
}

type antigravityReportStep struct {
	SystemMessage struct {
		AgentMessage struct {
			Recipient string `protobuf:"bytes,2,opt"`
			Sender    string `protobuf:"bytes,3,opt"`
			Content   string `protobuf:"bytes,4,opt"`
		} `protobuf:"bytes,4,opt"`
	} `protobuf:"bytes,114,opt"`
}

type antigravityPlannerStep struct {
	Response struct {
		Text      string   `protobuf:"bytes,1,opt"`
		ToolCalls [][]byte `protobuf:"bytes,7,rep"`
		Display   string   `protobuf:"bytes,8,opt"`
	} `protobuf:"bytes,20,opt"`
}

type antigravityChildOutcome struct {
	status string
	report string
}

type antigravityChildProbe func(context.Context, map[string]int, string) (map[string]antigravityChildOutcome, error)

func (s *antigravitySessionDB) watchSubagents(parent string) antigravityChildProbe {
	before := s.regular()
	// Launch identity is immutable for this prompt. Later polls read only the
	// matched children, including any kill written after the launch.
	bindings := map[string][]antigravityChildRecord{}
	return func(ctx context.Context, calls map[string]int, reply string) (map[string]antigravityChildOutcome, error) {
		after := s.regular()
		if after == nil || !antigravitySessionID.MatchString(parent) || before != nil && !os.SameFile(before, after) {
			return nil, nil
		}
		before = after
		db, err := s.open()
		if err != nil {
			return nil, nil
		}
		defer db.Close()
		ctx, cancel := context.WithTimeout(ctx, antigravitySettleTimeout)
		defer cancel()
		tx, err := db.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
		if err != nil {
			return nil, nil
		}
		defer tx.Rollback()
		return s.subagentOutcomes(tx, parent, calls, bindings, reply)
	}
}

func (s *antigravitySessionDB) subagentOutcomes(tx *sql.Tx, parent string, calls map[string]int, bindings map[string][]antigravityChildRecord, reply string) (map[string]antigravityChildOutcome, error) {
	// Read only this parent's native declarations. Never open a path supplied
	// by a tool or read the child's workspace or private transcript.
	root, err := os.OpenRoot(s.dataDir)
	if err != nil {
		return nil, nil
	}
	defer root.Close()
	var directory string
	for _, part := range []string{"brain", parent, ".system_generated", "subagents"} {
		directory = filepath.Join(directory, part)
		if info, err := root.Lstat(directory); err != nil || !info.IsDir() {
			return nil, nil
		}
	}
	dir, err := root.OpenRoot(directory)
	if err != nil {
		return nil, nil
	}
	defer dir.Close()
	for call, count := range calls {
		if len(bindings[call]) != count {
			bindAntigravityChildren(dir, tx, calls, bindings)
			break
		}
	}
	lastReply, providerFailure := antigravityDeliveredPlannerStep(tx, reply)
	outcomes := make(map[string]antigravityChildOutcome, len(calls))
	for call, count := range calls {
		children := bindings[call]
		if len(children) != count {
			continue
		}
		var reports, statuses []string
		for _, binding := range children {
			child := readAntigravityChild(dir, binding.ConversationID)
			if child == nil || *child.SpawnStepIndex != *binding.SpawnStepIndex {
				break
			}
			spawn := *child.SpawnStepIndex
			if providerFailure > spawn {
				var payload []byte
				_ = tx.QueryRow("SELECT "+antigravityErrorPayload+" FROM steps WHERE idx = ? AND step_type = 17", providerFailure).Scan(&payload)
				return nil, antigravityStepError(payload, errAntigravityProvider)
			}
			if child.State == "SUBAGENT_STATE_KILLED" {
				statuses = append(statuses, "interrupted")
				continue
			}
			idx, report, ok := antigravityChildReport(tx, parent, child.ConversationID, spawn)
			switch {
			case !ok:
				continue
			case idx <= spawn && child.State == "SUBAGENT_STATE_ALIVE":
				statuses = append(statuses, "running")
			case idx > spawn:
				reports = append(reports, report)
				if lastReply > idx {
					statuses = append(statuses, "completed")
				} else {
					statuses = append(statuses, "reported")
				}
			}
		}
		if len(statuses) == count {
			for _, status := range []string{"running", "reported", "interrupted", "completed"} {
				if slices.Contains(statuses, status) {
					outcomes[call] = antigravityChildOutcome{status: status, report: strings.Join(reports, "\n\n")}
					break
				}
			}
		}
	}
	return outcomes, nil
}

func bindAntigravityChildren(dir *os.Root, tx *sql.Tx, calls map[string]int, bindings map[string][]antigravityChildRecord) {
	entries, err := fs.ReadDir(dir.FS(), ".")
	if err != nil {
		return
	}
	found := map[string][]antigravityChildRecord{}
	for _, entry := range entries {
		id, ok := strings.CutSuffix(entry.Name(), ".json")
		if !ok || !antigravitySessionID.MatchString(id) || !entry.Type().IsRegular() {
			continue
		}
		child := readAntigravityChild(dir, id)
		if child == nil {
			continue
		}
		var raw []byte
		var meta antigravityStepMetadata
		err := tx.QueryRow("SELECT metadata FROM steps WHERE idx = ? AND length(metadata) <= ?", *child.SpawnStepIndex, 1<<20).Scan(&raw)
		if err == nil && proto.Unmarshal(raw, &meta) == nil && meta.ToolCall.Name == "invoke_subagent" && calls[meta.ToolCall.ID] > 0 {
			found[meta.ToolCall.ID] = append(found[meta.ToolCall.ID], *child)
		}
	}
	for call, children := range found {
		if len(children) == calls[call] {
			bindings[call] = children
		}
	}
}

func readAntigravityChild(dir *os.Root, id string) *antigravityChildRecord {
	name := id + ".json"
	info, err := dir.Lstat(name)
	if err != nil || !info.Mode().IsRegular() || info.Size() > 64<<10 {
		return nil
	}
	f, err := dir.Open(name)
	if err != nil {
		return nil
	}
	defer f.Close()
	var child antigravityChildRecord
	if json.NewDecoder(io.LimitReader(f, 64<<10)).Decode(&child) != nil || child.ConversationID != id || child.SpawnStepIndex == nil {
		return nil
	}
	return &child
}

// A waiting message can still be Lever's last text after the child reports.
// Require a later, finished planner step whose reply also arrived over ACP.
func antigravityDeliveredPlannerStep(tx *sql.Tx, reply string) (delivered, failed int) {
	var idx, stepType int
	var raw []byte
	var planner antigravityPlannerStep
	err := tx.QueryRow(`SELECT idx, step_type, CASE WHEN step_type = 15 AND status = 3 AND length(step_payload) <= ? THEN step_payload END
		FROM steps ORDER BY idx DESC LIMIT 1`, 4<<20).Scan(&idx, &stepType, &raw)
	if err == nil && stepType == 17 {
		return -1, idx
	}
	if err == nil && proto.Unmarshal(raw, &planner) == nil && len(planner.Response.ToolCalls) == 0 {
		for _, text := range []string{planner.Response.Display, planner.Response.Text} {
			if text = strings.TrimSpace(text); text != "" && strings.HasSuffix(strings.TrimSpace(reply), text) {
				return idx, -1
			}
		}
	}
	return -1, -1
}

func antigravityChildReport(tx *sql.Tx, parent, child string, spawn int) (int, string, bool) {
	// An outgoing send_message after a report gives the child more work. Only
	// a subsequent incoming message can satisfy that handoff.
	rows, err := tx.Query(`SELECT idx, step_type, CASE step_type WHEN 101 THEN step_payload ELSE metadata END FROM steps
		WHERE idx > ? AND status = 3 AND (
		  (step_type = 101 AND length(step_payload) <= ? AND instr(step_payload, CAST(? AS BLOB)) > 0) OR
		  (step_type = 132 AND length(metadata) <= ? AND instr(metadata, CAST('send_message' AS BLOB)) > 0 AND instr(metadata, CAST(? AS BLOB)) > 0)
		) ORDER BY idx DESC`, spawn, 4<<20, child, 1<<20, child)
	if err != nil {
		return -1, "", false
	}
	defer rows.Close()
	for rows.Next() {
		var idx, kind int
		var raw []byte
		if rows.Scan(&idx, &kind, &raw) != nil {
			return -1, "", false
		}
		if kind == 132 {
			var meta antigravityStepMetadata
			var input struct{ Recipient string }
			if proto.Unmarshal(raw, &meta) != nil {
				return -1, "", false
			}
			if meta.ToolCall.Name == "send_message" && json.Unmarshal([]byte(meta.ToolCall.Arguments), &input) == nil && input.Recipient == child {
				return -1, "", true
			}
			continue
		}
		var step antigravityReportStep
		if proto.Unmarshal(raw, &step) != nil {
			return -1, "", false
		}
		message := step.SystemMessage.AgentMessage
		if message.Recipient == parent && message.Sender == child && message.Content != "" {
			return idx, message.Content, true
		}
	}
	return -1, "", rows.Err() == nil
}
