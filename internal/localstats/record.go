package localstats

import (
	"bufio"
	"bytes"
	"encoding/json"
	"io"
	"math"
	"strings"
	"time"

	"lever/internal/model"
)

const (
	minValidDurationMs = 50
	maxValidDurationMs = 10 * 60 * 1000 // 10 minutes
	maxValidTps        = 2500.0
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
	DurationMs   int64
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

// extractFastTimestamp extracts a JSON "timestamp":"..." value from the line prefix
// without unmarshaling multi-MB message or tool-output payloads.
func extractFastTimestamp(line []byte) (time.Time, bool) {
	// Scan prefix first (timestamp is near the start in Codex/Claude/Pi JSONL lines).
	prefix := line
	if len(prefix) > 512 {
		prefix = prefix[:512]
	}
	if ts, ok := scanTimestampField(prefix); ok {
		return ts, true
	}
	// If the line is huge and timestamp wasn't in the first 512 bytes, also check tail.
	if len(line) > 512 {
		tailStart := max(0, len(line)-512)
		if ts, ok := scanTimestampField(line[tailStart:]); ok {
			return ts, true
		}
	}
	var hdr struct {
		Timestamp string `json:"timestamp"`
	}
	if json.Unmarshal(line, &hdr) == nil {
		return parseTimestamp(hdr.Timestamp)
	}
	return time.Time{}, false
}

func scanTimestampField(buf []byte) (time.Time, bool) {
	key := []byte(`"timestamp"`)
	idx := bytes.Index(buf, key)
	if idx < 0 {
		return time.Time{}, false
	}
	rest := buf[idx+len(key):]
	colon := bytes.IndexByte(rest, ':')
	if colon < 0 {
		return time.Time{}, false
	}
	rest = bytes.TrimLeft(rest[colon+1:], " \t")
	if len(rest) < 2 || rest[0] != '"' {
		return time.Time{}, false
	}
	rest = rest[1:]
	end := bytes.IndexByte(rest, '"')
	if end <= 0 || end > 64 {
		return time.Time{}, false
	}
	return parseTimestamp(string(rest[:end]))
}

func sanitizeDurationMs(d time.Duration) int64 {
	ms := d.Milliseconds()
	if ms < minValidDurationMs || ms > maxValidDurationMs {
		return 0
	}
	return ms
}

func isValidTpsSample(outputTokens, durationMs int64) bool {
	if outputTokens <= 0 || durationMs < minValidDurationMs || durationMs > maxValidDurationMs {
		return false
	}
	tps := float64(outputTokens) / (float64(durationMs) / 1000.0)
	return tps > 0 && tps <= maxValidTps
}

func calcTps(outputTokens, durationMs int64) float64 {
	if outputTokens <= 0 || durationMs <= 0 {
		return 0
	}
	v := float64(outputTokens) / (float64(durationMs) / 1000.0)
	return math.Round(v*10) / 10
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
