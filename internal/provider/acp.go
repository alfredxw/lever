package provider

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"time"

	acp "github.com/coder/acp-go-sdk"
	"lever/internal/device"
	"lever/internal/model"
	"lever/internal/workspace"
)

// The SDK owns JSON-RPC framing, ordering and cancellation. Lever offers no
// filesystem or terminal callbacks: the agent retains its own tool execution.
type acpRuntime struct {
	conn          *acp.Connection
	process       *device.Process
	initial       acp.InitializeResponse
	sink          Sink
	ctx           context.Context
	cancel        context.CancelFunc
	mu            sync.Mutex
	cwd           string
	antigravity   bool
	session       acp.SessionId
	active        bool
	modeTouched   bool
	promptStarted chan struct{}
	agyCLI        bool
	commands      map[acp.SessionId][]model.NativeCommand
	skillCommands map[string]bool
	commandUpdate chan struct{}
	background    *antigravityBackground
	interruptDone <-chan struct{}
	items         map[string]model.Item
	tools         map[string]*acpToolState
	subagents     map[string]*subagent
	textID        string
	textMessageID string
	nextMsg       int
	err           error
	output        *antigravityOutput
	preset        *antigravityPreset
	cleanup       func()
	dshFlash      bool
}

// Models is the v1 model-selection shape still emitted by existing ACP agents.
// Newer agents use the standard model/thought_level configuration categories.
type acpState struct {
	SessionID     acp.SessionId             `json:"sessionId"`
	Modes         *acp.SessionModeState     `json:"modes"`
	ConfigOptions []acp.SessionConfigOption `json:"configOptions"`
	Models        *struct {
		CurrentModelID  string `json:"currentModelId"`
		AvailableModels []struct {
			ModelID string `json:"modelId"`
			Name    string `json:"name"`
		} `json:"availableModels"`
	} `json:"models"`
}

func openACP(ctx context.Context, config model.Provider, cwd string, sink Sink, permission string) (*acpRuntime, error) {
	if config.PluginID == "lever.dsh" && slices.Equal(config.Args, []string{"--profile", "acp"}) {
		return openDSH(ctx, config, cwd, sink)
	}
	return openACPWithAuth(ctx, config, cwd, sink, nil, permission)
}

func openACPWithAuth(ctx context.Context, config model.Provider, cwd string, sink Sink, onURL func(string), permission string) (*acpRuntime, error) {
	c, retryWithoutPPS, err := openACPOptions(ctx, config, cwd, sink, onURL, permission, true)
	if err != nil && retryWithoutPPS && ctx.Err() == nil {
		c, _, err = openACPOptions(ctx, config, cwd, sink, onURL, permission, false)
	}
	return c, err
}

func openACPOptions(ctx context.Context, config model.Provider, cwd string, sink Sink, onURL func(string), permission string, processPerSession bool) (*acpRuntime, bool, error) {
	path, err := Executable(ctx, config)
	if err != nil {
		return nil, false, err
	}
	ctx, cancel := context.WithCancel(ctx)
	c := &acpRuntime{
		ctx:           ctx,
		cancel:        cancel,
		sink:          sink,
		cwd:           cwd,
		antigravity:   config.Type == "antigravity",
		agyCLI:        IsAntigravityCLI(config, path) && (config.Type == "antigravity" || slices.Contains(config.Args, "acp")),
		items:         map[string]model.Item{},
		tools:         map[string]*acpToolState{},
		subagents:     map[string]*subagent{},
		commands:      make(map[acp.SessionId][]model.NativeCommand),
		commandUpdate: make(chan struct{}, 1),
	}
	cmd := device.Command(path, config.Args...)
	cmd.Dir = cwd
	if config.Type == "antigravity" {
		nativeCLI := IsAntigravityCLI(config, path)
		c.background = newAntigravityBackground()
		if nativeCLI {
			c.preset = antigravityCLIPreset(permission)
		}
		cmd, c.cleanup, err = antigravityCommand(ctx, config, path, cwd, c.preset, processPerSession)
		if err != nil {
			cancel()
			return nil, false, err
		}
		c.output = &antigravityOutput{onURL: onURL, cancel: cancel, nativeCLI: nativeCLI}
		cmd.Stderr = c.output
	}
	c.process, err = device.StartProtocol(cmd, func(w io.Writer, r io.Reader) <-chan struct{} {
		if c.output != nil {
			r = c.output.stdout(r)
		}
		c.conn = acp.NewConnection(c.handle, w, r)
		return c.conn.Done()
	})
	if err != nil {
		cancel()
		if c.cleanup != nil {
			c.cleanup()
		}
		return nil, false, err
	}
	interruptDone := make(chan struct{})
	c.interruptDone = interruptDone
	c.process.Watch(ctx, func() {
		defer close(interruptDone)
		c.mu.Lock()
		session := c.session
		c.mu.Unlock()
		if session != "" {
			interrupt, stop := context.WithTimeout(context.Background(), time.Second)
			defer stop()
			_ = c.conn.SendNotification(interrupt, "session/cancel", acp.CancelNotification{SessionId: session})
		}
	})
	timeout := setupTimeout(config)
	if onURL != nil {
		timeout = 5 * time.Minute
	}
	initCtx, stop := context.WithTimeout(ctx, timeout)
	defer stop()
	c.initial, err = acp.SendRequest[acp.InitializeResponse](c.conn, initCtx, "initialize", acp.InitializeRequest{ProtocolVersion: acp.ProtocolVersionNumber, ClientInfo: &acp.Implementation{Name: "lever", Version: "0.1.0"}})
	if err == nil && c.initial.ProtocolVersion != acp.ProtocolVersionNumber {
		err = fmt.Errorf("Unsupported ACP protocol version: %d (Lever supports v1)", c.initial.ProtocolVersion)
	}
	if err == nil && config.Type == "antigravity" && !IsAntigravityCLI(config, path) {
		err = c.conn.SendRequestNoResult(initCtx, "authenticate", object{"methodId": antigravityAuthMethod(config)})
	}
	if err != nil {
		c.close()
		retryWithoutPPS := processPerSession && c.output != nil && c.output.failure(nil) == nil && c.output.processPerSessionUnsupported()
		return nil, retryWithoutPPS, c.failure(err)
	}
	return c, false, nil
}

func (c *acpRuntime) close() {
	defer c.cancel()
	if c.background != nil && c.ctx.Err() != nil {
		timer := time.NewTimer(time.Second)
		defer timer.Stop()
		select {
		case <-c.interruptDone:
		case <-c.conn.Done():
		case <-timer.C:
		}
	}
	if c.output != nil && c.output.reader != nil {
		_ = c.output.reader.Close()
	}
	c.process.Close()
	if c.cleanup != nil {
		c.cleanup()
	}
}

func (c *acpRuntime) failure(err error) error {
	if c.output != nil {
		return c.output.failure(err)
	}
	return err
}

func (c *acpRuntime) capabilities() model.ProviderCapabilities {
	a := c.initial.AgentCapabilities
	return model.ProviderCapabilities{Steering: c.steerMethod() != "", Images: a.PromptCapabilities.Image, Audio: a.PromptCapabilities.Audio, Files: true, FileLinksOnly: !a.PromptCapabilities.EmbeddedContext, MultiRoot: a.SessionCapabilities.AdditionalDirectories != nil, MCP: true, Resume: a.LoadSession || a.SessionCapabilities.Resume != nil}
}

func acpDirectoryContext(caps model.ProviderCapabilities) bool {
	return !caps.MultiRoot && caps.Files
}

func (c *acpRuntime) sessionState(ctx context.Context, cwd, native string, directories []string, servers []acp.McpServer) (acpState, error) {
	if servers == nil {
		servers = []acp.McpServer{}
	}
	var meta map[string]any
	if c.output != nil && c.initial.AgentInfo != nil {
		switch c.initial.AgentInfo.Version {
		case "1.4.2", "1.4.3", "1.4.4", "1.4.5":
			// These versions otherwise write a system skill into the workspace.
			meta = object{"antigravity": object{"disabledTools": []string{"run_workflow"}}}
		}
	}
	if native == "" {
		return acp.SendRequest[acpState](c.conn, ctx, "session/new", acp.NewSessionRequest{Meta: meta, Cwd: cwd, AdditionalDirectories: directories, McpServers: servers})
	}
	c.mu.Lock()
	c.session = acp.SessionId(native)
	c.mu.Unlock()
	if c.initial.AgentCapabilities.SessionCapabilities.Resume != nil {
		return acp.SendRequest[acpState](c.conn, ctx, "session/resume", acp.ResumeSessionRequest{Meta: meta, SessionId: acp.SessionId(native), Cwd: cwd, AdditionalDirectories: directories, McpServers: servers})
	}
	if !c.initial.AgentCapabilities.LoadSession {
		return acpState{}, errors.New("This ACP runtime cannot restore native sessions")
	}
	// Replay from session/load is suppressed until Prompt begins. Lever already
	// owns its visible history and must not append that replay to the new run.
	return acp.SendRequest[acpState](c.conn, ctx, "session/load", acp.LoadSessionRequest{Meta: meta, SessionId: acp.SessionId(native), Cwd: cwd, AdditionalDirectories: directories, McpServers: servers})
}

func acpChoices(option *acp.SessionConfigOptionSelect) []acp.SessionConfigSelectOption {
	if option.Options.Ungrouped != nil {
		return []acp.SessionConfigSelectOption(*option.Options.Ungrouped)
	}
	var out []acp.SessionConfigSelectOption
	if option.Options.Grouped != nil {
		for _, group := range *option.Options.Grouped {
			out = append(out, group.Options...)
		}
	}
	return out
}

func (state acpState) option(category acp.SessionConfigOptionCategory) *acp.SessionConfigOptionSelect {
	for _, option := range state.ConfigOptions {
		if s := option.Select; s != nil && ((s.Category != nil && *s.Category == category) || (s.Category == nil && string(s.Id) == string(category))) {
			return s
		}
	}
	return nil
}

func (state acpState) catalog() model.Catalog {
	catalog := model.Catalog{Models: []model.ModelInfo{}, Permissions: []model.PermissionInfo{}}
	efforts, defaultEffort := []string{}, ""
	if option := state.option(acp.SessionConfigOptionCategoryThoughtLevel); option != nil {
		defaultEffort = string(option.CurrentValue)
		for _, value := range acpChoices(option) {
			efforts = append(efforts, string(value.Value))
		}
	}
	if option := state.option(acp.SessionConfigOptionCategoryModel); option != nil {
		for _, value := range acpChoices(option) {
			catalog.Models = append(catalog.Models, model.ModelInfo{ID: string(value.Value), Name: value.Name, Default: value.Value == option.CurrentValue, Efforts: efforts, DefaultEffort: defaultEffort})
		}
	} else if state.Models != nil {
		for _, value := range state.Models.AvailableModels {
			catalog.Models = append(catalog.Models, model.ModelInfo{ID: value.ModelID, Name: value.Name, Default: value.ModelID == state.Models.CurrentModelID, Efforts: efforts, DefaultEffort: defaultEffort})
		}
	}
	if len(catalog.Models) == 0 {
		catalog.Models = append(catalog.Models, model.ModelInfo{Name: "Default", Default: true, Efforts: efforts, DefaultEffort: defaultEffort})
	}
	if option := state.option(acp.SessionConfigOptionCategoryMode); option != nil {
		catalog.DefaultPermission = string(option.CurrentValue)
		for _, value := range acpChoices(option) {
			catalog.Permissions = append(catalog.Permissions, model.PermissionInfo{ID: string(value.Value), Name: value.Name, Description: value.Description})
		}
	} else if state.Modes != nil {
		catalog.DefaultPermission = string(state.Modes.CurrentModeId)
		for _, value := range state.Modes.AvailableModes {
			catalog.Permissions = append(catalog.Permissions, model.PermissionInfo{ID: string(value.Id), Name: value.Name, Description: value.Description})
		}
	}
	return catalog
}

func discoverACP(ctx context.Context, config model.Provider, cwd string) (model.Catalog, error) {
	if config.Type == "antigravity" {
		// Catalog access is account-scoped. Do not run project hooks or create
		// native skill placeholders in the user's workspace while probing.
		probe, err := antigravityProbeDir(ctx)
		if err != nil {
			return model.Catalog{}, err
		}
		cwd = probe
		defer os.RemoveAll(probe)
	}
	c, err := openACP(ctx, config, cwd, nil, "")
	if err != nil {
		return model.Catalog{}, err
	}
	var state acpState
	defer func() {
		if state.SessionID != "" && c.initial.AgentCapabilities.SessionCapabilities.Close != nil {
			closeCtx, stop := context.WithTimeout(context.Background(), 2*time.Second)
			_ = c.conn.SendRequestNoResult(closeCtx, "session/close", acp.CloseSessionRequest{SessionId: state.SessionID})
			stop()
		}
		c.close()
		if config.Type == "antigravity" {
			removeAntigravityProbe(ctx, config, string(state.SessionID), cwd)
		}
	}()
	state, err = c.sessionState(ctx, cwd, "", nil, []acp.McpServer{})
	if err != nil {
		return model.Catalog{}, c.failure(err)
	}
	c.mu.Lock()
	c.session = state.SessionID
	c.mu.Unlock()
	catalog := state.catalog()
	if c.dshFlash {
		addDSHFlashAlias(&catalog)
	}
	if config.Type == "antigravity" {
		if len(catalog.Models) == 1 && catalog.Models[0].ID == "" {
			return model.Catalog{}, errors.New("Antigravity returned no available models. Check this Google account's access.")
		}
		// Thinking levels are model-specific. Read each model's actual options
		// instead of advertising the default model's levels for every model.
		var original model.Selection
		for _, entry := range catalog.Models {
			if entry.Default {
				original.Model, original.Effort = entry.ID, entry.DefaultEffort
			}
		}
		for i := range catalog.Models {
			entry := &catalog.Models[i]
			if err := c.applySelection(ctx, &state, model.Selection{Model: entry.ID}); err != nil {
				return model.Catalog{}, err
			}
			current := state.catalog()
			for _, m := range current.Models {
				if m.Default {
					entry.Efforts, entry.DefaultEffort = m.Efforts, m.DefaultEffort
				}
			}
		}
		if original.Model != "" {
			if err := c.applySelection(ctx, &state, original); err != nil {
				return model.Catalog{}, err
			}
		}
	}
	catalog.Capabilities = c.capabilities()
	catalog.Commands = c.initialCommands(ctx, state.SessionID)
	catalog.Path, _ = Executable(ctx, config)
	if c.initial.AgentInfo != nil {
		catalog.Version = c.initial.AgentInfo.Version
	}
	return catalog, nil
}

func (c *acpRuntime) applySelection(ctx context.Context, state *acpState, selection model.Selection) error {
	if c.dshFlash {
		current := state.option(acp.SessionConfigOptionCategoryModel)
		if selection.Model == dshLegacyFlashModel || (selection.Model == "" && current != nil && current.CurrentValue == dshLegacyFlashModel) {
			selection.Model = dshFlashModel
		}
	}
	for _, change := range []struct {
		category acp.SessionConfigOptionCategory
		value    string
	}{
		{acp.SessionConfigOptionCategoryModel, selection.Model}, {acp.SessionConfigOptionCategoryThoughtLevel, selection.Effort}, {acp.SessionConfigOptionCategoryMode, selection.Permission},
	} {
		if change.value == "" {
			continue
		}
		if option := state.option(change.category); option != nil {
			if !slices.ContainsFunc(acpChoices(option), func(value acp.SessionConfigSelectOption) bool { return string(value.Value) == change.value }) {
				// ACP v1 only advertises thought_level for the initial model during discovery.
				// Fall back to the active model's default when it accepts a narrower set.
				if change.category == acp.SessionConfigOptionCategoryThoughtLevel {
					continue
				}
				return fmt.Errorf("Unsupported ACP %s: %s", change.category, change.value)
			}
			if string(option.CurrentValue) == change.value {
				continue
			}
			updated, err := acp.SendRequest[acp.SetSessionConfigOptionResponse](c.conn, ctx, "session/set_config_option", object{"sessionId": c.session, "configId": option.Id, "value": change.value})
			if err != nil {
				return err
			}
			if updated.ConfigOptions != nil {
				state.ConfigOptions = updated.ConfigOptions
			}
			if change.category == acp.SessionConfigOptionCategoryMode {
				if option := state.option(change.category); option == nil || string(option.CurrentValue) != change.value {
					return errors.New("ACP runtime did not apply the selected permission mode")
				}
			}
			continue
		}
		switch change.category {
		case acp.SessionConfigOptionCategoryMode:
			if state.Modes == nil || !slices.ContainsFunc(state.Modes.AvailableModes, func(mode acp.SessionMode) bool { return string(mode.Id) == change.value }) {
				return fmt.Errorf("Unsupported ACP permission mode: %s", change.value)
			}
			if string(state.Modes.CurrentModeId) != change.value {
				if err := c.conn.SendRequestNoResult(ctx, "session/set_mode", acp.SetSessionModeRequest{SessionId: c.session, ModeId: acp.SessionModeId(change.value)}); err != nil {
					return err
				}
				state.Modes.CurrentModeId = acp.SessionModeId(change.value)
			}
		case acp.SessionConfigOptionCategoryModel:
			if state.Models != nil && state.Models.CurrentModelID == change.value {
				continue
			}
			if err := c.conn.SendRequestNoResult(ctx, "session/set_model", object{"sessionId": c.session, "modelId": change.value}); err != nil {
				return err
			}
			if state.Models != nil {
				state.Models.CurrentModelID = change.value
			}
		case acp.SessionConfigOptionCategoryThoughtLevel:
			// The active model does not expose a thought_level option; keep its default.
			continue
		default:
			return errors.New("This ACP runtime does not offer reasoning effort configuration")
		}
	}
	return nil
}

func runACP(ctx context.Context, in Input, sink Sink) error {
	cwd := workspace.CWD(in.Session.Scope)
	if isTraeCLI(in.Provider) {
		in.Provider.Args = traeSkillArguments(in.Provider.Args, in.Skills)
	}
	c, err := openACP(ctx, in.Provider, cwd, sink, in.Selection.Permission)
	if err != nil {
		return err
	}
	defer c.close()
	caps := c.capabilities()
	if in.Steers != nil {
		state := SteerUnavailable
		if caps.Steering {
			state = SteerPending
		}
		if err := sink.SetSteerState(state); err != nil {
			return err
		}
	}
	if len(in.Profile.Skills) > 0 && !acpSkillContext(in.Provider) {
		return errors.New("This ACP runtime does not support Agent skill directories")
	}
	directories := additionalDirectories(in.Session.Scope)
	var contextDirectories []string
	if acpDirectoryContext(caps) {
		contextDirectories, directories = directories, nil
	}
	if c.agyCLI && caps.MultiRoot && in.Skills.AntigravityCatalogRoot != "" {
		directories = append(directories, in.Skills.AntigravityCatalogRoot)
	}
	if caps.MultiRoot && in.Skills.AntigravityRoot != "" {
		directories = append(directories, in.Skills.AntigravityRoot)
		c.mu.Lock()
		c.skillCommands = make(map[string]bool, len(in.Skills.AntigravitySkills))
		for _, name := range in.Skills.AntigravitySkills {
			c.skillCommands[name] = true
		}
		c.mu.Unlock()
	}
	servers := []acp.McpServer{}
	if in.MCPURL != "" {
		if c.initial.AgentCapabilities.McpCapabilities.Http {
			servers = append(servers, acp.McpServer{Http: &acp.McpServerHttpInline{Name: "lever", Url: in.MCPURL, Headers: []acp.HttpHeader{{Name: "Authorization", Value: "Bearer " + in.MCPToken}}}})
		} else {
			stdio, err := mcpStdioServer(in.MCPURL, in.MCPToken)
			if err != nil {
				return err
			}
			servers = append(servers, stdio)
		}
	} else if in.RequireMCP {
		return errors.New("This ACP runtime does not support the MCP connection required by this message")
	}
	setup, stop := context.WithTimeout(c.ctx, setupTimeout(in.Provider))
	defer stop()
	state, err := c.sessionState(setup, cwd, in.Session.NativeID, directories, servers)
	if err != nil {
		return c.failure(err)
	}
	native := in.Session.NativeID
	if native == "" {
		native = string(state.SessionID)
	} else if state.SessionID != "" && string(state.SessionID) != native {
		return errors.New("ACP runtime restored a different native session")
	}
	if native == "" {
		return errors.New("ACP runtime returned an empty native session ID")
	}
	c.mu.Lock()
	c.session = acp.SessionId(native)
	c.mu.Unlock()
	if caps.Resume {
		if err = sink.Bind(native); err != nil {
			return err
		}
	}
	selection := in.Selection
	if c.preset != nil {
		selection.Permission = c.preset.nativeMode
	}
	if err = c.applySelection(setup, &state, selection); err != nil {
		return err
	}
	name, argument := in.command()
	var advertised []model.NativeCommand
	if name != "" || (caps.MultiRoot && len(in.Skills.AntigravitySkills) > 0) {
		advertised = c.initialCommands(setup, c.session)
		if name != "" && advertised == nil && in.Session.Runtime != nil && in.Session.Runtime.Commands != nil {
			advertised = *in.Session.Runtime.Commands
		}
	}
	nativeCommand := hasCommand(advertised, name)
	if !nativeCommand && (name == "goal" || name == "loop" || name == "compact") {
		return fmt.Errorf("This ACP session does not advertise /%s", name)
	}
	if nativeCommand && in.Provider.Type == "antigravity" && name == "goal" && (argument == "" || slices.Contains([]string{"pause", "resume", "clear", "edit", "status", "show"}, strings.ToLower(argument))) {
		return errors.New("Antigravity /goal requires an objective")
	}
	prompt, err := acpPrompt(in, caps, advertised)
	if err != nil {
		return err
	}
	if nativeCommand {
		prompt[0] = acp.TextBlock(strings.TrimSpace(in.Text))
	} else if in.Skills.Context != "" {
		prompt = append(prompt, acp.TextBlock("\n\n"+in.Skills.Context))
	}
	if !nativeCommand && caps.FileLinksOnly {
		for _, path := range contextDirectories {
			prompt = append(prompt, acp.ResourceLinkBlock(filepath.Base(path), acpFileURI(path)))
		}
	} else if !nativeCommand && len(contextDirectories) > 0 {
		prompt = append(prompt, acp.ResourceBlock(acp.EmbeddedResourceResource{
			TextResourceContents: &acp.TextResourceContents{
				Uri:      "lever://workspace/additional-directories",
				MimeType: new("application/json"),
				Text:     pretty(object{"additionalDirectories": contextDirectories}),
			},
		}))
	}
	c.mu.Lock()
	c.active = true
	if commands, ok := c.commands[c.session]; ok {
		err = c.publishCommands(commands)
	}
	c.mu.Unlock()
	if err != nil {
		return err
	}
	if c.preset == nil && (state.option(acp.SessionConfigOptionCategoryMode) != nil || state.Modes != nil) {
		sink.EnablePermissionChanges(func(ctx context.Context, permission string) error {
			c.mu.Lock()
			active := c.active
			if active {
				c.modeTouched = true
			}
			c.mu.Unlock()
			if !active {
				return errors.New("The ACP prompt is no longer active")
			}
			if c.output != nil && c.output.nativeCLI && antigravityCLIPreset(permission) != nil {
				return errors.New("Antigravity permission presets take effect on the next turn")
			}
			err := c.applySelection(ctx, &state, model.Selection{Permission: permission})
			if err != nil && ctx.Err() != nil {
				return errors.Join(ErrUnconfirmed, err)
			}
			return err
		})
	}
	var outcome func(acp.StopReason) error
	if in.Provider.Type == "antigravity" {
		sessionDB := openAntigravitySessionDB(c.ctx, in.Provider, native)
		outcome = watchAntigravityOutcomeDB(c.ctx, sessionDB)
		if c.background != nil {
			c.mu.Lock()
			c.background.probe = sessionDB.watchBackground()
			c.background.childProbe = sessionDB.watchSubagents(native)
			c.mu.Unlock()
		}
	}
	err = c.prompt(ctx, prompt, outcome, in.Steers)
	var checkpoint *antigravityAuthCheckpoint
	if errors.As(err, &checkpoint) && c.agyCLI && caps.Resume && name == "" && c.canContinueAfterAuthFailure() {
		checkpoint.native = native
	}
	return err
}

func (c *acpRuntime) prompt(ctx context.Context, prompt []acp.ContentBlock, outcome func(acp.StopReason) error, steers <-chan struct{}) error {
	result, err := c.runPrompts(prompt, steers)
	c.mu.Lock()
	if c.err == nil && err == nil {
		c.err = c.finishMessage()
	}
	outputErr := c.err
	c.active = false
	c.mu.Unlock()
	if outputErr != nil {
		return outputErr
	}
	if ctx.Err() != nil {
		return ctx.Err()
	}
	if err != nil {
		if errors.Is(err, ErrUnconfirmed) {
			return err
		}
		select {
		case <-c.conn.Done():
			return errors.Join(ErrUnconfirmed, err)
		default:
			return err
		}
	}
	if outcome != nil {
		if err := outcome(result.StopReason); err != nil {
			return err
		}
	}
	switch result.StopReason {
	case acp.StopReasonEndTurn, acp.StopReasonRefusal:
		return nil
	case acp.StopReasonCancelled:
		return context.Canceled
	default:
		return fmt.Errorf("ACP turn stopped before completion: %s", result.StopReason)
	}
}

func acpPrompt(in Input, caps model.ProviderCapabilities, advertised []model.NativeCommand) ([]acp.ContentBlock, error) {
	var skills []string
	if caps.MultiRoot && len(in.Skills.AntigravitySkills) > 0 {
		refs := make([]model.Reference, 0, len(in.References))
		for _, ref := range in.References {
			name := in.Skills.AntigravitySkills[ref.Path]
			if ref.Kind == "skill" && hasCommand(advertised, name) {
				if !slices.Contains(skills, "/"+name) {
					skills = append(skills, "/"+name)
				}
			} else {
				refs = append(refs, ref)
			}
		}
		in.References = refs
	}
	text := in.Message()
	if in.Profile.Instructions != "" {
		text = "Agent instructions:\n" + in.Profile.Instructions + "\n\nUser message:\n" + text
	}
	// Antigravity expands consecutive skill commands only at the start of
	// the first text block, before Agent instructions and handoff history.
	if len(skills) > 0 {
		text = strings.Join(skills, " ") + " " + text
	}
	prompt := []acp.ContentBlock{acp.TextBlock(text)}
	for _, file := range in.Attachments {
		mediaType := strings.ToLower(strings.TrimSpace(strings.SplitN(file.MediaType, ";", 2)[0]))
		if mediaType == "audio/wave" || mediaType == "audio/x-wav" {
			mediaType = "audio/wav"
		}
		audioFile := strings.HasPrefix(mediaType, "audio/") && mediaType != "audio/*" && mediaType != "audio/"
		audio := audioFile && caps.Audio
		if in.Provider.Type == "antigravity" && audio {
			switch mediaType {
			case "audio/aac", "audio/flac", "audio/mp3", "audio/mpeg", "audio/mp4", "audio/m4a", "audio/x-m4a", "audio/ogg", "audio/wav", "audio/webm":
			default:
				audio = false
			}
		}
		if file.Image() || audio {
			if file.Image() && !caps.Images {
				return nil, errors.New("This ACP runtime does not accept images")
			}
			data, err := os.ReadFile(file.Path)
			if err != nil {
				return nil, err
			}
			encoded := base64.StdEncoding.EncodeToString(data)
			if audio {
				prompt = append(prompt, acp.AudioBlock(encoded, mediaType))
			} else {
				prompt = append(prompt, acp.ImageBlock(encoded, file.MediaType))
			}
		} else {
			fileCaps := caps
			fileCaps.FileLinksOnly = caps.FileLinksOnly || audioFile
			block, err := acpResource(file.Path, file.Name, file.MediaType, fileCaps)
			if err != nil {
				return nil, err
			}
			prompt = append(prompt, block)
		}
	}
	// The handoff already carries an inline history tail and a local path.
	if in.History != "" && caps.Files {
		block, err := acpResource(in.History, filepath.Base(in.History), "application/x-ndjson", caps)
		if err != nil {
			return nil, err
		}
		prompt = append(prompt, block)
	}
	return prompt, nil
}

func acpFileURI(path string) string {
	return (&url.URL{Scheme: "file", Path: "/" + strings.TrimPrefix(filepath.ToSlash(path), "/")}).String()
}

func acpResource(path, name, mediaType string, caps model.ProviderCapabilities) (acp.ContentBlock, error) {
	if !caps.Files {
		return acp.ContentBlock{}, errors.New("This ACP runtime does not accept embedded files")
	}
	uri := acpFileURI(path)
	if caps.FileLinksOnly {
		block := acp.ResourceLinkBlock(name, uri)
		block.ResourceLink.MimeType = &mediaType
		return block, nil
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return acp.ContentBlock{}, err
	}
	if strings.HasPrefix(mediaType, "text/") || mediaType == "application/json" || mediaType == "application/x-ndjson" {
		return acp.ContentBlock{Resource: &acp.ContentBlockResource{Resource: acp.EmbeddedResourceResource{TextResourceContents: &acp.TextResourceContents{Uri: uri, MimeType: &mediaType, Text: string(data)}}}}, nil
	}
	return acp.ContentBlock{Resource: &acp.ContentBlockResource{Resource: acp.EmbeddedResourceResource{BlobResourceContents: &acp.BlobResourceContents{Uri: uri, MimeType: &mediaType, Blob: base64.StdEncoding.EncodeToString(data)}}}}, nil
}

func (c *acpRuntime) handle(ctx context.Context, method string, raw json.RawMessage) (any, *acp.RequestError) {
	switch method {
	case "session/request_permission":
		var params acp.RequestPermissionRequest
		if err := json.Unmarshal(raw, &params); err != nil {
			return nil, acp.NewInvalidParams(err.Error())
		}
		c.mu.Lock()
		active := c.active && params.SessionId == c.session
		var finishErr error
		if active && c.sink != nil && len(params.Options) > 0 {
			finishErr = c.finishMessage()
			if finishErr == nil && c.background != nil {
				c.background.startRequest()
				defer c.finishAntigravityRequest()
			}
		}
		c.mu.Unlock()
		cancelled := acp.RequestPermissionResponse{Outcome: acp.RequestPermissionOutcome{Cancelled: &acp.RequestPermissionOutcomeCancelled{}}}
		if finishErr != nil {
			c.mu.Lock()
			c.err = finishErr
			c.mu.Unlock()
			c.cancel()
			return cancelled, nil
		}
		if !active || c.sink == nil || len(params.Options) == 0 {
			return cancelled, nil
		}
		request := model.Request{Kind: "approval", Title: "Tool permission", Detail: pretty(params.ToolCall), Questions: []model.Question{}}
		if c.output != nil && strings.HasPrefix(string(params.ToolCall.ToolCallId), "interaction_") {
			request.Kind, request.Title = "question", "Choose an option"
		}
		if params.ToolCall.Title != nil {
			request.Title = *params.ToolCall.Title
		}
		for _, option := range params.Options {
			request.Options = append(request.Options, model.RequestOption{ID: string(option.OptionId), Name: option.Name, Allow: option.Kind == acp.PermissionOptionKindAllowOnce || option.Kind == acp.PermissionOptionKindAllowAlways})
			if request.Kind == "approval" && request.AllowOnce == nil && option.Kind == acp.PermissionOptionKindAllowOnce {
				request.AllowOnce = &model.Answer{Allow: true, Answers: map[string][]string{}, OptionID: string(option.OptionId)}
			}
		}
		answer, err := c.sink.Ask(ctx, request)
		if err != nil {
			if c.ctx.Err() != nil {
				return cancelled, nil
			}
			select {
			case <-c.conn.Done():
				err = fmt.Errorf("%w: runtime disconnected during approval", ErrUnconfirmed)
			default:
				if ctx.Err() != nil {
					return cancelled, nil
				}
			}
			c.mu.Lock()
			c.err = err
			c.mu.Unlock()
			c.cancel()
			return cancelled, nil
		}
		if answer.OptionID == "" {
			return cancelled, nil
		}
		for _, option := range params.Options {
			if string(option.OptionId) == answer.OptionID {
				return acp.RequestPermissionResponse{Outcome: acp.RequestPermissionOutcome{Selected: &acp.RequestPermissionOutcomeSelected{OptionId: option.OptionId}}}, nil
			}
		}
		return nil, acp.NewInvalidParams("Unknown permission option")
	case "session/update":
		var update acp.SessionNotification
		if err := json.Unmarshal(raw, &update); err != nil {
			return nil, acp.NewInvalidParams(err.Error())
		}
		c.mu.Lock()
		defer c.mu.Unlock()
		if u := update.Update.AvailableCommandsUpdate; u != nil {
			if c.session != "" && update.SessionId != c.session {
				return nil, nil
			}
			commands := make([]model.NativeCommand, 0, len(u.AvailableCommands))
			for _, v := range u.AvailableCommands {
				command := model.NativeCommand{Name: v.Name, Description: v.Description}
				if v.Input != nil && v.Input.Unstructured != nil {
					command.ArgumentHint = v.Input.Unstructured.Hint
				}
				commands = append(commands, command)
			}
			c.commands[update.SessionId] = commands
			select {
			case c.commandUpdate <- struct{}{}:
			default:
			}
			if c.active && c.sink != nil {
				if err := c.publishCommands(commands); err != nil {
					return nil, acp.NewInternalError(err.Error())
				}
			}
			return nil, nil
		}
		if !c.active || update.SessionId != c.session {
			return nil, nil
		}
		u := &update.Update
		if c.promptStarted != nil && (u.UserMessageChunk != nil || u.AgentMessageChunk != nil || u.AgentThoughtChunk != nil || u.ToolCall != nil || u.Plan != nil) {
			close(c.promptStarted)
			c.promptStarted = nil
		}
		if err := c.update(update.Update); err != nil {
			c.err = err
			c.cancel()
			return nil, acp.NewInternalError(err.Error())
		}
		if c.background != nil {
			c.background.observe(update.Update, c.tools)
		}
		return nil, nil
	default:
		return nil, acp.NewMethodNotFound(method)
	}
}

// Turn-local names carry a file selection across ACP and do not belong in
// the composer's command picker. The caller holds c.mu.
func (c *acpRuntime) publishCommands(commands []model.NativeCommand) error {
	if len(c.skillCommands) > 0 {
		commands = slices.DeleteFunc(slices.Clone(commands), func(command model.NativeCommand) bool { return c.skillCommands[command.Name] })
	}
	return c.sink.UpdateRuntime(func(s *model.SessionRuntime) { s.Commands = &commands })
}

// ACP announcements may precede or follow session/new. Most agents publish
// immediately. An agent without slash commands must still become usable.
func (c *acpRuntime) initialCommands(ctx context.Context, id acp.SessionId) []model.NativeCommand {
	timer := time.NewTimer(250 * time.Millisecond)
	defer timer.Stop()
	for {
		c.mu.Lock()
		commands, ok := c.commands[id]
		c.mu.Unlock()
		if ok {
			return commands
		}
		select {
		case <-c.commandUpdate:
		case <-timer.C:
			return nil
		case <-ctx.Done():
			return nil
		}
	}
}

func acpText(content acp.ContentBlock) string {
	if content.Text != nil {
		return content.Text.Text
	}
	return "[ACP content]\n" + clip(pretty(content))
}

func (c *acpRuntime) update(update acp.SessionUpdate) error {
	if u := update.UsageUpdate; u != nil {
		return setContextUsage(c.sink, float64(u.Used), float64(u.Size))
	}
	var item model.Item
	switch {
	case update.AgentMessageChunk != nil || update.AgentThoughtChunk != nil:
		kind, content, messageID := "text", acp.ContentBlock{}, ""
		if update.AgentMessageChunk != nil {
			content = update.AgentMessageChunk.Content
			if update.AgentMessageChunk.MessageId != nil {
				messageID = *update.AgentMessageChunk.MessageId
			}
		} else {
			kind = "reasoning"
			content = update.AgentThoughtChunk.Content
			if update.AgentThoughtChunk.MessageId != nil {
				messageID = *update.AgentThoughtChunk.MessageId
			}
		}
		text := acpText(content)
		if kind == "reasoning" && text == "" {
			return nil
		}
		item = c.items[c.textID]
		messageChanged := messageID != "" && c.textMessageID != "" && messageID != c.textMessageID
		if item.Kind != kind || messageChanged {
			if err := c.finishMessage(); err != nil {
				return err
			}
			item = model.Item{ID: fmt.Sprintf("message-%d", c.nextMsg), Kind: kind, Status: "running"}
			c.nextMsg++
			c.textID = item.ID
			c.textMessageID = messageID
		} else if c.textMessageID == "" && messageID != "" {
			c.textMessageID = messageID
		}
		item.Text += text
	case update.ToolCall != nil:
		if err := c.finishMessage(); err != nil {
			return err
		}
		state := c.mergeToolCall(update.ToolCall)
		if c.antigravity && isAntigravitySubagentCall(state) {
			return c.emitAntigravitySubagent(state)
		}
		item = normalizeACPToolItem(state, c.cwd)
	case update.ToolCallUpdate != nil:
		if err := c.finishMessage(); err != nil {
			return err
		}
		state := c.mergeToolCallUpdate(update.ToolCallUpdate)
		if c.antigravity && isAntigravitySubagentCall(state) {
			return c.emitAntigravitySubagent(state)
		}
		item = normalizeACPToolItem(state, c.cwd)
	case update.Plan != nil:
		if err := c.finishMessage(); err != nil {
			return err
		}
		item = model.Item{ID: "plan", Kind: "plan", Title: "Plan", Status: "running"}
		for _, entry := range update.Plan.Entries {
			item.Text += fmt.Sprintf("%s: %s\n", entry.Status, entry.Content)
		}
	case update.PlanUpdate != nil:
		if err := c.finishMessage(); err != nil {
			return err
		}
		item = model.Item{ID: "plan", Kind: "plan", Title: "Plan", Status: "running"}
		switch {
		case update.PlanUpdate.Plan.Items != nil:
			for _, entry := range update.PlanUpdate.Plan.Items.Entries {
				item.Text += fmt.Sprintf("%s: %s\n", entry.Status, entry.Content)
			}
		case update.PlanUpdate.Plan.Markdown != nil:
			item.Text = clip(update.PlanUpdate.Plan.Markdown.Content)
		case update.PlanUpdate.Plan.File != nil:
			item.Text = update.PlanUpdate.Plan.File.Uri
		default:
			return nil
		}
	default:
		return nil
	}
	return c.emit(item)
}

func (c *acpRuntime) finishMessage() error {
	if c.textID == "" {
		return nil
	}
	item := c.items[c.textID]
	c.textID = ""
	c.textMessageID = ""
	item.Status = "completed"
	return c.emit(item)
}

func (c *acpRuntime) emit(item model.Item) error {
	c.items[item.ID] = item
	if item.Kind == "reasoning" && strings.TrimSpace(item.Text) == "" {
		return nil
	}
	return c.sink.Item(item)
}

func acpToolStatus(status acp.ToolCallStatus) string {
	switch status {
	case acp.ToolCallStatusCompleted:
		return "completed"
	case acp.ToolCallStatusFailed:
		return "failed"
	default:
		return "running"
	}
}

func acpToolAction(kind acp.ToolKind) model.ToolAction {
	switch kind {
	case acp.ToolKindExecute:
		return model.ToolActionCommand
	case acp.ToolKindEdit, acp.ToolKindDelete, acp.ToolKindMove:
		return model.ToolActionEdit
	case acp.ToolKindRead:
		return model.ToolActionRead
	case acp.ToolKindSearch, acp.ToolKindFetch:
		return model.ToolActionSearch
	default:
		return ""
	}
}
