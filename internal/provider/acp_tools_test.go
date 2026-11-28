package provider

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"

	acp "github.com/coder/acp-go-sdk"
	"lever/internal/model"
)

type recordingSink struct {
	mu      sync.Mutex
	items   []model.Item
	byID    map[string]model.Item
	titles  []string
	runtime model.SessionRuntime
}

func newRecordingSink() *recordingSink {
	return &recordingSink{byID: map[string]model.Item{}}
}

func (s *recordingSink) Bind(string) error     { return nil }
func (s *recordingSink) BindTurn(string) error { return nil }
func (s *recordingSink) UpdateRuntime(update func(*model.SessionRuntime)) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	update(&s.runtime)
	return nil
}
func (s *recordingSink) contextUsage() *model.ContextUsage {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.runtime.Context == nil {
		return nil
	}
	copy := *s.runtime.Context
	return &copy
}
func (s *recordingSink) Usage([]model.UsageWindow) error                             { return nil }
func (s *recordingSink) Title(title string) error                                    { s.titles = append(s.titles, title); return nil }
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

func TestACPSessionInfoUpdateTitles(t *testing.T) {
	rt, sink := newTestACPRuntime("/workspace", true)
	rt.session = "sess-1"
	rt.promptStarted = make(chan struct{})

	sendUpdate := func(payload map[string]any) {
		t.Helper()
		raw, err := json.Marshal(payload)
		if err != nil {
			t.Fatal(err)
		}
		if _, rpcErr := rt.handle(context.Background(), "session/update", raw); rpcErr != nil {
			t.Fatalf("handle session/update: %+v", rpcErr)
		}
	}

	// Arriving before c.active (e.g. during session/resume) is buffered per session.
	sendUpdate(map[string]any{
		"sessionId": "other-session",
		"update":    map[string]any{"sessionUpdate": "session_info_update", "title": "Wrong Session"},
	})
	sendUpdate(map[string]any{
		"sessionId": "sess-1",
		"update":    map[string]any{"sessionUpdate": "session_info_update", "title": "  Resumed\n  Summary  "},
	})
	if len(sink.titles) != 0 {
		t.Fatalf("pre-active title published early: %v", sink.titles)
	}
	if rt.titles["sess-1"] != "Resumed Summary" || rt.titles["other-session"] != "" {
		t.Fatalf("unexpected buffered titles: %+v", rt.titles)
	}
	select {
	case <-rt.promptStarted:
		t.Fatal("session_info_update must not signal prompt start")
	default:
	}

	// Flush on activation, then deduplicate identical live repeats.
	rt.active = true
	if err := rt.publishTitle(rt.titles[rt.session]); err != nil {
		t.Fatal(err)
	}
	sendUpdate(map[string]any{
		"sessionId": "sess-1",
		"update":    map[string]any{"sessionUpdate": "session_info_update", "title": "Resumed Summary"},
	})
	// Null and whitespace-only titles are ignored.
	sendUpdate(map[string]any{
		"sessionId": "sess-1",
		"update":    map[string]any{"sessionUpdate": "session_info_update", "title": nil},
	})
	sendUpdate(map[string]any{
		"sessionId": "sess-1",
		"update":    map[string]any{"sessionUpdate": "session_info_update", "title": "   \t\n "},
	})
	// A distinct title over 80 runes is normalized and clipped to 80 runes.
	longTitle := strings.Repeat("标", 90)
	sendUpdate(map[string]any{
		"sessionId": "sess-1",
		"update":    map[string]any{"sessionUpdate": "session_info_update", "title": "  " + longTitle + "  "},
	})

	want := []string{"Resumed Summary", strings.Repeat("标", 80)}
	if !slices.Equal(sink.titles, want) {
		t.Fatalf("titles = %v, want %v", sink.titles, want)
	}
	select {
	case <-rt.promptStarted:
		t.Fatal("live session_info_update must not signal prompt start")
	default:
	}
}

func TestACPSessionInfoUpdateTitlesDisabled(t *testing.T) {
	rt, sink := newTestACPRuntime("/workspace", true)
	rt.provider.NativeTitles = new(false)
	rt.session = "sess-1"

	sendUpdate := func(payload map[string]any) {
		t.Helper()
		raw, err := json.Marshal(payload)
		if err != nil {
			t.Fatal(err)
		}
		if _, rpcErr := rt.handle(context.Background(), "session/update", raw); rpcErr != nil {
			t.Fatalf("handle session/update: %+v", rpcErr)
		}
	}

	sendUpdate(map[string]any{
		"sessionId": "sess-1",
		"update":    map[string]any{"sessionUpdate": "session_info_update", "title": "English Summary"},
	})
	if len(rt.titles) != 0 || len(sink.titles) != 0 {
		t.Fatalf("disabled native titles buffered or published pre-active title: titles=%+v sink=%v", rt.titles, sink.titles)
	}

	rt.active = true
	sendUpdate(map[string]any{
		"sessionId": "sess-1",
		"update":    map[string]any{"sessionUpdate": "session_info_update", "title": "Another English Summary"},
	})
	if err := rt.publishTitle("Direct Title"); err != nil {
		t.Fatal(err)
	}
	if len(rt.titles) != 0 || len(sink.titles) != 0 {
		t.Fatalf("disabled native titles published live title: titles=%+v sink=%v", rt.titles, sink.titles)
	}
}

func TestACPImageContentBlocksAndTools(t *testing.T) {
	cwd := t.TempDir()
	assets := t.TempDir()
	raw := testPNGBytes(t)
	encoded := base64.StdEncoding.EncodeToString(raw)

	rt, sink := newTestACPRuntime(cwd, true)
	rt.assets = assets
	rt.runID = "run-acp-img"
	rt.imageBudget = newTurnImageBudget()

	// 1. AgentMessageChunk with ContentBlock.Image materializes raster image & embeds cleanly without dumping raw base64.
	if err := rt.update(acp.SessionUpdate{
		AgentMessageChunk: &acp.SessionUpdateAgentMessageChunk{
			Content: acp.ContentBlock{
				Image: &acp.ContentBlockImage{
					Data:     encoded,
					MimeType: "image/png",
				},
			},
		},
	}); err != nil {
		t.Fatal(err)
	}
	// Non-image binary resource produces clean placeholder, never raw base64.
	nonImageBlob := base64.StdEncoding.EncodeToString([]byte("PK\x03\x04binary-archive-payload"))
	if err := rt.update(acp.SessionUpdate{
		AgentMessageChunk: &acp.SessionUpdateAgentMessageChunk{
			Content: acp.ContentBlock{
				Resource: &acp.ContentBlockResource{
					Resource: acp.EmbeddedResourceResource{
						BlobResourceContents: &acp.BlobResourceContents{
							Uri:  "file:///tmp/archive.bin",
							Blob: nonImageBlob,
						},
					},
				},
			},
		},
	}); err != nil {
		t.Fatal(err)
	}
	var textItem model.Item
	for _, it := range sink.items {
		if it.Kind == "text" {
			textItem = it
		}
	}
	if len(textItem.ImageFiles) != 1 {
		t.Fatalf("expected 1 materialized image on text item, got %+v", textItem)
	}
	if strings.Contains(textItem.Text, encoded) || strings.Contains(textItem.Text, nonImageBlob) {
		t.Fatalf("text item dumped raw base64: %q", textItem.Text)
	}
	if !strings.Contains(textItem.Text, "![](<"+textItem.ImageFiles[0].Path+">)") {
		t.Fatalf("text item missing embedded image markdown: %q", textItem.Text)
	}
	if !strings.Contains(textItem.Text, "\n\n[ACP binary resource: file:///tmp/archive.bin]") {
		t.Fatalf("text item missing clean binary resource placeholder: %q", textItem.Text)
	}

	// 2. generate_image tool with RawOutput imagePath gets ToolActionImage, populates ImageFiles, and projects into final reply.
	genPath := filepath.Join(t.TempDir(), "generated.png")
	if err := os.WriteFile(genPath, raw, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := rt.update(acp.SessionUpdate{
		ToolCall: &acp.SessionUpdateToolCall{
			ToolCallId: "gen-1",
			Title:      "Running generate_image",
			Kind:       acp.ToolKindOther,
			Status:     acp.ToolCallStatusCompleted,
			RawOutput:  map[string]any{"imagePath": genPath},
		},
	}); err != nil {
		t.Fatal(err)
	}
	genItem := sink.byID["tool-gen-1"]
	if genItem.ToolAction != model.ToolActionImage || genItem.Title != "Generate image" || len(genItem.ImageFiles) != 1 || genItem.ImageFiles[0].Path != genPath {
		t.Fatalf("unexpected generate_image tool item: %+v", genItem)
	}

	// 3. view_image tool gets ToolActionRead + ImageFiles, and must NOT be projected into assistant prose.
	viewedPath := filepath.Join(cwd, "diagram.png")
	if err := os.WriteFile(viewedPath, raw, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := rt.update(acp.SessionUpdate{
		ToolCall: &acp.SessionUpdateToolCall{
			ToolCallId: "view-1",
			Title:      "Running view_image",
			Kind:       acp.ToolKindRead,
			Status:     acp.ToolCallStatusCompleted,
			Locations:  []acp.ToolCallLocation{{Path: viewedPath}},
		},
	}); err != nil {
		t.Fatal(err)
	}
	viewItem := sink.byID["tool-view-1"]
	if viewItem.ToolAction != model.ToolActionRead || len(viewItem.ImageFiles) != 1 || viewItem.ImageFiles[0].Path != viewedPath {
		t.Fatalf("unexpected view_image tool item: %+v", viewItem)
	}

	// End-of-turn projection appends genPath onto the assistant reply, but NOT viewedPath.
	if err := rt.projectGeneratedImages(); err != nil {
		t.Fatal(err)
	}
	final := sink.byID[textItem.ID]
	if !strings.Contains(final.Text, "![](<"+genPath+">)") {
		t.Fatalf("final reply missing projected generated image: %q", final.Text)
	}
	if strings.Contains(final.Text, viewedPath) {
		t.Fatalf("final reply unexpectedly projected viewed image: %q", final.Text)
	}
}

func TestACPAntigravityImageGeneratorSubagent(t *testing.T) {
	cwd := t.TempDir()
	childOut := filepath.Join(t.TempDir(), "brain", "child-1", "cover.png")
	if err := os.MkdirAll(filepath.Dir(childOut), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(childOut, testPNGBytes(t), 0o600); err != nil {
		t.Fatal(err)
	}

	rt, sink := newTestACPRuntime(cwd, true)
	rt.assets = t.TempDir()
	rt.runID = "run-agy-sub"
	rt.imageBudget = newTurnImageBudget()

	// Launching invoke_subagent with TypeName="image-generator" and no Role defaults to "Image generator".
	if err := rt.update(acp.SessionUpdate{
		ToolCall: &acp.SessionUpdateToolCall{
			ToolCallId: "imgsub-1",
			Title:      "Run invoke_subagent",
			Kind:       acp.ToolKindOther,
			Status:     acp.ToolCallStatusInProgress,
			RawInput:   map[string]any{"TypeName": "image-generator", "Prompt": "Draw a cozy cabin"},
		},
	}); err != nil {
		t.Fatal(err)
	}
	sub := sink.byID["subagent:imgsub-1"]
	if sub.Kind != "subagent" || sub.Title != "Image generator" {
		t.Fatalf("unexpected image-generator subagent: %+v", sub)
	}

	done := acp.ToolCallStatusCompleted
	if err := rt.update(acp.SessionUpdate{
		ToolCallUpdate: &acp.SessionToolCallUpdate{
			ToolCallId: "imgsub-1",
			Status:     &done,
			RawOutput:  "Generated image saved at `" + childOut + "`.",
		},
	}); err != nil {
		t.Fatal(err)
	}
	sub = sink.byID["subagent:imgsub-1"]
	if len(sub.ImageFiles) != 1 || sub.ImageFiles[0].Path != childOut {
		t.Fatalf("expected subagent ImageFiles to contain %q, got %+v", childOut, sub.ImageFiles)
	}

	// Parent sends text without embedding the image -> end-of-turn projection appends it.
	if err := rt.update(acp.SessionUpdate{
		AgentMessageChunk: &acp.SessionUpdateAgentMessageChunk{
			Content: acp.TextBlock("All set, your cabin illustration is ready."),
		},
	}); err != nil {
		t.Fatal(err)
	}
	if err := rt.projectGeneratedImages(); err != nil {
		t.Fatal(err)
	}
	final := sink.byID[rt.lastTextID]
	if !strings.Contains(final.Text, "![](<"+childOut+">)") {
		t.Fatalf("parent reply missing projected subagent image: %q", final.Text)
	}
}
