package localstats

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"lever/internal/model"
)

const claudeSyntheticModel = "<synthetic>"

type claudeLine struct {
	Type      string          `json:"type"`
	Timestamp string          `json:"timestamp"`
	SessionID string          `json:"sessionId"`
	RequestID string          `json:"requestId"`
	CWD       string          `json:"cwd"`
	CostUSD   *float64        `json:"costUSD"`
	Message   json.RawMessage `json:"message"`
}

type claudeAssistantMessage struct {
	ID      string       `json:"id"`
	Model   string       `json:"model"`
	Usage   *claudeUsage `json:"usage"`
	Content any          `json:"content"`
}

type claudeUsage struct {
	InputTokens              int64                `json:"input_tokens"`
	CacheReadInputTokens     int64                `json:"cache_read_input_tokens"`
	CacheCreationInputTokens int64                `json:"cache_creation_input_tokens"`
	OutputTokens             int64                `json:"output_tokens"`
	CacheCreation            *claudeCacheCreation `json:"cache_creation"`
	Iterations               []claudeAdvisorIter  `json:"iterations"`
}

type claudeCacheCreation struct {
	Ephemeral1hInputTokens int64 `json:"ephemeral_1h_input_tokens"`
}

type claudeAdvisorIter struct {
	Type                     string               `json:"type"`
	Model                    string               `json:"model"`
	InputTokens              int64                `json:"input_tokens"`
	CacheReadInputTokens     int64                `json:"cache_read_input_tokens"`
	CacheCreationInputTokens int64                `json:"cache_creation_input_tokens"`
	OutputTokens             int64                `json:"output_tokens"`
	CacheCreation            *claudeCacheCreation `json:"cache_creation"`
}

func parseClaudeFile(path string) (parsedFile, error) {
	f, err := os.Open(path)
	if err != nil {
		return parsedFile{}, err
	}
	defer f.Close()

	fallbackSessionID := strings.TrimSuffix(filepath.Base(path), filepath.Ext(path))
	var out parsedFile
	dedupeIdx := make(map[string]int)

	appendOrMerge := func(rec usageRecord) {
		if rec.Totals.Total == 0 && (rec.ReportedCost == nil || *rec.ReportedCost <= 0) {
			return
		}
		if rec.DedupeKey != "" {
			if idx, ok := dedupeIdx[rec.DedupeKey]; ok {
				prev := &out.Records[idx]
				prev.Totals.UncachedInput = max(prev.Totals.UncachedInput, rec.Totals.UncachedInput)
				prev.Totals.CachedInput = max(prev.Totals.CachedInput, rec.Totals.CachedInput)
				prev.Totals.CacheWrite = max(prev.Totals.CacheWrite, rec.Totals.CacheWrite)
				prev.Totals.Output = max(prev.Totals.Output, rec.Totals.Output)
				prev.Totals = computeTotal(prev.Totals)
				prev.CacheWrite1h = max(prev.CacheWrite1h, rec.CacheWrite1h)
				if rec.ReportedCost != nil && (prev.ReportedCost == nil || *rec.ReportedCost > *prev.ReportedCost) {
					v := *rec.ReportedCost
					prev.ReportedCost = &v
				}
				if rec.Timestamp.After(prev.Timestamp) {
					prev.Timestamp = rec.Timestamp
				}
				return
			}
			dedupeIdx[rec.DedupeKey] = len(out.Records)
		}
		out.Records = append(out.Records, rec)
	}

	err = readLines(f, func(line []byte) {
		hasUsage := bytes.Contains(line, []byte(`"usage"`))
		needTitle := out.Title == "" && bytes.Contains(line, []byte(`"user"`))
		needCWD := out.CWD == "" && bytes.Contains(line, []byte(`"cwd"`))
		if !hasUsage && !needTitle && !needCWD {
			return
		}
		var entry claudeLine
		if json.Unmarshal(line, &entry) != nil {
			return
		}
		if out.CWD == "" && entry.CWD != "" {
			out.CWD = entry.CWD
		}
		if out.Title == "" && entry.Type == "user" && len(entry.Message) > 0 {
			out.Title = extractClaudeUserTitle(entry.Message)
		}
		if !hasUsage || entry.Type != "assistant" || len(entry.Message) == 0 {
			return
		}
		var msg claudeAssistantMessage
		if json.Unmarshal(entry.Message, &msg) != nil || msg.Usage == nil {
			return
		}
		modelID := strings.TrimSpace(msg.Model)
		if modelID == "" || modelID == claudeSyntheticModel {
			return
		}
		ts, ok := parseTimestamp(entry.Timestamp)
		if !ok {
			return
		}
		sid := strings.TrimSpace(entry.SessionID)
		if sid == "" {
			sid = fallbackSessionID
		}
		var dedupeKey string
		if msg.ID != "" || entry.RequestID != "" {
			dedupeKey = "claude:" + msg.ID + ":" + entry.RequestID
		}
		var w1h int64
		if msg.Usage.CacheCreation != nil {
			w1h = max(int64(0), msg.Usage.CacheCreation.Ephemeral1hInputTokens)
		}
		var reported *float64
		if entry.CostUSD != nil && *entry.CostUSD > 0 {
			v := *entry.CostUSD
			reported = &v
		}
		totals := computeTotal(model.TokenTotals{
			UncachedInput: msg.Usage.InputTokens,
			CachedInput:   msg.Usage.CacheReadInputTokens,
			CacheWrite:    msg.Usage.CacheCreationInputTokens,
			Output:        msg.Usage.OutputTokens,
		})
		appendOrMerge(usageRecord{
			Provider:     "claude",
			SessionID:    sid,
			Model:        modelID,
			CWD:          out.CWD,
			Timestamp:    ts,
			Totals:       totals,
			CacheWrite1h: w1h,
			ReportedCost: reported,
			DedupeKey:    dedupeKey,
		})

		for idx, iter := range msg.Usage.Iterations {
			if iter.Type != "advisor_message" {
				continue
			}
			am := strings.TrimSpace(iter.Model)
			if am == "" || am == claudeSyntheticModel {
				continue
			}
			var iw1h int64
			if iter.CacheCreation != nil {
				iw1h = max(int64(0), iter.CacheCreation.Ephemeral1hInputTokens)
			}
			var iterKey string
			if dedupeKey != "" {
				iterKey = dedupeKey + ":advisor:" + strconv.Itoa(idx)
			}
			appendOrMerge(usageRecord{
				Provider:  "claude",
				SessionID: sid,
				Model:     am,
				CWD:       out.CWD,
				Timestamp: ts,
				Totals: computeTotal(model.TokenTotals{
					UncachedInput: iter.InputTokens,
					CachedInput:   iter.CacheReadInputTokens,
					CacheWrite:    iter.CacheCreationInputTokens,
					Output:        iter.OutputTokens,
				}),
				CacheWrite1h: iw1h,
				DedupeKey:    iterKey,
			})
		}
	})
	for i := range out.Records {
		if out.Records[i].CWD == "" {
			out.Records[i].CWD = out.CWD
		}
		out.Records[i].Title = out.Title
	}
	return out, err
}

func extractClaudeUserTitle(raw json.RawMessage) string {
	var msg struct {
		Content any `json:"content"`
	}
	if json.Unmarshal(raw, &msg) != nil {
		return ""
	}
	switch v := msg.Content.(type) {
	case string:
		return trimTitle(v)
	case []any:
		for _, item := range v {
			m, ok := item.(map[string]any)
			if !ok {
				continue
			}
			if m["type"] == "text" {
				if text, ok := m["text"].(string); ok {
					if title := trimTitle(text); title != "" {
						return title
					}
				}
			}
		}
	}
	return ""
}
