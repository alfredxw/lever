package plugin

import (
	"context"
	"time"

	"lever/internal/model"
)

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
	Name   string
	Cursor string
	Items  []TaskSourceItem
	// VisibleIDs is the complete set currently in scope. Incremental sources leave it nil.
	VisibleIDs []string
}

type TaskSourceError struct {
	Status  int
	Code    string
	Message string
	RetryAt time.Time
}

func (e *TaskSourceError) Error() string { return e.Message }
