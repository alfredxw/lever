package provider

import (
	"context"
	"path/filepath"
	"strings"
	"testing"

	acp "github.com/coder/acp-go-sdk"
	"lever/internal/model"
)

type recordingSink struct {
	items []model.Item
	byID  map[string]model.Item
}

func newRecordingSink() *recordingSink {
	return &recordingSink{byID: map[string]model.Item{}}
}

func (s *recordingSink) Bind(string) error                                           { return nil }
func (s *recordingSink) BindTurn(string) error                                       { return nil }
func (s *recordingSink) UpdateRuntime(func(*model.SessionRuntime)) error             { return nil }
func (s *recordingSink) TurnDiff(string) error                                       { return nil }
func (s *recordingSink) EnablePermissionChanges(func(context.Context, string) error) {}
func (s *recordingSink) SetSteerState(SteerState) error                              { return nil }
func (s *recordingSink) NextSteer() (*Input, error)                                  { return nil, nil }
func (s *recordingSink) Steered(string, error) error                                 { return nil }
func (s *recordingSink) Ask(context.Context, model.Request) (model.Answer, error) {
	return model.Answer{}, nil
}
func (s *recordingSink) Item(item model.Item) error {
	s.byID[item.ID] = item
	for i := range s.items {
		if s.items[i].ID == item.ID {
			s.items[i] = item
			return nil
		}
	}
	s.items = append(s.items, item)
	return nil
}

func newTestACPRuntime(cwd string, antigravity bool) (*acpRuntime, *recordingSink) {
	sink := newRecordingSink()
	return &acpRuntime{
		sink:        sink,
		cwd:         cwd,
		antigravity: antigravity,
		items:       map[string]model.Item{},
		tools:       map[string]*acpToolState{},
		subagents:   map[string]*subagent{},
	}, sink
}

func TestACPThoughtSegmentationAndClosure(t *testing.T) {
	rt, sink := newTestACPRuntime("/workspace", true)
	msg1, msg2 := "thought-1", "thought-2"

	for _, upd := range []acp.SessionUpdate{
		{AgentThoughtChunk: &acp.SessionUpdateAgentThoughtChunk{MessageId: &msg1, Content: acp.TextBlock("First ")}},
		{AgentThoughtChunk: &acp.SessionUpdateAgentThoughtChunk{MessageId: &msg1, Content: acp.TextBlock("idea.")}},
		{AgentThoughtChunk: &acp.SessionUpdateAgentThoughtChunk{MessageId: &msg2, Content: acp.TextBlock("Second idea.")}},
	} {
		if err := rt.update(upd); err != nil {
			t.Fatal(err)
		}
	}
	if len(sink.items) != 2 {
		t.Fatalf("expected 2 reasoning segments, got %d: %+v", len(sink.items), sink.items)
	}
	if sink.items[0].Text != "First idea." || sink.items[0].Status != "completed" {
		t.Fatalf("first reasoning was not closed cleanly: %+v", sink.items[0])
	}
	if sink.items[1].Text != "Second idea." || sink.items[1].Status != "running" {
		t.Fatalf("second reasoning should still be running: %+v", sink.items[1])
	}

	statusDone := acp.ToolCallStatusCompleted
	if err := rt.update(acp.SessionUpdate{
		ToolCallUpdate: &acp.SessionToolCallUpdate{
			ToolCallId: "late-update",
			Status:     &statusDone,
		},
	}); err != nil {
		t.Fatal(err)
	}
	if sink.items[1].Status != "completed" {
		t.Fatalf("ToolCallUpdate did not close open reasoning: %+v", sink.items[1])
	}
}

func TestACPAntigravityToolNormalization(t *testing.T) {
	cwd := filepath.Join(t.TempDir(), "repo")
	rt, sink := newTestACPRuntime(cwd, true)

	// 1. Command with RawInput CommandLine and RawOutput combinedOutput + exitCode.
	if err := rt.update(acp.SessionUpdate{
		ToolCall: &acp.SessionUpdateToolCall{
			ToolCallId: "cmd-1",
			Title:      "Running run_command",
			Kind:       acp.ToolKindOther,
			Status:     acp.ToolCallStatusInProgress,
			RawInput:   map[string]any{"CommandLine": "go test ./internal/provider"},
		},
	}); err != nil {
		t.Fatal(err)
	}
	cmdItem := sink.byID["tool-cmd-1"]
	if cmdItem.ToolAction != model.ToolActionCommand || cmdItem.Title != "go test ./internal/provider" || cmdItem.Status != "running" {
		t.Fatalf("unexpected running command item: %+v", cmdItem)
	}

	completed := acp.ToolCallStatusCompleted
	if err := rt.update(acp.SessionUpdate{
		ToolCallUpdate: &acp.SessionToolCallUpdate{
			ToolCallId: "cmd-1",
			Status:     &completed,
			RawOutput:  map[string]any{"combinedOutput": "FAIL\n", "exitCode": float64(1)},
		},
	}); err != nil {
		t.Fatal(err)
	}
	cmdItem = sink.byID["tool-cmd-1"]
	if cmdItem.Text != "FAIL" || cmdItem.ExitCode == nil || *cmdItem.ExitCode != 1 || cmdItem.Title != "go test ./internal/provider" {
		t.Fatalf("unexpected completed command item: %+v", cmdItem)
	}

	// 2. Read file with generic title + Location inside cwd.
	if err := rt.update(acp.SessionUpdate{
		ToolCall: &acp.SessionUpdateToolCall{
			ToolCallId: "read-1",
			Title:      "Running view_file",
			Kind:       acp.ToolKindRead,
			Status:     acp.ToolCallStatusInProgress,
			Locations:  []acp.ToolCallLocation{{Path: filepath.Join(cwd, "internal", "provider", "acp.go")}},
		},
	}); err != nil {
		t.Fatal(err)
	}
	readItem := sink.byID["tool-read-1"]
	if readItem.ToolAction != model.ToolActionRead || readItem.Title != "internal/provider/acp.go" {
		t.Fatalf("unexpected read item: %+v", readItem)
	}

	// 3. Edit with Diff content.
	oldText := "old line"
	if err := rt.update(acp.SessionUpdate{
		ToolCall: &acp.SessionUpdateToolCall{
			ToolCallId: "edit-1",
			Title:      "Running replace_file_content",
			Kind:       acp.ToolKindEdit,
			Status:     acp.ToolCallStatusCompleted,
			Content:    []acp.ToolCallContent{{Diff: &acp.ToolCallContentDiff{Path: filepath.Join(cwd, "web", "app.ts"), OldText: &oldText, NewText: "new line"}}},
		},
	}); err != nil {
		t.Fatal(err)
	}
	editItem := sink.byID["tool-edit-1"]
	if editItem.ToolAction != model.ToolActionEdit || editItem.Title != "web/app.ts" || !strings.Contains(editItem.Text, "- old line") || !strings.Contains(editItem.Text, "+ new line") {
		t.Fatalf("unexpected edit item: %+v", editItem)
	}

	// 4. Search with Query in RawInput.
	if err := rt.update(acp.SessionUpdate{
		ToolCall: &acp.SessionUpdateToolCall{
			ToolCallId: "search-1",
			Title:      "Running grep_search",
			Kind:       acp.ToolKindSearch,
			Status:     acp.ToolCallStatusCompleted,
			RawInput:   map[string]any{"Query": "RunActivity"},
			Content:    []acp.ToolCallContent{{Content: &acp.ToolCallContentContent{Content: acp.TextBlock("web/src/features/chat/RunActivity.tsx:93")}}},
		},
	}); err != nil {
		t.Fatal(err)
	}
	searchItem := sink.byID["tool-search-1"]
	if searchItem.ToolAction != model.ToolActionSearch || searchItem.Title != "RunActivity" || searchItem.Text != "web/src/features/chat/RunActivity.tsx:93" {
		t.Fatalf("unexpected search item: %+v", searchItem)
	}

	// 5. Custom non-generic title is preserved.
	if err := rt.update(acp.SessionUpdate{
		ToolCall: &acp.SessionUpdateToolCall{
			ToolCallId: "custom-1",
			Title:      "Inspect workspace",
			Status:     acp.ToolCallStatusInProgress,
		},
	}); err != nil {
		t.Fatal(err)
	}
	if got := sink.byID["tool-custom-1"]; got.Title != "Inspect workspace" {
		t.Fatalf("custom title should be preserved: %+v", got)
	}
}

func TestACPAntigravitySubagentMapping(t *testing.T) {
	rt, sink := newTestACPRuntime("/workspace", true)

	// Flat agy 1.5 invoke_subagent call.
	if err := rt.update(acp.SessionUpdate{
		ToolCall: &acp.SessionUpdateToolCall{
			ToolCallId: "sub-1",
			Title:      "Run invoke_subagent",
			Kind:       acp.ToolKindOther,
			Status:     acp.ToolCallStatusInProgress,
			RawInput:   map[string]any{"Role": "Codebase Researcher", "Prompt": "Inspect RunActivity.tsx"},
		},
	}); err != nil {
		t.Fatal(err)
	}
	sub := sink.byID["subagent:sub-1"]
	if sub.Kind != "subagent" || sub.Title != "Codebase Researcher" || sub.Status != "running" || sub.Subagent == nil || sub.Subagent.Prompt != "Inspect RunActivity.tsx" {
		t.Fatalf("unexpected running subagent: %+v", sub)
	}
	if _, exists := sink.byID["tool-sub-1"]; exists {
		t.Fatal("subagent should not also emit a duplicate tool item")
	}

	done := acp.ToolCallStatusCompleted
	if err := rt.update(acp.SessionUpdate{
		ToolCallUpdate: &acp.SessionToolCallUpdate{
			ToolCallId: "sub-1",
			Status:     &done,
			RawOutput:  "Found the live row logic.",
		},
	}); err != nil {
		t.Fatal(err)
	}
	sub = sink.byID["subagent:sub-1"]
	if sub.Status != "completed" || sub.Text != "Found the live row logic." || sub.Subagent.FinishedAt == "" {
		t.Fatalf("unexpected completed subagent: %+v", sub)
	}

	// Batch format with Subagents array.
	if err := rt.update(acp.SessionUpdate{
		ToolCall: &acp.SessionUpdateToolCall{
			ToolCallId: "sub-batch",
			Title:      "Running start_subagent",
			Status:     acp.ToolCallStatusInProgress,
			RawInput: map[string]any{
				"Subagents": []any{
					map[string]any{"Role": "Reader", "Prompt": "Read A"},
					map[string]any{"Role": "Tester", "Prompt": "Test B"},
				},
			},
		},
	}); err != nil {
		t.Fatal(err)
	}
	batch := sink.byID["subagent:sub-batch"]
	if batch.Title != "Reader, Tester" || !strings.Contains(batch.Subagent.Prompt, "Read A") || !strings.Contains(batch.Subagent.Prompt, "Test B") {
		t.Fatalf("unexpected batch subagent: %+v", batch)
	}

	// MCP tool call with same title stays a normal tool.
	if err := rt.update(acp.SessionUpdate{
		ToolCall: &acp.SessionUpdateToolCall{
			ToolCallId: "mcp-1",
			Title:      "Running invoke_subagent",
			Status:     acp.ToolCallStatusInProgress,
			Meta:       map[string]any{"is_mcp_tool_call": true},
		},
	}); err != nil {
		t.Fatal(err)
	}
	if sink.byID["tool-mcp-1"].Kind != "tool" {
		t.Fatalf("MCP tool call should remain a normal tool: %+v", sink.byID["tool-mcp-1"])
	}
}
