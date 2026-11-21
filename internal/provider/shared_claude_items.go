package provider

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"strconv"
	"strings"

	"lever/internal/model"
)

type claudeSharedBlock struct {
	Type      string          `json:"type"`
	Text      string          `json:"text"`
	Thinking  string          `json:"thinking"`
	ID        string          `json:"id"`
	Name      string          `json:"name"`
	Input     json.RawMessage `json:"input"`
	ToolUseID string          `json:"tool_use_id"`
	Content   json.RawMessage `json:"content"`
	IsError   bool            `json:"is_error"`
	Source    *struct {
		Type      string `json:"type"`
		MediaType string `json:"media_type"`
		Data      string `json:"data"`
	} `json:"source"`
}

func claudeSharedBlocks(content json.RawMessage) []claudeSharedBlock {
	if len(content) > 0 && content[0] == '"' {
		var text string
		if json.Unmarshal(content, &text) == nil {
			return []claudeSharedBlock{{Type: "text", Text: text}}
		}
	}
	var blocks []claudeSharedBlock
	_ = json.Unmarshal(content, &blocks)
	return blocks
}

func claudeSharedContent(entry *sharedEntry, blocks []claudeSharedBlock) {
	var text []string
	for _, block := range blocks {
		switch block.Type {
		case "text":
			if block.Text != "" {
				text = append(text, block.Text)
			}
		case "image":
			if source := block.Source; source != nil && source.Type == "base64" && strings.HasPrefix(source.MediaType, "image/") {
				entry.addImage(sharedImage{data: source.Data})
			}
		}
	}
	entry.Text = strings.Join(text, "\n\n")
}

func claudeSharedEntries(event claudeSharedEvent) []sharedEntry {
	if event.ID == "" || event.Side || event.Summary {
		return nil
	}
	role, content, origin := event.Type, event.Message.Content, event.Origin
	if role == "attachment" && event.Attachment != nil && event.Attachment.Type == "queued_command" && event.Attachment.CommandMode == "prompt" {
		role, content, origin = "user", event.Attachment.Prompt, event.Attachment.Origin
	}
	if role != "user" && role != "assistant" {
		return nil
	}
	message := newSharedEntry(event.ID, role, "text", event.Timestamp)
	blocks := claudeSharedBlocks(content)
	if origin != nil && origin.Kind == "peer" {
		// Idle inputs appear as hidden user lines; busy inputs may be queued commands.
		body, own := strings.CutPrefix(origin.Body, claudeSharedPreamble)
		if !own {
			return nil
		}
		claudeSharedContent(&message, blocks)
		message.Text = strings.ReplaceAll(body, `<\/cross-session-message`, `</cross-session-message`)
	} else if !event.Meta {
		claudeSharedContent(&message, blocks)
	}
	var activity []sharedEntry
	for index, block := range blocks {
		id := event.ID + "/" + strconv.Itoa(index)
		entry := newSharedEntry(id, "assistant", "tool", event.Timestamp)
		switch {
		case role == "user" && (block.Type == "tool_result" || strings.HasSuffix(block.Type, "_tool_result")):
			entry.toolID, entry.toolResult = block.ToolUseID, true
			claudeSharedContent(&entry, claudeSharedBlocks(block.Content))
			if block.IsError {
				entry.Status = "failed"
			}
		case role == "assistant" && !event.Meta && (block.Type == "tool_use" || block.Type == "server_tool_use"):
			entry.toolID, entry.Title, entry.Text = block.ID, block.Name, string(block.Input)
			entry.Status = "running"
		case role == "assistant" && !event.Meta && block.Type == "thinking" && strings.TrimSpace(block.Thinking) != "":
			entry.Kind, entry.Text = "reasoning", block.Thinking
		default:
			continue
		}
		entry.Text = sharedDetail(entry.Text)
		activity = append(activity, entry)
	}
	if (strings.TrimSpace(message.Text) == "" && len(message.Images) == 0) ||
		strings.HasPrefix(message.Text, "<local-command-") || strings.HasPrefix(message.Text, "<command-name>") ||
		strings.HasPrefix(message.Text, "[Request interrupted by user") {
		return activity
	}
	if role == "user" {
		return append(activity, message)
	}
	switch event.Message.StopReason {
	case "tool_use":
		message.Kind = "commentary"
	case "end_turn", "stop_sequence", "max_tokens":
		message.Kind = "final"
	}
	return append([]sharedEntry{message}, activity...)
}

func sharedClaudePreview(ctx context.Context, path string) string {
	var preview string
	readSharedPreviewTail(ctx, path, func(line []byte) bool {
		var event claudeSharedEvent
		if json.Unmarshal(line, &event) != nil {
			return false
		}
		for _, entry := range claudeSharedEntries(event) {
			switch entry.Kind {
			case "text", "commentary", "final":
				if preview = sharedSnippet(entry.Text); preview != "" {
					return true
				}
			}
		}
		return false
	})
	return preview
}

func readSharedClaudeEntry(ctx context.Context, config model.Provider, id, messageID string, managed map[string]bool) (sharedEntry, error) {
	thread, err := accessibleSharedClaudeThread(ctx, config, id, managed)
	if err != nil {
		return sharedEntry{}, err
	}
	if thread.path == "" {
		return sharedEntry{}, os.ErrNotExist
	}
	eventID, _, _ := strings.Cut(messageID, "/")
	match := []byte(`"` + eventID + `"`)
	var found sharedEntry
	err = readSharedLinesBackwards(ctx, thread.path, 0, func(line []byte) bool {
		var event claudeSharedEvent
		if !bytes.Contains(line, match) || json.Unmarshal(line, &event) != nil || event.ID != eventID {
			return false
		}
		for _, entry := range claudeSharedEntries(event) {
			if entry.ID == messageID {
				found = entry
				return true
			}
		}
		return false
	})
	if err == nil && found.ID == "" {
		err = os.ErrNotExist
	}
	return found, err
}
