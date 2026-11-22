package provider

import (
	"context"
	"image"
	"image/color"
	"image/png"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"lever/internal/model"
)

type liveSink struct {
	native string
	mu     sync.Mutex
	items  map[string]model.Item
}

func TestLiveComposer(t *testing.T) {
	if os.Getenv("LEVER_LIVE_TEST") != "1" {
		t.Skip("set LEVER_LIVE_TEST=1 for a real runtime smoke test")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	catalog, err := Discover(ctx, model.Provider{ID: "codex", Type: "codex", Enabled: true}, "")
	if err != nil {
		t.Fatal(err)
	}
	chosen := catalog.Models[0]
	for _, candidate := range catalog.Models {
		if candidate.Default {
			chosen = candidate
			break
		}
	}
	dir := t.TempDir()
	path := filepath.Join(dir, "red.png")
	file, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	picture := image.NewRGBA(image.Rect(0, 0, 128, 128))
	for y := 0; y < 128; y++ {
		for x := 0; x < 128; x++ {
			picture.Set(x, y, color.RGBA{R: 230, G: 20, B: 20, A: 255})
		}
	}
	err = png.Encode(file, picture)
	file.Close()
	if err != nil {
		t.Fatal(err)
	}
	session := model.Session{ID: "composer-live", Scope: model.Scope{Roots: []model.Root{{ID: "root", Path: dir}}, PrimaryRootID: "root"}, Selection: model.Selection{Provider: "codex", Permission: "read_only"}}
	sink := &liveSink{items: map[string]model.Item{}}
	selection := model.Selection{Provider: "codex", Model: chosen.ID, Effort: chosen.DefaultEffort, Fast: chosen.Fast}
	err = Run(ctx, Input{Provider: model.Provider{ID: "codex", Type: "codex", Enabled: true}, Session: session, Selection: selection, RunID: "cf5774b0-a7da-4b22-b0a4-111111111111", Text: "Do not use tools. What is the dominant color of the attached image? Reply with exactly one English color word.", Assets: dir, Attachments: []Attachment{{Attachment: model.Attachment{ID: "image", Name: "red.png", MediaType: "image/png"}, Path: path}}}, sink)
	if err != nil {
		t.Fatal(err)
	}
	text := ""
	for _, item := range sink.items {
		if item.Kind == "text" {
			text += item.Text
		}
	}
	if !strings.Contains(strings.ToLower(text), "red") {
		t.Fatalf("image was not understood: %s", text)
	}
	t.Logf("model=%s effort=%s fast=%t image=%s", chosen.ID, selection.Effort, selection.Fast, text)
}

func (s *liveSink) NextSteer() (*Input, error)                                  { return nil, nil }
func (s *liveSink) Steered(string, error) error                                 { return nil }
func (s *liveSink) TurnDiff(string) error                                       { return nil }
func (s *liveSink) UpdateRuntime(func(*model.SessionRuntime)) error             { return nil }
func (s *liveSink) EnablePermissionChanges(func(context.Context, string) error) {}

func (s *liveSink) Bind(id string) error  { s.native = id; return nil }
func (s *liveSink) BindTurn(string) error { return nil }
func (s *liveSink) Item(item model.Item) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.items[item.ID] = item
	return nil
}
func (s *liveSink) Ask(context.Context, model.Request) (model.Answer, error) {
	return model.Answer{Allow: false}, nil
}

// Explicit opt-in: these checks call installed/authenticated runtimes and may
// consume account credits. Normal test runs use the subprocess protocol fixture.
func TestLiveRuntimes(t *testing.T) {
	if os.Getenv("LEVER_LIVE_TEST") != "1" {
		t.Skip("set LEVER_LIVE_TEST=1 for a real runtime smoke test")
	}
	for _, name := range []string{"codex", "claude"} {
		t.Run(name, func(t *testing.T) {
			dir := t.TempDir()
			session := model.Session{ID: "live-smoke", Scope: model.Scope{Roots: []model.Root{{ID: "root", Path: dir}}, PrimaryRootID: "root"}, Selection: model.Selection{Provider: name, Permission: "ask"}}
			session.Selection.Model = os.Getenv("LEVER_LIVE_" + strings.ToUpper(name) + "_MODEL")
			if name == "codex" {
				session.Selection.Permission = "read_only"
			}
			for turn := 0; turn < 3; turn++ {
				ctx, cancel := context.WithTimeout(context.Background(), 70*time.Second)
				sink := &liveSink{items: map[string]model.Item{}}
				marker := "first-marker"
				input := "Remember the word lever-fern. Reply with that word."
				if turn == 1 {
					marker = "next-marker"
					input = "What word did I ask you to remember? Reply with that word."
				}
				profile := model.Profile{Instructions: "Do not use tools. Include exactly this marker after your answer: " + marker}
				if turn == 1 {
					profile.Instructions = strings.Repeat("Keep answers concise. ", 220) + profile.Instructions
				}
				if turn == 2 {
					profile.Instructions = ""
					input = "Do not use tools. What word did I ask you to remember? Reply with only that word, without a marker."
				}
				err := Run(ctx, Input{Provider: model.Provider{ID: name, Type: name, Enabled: true}, Session: session, Profile: profile, RunID: "9f0db7f9-20b5-4d94-9253-001e55d49a8" + string(rune('0'+turn)), Text: input, Assets: dir}, sink)
				cancel()
				if err != nil {
					t.Fatalf("%v (bound=%t, items=%d)", err, sink.native != "", len(sink.items))
				}
				if sink.native == "" {
					t.Fatal("missing native session")
				}
				if session.NativeID != "" && sink.native != session.NativeID {
					t.Fatal("resume changed native session")
				}
				session.NativeID = sink.native
				text := ""
				for _, item := range sink.items {
					if item.Kind == "text" {
						text += item.Text
					}
				}
				if text == "" {
					t.Fatal("no assistant output")
				}
				if !strings.Contains(strings.ToLower(text), "lever-fern") {
					t.Fatalf("native session did not retain the prior word: %s", text)
				}
				if turn < 2 && (!strings.Contains(text, marker) || (turn == 1 && strings.Contains(text, "first-marker"))) {
					t.Fatalf("native session did not apply current instructions: %s", text)
				}
				if turn == 2 && strings.TrimSpace(text) != "lever-fern" {
					t.Fatalf("clearing instructions left an earlier marker active: %s", text)
				}
				t.Log(name, "turn", turn, "output:", text)
			}
		})
	}
}

func TestLiveAntigravityBackgroundContinuation(t *testing.T) {
	if os.Getenv("LEVER_LIVE_TEST") != "1" {
		t.Skip("set LEVER_LIVE_TEST=1 for a real runtime smoke test")
	}
	cwd := t.TempDir()
	stateDir := t.TempDir()
	ctx, cancel := context.WithTimeout(WithStateDir(context.Background(), stateDir), 3*time.Minute)
	defer cancel()

	sink := &liveSink{items: map[string]model.Item{}}
	targetFile := filepath.Join(cwd, "a.txt")
	in := Input{
		Provider: model.Provider{ID: "antigravity", Type: "antigravity", Command: "agy", Enabled: true},
		Session: model.Session{
			ID:    "live-agy-bg",
			Scope: model.Scope{PrimaryRootID: "root", Roots: []model.Root{{ID: "root", Path: cwd}}},
		},
		Selection: model.Selection{Provider: "antigravity", Model: "gemini-3.8-flash", Effort: "high", Permission: "turbo"},
		Text: `Follow these exact steps strictly in order:
1. Call run_command with CommandLine="sleep 12 && echo STEP1" and WaitMsBeforeAsync=500. When it goes to the background, reply "Waiting for STEP1" and end your turn to wait for its completion notification.
2. When STEP1 finishes, reply "STEP1 finished, writing file" AND call write_file to create "` + targetFile + `" with content "hello".
3. Next, call run_command with CommandLine="sleep 3 && echo STEP2" and WaitMsBeforeAsync=500. When STEP2 goes to the background, reply "Waiting for STEP2" and end your turn.
4. When STEP2 finishes, reply "ALL_VERIFIED_DONE".`,
	}

	if err := Run(ctx, in, sink); err != nil {
		t.Fatalf("antigravity background continuation failed: %v", err)
	}
	data, err := os.ReadFile(targetFile)
	if err != nil || strings.TrimSpace(string(data)) != "hello" {
		t.Fatalf("expected %s to contain hello, got %q (err=%v)", targetFile, string(data), err)
	}
	var text strings.Builder
	for _, item := range sink.items {
		if item.Kind == "text" {
			text.WriteString(item.Text)
			text.WriteString("\n")
		}
		if item.Kind == "tool" && item.Status != "completed" {
			t.Fatalf("tool did not finish cleanly: %+v", item)
		}
	}
	if !strings.Contains(text.String(), "ALL_VERIFIED_DONE") {
		t.Fatalf("run finished before final post-background reply: %s", text.String())
	}
	t.Logf("native=%s output=%q", sink.native, text.String())
}
