package provider

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"lever/internal/model"
)

const SharedListLimit = 120

var sharedUUID = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)

var (
	ErrSharedBusy        = errors.New("the original conversation is still running")
	ErrSharedUnavailable = errors.New("open the conversation in the original app to continue")
	ErrSharedUnconfirmed = errors.New("delivery could not be confirmed; check the original app before resending")
)

func SharedStore(config model.Provider) string {
	dir := baseConfigurationDirectory(config)
	if !filepath.IsAbs(dir) {
		return ""
	}
	if resolved, err := filepath.EvalSymlinks(dir); err == nil {
		dir = resolved
	}
	return filepath.Clean(dir)
}

func ListShared(ctx context.Context, config model.Provider, managed map[string]bool) ([]model.SharedConversation, error) {
	switch config.Type {
	case "codex":
		return listSharedCodex(ctx, config, managed)
	case "claude":
		return listSharedClaude(ctx, config, managed)
	}
	return nil, nil
}

func ReadShared(ctx context.Context, config model.Provider, id string, limit int, managed map[string]bool) (model.SharedHistory, error) {
	switch config.Type {
	case "codex":
		if sharedUUID.MatchString(id) && !managed[id] {
			return readSharedCodex(ctx, config, id, limit)
		}
	case "claude":
		if sharedUUID.MatchString(strings.TrimPrefix(id, "local_")) {
			return readSharedClaude(ctx, config, id, limit, managed)
		}
	}
	return model.SharedHistory{}, os.ErrNotExist
}

// SharedWorkingDirectory checks the same native ownership as ReadShared without
// loading a transcript for each embedded image.
func SharedWorkingDirectory(ctx context.Context, config model.Provider, id string, managed map[string]bool) (string, error) {
	switch config.Type {
	case "codex":
		if sharedUUID.MatchString(id) && !managed[id] {
			threads, err := sharedCodexThreads(ctx, config, id)
			if err != nil {
				return "", err
			}
			return threads[0].Cwd, nil
		}
	case "claude":
		if sharedUUID.MatchString(strings.TrimPrefix(id, "local_")) {
			thread, err := accessibleSharedClaudeThread(ctx, config, id, managed)
			return thread.Cwd, err
		}
	}
	return "", os.ErrNotExist
}

func ReadSharedImage(ctx context.Context, config model.Provider, id, imageID string, managed map[string]bool) ([]byte, string, error) {
	separator := strings.LastIndexByte(imageID, ':')
	if separator <= 0 || len(imageID) > 512 {
		return nil, "", os.ErrNotExist
	}
	entry, err := readSharedEntry(ctx, config, id, imageID[:separator], managed)
	if err != nil {
		return nil, "", err
	}
	for index, image := range entry.Images {
		if image.ID == imageID {
			return entry.sources[index].read()
		}
	}
	return nil, "", os.ErrNotExist
}

func ReadSharedDetail(ctx context.Context, config model.Provider, id, messageID string, managed map[string]bool) (string, error) {
	entry, err := readSharedEntry(ctx, config, id, messageID, managed)
	return entry.Text, err
}

func readSharedEntry(ctx context.Context, config model.Provider, id, messageID string, managed map[string]bool) (sharedEntry, error) {
	if messageID == "" || len(messageID) > 512 {
		return sharedEntry{}, os.ErrNotExist
	}
	switch config.Type {
	case "codex":
		if sharedUUID.MatchString(id) && !managed[id] {
			return readSharedCodexEntry(ctx, config, id, messageID)
		}
	case "claude":
		if sharedUUID.MatchString(strings.TrimPrefix(id, "local_")) {
			return readSharedClaudeEntry(ctx, config, id, messageID, managed)
		}
	}
	return sharedEntry{}, os.ErrNotExist
}

func SendShared(ctx context.Context, config model.Provider, id, commandID, text string, managed map[string]bool) error {
	switch config.Type {
	case "codex":
		if sharedUUID.MatchString(id) && !managed[id] {
			return sendSharedCodex(ctx, config, id, commandID, text)
		}
	case "claude":
		if sharedUUID.MatchString(strings.TrimPrefix(id, "local_")) {
			return sendSharedClaude(ctx, config, id, commandID, text, managed)
		}
	}
	return os.ErrNotExist
}

func sharedTime(ms int64) string {
	if ms <= 0 {
		return ""
	}
	return time.UnixMilli(ms).UTC().Format(time.RFC3339Nano)
}

func sharedSnippet(text string) string {
	text = strings.Join(strings.Fields(text), " ")
	runes := []rune(text)
	if len(runes) > 160 {
		return string(runes[:160]) + "…"
	}
	return text
}
