package provider

import (
	"bytes"
	"context"
	"encoding/json"
	"path/filepath"
	"strings"
	"time"

	"lever/internal/model"
)

type codexSharedState struct {
	turn, status string
	startedAt    int64 // Unix seconds in both the Codex projection and app-server API.
	preview      string
}

func (s codexSharedState) busy() bool { return s.status == "inProgress" || s.status == "running" }

func (s codexSharedState) activity() *model.SharedActivity {
	if !s.busy() {
		return nil
	}
	return &model.SharedActivity{Status: "running", TurnID: s.turn, StartedAt: sharedTime(s.startedAt * 1000)}
}

// Read the latest turn and visible message for each listed session in one snapshot.
func sharedCodexSummaries(ctx context.Context, dir string, threads []sharedCodexThread) map[string]codexSharedState {
	if len(threads) == 0 {
		return nil
	}
	db, err := openSharedCodexDB(dir, "thread_history_")
	if err != nil {
		return nil
	}
	defer db.Close()
	ids := make([]string, 0, len(threads))
	for _, thread := range threads {
		ids = append(ids, thread.ID)
	}
	keys, _ := json.Marshal(ids)
	rows, err := db.QueryContext(ctx, `SELECT ids.value, COALESCE(turn.turn_id,''), COALESCE(turn.status,''), COALESCE(turn.started_at,0),
		COALESCE((SELECT COALESCE(NULLIF(json_extract(item_json,'$.text'),''),
			(SELECT group_concat(json_extract(value,'$.text'),'') FROM json_each(item_json,'$.content')
			 WHERE type='object' AND json_extract(value,'$.type') IN ('text','output_text'))) AS message
			FROM thread_items WHERE thread_id=ids.value AND item_type IN ('userMessage','agentMessage')
			AND json_valid(item_json) AND trim(message,char(9,10,11,12,13,32)) <> ''
			ORDER BY rollout_ordinal DESC LIMIT 1),'')
		FROM json_each(?) AS ids LEFT JOIN thread_turns AS turn ON turn.thread_id=ids.value
		AND turn.rollout_ordinal=(SELECT rollout_ordinal FROM thread_turns WHERE thread_id=ids.value ORDER BY rollout_ordinal DESC LIMIT 1)`, string(keys))
	if err != nil {
		return nil
	}
	defer rows.Close()
	states := make(map[string]codexSharedState, len(ids))
	for rows.Next() {
		var id string
		var state codexSharedState
		if rows.Scan(&id, &state.turn, &state.status, &state.startedAt, &state.preview) == nil {
			state.preview = sharedSnippet(stripCodexCitations(state.preview))
			states[id] = state
		}
	}
	return states
}

func sharedCodexRolloutState(ctx context.Context, path string) codexSharedState {
	var state codexSharedState
	if !filepath.IsAbs(path) {
		return state
	}
	_ = readSharedLinesBackwards(ctx, path, 0, func(line []byte) bool {
		if !bytes.Contains(line, []byte(`"event_msg"`)) {
			return false
		}
		var event struct {
			Type      string    `json:"type"`
			Timestamp time.Time `json:"timestamp"`
			Payload   struct {
				Type   string `json:"type"`
				TurnID string `json:"turn_id"`
			} `json:"payload"`
		}
		if json.Unmarshal(line, &event) != nil || event.Type != "event_msg" {
			return false
		}
		switch event.Payload.Type {
		case "task_started", "turn_started":
			state = codexSharedState{turn: event.Payload.TurnID, status: "inProgress", startedAt: event.Timestamp.Unix()}
			return true
		case "task_complete", "turn_complete", "turn_aborted":
			return true
		default:
			return false
		}
	})
	return state
}

func sharedCodexRolloutPreview(ctx context.Context, path string) string {
	if !filepath.IsAbs(path) {
		return ""
	}
	var preview string
	readSharedPreviewTail(ctx, path, func(line []byte) bool {
		if !bytes.Contains(line, []byte(`"event_msg"`)) {
			return false
		}
		var event struct {
			Type    string `json:"type"`
			Payload struct {
				Type             string `json:"type"`
				Message          string `json:"message"`
				LastAgentMessage string `json:"last_agent_message"`
				Item             struct {
					Type    string `json:"type"`
					Content []struct {
						Type string `json:"type"`
						Text string `json:"text"`
					} `json:"content"`
				} `json:"item"`
			} `json:"payload"`
		}
		if json.Unmarshal(line, &event) != nil || event.Type != "event_msg" {
			return false
		}
		payload := event.Payload
		switch payload.Type {
		case "user_message", "agent_message":
			preview = sharedSnippet(stripCodexCitations(payload.Message))
		case "task_complete", "turn_complete":
			preview = sharedSnippet(stripCodexCitations(payload.LastAgentMessage))
		case "item_completed":
			item := payload.Item
			if item.Type != "UserMessage" && item.Type != "AgentMessage" {
				return false
			}
			var message strings.Builder
			for _, part := range item.Content {
				if strings.EqualFold(part.Type, "text") || part.Type == "output_text" {
					message.WriteString(part.Text)
				}
			}
			preview = sharedSnippet(stripCodexCitations(message.String()))
		case "thread_rolled_back":
			return true
		}
		return preview != ""
	})
	return preview
}
