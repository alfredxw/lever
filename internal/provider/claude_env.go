package provider

import (
	"os/exec"
	"path/filepath"
	"slices"
	"strings"

	"lever/internal/model"
)

const claudeEntrypoint = "lever"

// applyClaudeEnvironment isolates Lever-launched Claude processes from any host
// Claude session and labels them with Lever's entrypoint unless overridden in
// the profile's settings.json.
func applyClaudeEnvironment(cmd *exec.Cmd, config model.Provider) {
	cmd.Env = slices.DeleteFunc(cmd.Env, func(entry string) bool {
		key, _, _ := strings.Cut(entry, "=")
		switch strings.ToUpper(key) {
		case "CLAUDE_CODE_ENTRYPOINT",
			"CLAUDECODE",
			"CLAUDE_CODE_SESSION_ID",
			"CLAUDE_CODE_HOST_SESSION_ID",
			"CLAUDE_CODE_CHILD_SESSION",
			"CLAUDE_CODE_SESSION_ATTENDED",
			"CLAUDE_CODE_MESSAGING_SOCKET",
			"CLAUDE_CODE_MESSAGING_TOKEN",
			"CLAUDE_CODE_EXECPATH",
			"CLAUDE_CODE_DESKTOP_APP_VERSION",
			"CLAUDE_EFFORT",
			"CLAUDE_PID",
			"CLAUDE_AGENT_SDK_VERSION":
			return true
		}
		return false
	})
	cmd.Env = append(cmd.Env, "CLAUDE_CODE_ENTRYPOINT="+claudeProcessEntrypoint(config))
}

// claudeProcessEntrypoint resolves the entrypoint for a Claude Code process.
// Claude Code reads CLAUDE_CODE_ENTRYPOINT only from the process environment
// (ignoring settings.json's env block), so Lever applies a user's explicit
// settings.json override itself and otherwise identifies processes as "lever".
func claudeProcessEntrypoint(config model.Provider) string {
	if dir := ConfigurationDirectory(config); dir != "" {
		var settings struct {
			Env map[string]string `json:"env"`
		}
		if readSharedJSON(filepath.Join(dir, "settings.json"), &settings) == nil {
			if value := strings.TrimSpace(settings.Env["CLAUDE_CODE_ENTRYPOINT"]); value != "" {
				return value
			}
		}
	}
	return claudeEntrypoint
}
