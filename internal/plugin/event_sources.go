package plugin

import (
	"context"
	"encoding/json"
)

// EventSourceAdapter reads a bounded batch without changing the source.
// The host persists the cursor together with the events it accepts.
type EventSourceAdapter interface {
	Poll(ctx context.Context, config map[string]string, cursor string, limit int) (EventBatch, error)
}

type EventBatch struct {
	Events []SourceEvent
	Cursor string
	More   bool
}

type SourceEvent struct {
	Key     string
	Payload json.RawMessage
}
