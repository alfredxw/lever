package localstats

import (
	"bufio"
	"bytes"
	"io"
	"strings"
	"time"

	"lever/internal/model"
)

type usageRecord struct {
	Provider     string
	SessionID    string
	Model        string
	CWD          string
	Title        string
	Timestamp    time.Time
	Totals       model.TokenTotals
	CacheWrite1h int64
	ReportedCost *float64
	DedupeKey    string
}

type parsedFile struct {
	Records []usageRecord
	CWD     string
	Title   string
}

func computeTotal(t model.TokenTotals) model.TokenTotals {
	t.UncachedInput = max(int64(0), t.UncachedInput)
	t.CachedInput = max(int64(0), t.CachedInput)
	t.CacheWrite = max(int64(0), t.CacheWrite)
	t.Output = max(int64(0), t.Output)
	t.Reasoning = max(int64(0), min(t.Output, t.Reasoning))
	t.Total = t.UncachedInput + t.CachedInput + t.CacheWrite + t.Output
	return t
}

func parseTimestamp(raw string) (time.Time, bool) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return time.Time{}, false
	}
	if ts, err := time.Parse(time.RFC3339Nano, raw); err == nil {
		return ts.UTC(), true
	}
	if ts, err := time.Parse(time.RFC3339, raw); err == nil {
		return ts.UTC(), true
	}
	return time.Time{}, false
}

func trimTitle(raw string) string {
	s := strings.TrimSpace(raw)
	if s == "" {
		return ""
	}
	// Drop internal XML/system preamble tags when scanning external transcripts.
	if strings.HasPrefix(s, "<") {
		if idx := strings.Index(s, "\n"); idx >= 0 {
			for _, line := range strings.Split(s, "\n") {
				line = strings.TrimSpace(line)
				if line != "" && !strings.HasPrefix(line, "<") {
					s = line
					break
				}
			}
		}
	}
	s = strings.Join(strings.Fields(s), " ")
	runes := []rune(s)
	if len(runes) > 90 {
		return strings.TrimSpace(string(runes[:90])) + "…"
	}
	return s
}

// readLines streams arbitrarily long JSONL lines without hitting bufio.Scanner's token limit.
func readLines(r io.Reader, fn func(line []byte)) error {
	br := bufio.NewReaderSize(r, 64<<10)
	for {
		line, err := br.ReadBytes('\n')
		trimmed := bytes.TrimSpace(line)
		if len(trimmed) > 0 {
			fn(trimmed)
		}
		if err == io.EOF {
			return nil
		}
		if err != nil {
			return err
		}
	}
}

func providerDisplayName(kind string) string {
	switch strings.ToLower(strings.TrimSpace(kind)) {
	case "claude":
		return "Claude Code"
	case "codex":
		return "Codex"
	case "antigravity":
		return "Antigravity"
	case "pi":
		return "Pi"
	case "dsh":
		return "DeepSeek Harness"
	case "acp":
		return "ACP"
	default:
		if kind == "" {
			return "Unknown"
		}
		return kind
	}
}
