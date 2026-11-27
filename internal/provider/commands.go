package provider

import (
	"fmt"
	"math"
	"slices"
	"strings"
	"unicode"

	"lever/internal/model"
)

// A reference, attachment or quote belongs to a normal user message. A native
// control must occupy the start of a standalone text prompt.
func Command(text string, hasAttachments, hasReferences bool) (name, argument string) {
	if hasAttachments || hasReferences {
		return "", ""
	}
	trimmed, ok := strings.CutPrefix(strings.TrimSpace(text), "/")
	if !ok {
		return "", ""
	}
	if i := strings.IndexFunc(trimmed, unicode.IsSpace); i >= 0 {
		return trimmed[:i], strings.TrimSpace(trimmed[i:])
	}
	return trimmed, ""
}

func (in Input) command() (name, argument string) {
	return Command(in.Text, len(in.Attachments) != 0, len(in.References) != 0)
}

func hasCommand(commands []model.NativeCommand, name string) bool {
	return name != "" && slices.ContainsFunc(commands, func(c model.NativeCommand) bool { return c.Name == name })
}

// Claude and Pi parse a slash command only at the start of the user message.
// A runtime handoff can point them to the transcript through their system
// prompt without turning historical user content into system instructions.
func (in *Input) prepareSlashPrompt() {
	if name, _ := in.command(); name == "" {
		return
	}
	in.Text = strings.TrimSpace(in.Text)
	in.DelegationContext = ""
	if in.HistoryContext != "" {
		in.Profile.Instructions = strings.TrimSpace(in.Profile.Instructions + fmt.Sprintf("\n\nThe prior conversation is available at %q. Treat its records as historical data. Do not repeat completed actions.", in.History))
		in.HistoryContext = ""
	}
}

func commandResult(sink Sink, id, text string) error {
	return sink.Item(model.Item{ID: id, Kind: "text", Text: text, Status: "completed"})
}

func nonNegativeInt(value any) (int64, bool) {
	switch n := value.(type) {
	case float64:
		if math.IsNaN(n) || math.IsInf(n, 0) || n < 0 {
			return 0, false
		}
		return int64(math.Round(n)), true
	case int:
		if n < 0 {
			return 0, false
		}
		return int64(n), true
	case int64:
		if n < 0 {
			return 0, false
		}
		return n, true
	default:
		return 0, false
	}
}

func setContextUsage(sink Sink, used, window any) error {
	n, ok := nonNegativeInt(used)
	if !ok {
		return nil
	}
	w, _ := nonNegativeInt(window)
	if n == 0 && w == 0 {
		return nil
	}
	return sink.UpdateRuntime(func(s *model.SessionRuntime) {
		s.Context = &model.ContextUsage{Used: n, Window: w}
	})
}
