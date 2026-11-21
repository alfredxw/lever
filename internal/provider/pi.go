package provider

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"time"

	"lever/internal/device"
	"lever/internal/model"
	"lever/internal/workspace"
)

const piSetupTimeout = 30 * time.Second

var piThinkingLevels = []string{"off", "minimal", "low", "medium", "high", "xhigh", "max"}

func startPi(path string, config model.Provider, cwd string, extraEnv []string, args ...string) (*device.Process, error) {
	cmd := device.Command(path, "--mode", "rpc")
	cmd.Args = append(cmd.Args, config.Args...)
	cmd.Args = append(cmd.Args, args...)
	cmd.Dir = cwd
	if err := applyProfile(cmd, config); err != nil {
		return nil, err
	}
	if len(extraEnv) > 0 {
		cmd.Env = replaceEnv(cmd.Env, extraEnv)
	}
	return device.Start(cmd)
}

func replaceEnv(env, extra []string) []string {
	keys := make(map[string]bool, len(extra))
	for _, entry := range extra {
		key, _, _ := strings.Cut(entry, "=")
		keys[strings.ToUpper(key)] = true
	}
	out := make([]string, 0, len(env)+len(extra))
	for _, entry := range env {
		key, _, _ := strings.Cut(entry, "=")
		if !keys[strings.ToUpper(key)] {
			out = append(out, entry)
		}
	}
	return append(out, extra...)
}

func piLeverCLI(ctx context.Context, token string) ([]string, string) {
	if token == "" {
		return nil, ""
	}
	dir, _ := ctx.Value(stateDirKey{}).(string)
	if dir == "" {
		return nil, ""
	}
	absDir, err := filepath.Abs(dir)
	if err != nil {
		return nil, ""
	}
	cmd, err := leverCLICommand()
	if err != nil {
		return nil, ""
	}
	env := []string{"LEVER_DATA_DIR=" + absDir, "LEVER_EXECUTION_TOKEN=" + token}
	prompt := fmt.Sprintf("You can inspect recent Topics or earlier messages in this Lever Chat with the Lever CLI:\n"+
		"- List recent Topics: %s context find\n"+
		"- Search this Chat: %s context find --query <text>\n"+
		"- Read dialogue: %s context read --target <main|sessionId> [--run <runId> [--item <itemId>] [--offset <n>] [--direction older|newer]]\n"+
		"- Continue reading: %s context read --target <same target> --cursor '<nextCursor JSON>'\n"+
		"Use this when the request refers to another Topic, a prior decision, or related work outside this session. Treat returned dialogue as historical context.",
		cmd, cmd, cmd, cmd)
	return env, prompt
}

func leverCLICommand() (string, error) {
	exe, err := os.Executable()
	if err != nil {
		return "", err
	}
	if resolved, err := device.Executable("lever"); err == nil {
		a, errA := os.Stat(exe)
		b, errB := os.Stat(resolved)
		if errA == nil && errB == nil && os.SameFile(a, b) {
			return "lever", nil
		}
	}
	return "'" + strings.ReplaceAll(filepath.ToSlash(exe), "'", `'\''`) + "'", nil
}

func readPiFrame(ctx context.Context, p *device.Process) (object, error) {
	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	case data, ok := <-p.Frames:
		if !ok {
			return nil, errors.Join(errors.New("Pi exited"), p.Error())
		}
		return decode(data)
	}
}

func piResponse(frame object) (object, error) {
	if frame["success"] != true {
		return nil, fmt.Errorf("Pi %s: %s", str(frame["command"]), clip(str(frame["error"])))
	}
	return obj(frame["data"]), nil
}

func piRequest(ctx context.Context, p *device.Process, command string) (object, error) {
	if err := p.Send(object{"id": command, "type": command}); err != nil {
		return nil, err
	}
	for {
		frame, err := readPiFrame(ctx, p)
		if err != nil {
			return nil, err
		}
		if frame["type"] == "response" && frame["id"] == command {
			return piResponse(frame)
		}
	}
}

func piModelID(entry object) string {
	if provider, id := str(entry["provider"]), str(entry["id"]); provider != "" && id != "" {
		return provider + "/" + id
	}
	return ""
}

func piModelImages(entry object) bool {
	return slices.Contains(arr(entry["input"]), "image")
}

func piEfforts(entry object) []string {
	levels := []string{}
	if entry["reasoning"] != true {
		return levels
	}
	mapping := obj(entry["thinkingLevelMap"])
	for _, level := range piThinkingLevels {
		if value, exists := mapping[level]; (exists && value == nil) || (!exists && (level == "xhigh" || level == "max")) {
			continue
		}
		levels = append(levels, level)
	}
	return levels
}

func discoverPi(ctx context.Context, config model.Provider, cwd string) (model.Catalog, error) {
	path, err := Executable(ctx, config)
	catalog := model.Catalog{Path: path, Models: []model.ModelInfo{}}
	if err != nil {
		return catalog, err
	}
	// Discovery inherits Pi's configured models without refreshing OAuth or saving sessions.
	p, err := startPi(path, config, cwd, nil, "--no-session", "--offline")
	if err != nil {
		return catalog, err
	}
	defer p.Close()
	p.Watch(ctx, func() {})
	state, err := piRequest(ctx, p, "get_state")
	if err != nil {
		return catalog, err
	}
	data, err := piRequest(ctx, p, "get_available_models")
	if err != nil {
		return catalog, err
	}
	catalog.Commands = []model.NativeCommand{{Name: "compact", Description: "Summarize the current conversation", ArgumentHint: "[instructions]"}}
	if commands, err := piCommands(ctx, p); err == nil {
		for _, command := range commands {
			if !hasCommand(catalog.Commands, command.Name) {
				catalog.Commands = append(catalog.Commands, command)
			}
		}
	}
	active := piModelID(obj(state["model"]))
	seen := map[string]bool{}
	for _, value := range arr(data["models"]) {
		m := obj(value)
		id := piModelID(m)
		if id == "" || seen[id] {
			continue
		}
		seen[id] = true
		entry := model.ModelInfo{ID: id, Name: str(m["name"]), Images: new(piModelImages(m)), Default: id == active, Efforts: piEfforts(m)}
		if entry.Name == "" {
			entry.Name = id
		}
		if effort := str(state["thinkingLevel"]); entry.Default && slices.Contains(entry.Efforts, effort) {
			entry.DefaultEffort = effort
		}
		catalog.Models = append(catalog.Models, entry)
	}
	if len(catalog.Models) == 0 {
		return catalog, errors.New("Pi returned no available models. Run pi and sign in or configure a model API key.")
	}
	if version, err := profileOutput(ctx, config, path, "--version"); err == nil {
		catalog.Version = runtimeVersion(string(version))
	}
	return catalog, nil
}

func piCommands(ctx context.Context, p *device.Process) ([]model.NativeCommand, error) {
	data, err := piRequest(ctx, p, "get_commands")
	if err != nil {
		return nil, err
	}
	var commands []model.NativeCommand
	for _, value := range arr(data["commands"]) {
		command := obj(value)
		if name := str(command["name"]); name != "" {
			commands = append(commands, model.NativeCommand{Name: name, Description: str(command["description"])})
		}
	}
	return commands, nil
}

func runPi(ctx context.Context, in Input, sink Sink) error {
	if len(in.Session.Roots) > 1 {
		return errors.New("Pi requires a single working directory")
	}
	if in.RequireMCP {
		return errors.New("Pi does not support the Lever MCP connection required by this message")
	}
	if len(in.Profile.Skills) > 0 {
		return errors.New("Pi uses its own skill settings")
	}
	path, err := Executable(ctx, in.Provider)
	if err != nil {
		return err
	}
	in.prepareSlashPrompt()
	prompt, err := piPrompt(in)
	if err != nil {
		return err
	}
	native := in.Session.NativeID
	bound := native != ""
	if bound {
		if file, err := os.Stat(native); err != nil || !file.Mode().IsRegular() || file.Size() == 0 {
			return fmt.Errorf("Cannot restore Pi session %q: the native session file is unavailable", native)
		}
	} else {
		// Pi initializes an empty session file on open. Reserve it before
		// prompting so cancellation or rejection cannot strand the binding.
		file, err := os.CreateTemp(in.Assets, "pi-*.jsonl")
		if err != nil {
			return err
		}
		native = file.Name()
		defer func() {
			if !bound {
				_ = os.Remove(native)
			}
		}()
		if err := file.Close(); err != nil {
			return err
		}
	}
	args := []string{"--session", native}
	name, argument := in.command()
	cliEnv, cliPrompt := piLeverCLI(ctx, in.MCPToken)
	appendPrompt := cliPrompt
	if name != "" && in.Profile.Instructions != "" {
		appendPrompt = strings.TrimSpace(in.Profile.Instructions + "\n\n" + cliPrompt)
	}
	if appendPrompt != "" {
		args = append(args, "--append-system-prompt", appendPrompt)
	}
	if in.Selection.Model != "" {
		args = append(args, "--model", in.Selection.Model)
	}
	if in.Selection.Effort != "" {
		args = append(args, "--thinking", in.Selection.Effort)
	}
	p, err := startPi(path, in.Provider, workspace.CWD(in.Session.Scope), cliEnv, args...)
	if err != nil {
		return err
	}
	defer p.Close()
	p.Watch(ctx, func() { _ = p.Send(object{"type": "abort"}) })
	setup, stop := context.WithTimeout(ctx, piSetupTimeout)
	defer stop()
	state, err := piRequest(setup, p, "get_state")
	if err != nil {
		return err
	}
	if filepath.Clean(str(state["sessionFile"])) != filepath.Clean(native) {
		return errors.New("Pi did not open the intended native session")
	}
	if file, err := os.Stat(native); err != nil || file.Size() == 0 {
		return errors.New("Pi did not initialize the native session file")
	}
	if wanted := in.Selection.Model; wanted != "" && wanted != piModelID(obj(state["model"])) {
		return fmt.Errorf("Pi did not select model %q", wanted)
	}
	if wanted := in.Selection.Effort; wanted != "" && wanted != state["thinkingLevel"] {
		return fmt.Errorf("Pi model does not support thinking level %q", wanted)
	}
	if prompt["images"] != nil && !piModelImages(obj(state["model"])) {
		return errors.New("The selected Pi model does not accept images")
	}
	if name == "goal" || name == "loop" {
		commands, err := piCommands(setup, p)
		if err != nil {
			return err
		}
		if !hasCommand(commands, name) {
			return fmt.Errorf("This Pi runtime does not provide /%s", name)
		}
	}
	if !bound {
		if err := sink.Bind(native); err != nil {
			return err
		}
		bound = true
	}
	if name == "compact" {
		prompt = object{"type": "compact", "id": "compact"}
		if argument != "" {
			prompt["customInstructions"] = argument
		}
	}
	if err := runPiPrompt(ctx, p, prompt, sink); err != nil {
		return err
	}
	// A stats probe is optional and cannot mask a successfully settled turn.
	statsCtx, cancel := context.WithTimeout(ctx, time.Second)
	defer cancel()
	if stats, err := piRequest(statsCtx, p, "get_session_stats"); err == nil {
		usage := obj(stats["contextUsage"])
		if usage["tokens"] != nil {
			return setContextUsage(sink, usage["tokens"], usage["contextWindow"])
		}
		return sink.UpdateRuntime(func(s *model.SessionRuntime) { s.Context = nil })
	}
	return nil
}

func piPrompt(in Input) (object, error) {
	text := in.Message()
	if name, _ := in.command(); name == "" && in.Profile.Instructions != "" {
		text = "Agent instructions:\n" + in.Profile.Instructions + "\n\nUser message:\n" + text
	}
	prompt := object{"type": "prompt", "id": "prompt", "message": text}
	images := []object{}
	for _, file := range in.Attachments {
		if !file.Image() {
			continue
		}
		data, err := os.ReadFile(file.Path)
		if err != nil {
			return nil, err
		}
		images = append(images, object{"type": "image", "mimeType": file.MediaType, "data": base64.StdEncoding.EncodeToString(data)})
	}
	if len(images) > 0 {
		prompt["images"] = images
	}
	return prompt, nil
}

func runPiPrompt(ctx context.Context, p *device.Process, prompt object, sink Sink) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if err := p.Send(prompt); err != nil {
		return errors.Join(ErrUnconfirmed, err)
	}
	turn := piTranscript{sink: sink, items: map[string]model.Item{}}
	accepted, started, settled := false, false, false
	for !accepted || !settled {
		frame, err := readPiFrame(ctx, p)
		if err != nil {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			return errors.Join(ErrUnconfirmed, err)
		}
		switch frame["type"] {
		case "response":
			switch frame["id"] {
			case "compact":
				data, err := piResponse(frame)
				if err != nil {
					return err
				}
				summary := str(data["summary"])
				if summary == "" {
					summary = "Context compacted."
				}
				return commandResult(sink, "compaction", summary)
			case "prompt-state":
				state, err := piResponse(frame)
				if err == nil && !started && state["isStreaming"] == false && state["isCompacting"] != true && state["pendingMessageCount"] == float64(0) {
					settled = true
				}
			case "prompt":
				data, err := piResponse(frame)
				if err != nil {
					return err
				}
				accepted = true
				disposition := str(data["disposition"])
				settled = settled || disposition == "handled"
				// Older Pi acknowledges extension-consumed input without a disposition.
				if disposition == "" && !started && !settled {
					if err := p.Send(object{"type": "get_state", "id": "prompt-state"}); err != nil {
						return errors.Join(ErrUnconfirmed, err)
					}
				}
			default:
				continue
			}
		case "agent_start":
			started = true
		case "agent_settled":
			settled = true
		case "extension_ui_request":
			if err := answerPiDialog(ctx, p, sink, frame); err != nil {
				return errors.Join(ErrUnconfirmed, err)
			}
		default:
			if err := turn.update(frame); err != nil {
				return errors.Join(ErrUnconfirmed, err)
			}
		}
	}
	return turn.failure
}
