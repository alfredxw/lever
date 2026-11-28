package localstats

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"

	"lever/internal/model"
)

type piUsageBlock struct {
	Input      int64 `json:"input"`
	Output     int64 `json:"output"`
	CacheRead  int64 `json:"cacheRead"`
	CacheWrite int64 `json:"cacheWrite"`
	Reasoning  int64 `json:"reasoning"`
	Cost       *struct {
		Total float64 `json:"total"`
	} `json:"cost"`
}

func parsePiFile(path string) (parsedFile, error) {
	f, err := os.Open(path)
	if err != nil {
		return parsedFile{}, err
	}
	defer f.Close()

	var out parsedFile
	sessionID := strings.TrimSuffix(filepath.Base(path), filepath.Ext(path))
	seen := make(map[string]bool)

	err = readLines(f, func(line []byte) {
		if !bytes.Contains(line, []byte(`"usage"`)) &&
			!bytes.Contains(line, []byte(`"session"`)) &&
			!(out.Title == "" && bytes.Contains(line, []byte(`"user"`))) {
			return
		}
		var entry struct {
			Type      string        `json:"type"`
			ID        string        `json:"id"`
			Timestamp string        `json:"timestamp"`
			CWD       string        `json:"cwd"`
			Provider  string        `json:"provider"`
			Model     string        `json:"model"`
			Usage     *piUsageBlock `json:"usage"`
			Message   *struct {
				Role          string        `json:"role"`
				Provider      string        `json:"provider"`
				Model         string        `json:"model"`
				ResponseModel string        `json:"responseModel"`
				Content       any           `json:"content"`
				Usage         *piUsageBlock `json:"usage"`
			} `json:"message"`
		}
		if json.Unmarshal(line, &entry) != nil {
			return
		}
		if entry.Type == "session" {
			if entry.ID != "" {
				sessionID = entry.ID
			}
			if entry.CWD != "" {
				out.CWD = entry.CWD
			}
			return
		}
		if out.Title == "" && entry.Type == "message" && entry.Message != nil && entry.Message.Role == "user" {
			if text, ok := entry.Message.Content.(string); ok {
				out.Title = trimTitle(text)
			}
		}

		var u *piUsageBlock
		var modelID string
		switch entry.Type {
		case "message":
			if entry.Message == nil || entry.Message.Usage == nil {
				return
			}
			u = entry.Message.Usage
			m := strings.TrimSpace(entry.Message.ResponseModel)
			if m == "" {
				m = strings.TrimSpace(entry.Message.Model)
			}
			if m != "" {
				modelID = m
			} else if entry.Message.Role == "toolResult" {
				modelID = "tools"
			}
		case "usage":
			u = entry.Usage
			modelID = strings.TrimSpace(entry.Model)
		case "compaction", "branch_summary":
			u = entry.Usage
			modelID = "summaries"
		default:
			return
		}
		if u == nil || modelID == "" {
			return
		}
		ts, ok := parseTimestamp(entry.Timestamp)
		if !ok {
			return
		}
		totals := computeTotal(model.TokenTotals{
			UncachedInput: u.Input,
			CachedInput:   u.CacheRead,
			CacheWrite:    u.CacheWrite,
			Output:        u.Output,
			Reasoning:     u.Reasoning,
		})
		var reported *float64
		if u.Cost != nil && u.Cost.Total > 0 {
			v := u.Cost.Total
			reported = &v
		}
		if totals.Total == 0 && reported == nil {
			return
		}
		key := "pi:" + entry.ID + ":" + entry.Timestamp + ":" + modelID
		if entry.ID != "" {
			if seen[key] {
				return
			}
			seen[key] = true
		}
		out.Records = append(out.Records, usageRecord{
			Provider:     "pi",
			SessionID:    sessionID,
			Model:        modelID,
			CWD:          out.CWD,
			Timestamp:    ts,
			Totals:       totals,
			ReportedCost: reported,
			DedupeKey:    key,
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
