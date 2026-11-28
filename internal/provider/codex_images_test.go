package provider

import (
	"encoding/base64"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"lever/internal/model"
)

func TestCodexImageTrackerLifecycleAndProjection(t *testing.T) {
	assets := t.TempDir()
	cwd := t.TempDir()
	saved := filepath.Join(t.TempDir(), "poster.png")
	raw := testPNGBytes(t)
	if err := os.WriteFile(saved, raw, 0o600); err != nil {
		t.Fatal(err)
	}

	t.Run("savedPath preserves started inputs and appends embed onto final answer", func(t *testing.T) {
		tracker := newCodexImageTracker(assets, "run-1", cwd)
		items := map[string]model.Item{}
		emit := func(item model.Item) error {
			items[item.ID] = item
			return nil
		}

		started := tracker.imageGenerationItem(object{
			"id":                    "ig-1",
			"status":                "inProgress",
			"revisedPrompt":         "A minimalist mountain poster",
			"transparentBackground": true,
		}, false)
		if started.Kind != "tool" || started.ToolAction != model.ToolActionImage || started.Title != "Generate image" || started.Status != "running" {
			t.Fatalf("unexpected started item: %+v", started)
		}
		if !strings.Contains(started.Text, "minimalist mountain poster") || !strings.Contains(started.Text, "transparentBackground") {
			t.Fatalf("started item missing inputs: %q", started.Text)
		}
		_ = emit(started)

		// Completion omits revisedPrompt/transparentBackground; tracker preserves them.
		completed := tracker.imageGenerationItem(object{
			"id":        "ig-1",
			"status":    "completed",
			"savedPath": saved,
		}, true)
		if completed.Status != "completed" || len(completed.ImageFiles) != 1 || completed.ImageFiles[0].Path != saved {
			t.Fatalf("unexpected completed item: %+v", completed)
		}
		if !strings.Contains(completed.Text, "minimalist mountain poster") || !strings.Contains(completed.Text, "savedPath") {
			t.Fatalf("completed item did not preserve inputs/savedPath: %q", completed.Text)
		}
		_ = emit(completed)

		// Assistant prose does not embed the image yet -> project appends it.
		ans := model.Item{ID: "msg-1", Kind: "text", Text: "Created your poster.", Status: "completed"}
		_ = emit(ans)
		tracker.noteAnswer(ans.ID)

		if err := tracker.project(items, emit); err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(items["msg-1"].Text, "![](<"+saved+">)") {
			t.Fatalf("projected answer missing image embed: %q", items["msg-1"].Text)
		}
		if len(items) != 2 {
			t.Fatalf("expected 2 items (tool + answer), got %d: %+v", len(items), items)
		}
		// Projecting again is a no-op (idempotent).
		before := items["msg-1"].Text
		if err := tracker.project(items, emit); err != nil {
			t.Fatal(err)
		}
		if items["msg-1"].Text != before {
			t.Fatalf("re-projection mutated answer:\nbefore: %q\nafter:  %q", before, items["msg-1"].Text)
		}
	})

	t.Run("image-only turn materializes base64 fallback into separate message id", func(t *testing.T) {
		tracker := newCodexImageTracker(assets, "run-2", cwd)
		items := map[string]model.Item{}
		emit := func(item model.Item) error {
			items[item.ID] = item
			return nil
		}

		completed := tracker.imageGenerationItem(object{
			"id":     "ig-base64",
			"status": "completed",
			"result": base64.StdEncoding.EncodeToString(raw),
		}, true)
		if completed.Status != "completed" || len(completed.ImageFiles) != 1 {
			t.Fatalf("expected base64 fallback image to materialize: %+v", completed)
		}
		_ = emit(completed)

		if err := tracker.project(items, emit); err != nil {
			t.Fatal(err)
		}
		msg, ok := items["generated-image-message:ig-base64"]
		if !ok || msg.Kind != "text" || msg.Status != "completed" {
			t.Fatalf("expected independent image message, got: %+v", items)
		}
		if !strings.Contains(msg.Text, completed.ImageFiles[0].Path) {
			t.Fatalf("image message missing materialized path: %q", msg.Text)
		}
		// Tool item must remain untouched alongside the independent text item.
		if items["ig-base64"].Kind != "tool" {
			t.Fatalf("tool item was overwritten: %+v", items["ig-base64"])
		}
	})

	t.Run("failure and finishRunning handle incomplete image generations cleanly", func(t *testing.T) {
		tracker := newCodexImageTracker(assets, "run-3", cwd)
		items := map[string]model.Item{}
		emit := func(item model.Item) error {
			items[item.ID] = item
			return nil
		}

		failed := tracker.imageGenerationItem(object{
			"id":      "ig-fail",
			"status":  "failed",
			"failure": map[string]any{"message": "safety filter"},
		}, true)
		if failed.Status != "failed" || len(failed.ImageFiles) != 0 || !strings.Contains(failed.Text, "safety filter") {
			t.Fatalf("unexpected failed item: %+v", failed)
		}
		_ = emit(failed)

		_ = emit(tracker.imageGenerationItem(object{
			"id":            "ig-dangling",
			"status":        "inProgress",
			"revisedPrompt": "Interrupted artwork",
		}, false))

		if err := tracker.finishRunning("interrupted", emit); err != nil {
			t.Fatal(err)
		}
		dangling := items["ig-dangling"]
		if dangling.Status != "interrupted" || !strings.Contains(dangling.Text, "Interrupted artwork") {
			t.Fatalf("dangling image generation not finished cleanly: %+v", dangling)
		}
		if err := tracker.project(items, emit); err != nil {
			t.Fatal(err)
		}
		if len(items) != 2 {
			t.Fatalf("failed/interrupted image gen should not project a text message: %+v", items)
		}
	})
}

func TestCodexImageViewAndToolCallImages(t *testing.T) {
	cwd := t.TempDir()
	imgPath := filepath.Join(cwd, "assets", "hero.png")
	raw := testPNGBytes(t)
	if err := os.MkdirAll(filepath.Dir(imgPath), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(imgPath, raw, 0o600); err != nil {
		t.Fatal(err)
	}

	view := codexImageViewItem(object{"id": "iv-1", "path": imgPath}, cwd, "completed")
	if view.ToolAction != model.ToolActionRead || view.Title != "assets/hero.png" || len(view.ImageFiles) != 1 || view.ImageFiles[0].Path != imgPath {
		t.Fatalf("unexpected imageView item: %+v", view)
	}

	assets := t.TempDir()
	encoded := base64.StdEncoding.EncodeToString(raw)
	item := model.Item{ID: "dyn-1", Status: "completed"}
	applyCodexToolCall(&item, "dynamicToolCall", object{
		"tool":      "render_diagram",
		"namespace": "viz",
		"arguments": map[string]any{"theme": "mono"},
		"contentItems": []any{
			map[string]any{"type": "inputText", "text": "diagram ready"},
			map[string]any{"type": "inputImage", "imageUrl": "data:image/png;base64," + encoded},
		},
	}, assets, "run-dyn", cwd, newTurnImageBudget(), codexCitationIndex{})

	if item.Title != "viz / render_diagram" || len(item.ImageFiles) != 1 {
		t.Fatalf("unexpected dynamicToolCall item: %+v", item)
	}
	if strings.Contains(item.Text, encoded) || !strings.Contains(item.Text, "diagram ready") {
		t.Fatalf("tool text should strip base64 and keep text: %q", item.Text)
	}
}

func TestCodexSharedEntryImageGeneration(t *testing.T) {
	okEntry, ok := codexSharedEntry(object{
		"type":      "imageGeneration",
		"status":    "completed",
		"savedPath": "/tmp/generated.png",
	}, "turn-1", "ig-1", "")
	if !ok || okEntry.Kind != "image" || okEntry.ToolAction != model.ToolActionImage || okEntry.Text != "" || len(okEntry.Images) != 1 {
		t.Fatalf("unexpected completed shared image entry: %+v", okEntry)
	}

	failEntry, ok := codexSharedEntry(object{
		"type":          "imageGeneration",
		"status":        "failed",
		"revisedPrompt": "sunset",
		"failure":       "quota exceeded",
	}, "turn-1", "ig-2", "")
	if !ok || failEntry.Kind != "tool" || failEntry.Status != "failed" || failEntry.ToolAction != model.ToolActionImage || !strings.Contains(failEntry.Text, "quota exceeded") {
		t.Fatalf("unexpected failed shared image entry: %+v", failEntry)
	}

	viewEntry, ok := codexSharedEntry(object{
		"type": "imageView",
		"path": "/tmp/view.png",
	}, "turn-1", "iv-1", "")
	if !ok || viewEntry.ToolAction != model.ToolActionRead || len(viewEntry.Images) != 1 {
		t.Fatalf("unexpected shared imageView entry: %+v", viewEntry)
	}
}
