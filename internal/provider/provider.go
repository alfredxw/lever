// Package provider adapts native coding runtimes. It does not execute model tools.
package provider

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"slices"
	"strconv"
	"strings"
	"time"

	"lever/internal/device"
	"lever/internal/model"
)

// ErrUnconfirmed means the runtime disconnected after accepting work without a
// terminal event. The caller must not replay that input automatically.
var ErrUnconfirmed = errors.New("runtime disconnected before confirming completion")

// A pause request cancels provider I/O. ErrPaused confirms the native turn ended
// and the provider can continue it from its saved conversation.
var ErrPauseRequested = errors.New("pause requested")
var ErrPaused = errors.New("execution paused")

// A native rejection confirms this input was not accepted, so it may be queued.
var ErrSteerRejected = errors.New("runtime rejected steering message")

type Input struct {
	Provider                                       model.Provider
	Session                                        model.Session
	Profile                                        model.Profile
	Selection                                      model.Selection
	Attachments                                    []Attachment
	References                                     []model.Reference
	Skills                                         SkillPlan
	Steers                                         <-chan struct{} `json:"-"`
	RunID, Text, Assets, MCPURL, MCPToken, History string
	ContextToken                                   string `json:",omitempty"`
	HistoryContext                                 string
	RequireMCP                                     bool
	Recovery                                       *Recovery
}

type Recovery struct {
	NativeTurnID     *string
	Continue         bool
	SkipOutputReplay bool // A confirmed pause already saved the streamed output.
}

func SupportsTurnContinuation(kind string) bool {
	return kind == "codex" || kind == "claude"
}

type SteerState string

const (
	SteerUnavailable SteerState = "unavailable"
	SteerPending     SteerState = "pending"
	SteerReady       SteerState = "ready"
)

func (in Input) CanPauseTurn() bool {
	if !SupportsTurnContinuation(in.Provider.Type) {
		return false
	}
	name, _ := in.command()
	if in.Provider.Type == "claude" {
		runtime := in.Session.Runtime
		return name == "" && (runtime == nil || runtime.Goal == nil || runtime.Goal.Status != "active")
	}
	return name != "compact" && name != "goal"
}

type Attachment struct {
	model.Attachment
	Path string
}

func (in Input) Message() string {
	text := in.Text
	if in.HistoryContext != "" {
		text = in.HistoryContext + "\n\nCurrent user message:\n" + text
	}
	for _, file := range in.Attachments {
		text += fmt.Sprintf("\n\n[Attached file %q (%s), saved at %q]", file.Name, file.MediaType, file.Path)
	}
	for _, ref := range in.References {
		switch ref.Kind {
		case "browserElement":
			if el := ref.Element; el != nil {
				text += fmt.Sprintf("\n\n[Selected webpage element: page=%q tag=%q selector=%q visible text=%q]", el.URL, el.Tag, el.Selector, el.Text)
			}
		case "file":
			text += fmt.Sprintf("\n\n[Referenced file %q at %q]", ref.Name, ref.Path)
		case "skill":
			switch {
			case ref.Provider == in.Provider.ID && in.Provider.Type == "codex":
				continue
			case ref.Provider == in.Provider.ID && in.Provider.Type == "claude":
				text += fmt.Sprintf("\n\nUse the /%s skill for this request.", ref.Name)
			default:
				text += fmt.Sprintf("\n\nRead and follow the %q skill at %q for this request.", ref.Name, in.skillPath(ref))
			}
		case "chat", "topic":
			text += fmt.Sprintf("\n\n[Referenced %s %q: use read_chat_context with target %q for dialogue.]", ref.Kind, ref.Name, ref.ID)
		case "agent":
			text += fmt.Sprintf("\n\n[Collaborate with Agent %q using delegate_start with agentId %q (or delegate_reply to continue an existing delegation). Use delegate_wait to collect results or end your turn to receive an automatic receipt.]", ref.Name, ref.ID)
		case "note", "workItem", "noteTask", "externalTask", "automationTask":
			text += fmt.Sprintf("\n\n[Referenced %s %q: use read_reference with kind %q and id %q for its current content.]", ref.Kind, ref.Name, ref.Kind, ref.ID)
		}
	}
	return text
}

func additionalDirectories(scope model.Scope) []string {
	var paths []string
	for _, root := range scope.Roots {
		if root.ID != scope.PrimaryRootID {
			paths = append(paths, root.Path)
		}
	}
	return paths
}

func (in Input) skillPath(ref model.Reference) string {
	for _, source := range in.Skills.Bundled {
		if ref.Path == filepath.Join(source, "SKILL.md") {
			return filepath.Join(in.Assets, "skills", filepath.Base(source), "SKILL.md")
		}
	}
	return ref.Path
}

func (file Attachment) Image() bool {
	switch file.MediaType {
	case "image/png", "image/jpeg", "image/webp", "image/gif":
		return true
	}
	return false
}

type Sink interface {
	Bind(string) error
	BindTurn(string) error
	UpdateRuntime(func(*model.SessionRuntime)) error
	Usage([]model.UsageWindow) error
	Title(string) error
	Item(model.Item) error
	TurnDiff(string) error
	Ask(context.Context, model.Request) (model.Answer, error)
	EnablePermissionChanges(func(context.Context, string) error)
	SetSteerState(SteerState) error
	NextSteer() (*Input, error)
	Steered(string, error) error
}

func Run(ctx context.Context, in Input, sink Sink) error {
	d, ok := drivers[in.Provider.Type]
	if !ok {
		return errors.New("unsupported provider type")
	}
	selection, err := ResolveSelection(in.Selection, in.Session.Selection, in.Provider)
	if err != nil {
		return err
	}
	in.Selection = selection
	in.Profile.Scope = in.Session.Scope
	// The process driving the turn can outlive the backend that started it.
	// Each concurrent turn owns its own system sleep assertion.
	if release, err := device.PreventIdleSleep(ctx); err == nil {
		defer release()
	} else if ctx.Err() == nil {
		slog.Warn("could not prevent idle sleep during provider run", "run", in.RunID, "error", err)
	}
	return d.run(ctx, in, sink)
}

func Probe(ctx context.Context, config model.Provider) model.ProviderInfo {
	p := model.ProviderInfo{Provider: config, Auth: "unknown", Capabilities: ConfiguredCapabilities(config), ReportsUsage: reportsProtocolUsage(config.Type)}
	p.ConfigPath = ConfigurationDirectory(config)
	if config.AuthMethod == "gemini-api-key" || config.AuthMethod == "agent-platform" {
		if file, err := antigravityKeyPath(ctx, config.ID); err == nil {
			info, err := os.Stat(file)
			p.HasAPIKey = err == nil && info.Size() > 0
		}
	}
	if config.Type == "antigravity" && IsAntigravityCLI(config, config.Command) {
		p.Auth = "cli"
	}
	path, err := Executable(ctx, config)
	if err != nil {
		p.Error = err.Error()
		return p
	}
	p.Path, p.Installed = path, true
	nativeAntigravity := config.Type == "antigravity" && IsAntigravityCLI(config, path)
	if nativeAntigravity {
		p.Auth = "cli"
	}
	if config.Enabled {
		_, p.CanLogin = nativeLoginArgs(config, path)
	}
	if (drivers[config.Type].acp && !nativeAntigravity) || !config.Enabled {
		return p
	}
	c, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	b, err := profileOutput(c, config, path, "--version")
	if err != nil {
		p.Error = err.Error()
	} else {
		p.Version = strings.TrimSpace(string(b))
		if nativeAntigravity {
			p.ReportsUsage = supportsAntigravityUsage(p.Version)
		}
	}
	return p
}

func configVariable(kind string) string {
	switch kind {
	case "codex":
		return "CODEX_HOME"
	case "claude":
		return "CLAUDE_CONFIG_DIR"
	case "pi":
		return "PI_CODING_AGENT_DIR"
	default:
		return ""
	}
}

// Use one environment for login, probing and turns. A new native login must
// not be overridden by the host's API key or OAuth token.
func applyProfile(cmd *exec.Cmd, config model.Provider) error {
	if config.ManagedProfile || config.ShadowHome != "" {
		cmd.Env = slices.DeleteFunc(cmd.Env, func(entry string) bool {
			key, _, _ := strings.Cut(entry, "=")
			switch strings.ToUpper(key) {
			case "OPENAI_API_KEY", "CODEX_API_KEY", "CODEX_ACCESS_TOKEN", "OPENAI_BASE_URL":
				return config.Type == "codex"
			case "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "CLAUDE_CODE_OAUTH_TOKEN",
				"CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR", "CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR",
				"CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY":
				return config.Type == "claude"
			}
			return false
		})
	}
	dir := config.ConfigDir
	if config.ShadowHome != "" {
		shared := baseConfigurationDirectory(config)
		if err := prepareCodexShadow(shared, config.ShadowHome); err != nil {
			return err
		}
		if os.Getenv("CODEX_SQLITE_HOME") == "" {
			cmd.Env = append(cmd.Env, "CODEX_SQLITE_HOME="+shared)
		}
		dir = config.ShadowHome
	}
	if name := configVariable(config.Type); name != "" && dir != "" {
		cmd.Env = append(cmd.Env, name+"="+dir)
	}
	if config.AutoCompactWindow != 0 {
		cmd.Env = append(cmd.Env, "CLAUDE_CODE_AUTO_COMPACT_WINDOW="+strconv.Itoa(config.AutoCompactWindow))
	}
	if config.Type == "claude" {
		applyClaudeEnvironment(cmd, config)
	}
	return nil
}

func profileOutput(ctx context.Context, config model.Provider, path string, args ...string) ([]byte, error) {
	cmd := device.Command(path, args...)
	if err := applyProfile(cmd, config); err != nil {
		return nil, err
	}
	return device.OutputCommand(ctx, cmd)
}

func nativeLoginArgs(config model.Provider, path string) ([]string, bool) {
	switch config.PluginID {
	case "lever.codex":
		return []string{"login"}, true
	case "lever.claude":
		return []string{"auth", "login"}, true
	case "lever.pi":
		return nil, true
	case "lever.dsh":
		return []string{"tui"}, true
	case "lever.antigravity":
		if IsAntigravityCLI(config, path) {
			return []string{"acp", "--login"}, true
		}
	}
	return nil, false
}

func SupportsLoginProfile(config model.Provider) bool {
	return config.PluginID == "lever."+config.Type && configVariable(config.Type) != ""
}

// Only expose authentication confirmed by the selected runtime. Neither command
// output nor account credentials are part of the provider list.
func LoginStatus(ctx context.Context, config model.Provider, path string) string {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	switch config.PluginID {
	case "lever.codex":
		client, err := openDiscovery(ctx, config, "", nil)
		if err != nil {
			return ""
		}
		defer client.close()
		result, err := client.call("account/read", object{"refreshToken": false})
		if err == nil {
			if str(obj(result["account"])["type"]) != "" {
				return "signedIn"
			}
			if account, reported := result["account"]; reported && account == nil && result["requiresOpenaiAuth"] == true {
				return "signedOut"
			}
		}
	case "lever.claude":
		data, _ := profileOutput(ctx, config, path, "auth", "status")
		var status struct{ LoggedIn *bool }
		// Claude also outputs the JSON status when it exits 1 for a signed-out user.
		if json.Unmarshal(data, &status) == nil && status.LoggedIn != nil {
			if *status.LoggedIn {
				return "signedIn"
			}
			return "signedOut"
		}
	}
	return ""
}

func LoginCommand(ctx context.Context, config model.Provider) (*exec.Cmd, error) {
	path, err := Executable(ctx, config)
	if err != nil {
		return nil, err
	}
	args, ok := nativeLoginArgs(config, path)
	if !ok {
		return nil, errors.New("This runtime does not support a login terminal")
	}
	cmd := device.Command(path, args...)
	if err := applyProfile(cmd, config); err != nil {
		return nil, err
	}
	return cmd, nil
}

// ConfigurationDirectory resolves the configured or inherited CLI configuration home.
func ConfigurationDirectory(config model.Provider) string {
	if config.ShadowHome != "" {
		return config.ShadowHome
	}
	return baseConfigurationDirectory(config)
}

func baseConfigurationDirectory(config model.Provider) string {
	name := configVariable(config.Type)
	if name == "" {
		return ""
	}
	if config.ConfigDir != "" {
		return config.ConfigDir
	}
	if path := os.Getenv(name); path != "" {
		return path
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	if config.Type == "pi" {
		return filepath.Join(home, ".pi", "agent")
	}
	return filepath.Join(home, "."+config.Type)
}

func Executable(ctx context.Context, config model.Provider) (string, error) {
	if config.Type == "antigravity" {
		return antigravityExecutable(ctx, config)
	}
	command := config.Command
	if command == "" {
		command = config.Type
	}
	path, err := device.Executable(command)
	if err != nil && runtime.GOOS == "darwin" && command == "dsh" && os.Getenv("LEVER_DSH_PATH") == "" {
		// DeepSeek Harness can ship a CLI before the user links it into PATH.
		if bundled, err := device.Executable("/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh"); err == nil {
			return bundled, nil
		}
	}
	return path, err
}

// IsExecutableMissing reports that the runtime binary could not be located.
func IsExecutableMissing(err error) bool {
	var lookup *exec.Error
	return errors.Is(err, exec.ErrNotFound) || errors.Is(err, errAntigravityNotInstalled) ||
		(errors.As(err, &lookup) && errors.Is(lookup.Err, os.ErrNotExist))
}

type object = map[string]any

func obj(v any) object                { m, _ := v.(map[string]any); return m }
func str(v any) string                { s, _ := v.(string); return s }
func arr(v any) []any                 { a, _ := v.([]any); return a }
func decode(b []byte) (object, error) { var m object; err := json.Unmarshal(b, &m); return m, err }
func pretty(v any) string {
	if v == nil {
		return ""
	}
	b, _ := json.MarshalIndent(v, "", "  ")
	return string(b)
}
func clip(s string) string {
	const max = 128 << 10
	if len(s) > max {
		return s[:max] + "\n… output truncated"
	}
	return s
}
func fail(v any) error { return fmt.Errorf("runtime: %s", clip(pretty(v))) }
