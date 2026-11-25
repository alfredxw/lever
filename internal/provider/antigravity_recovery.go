package provider

import (
	"context"
	"errors"
	"fmt"
	"os"
	"time"

	acp "github.com/coder/acp-go-sdk"
	"lever/internal/model"
)

const antigravityContinuePrompt = "Continue the interrupted request in this conversation from the last confirmed step. Do not repeat completed actions. Verify any uncertain outcome before acting."

type antigravityAuthCheckpoint struct {
	store        *antigravitySessionDB
	file         os.FileInfo
	before, last int
	native       string
}

func (*antigravityAuthCheckpoint) Error() string { return errAntigravityUnauthenticated.Error() }
func (*antigravityAuthCheckpoint) Unwrap() error { return errAntigravityUnauthenticated }

func (c *acpRuntime) canContinueAfterAuthFailure() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.modeTouched || c.background.requests != 0 || len(c.background.childCalls) != 0 {
		return false
	}
	for _, tool := range c.tools {
		if tool.Status != acp.ToolCallStatusCompleted && tool.Status != acp.ToolCallStatusFailed {
			return false
		}
	}
	return true
}

type antigravityContinuationSink struct {
	Sink
	ctx        context.Context
	checkpoint *antigravityAuthCheckpoint
}

func (s antigravityContinuationSink) Bind(native string) error {
	checkpoint := s.checkpoint
	changed := errors.New("Antigravity could not confirm the saved request and failure in the original conversation; no continuation was sent")
	if native != checkpoint.native || !os.SameFile(checkpoint.file, checkpoint.store.regular()) {
		return changed
	}
	db, err := checkpoint.store.open()
	if err != nil {
		return changed
	}
	defer db.Close()
	ctx, cancel := context.WithTimeout(s.ctx, time.Second)
	defer cancel()
	var last int
	var payload []byte
	var savedInput bool
	err = db.QueryRowContext(ctx, `SELECT idx, CASE WHEN step_type = 17 THEN `+antigravityErrorPayload+` END,
		EXISTS (SELECT 1 FROM steps WHERE idx > ? AND step_type = 14) FROM steps ORDER BY idx DESC LIMIT 1`, checkpoint.before).Scan(&last, &payload, &savedInput)
	if err != nil || last != checkpoint.last || !savedInput || antigravityStepError(payload, nil) != errAntigravityUnauthenticated {
		return changed
	}
	return s.Sink.Bind(native)
}

func (s antigravityContinuationSink) Item(item model.Item) error {
	item.ID = "auth-continuation:" + item.ID
	return s.Sink.Item(item)
}

func runAntigravity(ctx context.Context, in Input, sink Sink) error {
	err := runACP(ctx, in, sink)
	if err == nil || errors.Is(err, ErrUnconfirmed) {
		return err
	}
	var checkpoint *antigravityAuthCheckpoint
	if ctx.Err() == nil && errors.As(err, &checkpoint) && checkpoint.native != "" {
		in.Session.NativeID = checkpoint.native
		in.Text, in.History, in.HistoryContext = antigravityContinuePrompt, "", ""
		in.Attachments, in.References = nil, nil
		err = runACP(ctx, in, antigravityContinuationSink{sink, ctx, checkpoint})
		if err != nil && !errors.Is(err, errAntigravityUnauthenticated) {
			err = fmt.Errorf("Antigravity could not continue after HTTP 401: %w", err)
		}
	}
	if ctx.Err() != nil {
		return ctx.Err()
	}
	if errors.Is(err, ErrUnconfirmed) {
		return err
	}
	var request *acp.RequestError
	switch {
	case errors.Is(err, errAntigravityUnauthenticated):
		err = errAntigravityUnauthenticated
	case errors.Is(err, ErrAntigravityCLIAuthRequired), errors.As(err, &request) && request.Code == -32000:
		err = errors.New("Antigravity requires authentication.")
		if checkpoint != nil {
			err = errAntigravityUnauthenticated
		}
	default:
		return err
	}
	hint := errAntigravitySignIn.Error()
	if path, pathErr := Executable(ctx, in.Provider); pathErr == nil && IsAntigravityCLI(in.Provider, path) {
		hint = ErrAntigravityCLIAuthRequired.Error()
	} else if in.Provider.AuthMethod == "gemini-api-key" || in.Provider.AuthMethod == "agent-platform" {
		hint = "Check the credentials for this runtime in Settings → Providers"
	}
	if checkpoint != nil && checkpoint.native != "" {
		return fmt.Errorf("%w %s. Then send “continue” in this conversation instead of retrying the original request.", err, hint)
	}
	return fmt.Errorf("%w %s.", err, hint)
}
