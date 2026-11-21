package provider

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"

	"lever/internal/model"
)

func checkClaudeContinuation(ctx context.Context, in Input) error {
	if !in.Recovery.Continue || in.Recovery.NativeTurnID == nil {
		return errors.New("Claude requires a confirmed pause to continue this reply")
	}
	if len(sharedClaudeSessions(ConfigurationDirectory(in.Provider))[in.Session.NativeID]) > 0 {
		return errors.Join(ErrUnconfirmed, errors.New("Another Claude Code process has this conversation open"))
	}
	tip, err := claudeCheckpoint(ctx, in.Provider, in.Session.NativeID, in.RunID)
	if err != nil {
		return errors.Join(ErrUnconfirmed, err)
	}
	if tip != *in.Recovery.NativeTurnID {
		return errors.Join(ErrUnconfirmed, errors.New("The saved Claude Code conversation changed after the reply was paused"))
	}
	return nil
}

// Use the last saved message as the resume boundary and verify that this
// conversation includes the original input. Empty continuation frames have
// their own acknowledgement IDs but are not stored as user messages.
func claudeCheckpoint(ctx context.Context, config model.Provider, sessionID, runID string) (string, error) {
	if !sharedUUID.MatchString(sessionID) {
		return "", errors.New("Claude did not return a valid session ID")
	}
	projects := filepath.Join(ConfigurationDirectory(config), "projects")
	entries, err := os.ReadDir(projects)
	if err != nil {
		return "", err
	}
	var path string
	for _, entry := range entries {
		if err := ctx.Err(); err != nil {
			return "", err
		}
		if !entry.IsDir() {
			continue
		}
		candidate := filepath.Join(projects, entry.Name(), sessionID+".jsonl")
		if info, err := os.Lstat(candidate); err == nil && info.Mode().IsRegular() {
			if path != "" {
				return "", errors.New("Claude Code has more than one copy of this conversation")
			}
			path = candidate
		}
	}
	if path == "" {
		return "", errors.New("Claude Code could not find the saved conversation")
	}
	var tip string
	var decodeErr error
	found := false
	err = readSharedLinesBackwards(ctx, path, 0, func(line []byte) bool {
		var event claudeSharedEvent
		if decodeErr = json.Unmarshal(line, &event); decodeErr != nil {
			return true
		}
		if event.Side || event.ID == "" || (event.Type != "user" && event.Type != "assistant") {
			return false
		}
		if tip == "" {
			tip = event.ID
		}
		found = event.Type == "user" && event.ID == runID
		return found
	})
	if err := errors.Join(err, decodeErr); err != nil {
		return "", err
	}
	if !found {
		return "", errors.New("Claude Code did not save the original input")
	}
	return tip, nil
}
