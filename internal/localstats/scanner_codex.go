package localstats

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"time"

	"lever/internal/model"
)

type codexTokenUsage struct {
	InputTokens           int64 `json:"input_tokens"`
	CachedInputTokens     int64 `json:"cached_input_tokens"`
	CacheWriteInputTokens int64 `json:"cache_write_input_tokens"`
	OutputTokens          int64 `json:"output_tokens"`
	ReasoningOutputTokens int64 `json:"reasoning_output_tokens"`
	TotalTokens           int64 `json:"total_tokens"`
}

func (u codexTokenUsage) valid() bool {
	if u.InputTokens < 0 || u.CachedInputTokens < 0 || u.CacheWriteInputTokens < 0 || u.OutputTokens < 0 || u.ReasoningOutputTokens < 0 {
		return false
	}
	if u.CachedInputTokens+u.CacheWriteInputTokens > u.InputTokens {
		return false
	}
	if u.ReasoningOutputTokens > u.OutputTokens {
		return false
	}
	return true
}

func (u codexTokenUsage) toTotals() model.TokenTotals {
	return computeTotal(model.TokenTotals{
		UncachedInput: max(int64(0), u.InputTokens-u.CachedInputTokens-u.CacheWriteInputTokens),
		CachedInput:   u.CachedInputTokens,
		CacheWrite:    u.CacheWriteInputTokens,
		Output:        u.OutputTokens,
		Reasoning:     u.ReasoningOutputTokens,
	})
}

func (u codexTokenUsage) eq(other codexTokenUsage) bool {
	return u.InputTokens == other.InputTokens &&
		u.CachedInputTokens == other.CachedInputTokens &&
		u.CacheWriteInputTokens == other.CacheWriteInputTokens &&
		u.OutputTokens == other.OutputTokens &&
		u.ReasoningOutputTokens == other.ReasoningOutputTokens
}

func (u codexTokenUsage) sub(other codexTokenUsage) (codexTokenUsage, bool) {
	d := codexTokenUsage{
		InputTokens:           u.InputTokens - other.InputTokens,
		CachedInputTokens:     u.CachedInputTokens - other.CachedInputTokens,
		CacheWriteInputTokens: u.CacheWriteInputTokens - other.CacheWriteInputTokens,
		OutputTokens:          u.OutputTokens - other.OutputTokens,
		ReasoningOutputTokens: u.ReasoningOutputTokens - other.ReasoningOutputTokens,
	}
	d.TotalTokens = d.InputTokens + d.OutputTokens
	return d, d.valid()
}

type codexRolloutLine struct {
	Timestamp string          `json:"timestamp"`
	Type      string          `json:"type"`
	Payload   json.RawMessage `json:"payload"`
}

func parseCodexFile(path string) (parsedFile, error) {
	f, err := os.Open(path)
	if err != nil {
		return parsedFile{}, err
	}
	defer f.Close()

	var out parsedFile
	sessionID := strings.TrimSuffix(filepath.Base(path), filepath.Ext(path))
	var currentModel string
	var sawMeta bool
	var suppressingFork bool
	var forkAnchor time.Time
	var requestLedgerActive bool
	var lastCumulative *codexTokenUsage
	var lastSignature string
	var reqStartTS time.Time
	seenResponses := make(map[string]bool)

	isForkCopy := func(ts time.Time) bool {
		if !suppressingFork {
			return false
		}
		if ts.Sub(forkAnchor) < time.Second {
			forkAnchor = ts
			reqStartTS = time.Time{}
			return true
		}
		suppressingFork = false
		lastSignature = ""
		return false
	}

	err = readLines(f, func(line []byte) {
		isRespItem := bytes.Contains(line, []byte(`"response_item"`))
		isRespTrigger := isRespItem && (bytes.Contains(line, []byte(`"custom_tool_call_output"`)) ||
			bytes.Contains(line, []byte(`"function_call_output"`)) ||
			bytes.Contains(line, []byte(`"role":"user"`)) ||
			bytes.Contains(line, []byte(`"role": "user"`)))
		if !bytes.Contains(line, []byte(`"session_meta"`)) &&
			!bytes.Contains(line, []byte(`"turn_context"`)) &&
			!bytes.Contains(line, []byte(`"token_count"`)) &&
			!bytes.Contains(line, []byte(`"token_usage_record"`)) &&
			!bytes.Contains(line, []byte(`"user_message"`)) &&
			!(out.Title == "" && isRespItem) &&
			!isRespTrigger {
			return
		}
		// Fast path: capture trigger timestamps from large tool-output / user response_item lines
		// without JSON-unmarshaling multi-MB payloads once the session title is known.
		if isRespTrigger && out.Title != "" &&
			!bytes.Contains(line, []byte(`"token_usage_record"`)) &&
			!bytes.Contains(line, []byte(`"token_count"`)) &&
			!bytes.Contains(line, []byte(`"turn_context"`)) &&
			!bytes.Contains(line, []byte(`"session_meta"`)) {
			if ts, ok := extractFastTimestamp(line); ok && !isForkCopy(ts) {
				reqStartTS = ts
			}
			return
		}
		var entry codexRolloutLine
		if json.Unmarshal(line, &entry) != nil || len(entry.Payload) == 0 {
			return
		}
		ts, hasTS := parseTimestamp(entry.Timestamp)

		if entry.Type == "response_item" {
			var msg struct {
				Type    string `json:"type"`
				Role    string `json:"role"`
				Content []struct {
					Type string `json:"type"`
					Text string `json:"text"`
				} `json:"content"`
			}
			if json.Unmarshal(entry.Payload, &msg) == nil {
				if hasTS && (msg.Type == "function_call_output" || msg.Type == "custom_tool_call_output" || (msg.Type == "message" && msg.Role == "user")) {
					if !isForkCopy(ts) {
						reqStartTS = ts
					}
				}
				if out.Title == "" && msg.Type == "message" && msg.Role == "user" {
					for _, block := range msg.Content {
						txt := strings.TrimSpace(block.Text)
						if txt == "" ||
							strings.HasPrefix(txt, "# AGENTS.md") ||
							strings.HasPrefix(txt, "<environment_context>") ||
							strings.HasPrefix(txt, "<lever_") ||
							strings.HasPrefix(txt, "<INSTRUCTIONS>") {
							continue
						}
						out.Title = trimTitle(txt)
						break
					}
				}
			}
			return
		}

		switch entry.Type {
		case "session_meta":
			if sawMeta {
				return
			}
			sawMeta = true
			var meta struct {
				ID           string          `json:"id"`
				SessionID    string          `json:"session_id"`
				CWD          string          `json:"cwd"`
				ForkedFromID string          `json:"forked_from_id"`
				Source       json.RawMessage `json:"source"`
			}
			if json.Unmarshal(entry.Payload, &meta) != nil {
				return
			}
			if meta.ID != "" {
				sessionID = meta.ID
			} else if meta.SessionID != "" {
				sessionID = meta.SessionID
			}
			if meta.CWD != "" {
				out.CWD = meta.CWD
			}
			var parentThreadID string
			if src := bytes.TrimSpace(meta.Source); len(src) > 0 && src[0] == '{' {
				var srcObj struct {
					Subagent struct {
						ThreadSpawn struct {
							ParentThreadID string `json:"parent_thread_id"`
						} `json:"thread_spawn"`
					} `json:"subagent"`
				}
				if json.Unmarshal(src, &srcObj) == nil {
					parentThreadID = srcObj.Subagent.ThreadSpawn.ParentThreadID
				}
			}
			if hasTS && (meta.ForkedFromID != "" || parentThreadID != "") {
				suppressingFork = true
				forkAnchor = ts
			}
			return

		case "turn_context":
			requestLedgerActive = false
			if hasTS && !isForkCopy(ts) {
				reqStartTS = ts
			}
			var tc struct {
				Model string `json:"model"`
				CWD   string `json:"cwd"`
			}
			if json.Unmarshal(entry.Payload, &tc) == nil {
				if tc.Model != "" {
					currentModel = tc.Model
				}
				if out.CWD == "" && tc.CWD != "" {
					out.CWD = tc.CWD
				}
			}
			return

		case "token_usage_record":
			if !hasTS || currentModel == "" || isForkCopy(ts) {
				return
			}
			var rec struct {
				ResponseID string           `json:"response_id"`
				Usage      *codexTokenUsage `json:"usage"`
			}
			if json.Unmarshal(entry.Payload, &rec) != nil || rec.Usage == nil || !rec.Usage.valid() {
				return
			}
			if rec.ResponseID != "" {
				if seenResponses[rec.ResponseID] {
					return
				}
				seenResponses[rec.ResponseID] = true
				requestLedgerActive = true
				var durMs int64
				if !reqStartTS.IsZero() && ts.After(reqStartTS) {
					durMs = sanitizeDurationMs(ts.Sub(reqStartTS))
				}
				reqStartTS = ts
				totals := rec.Usage.toTotals()
				if totals.Total > 0 {
					out.Records = append(out.Records, usageRecord{
						Provider:   "codex",
						SessionID:  sessionID,
						Model:      currentModel,
						CWD:        out.CWD,
						Timestamp:  ts,
						Totals:     totals,
						DurationMs: durMs,
						DedupeKey:  "codex:" + sessionID + ":" + rec.ResponseID,
					})
				}
			}
			return
		}

		// Handle event_msg payloads: user_message (title) and token_count (usage snapshots)
		var payload struct {
			Type    string `json:"type"`
			Message string `json:"message"`
			Info    *struct {
				LastTokenUsage  *codexTokenUsage `json:"last_token_usage"`
				TotalTokenUsage *codexTokenUsage `json:"total_token_usage"`
			} `json:"info"`
		}
		if json.Unmarshal(entry.Payload, &payload) != nil {
			return
		}
		if payload.Type == "user_message" {
			if hasTS && !isForkCopy(ts) {
				reqStartTS = ts
			}
			if out.Title == "" && payload.Message != "" {
				out.Title = trimTitle(payload.Message)
			}
			return
		}
		if payload.Type != "token_count" || payload.Info == nil || !hasTS || currentModel == "" {
			return
		}
		last := payload.Info.LastTokenUsage
		cum := payload.Info.TotalTokenUsage

		if isForkCopy(ts) {
			if cum != nil && cum.valid() {
				c := *cum
				lastCumulative = &c
			}
			return
		}
		if requestLedgerActive {
			if cum != nil && cum.valid() {
				c := *cum
				lastCumulative = &c
			}
			return
		}

		prev := lastCumulative
		if cum != nil && cum.valid() {
			c := *cum
			lastCumulative = &c
		}
		hasLast := last != nil && last.valid() && last.InputTokens+last.OutputTokens > 0
		hasCum := cum != nil && cum.valid() && cum.InputTokens+cum.OutputTokens > 0
		if !hasLast && !hasCum {
			return
		}
		if cum != nil && prev != nil && cum.eq(*prev) {
			return
		}

		var effective codexTokenUsage
		if cum != nil && prev != nil {
			if delta, ok := cum.sub(*prev); ok && delta.InputTokens+delta.OutputTokens > 0 {
				effective = delta
			} else if hasLast && cum.eq(*last) {
				// Counter restarted in resumed process.
				effective = *last
			} else {
				return
			}
		} else if hasLast {
			sigBytes, _ := json.Marshal(last)
			sig := string(sigBytes)
			if cum == nil && sig == lastSignature {
				return
			}
			lastSignature = sig
			effective = *last
		} else if hasCum {
			effective = *cum
		} else {
			return
		}

		totals := effective.toTotals()
		if totals.Total == 0 {
			return
		}
		var durMs int64
		if !reqStartTS.IsZero() && ts.After(reqStartTS) {
			durMs = sanitizeDurationMs(ts.Sub(reqStartTS))
		}
		reqStartTS = ts
		out.Records = append(out.Records, usageRecord{
			Provider:   "codex",
			SessionID:  sessionID,
			Model:      currentModel,
			CWD:        out.CWD,
			Timestamp:  ts,
			Totals:     totals,
			DurationMs: durMs,
		})
	})

	for i := range out.Records {
		if out.Records[i].CWD == "" {
			out.Records[i].CWD = out.CWD
		}
		out.Records[i].Title = out.Title
	}
	return out, err
}
