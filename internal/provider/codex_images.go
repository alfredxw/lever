package provider

import (
	"path/filepath"
	"strings"

	"lever/internal/model"
)

type codexRunningImageGen struct {
	revisedPrompt         string
	transparentBackground *bool
}

type codexImageTracker struct {
	assets       string
	runID        string
	cwd          string
	budget       *turnImageBudget
	running      map[string]codexRunningImageGen
	saved        []string
	firstID      string
	lastAnswerID string
}

func newCodexImageTracker(assets, runID, cwd string) *codexImageTracker {
	return &codexImageTracker{
		assets:  assets,
		runID:   runID,
		cwd:     cwd,
		budget:  newTurnImageBudget(),
		running: map[string]codexRunningImageGen{},
	}
}

func (t *codexImageTracker) reset() {
	clear(t.running)
	t.saved = nil
	t.firstID = ""
	t.lastAnswerID = ""
	t.budget = newTurnImageBudget()
}

func (t *codexImageTracker) noteAnswer(id string) {
	if id != "" {
		t.lastAnswerID = id
	}
}

func (t *codexImageTracker) imageGenerationItem(v object, completed bool) model.Item {
	id := str(v["id"])
	prev := t.running[id]
	prompt := strings.TrimSpace(str(v["revisedPrompt"]))
	if prompt == "" {
		prompt = prev.revisedPrompt
	}
	transparent := prev.transparentBackground
	if flag, ok := v["transparentBackground"].(bool); ok {
		transparent = &flag
	}

	item := model.Item{
		ID:         id,
		Kind:       "tool",
		ToolAction: model.ToolActionImage,
		Title:      "Generate image",
		Status:     "running",
	}

	rawStatus := strings.ToLower(strings.TrimSpace(str(v["status"])))
	if !completed {
		t.running[id] = codexRunningImageGen{
			revisedPrompt:         prompt,
			transparentBackground: transparent,
		}
		item.Text = formatCodexImageGenDetail(prompt, transparent, "", nil)
		return item
	}

	delete(t.running, id)
	switch {
	case rawStatus == "failed" || rawStatus == "declined" || v["failure"] != nil:
		item.Status = "failed"
	case rawStatus == "cancelled" || rawStatus == "canceled" || rawStatus == "interrupted":
		item.Status = "interrupted"
	default:
		item.Status = "completed"
	}

	var imageFile model.ImageFile
	if item.Status == "completed" {
		savedPath := normalizeLocalImagePath(str(v["savedPath"]), t.cwd)
		result := strings.TrimSpace(str(v["result"]))
		switch {
		case savedPath != "" && (existingRegularImageFile(savedPath) || result == ""):
			imageFile = model.ImageFile{Path: savedPath, Name: filepath.Base(savedPath)}
		case result != "":
			if materialized, ok := materializeBase64Image(t.assets, t.runID, "codex-"+id, result, t.budget); ok {
				imageFile = materialized
			} else if savedPath != "" {
				imageFile = model.ImageFile{Path: savedPath, Name: filepath.Base(savedPath)}
			}
		}
	}

	if imageFile.Path != "" {
		item.ImageFiles = []model.ImageFile{imageFile}
		t.saved = append(t.saved, imageFile.Path)
		if t.firstID == "" {
			t.firstID = id
		}
	}
	item.Text = formatCodexImageGenDetail(prompt, transparent, imageFile.Path, v["failure"])
	return item
}

func (t *codexImageTracker) finishRunning(status string, emit func(model.Item) error) error {
	if len(t.running) == 0 {
		return nil
	}
	for id, input := range t.running {
		item := model.Item{
			ID:         id,
			Kind:       "tool",
			ToolAction: model.ToolActionImage,
			Title:      "Generate image",
			Status:     status,
			Text:       formatCodexImageGenDetail(input.revisedPrompt, input.transparentBackground, "", nil),
		}
		if err := emit(item); err != nil {
			return err
		}
	}
	clear(t.running)
	return nil
}

func (t *codexImageTracker) project(items map[string]model.Item, emit func(model.Item) error) error {
	if len(t.saved) == 0 {
		return nil
	}
	saved := t.saved
	t.saved = nil
	if t.lastAnswerID != "" {
		if answer, ok := items[t.lastAnswerID]; ok && answer.Kind == "text" {
			updated := appendGeneratedImageEmbeds(answer.Text, saved)
			if updated == answer.Text {
				return nil
			}
			answer.Text = updated
			return emit(answer)
		}
	}
	text := appendGeneratedImageEmbeds("", saved)
	if text == "" {
		return nil
	}
	msgID := "generated-image-message:" + t.firstID
	t.lastAnswerID = msgID
	return emit(model.Item{
		ID:     msgID,
		Kind:   "text",
		Text:   text,
		Status: "completed",
	})
}

func formatCodexImageGenDetail(prompt string, transparent *bool, savedPath string, failure any) string {
	detail := object{}
	if prompt != "" {
		detail["prompt"] = prompt
	}
	if transparent != nil {
		detail["transparentBackground"] = *transparent
	}
	if savedPath != "" {
		detail["savedPath"] = savedPath
	}
	if failure != nil {
		detail["failure"] = failure
	}
	if len(detail) == 0 {
		return ""
	}
	return clip(pretty(detail))
}

func codexImageViewItem(v object, cwd, status string) model.Item {
	rawPath := strings.TrimSpace(str(v["path"]))
	path := normalizeLocalImagePath(rawPath, cwd)
	title := acpDisplayPath(rawPath, cwd)
	if title == "" {
		title = "View image"
	}
	item := model.Item{
		ID:         str(v["id"]),
		Kind:       "tool",
		ToolAction: model.ToolActionRead,
		Title:      title,
		Text:       rawPath,
		Status:     status,
	}
	if path != "" {
		item.ImageFiles = []model.ImageFile{{Path: path, Name: filepath.Base(path)}}
	}
	return item
}

func applyCodexToolCall(item *model.Item, kind string, v object, assets, runID, cwd string, budget *turnImageBudget, citations codexCitationIndex) {
	item.Kind = "tool"
	if kind == "mcpToolCall" {
		item.Title = str(v["server"]) + " / " + str(v["tool"])
	} else {
		item.Title = str(v["tool"])
		if ns := str(v["namespace"]); ns != "" {
			item.Title = ns + " / " + item.Title
		}
		if item.Title == "" {
			item.Title = "Tool call"
		}
	}
	parts := []string{}
	if v["arguments"] != nil {
		if args := pretty(v["arguments"]); args != "" {
			parts = append(parts, clip(args))
		}
	}
	if v["result"] != nil {
		citations.addMCPResult(v["result"])
		imgs, sanitized := extractToolOutputImages(assets, runID, item.ID, cwd, v["result"], budget)
		for _, img := range imgs {
			item.ImageFiles = appendUniqueImageFile(item.ImageFiles, img)
		}
		if res := pretty(sanitized); res != "" {
			parts = append(parts, clip(res))
		}
	}
	if v["contentItems"] != nil {
		imgs, sanitized := extractToolOutputImages(assets, runID, item.ID, cwd, v["contentItems"], budget)
		for _, img := range imgs {
			item.ImageFiles = appendUniqueImageFile(item.ImageFiles, img)
		}
		if res := pretty(sanitized); res != "" {
			parts = append(parts, clip(res))
		}
	}
	if v["error"] != nil {
		item.Status = "failed"
		parts = append(parts, pretty(v["error"]))
	} else if v["success"] == false {
		item.Status = "failed"
	}
	item.Text = strings.Join(parts, "\n")
}
