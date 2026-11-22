package plugin

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"
	"unicode"

	"lever/internal/device"
)

const maxEventPollOutputBytes = 1 << 20

// EventSourceAdapter reads a bounded batch without changing the source.
// The host persists the cursor together with the events it accepts.
type EventSourceAdapter interface {
	Poll(ctx context.Context, config map[string]string, cursor string, limit int) (EventBatch, error)
}

type EventBatch struct {
	Events []SourceEvent `json:"events"`
	Cursor string        `json:"cursor"`
	More   bool          `json:"more,omitempty"`
}

type SourceEvent struct {
	Key     string          `json:"key"`
	Payload json.RawMessage `json:"payload"`
}

// StdioPollEventSource runs a package-relative executable for each poll.
// Configuration and secrets travel over stdin instead of process arguments.
type StdioPollEventSource struct {
	Directory      string
	ContributionID string
	Command        string
	CacheDir       string
	AutomationID   string
}

type eventPollRequest struct {
	ProtocolVersion int               `json:"protocolVersion"`
	Source          string            `json:"source"`
	AutomationID    string            `json:"automationId,omitempty"`
	Config          map[string]string `json:"config"`
	Cursor          string            `json:"cursor"`
	Limit           int               `json:"limit"`
}

func (s StdioPollEventSource) Poll(ctx context.Context, config map[string]string, cursor string, limit int) (EventBatch, error) {
	path, err := PackageExecutable(s.Directory, s.Command)
	if err != nil {
		return EventBatch{}, err
	}
	if config == nil {
		config = map[string]string{}
	}
	input, err := json.Marshal(eventPollRequest{
		ProtocolVersion: 1,
		Source:          s.ContributionID,
		AutomationID:    s.AutomationID,
		Config:          config,
		Cursor:          cursor,
		Limit:           limit,
	})
	if err != nil {
		return EventBatch{}, err
	}
	cmd := device.Command(path)
	cmd.Dir = s.Directory
	cmd.Stdin = bytes.NewReader(input)
	cmd.Env = append(cmd.Env, "LEVER_PLUGIN_DIR="+s.Directory)
	if s.CacheDir != "" {
		if err := os.MkdirAll(s.CacheDir, 0700); err != nil {
			return EventBatch{}, err
		}
		cmd.Env = append(cmd.Env, "LEVER_EVENT_SOURCE_CACHE="+s.CacheDir)
	}
	runCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	out := &boundedBuffer{limit: maxEventPollOutputBytes, onOverflow: cancel}
	err = device.WriteCommandOutput(runCtx, cmd, out)
	if out.overflowed {
		return EventBatch{}, errors.New("The event source output exceeded 1 MiB")
	}
	if err != nil {
		if ctx.Err() != nil {
			return EventBatch{}, ctx.Err()
		}
		var outErr *device.OutputError
		if errors.As(err, &outErr) {
			if message := summarizePluginError(outErr.Stderr); message != "" {
				return EventBatch{}, errors.New(message)
			}
		}
		return EventBatch{}, fmt.Errorf("Run event source %s: %w", s.ContributionID, err)
	}
	var batch EventBatch
	decoder := json.NewDecoder(bytes.NewReader(out.buf.Bytes()))
	if err := decoder.Decode(&batch); err != nil {
		return EventBatch{}, errors.New("The event source returned invalid JSON")
	}
	if err := decoder.Decode(new(any)); !errors.Is(err, io.EOF) {
		return EventBatch{}, errors.New("The event source must output a single JSON object")
	}
	return batch, nil
}

type boundedBuffer struct {
	buf        bytes.Buffer
	limit      int
	overflowed bool
	onOverflow func()
}

func (b *boundedBuffer) Write(p []byte) (int, error) {
	if b.overflowed {
		return len(p), nil
	}
	if b.buf.Len()+len(p) > b.limit {
		b.overflowed = true
		if b.onOverflow != nil {
			b.onOverflow()
		}
		return len(p), nil
	}
	return b.buf.Write(p)
}

func summarizePluginError(raw string) string {
	var clean strings.Builder
	space := false
	for _, r := range strings.TrimSpace(raw) {
		if unicode.IsSpace(r) {
			space = true
			continue
		}
		if unicode.IsControl(r) {
			continue
		}
		if space && clean.Len() > 0 {
			clean.WriteByte(' ')
		}
		space = false
		clean.WriteRune(r)
	}
	runes := []rune(clean.String())
	if len(runes) > 300 {
		return string(runes[:297]) + "..."
	}
	return string(runes)
}
