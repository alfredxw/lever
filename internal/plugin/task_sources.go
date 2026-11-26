package plugin

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"

	"lever/internal/device"
	"lever/internal/model"
)

const maxTaskSourceOutputBytes = 4 << 20

// A task source reads remote data. The host owns subscriptions, scheduling,
// checkpoints, and all local task state.
type TaskSourceAdapter interface {
	Resolve(context.Context, string) (TaskSourceTarget, error)
	Pull(context.Context, TaskSourceTarget, string, []TaskSourceRef) (TaskSourceBatch, error)
}

type TaskSourceTarget struct {
	ID        string
	Name      string
	SyncKind  model.TaskSourceKind
	LarkScope *model.LarkTaskScope
	Config    json.RawMessage
}

type TaskSourceRef struct {
	ExternalID string `json:"externalId"`
	Reference  string `json:"reference"`
}

type TaskSourceItem struct {
	TaskSourceRef
	Kind    string `json:"kind"`
	State   string `json:"state"`
	Title   string `json:"title"`
	URL     string `json:"url"`
	Body    string `json:"body"`
	DueAt   int64  `json:"dueAt,omitempty"`
	DueDate string `json:"dueDate,omitempty"`
}

type TaskSourceBatch struct {
	// Name refreshes the source's display name. Empty keeps the saved name.
	Name string `json:"name,omitempty"`
	// Summary updates the source's short scope description shown on cards.
	Summary string           `json:"summary,omitempty"`
	Cursor  string           `json:"cursor,omitempty"`
	Items   []TaskSourceItem `json:"items"`
	// VisibleIDs is the complete set currently in scope. Incremental sources leave it nil.
	VisibleIDs []string `json:"visibleIds"`
}

type TaskSourceError struct {
	Status  int
	Code    string
	Message string
	RetryAt time.Time
}

func (e *TaskSourceError) Error() string { return e.Message }

// StdioTaskSource runs a package-relative executable for task-stdio-v1 actions
// (inspect, preview, pull). Inputs travel over stdin; responses arrive as a
// single JSON object on stdout.
type StdioTaskSource struct {
	Directory      string
	ContributionID string
	Command        string
	CacheDir       string
	SourceID       string
}

type taskStdioRequest struct {
	ProtocolVersion int             `json:"protocolVersion"`
	Action          string          `json:"action"`
	Source          string          `json:"source"`
	SourceID        string          `json:"sourceId,omitempty"`
	Target          string          `json:"target,omitempty"`
	Config          json.RawMessage `json:"config,omitempty"`
	Cursor          string          `json:"cursor,omitempty"`
	Open            []TaskSourceRef `json:"open,omitempty"`
	SearchField     string          `json:"searchField,omitempty"`
	SearchQuery     string          `json:"searchQuery,omitempty"`
	Refresh         bool            `json:"refresh,omitempty"`
}

type taskStdioErrorEnvelope struct {
	Error *struct {
		Code    string `json:"code"`
		Message string `json:"message"`
		Status  int    `json:"status"`
		RetryAt int64  `json:"retryAt"`
	} `json:"error,omitempty"`
}

func (s StdioTaskSource) run(ctx context.Context, req taskStdioRequest, into any) error {
	path, err := PackageExecutable(s.Directory, s.Command)
	if err != nil {
		return &TaskSourceError{Status: http.StatusBadGateway, Code: "adapter", Message: err.Error()}
	}
	req.ProtocolVersion = 1
	req.Source = s.ContributionID
	if req.SourceID == "" {
		req.SourceID = s.SourceID
	}
	if len(bytes.TrimSpace(req.Config)) == 0 {
		req.Config = json.RawMessage(`{}`)
	}
	input, err := json.Marshal(req)
	if err != nil {
		return err
	}
	cmd := device.Command(path)
	cmd.Dir = s.Directory
	cmd.Stdin = bytes.NewReader(input)
	cmd.Env = append(cmd.Env, "LEVER_PLUGIN_DIR="+s.Directory)
	if s.CacheDir != "" {
		if err := os.MkdirAll(s.CacheDir, 0700); err != nil {
			return err
		}
		cmd.Env = append(cmd.Env, "LEVER_TASK_SOURCE_CACHE="+s.CacheDir)
	}
	runCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	out := &boundedBuffer{limit: maxTaskSourceOutputBytes, onOverflow: cancel}
	err = device.WriteCommandOutput(runCtx, cmd, out)
	if out.overflowed {
		return &TaskSourceError{Status: http.StatusBadGateway, Code: "response", Message: "The task source output exceeded 4 MiB"}
	}
	if err != nil {
		if ctx.Err() != nil {
			return &TaskSourceError{Status: http.StatusGatewayTimeout, Code: "offline", Message: "The task source request timed out"}
		}
		var outErr *device.OutputError
		if errors.As(err, &outErr) {
			if parsed := parseStdioTaskError(outErr.Stderr); parsed != nil {
				return parsed
			}
			if message := summarizePluginError(outErr.Stderr); message != "" {
				return &TaskSourceError{Status: http.StatusBadGateway, Code: "plugin", Message: message}
			}
		}
		return &TaskSourceError{Status: http.StatusBadGateway, Code: "response", Message: fmt.Sprintf("Run task source %s: %v", s.ContributionID, err)}
	}
	raw := out.buf.Bytes()
	var env taskStdioErrorEnvelope
	if json.Unmarshal(raw, &env) == nil && env.Error != nil && (env.Error.Message != "" || env.Error.Code != "") {
		return buildStdioTaskError(env.Error.Status, env.Error.Code, env.Error.Message, env.Error.RetryAt)
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	if err := decoder.Decode(into); err != nil {
		return &TaskSourceError{Status: http.StatusBadGateway, Code: "response", Message: "The task source returned invalid JSON"}
	}
	if err := decoder.Decode(new(any)); !errors.Is(err, io.EOF) {
		return &TaskSourceError{Status: http.StatusBadGateway, Code: "response", Message: "The task source must output a single JSON object"}
	}
	return nil
}

func parseStdioTaskError(stderr string) *TaskSourceError {
	trimmed := strings.TrimSpace(stderr)
	if !strings.HasPrefix(trimmed, "{") {
		return nil
	}
	var env taskStdioErrorEnvelope
	if json.Unmarshal([]byte(trimmed), &env) != nil || env.Error == nil {
		return nil
	}
	return buildStdioTaskError(env.Error.Status, env.Error.Code, env.Error.Message, env.Error.RetryAt)
}

func buildStdioTaskError(status int, code, message string, retryAt int64) *TaskSourceError {
	if status < 400 || status > 599 {
		status = http.StatusBadGateway
	}
	if code == "" {
		code = "plugin"
	}
	if message == "" {
		message = "Task source error"
	}
	err := &TaskSourceError{Status: status, Code: code, Message: message}
	if retryAt > 0 {
		err.RetryAt = time.Unix(retryAt, 0)
	}
	return err
}

func (s StdioTaskSource) Inspect(ctx context.Context, input model.TaskSourceInspectRequest) (model.TaskSourceInspect, error) {
	var result model.TaskSourceInspect
	err := s.run(ctx, taskStdioRequest{
		Action:      "inspect",
		SourceID:    input.SourceID,
		Config:      input.Config,
		SearchField: input.SearchField,
		SearchQuery: input.SearchQuery,
		Refresh:     input.Refresh,
	}, &result)
	return result, err
}

func (s StdioTaskSource) Preview(ctx context.Context, input model.TaskSourcePreviewRequest) (model.TaskSourcePreview, error) {
	var result model.TaskSourcePreview
	err := s.run(ctx, taskStdioRequest{
		Action:   "preview",
		SourceID: input.SourceID,
		Config:   input.Config,
		Refresh:  input.Refresh,
	}, &result)
	if err == nil && result.Items == nil {
		result.Items = []model.TaskSourcePreviewItem{}
	}
	return result, err
}

func (s StdioTaskSource) Resolve(ctx context.Context, target string) (TaskSourceTarget, error) {
	return TaskSourceTarget{ID: target}, nil
}

func (s StdioTaskSource) Pull(ctx context.Context, target TaskSourceTarget, cursor string, open []TaskSourceRef) (TaskSourceBatch, error) {
	var batch TaskSourceBatch
	err := s.run(ctx, taskStdioRequest{
		Action: "pull",
		Target: target.ID,
		Config: target.Config,
		Cursor: cursor,
		Open:   open,
	}, &batch)
	return batch, err
}
