package provider

import (
	"strings"
	"time"

	"lever/internal/model"
)

type subagent struct {
	item           model.Item
	detail         model.SubagentActivity
	imageGenerator bool
}

func newSubagent(id string) *subagent {
	return &subagent{
		item:   model.Item{ID: "subagent:" + id, Kind: "subagent", Status: "running"},
		detail: model.SubagentActivity{StartedAt: time.Now().UTC().Format(time.RFC3339Nano)},
	}
}

func (s *subagent) restart() {
	s.item.Status, s.item.Text = "running", ""
	s.detail.Progress, s.detail.FinishedAt = "", ""
	s.detail.StartedAt = time.Now().UTC().Format(time.RFC3339Nano)
}

func (s *subagent) task(title, prompt string) {
	if title != "" {
		s.item.Title = strings.Join(strings.Fields(title), " ")
	}
	if prompt != "" {
		s.detail.Prompt = clip(prompt)
	}
}

func (s *subagent) addImages(images []model.ImageFile) {
	for _, img := range images {
		s.item.ImageFiles = appendUniqueImageFile(s.item.ImageFiles, img)
	}
}

func (s *subagent) finish(status, result string) {
	s.item.Status = status
	if result != "" {
		s.item.Text = clip(result)
		s.detail.Progress = ""
	}
	if s.detail.FinishedAt == "" {
		s.detail.FinishedAt = time.Now().UTC().Format(time.RFC3339Nano)
	}
}

func (s *subagent) publish(sink Sink) error {
	item, detail := s.item, s.detail
	item.Subagent = &detail
	return sink.Item(item)
}

func subagentTerminalStatus(status string) string {
	switch status {
	case "completed":
		return "completed"
	case "failed", "errored":
		return "failed"
	case "interrupted", "stopped", "shutdown":
		return "interrupted"
	default:
		return ""
	}
}

func contentText(value any) string {
	if text, ok := value.(string); ok {
		return text
	}
	var parts []string
	for _, block := range arr(value) {
		if block := obj(block); str(block["type"]) == "text" {
			parts = append(parts, str(block["text"]))
		}
	}
	return strings.Join(parts, "\n\n")
}
