package app

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"unicode/utf8"

	"lever/internal/model"
	"lever/internal/plugin"
	"lever/internal/plugin/builtin/larkx"
	"lever/internal/provider"
	"lever/internal/store"
	"lever/internal/workspace"
)

type personalConfig struct {
	model.PersonalChannelSettings
	Region, Account, Session string
	Listening                bool
}

var personalCommand = regexp.MustCompile(`^/[\p{L}\p{N}_-]{1,48}$`)
var personalReaction = regexp.MustCompile(`^[A-Za-z0-9_+-]{1,64}$`)
var personalID = regexp.MustCompile(`^[1-9][0-9]{0,30}$`)

const personalDefaultSignature = "AI · {agent}"

func isPersonalChannel(p model.Plugin) bool {
	channels := p.Manifest.Contributes.Channels
	return len(channels) == 1 && channels[0].Driver == plugin.PersonalChannelDriver
}

func isBuiltinLarkx(p model.Plugin) bool {
	return p.Builtin && p.Manifest.ID == larkx.PluginID
}

func unsupportedPersonalChannel(p model.Plugin) bool {
	return isBuiltinLarkx(p) && !larkx.Supported()
}

func (a *App) personalConfig(ctx context.Context, id string) (model.Plugin, personalConfig, error) {
	var config personalConfig
	p, err := store.Get[model.Plugin](ctx, a.Store.DB, "SELECT data FROM plugins WHERE id=?", id)
	if err != nil {
		return p, config, err
	}
	if !p.Installed || !isPersonalChannel(p) {
		return p, config, sql.ErrNoRows
	}
	config, err = store.Get[personalConfig](ctx, a.Store.DB, "SELECT data FROM channel_connections WHERE kind=?", id)
	if errors.Is(err, sql.ErrNoRows) {
		signature := personalDefaultSignature
		if isBuiltinLarkx(p) {
			signature = larkx.DefaultSignature
		}
		return p, personalConfig{Region: "feishu", PersonalChannelSettings: model.PersonalChannelSettings{
			ChatMode: model.PersonalChannelChatSingle, ThreadReply: true, ContextLimit: 20, Signature: signature, Routes: []model.PersonalChannelRoute{}, ChatIDs: []string{},
		}}, nil
	}
	if err == nil && !config.ChatMode.Valid() {
		config.ChatMode = model.PersonalChannelChatSingle
	}
	return p, config, err
}

func (a *App) savePersonal(ctx context.Context, id string, config personalConfig, cancelBinding string) error {
	return a.Store.Write(ctx, func(tx *sql.Tx) error {
		if err := cancelChannelDeliveries(ctx, tx, cancelBinding); err != nil {
			return err
		}
		_, err := tx.ExecContext(ctx, "INSERT INTO channel_connections(kind,data) VALUES(?,?) ON CONFLICT(kind) DO UPDATE SET data=excluded.data", id, store.JSON(config))
		return err
	})
}

func (a *App) PersonalChannel(ctx context.Context, id string) (model.PersonalChannelView, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	p, config, err := a.personalConfig(ctx, id)
	if err != nil {
		return model.PersonalChannelView{}, err
	}
	view := model.PersonalChannelView{Settings: config.PersonalChannelSettings, State: "signedOut", Region: config.Region, Account: config.Account}
	if !p.Enabled {
		view.State = "disabled"
	} else if unsupportedPersonalChannel(p) {
		view.State = "unsupported"
	} else if worker := a.personal[id]; worker != nil {
		view.State, view.QR = worker.state, worker.qr
	} else if config.Account != "" {
		view.State = "paused"
	}
	if config.Account != "" {
		var last model.PersonalChannelReceipt
		var selection []byte
		err = a.Store.DB.QueryRowContext(ctx, `SELECT t.command,r.chat_id,r.session_id,r.id,s.kind='topic',t.chat_name,c.agent_id,d.status,r.status,t.context_ready,t.reaction,t.reaction_status,
json_extract(r.data,'$.selection') FROM personal_channel_turns t
JOIN runs r ON r.id=t.run_id JOIN sessions s ON s.id=r.session_id JOIN chats c ON c.id=r.chat_id JOIN channel_deliveries d ON d.run_id=r.id AND d.part='answer'
WHERE t.binding=? ORDER BY t.rowid DESC LIMIT 1`, personalBinding(id, config)).Scan(&last.Command, &last.ChatID, &last.SessionID, &last.RunID, &last.Topic, &last.ChatName, &last.AgentID,
			&last.Status, &last.RunStatus, &last.ContextReady, &last.Reaction, &last.ReactionStatus, &selection)
		if err == nil {
			if err := json.Unmarshal(selection, &last.Selection); err != nil {
				return view, err
			}
			view.Last = &last
		} else if !errors.Is(err, sql.ErrNoRows) {
			return view, err
		}
	}
	return view, nil
}

func (a *App) ConfigurePersonal(ctx context.Context, id string, settings model.PersonalChannelSettings) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	p, config, err := a.personalConfig(ctx, id)
	if err != nil {
		return err
	}
	if settings.ChatMode == "" {
		settings.ChatMode = config.ChatMode
	}
	if !settings.ChatMode.Valid() {
		return invalid("Choose a valid conversation mode")
	}
	settings.Prompt = strings.TrimSpace(settings.Prompt)
	if utf8.RuneCountInString(settings.Prompt) > 4000 || strings.ContainsRune(settings.Prompt, '\x00') {
		return invalid("Channel instructions must contain at most 4000 characters and no NUL characters")
	}
	if isBuiltinLarkx(p) {
		if utf8.RuneCountInString(settings.Signature) > 4000 || strings.ContainsRune(settings.Signature, '\x00') {
			return invalid("Reply suffix must contain at most 4000 characters and no NUL characters")
		}
	} else if len(settings.Signature) > 240 || strings.ContainsAny(settings.Signature, "\r\n") {
		return invalid("Signature must fit on one line and contain at most 240 bytes")
	}
	if settings.ContextLimit < 0 || settings.ContextLimit > 50 || settings.Reaction != "" && !personalReaction.MatchString(settings.Reaction) ||
		len(settings.Routes) > 64 || len(settings.ChatIDs) > 256 {
		return invalid("Invalid channel settings, reaction or context limit (0–50)")
	}
	for _, chat := range settings.ChatIDs {
		if !personalID.MatchString(chat) {
			return invalid("Use numeric conversation IDs")
		}
	}
	commands, agents := map[string]bool{}, map[string]bool{}
	for _, route := range settings.Routes {
		if agents[route.AgentID] || len(route.Commands) == 0 || len(route.Commands) > 24 {
			return invalid("Each Agent needs one route with 1–24 unique commands")
		}
		agents[route.AgentID] = true
		agent, err := store.Get[model.Agent](ctx, a.Store.DB, "SELECT data FROM agents WHERE id=?", route.AgentID)
		if err != nil || agent.Archived && route.Enabled {
			return invalid("Choose an active Agent or disable its route")
		}
		if choice := route.Selection; choice != nil {
			if choice.Provider == "" || len(choice.Provider) > 256 || len(choice.Model) > 4096 || len(choice.Effort) > 200 ||
				choice.Permission != "" || strings.ContainsAny(choice.Provider+choice.Model+choice.Effort, "\x00\r\n") {
				return invalid("Choose a channel runtime and model. Permissions come from the Agent.")
			}
			if route.Enabled {
				if _, err := a.personalSelection(ctx, route, agent.Profile); err != nil {
					return err
				}
			}
		}
		for _, command := range route.Commands {
			key := strings.ToLower(command)
			if !personalCommand.MatchString(command) || commands[key] {
				return invalid("Commands must be unique /names using letters, numbers, hyphens or underscores")
			}
			commands[key] = true
		}
	}
	config.PersonalChannelSettings = settings
	return a.savePersonal(ctx, id, config, "")
}

// Resolve every command from its route and current Agent, even in an existing thread.
// The desktop session's last choice and earlier channel overrides are not defaults.
func (a *App) personalSelection(ctx context.Context, route model.PersonalChannelRoute, profile model.Profile) (model.Selection, error) {
	base, err := agentDefaultSelection(ctx, a.Store.DB, model.Agent{Profile: profile})
	if err != nil {
		return model.Selection{}, err
	}
	if route.Selection == nil {
		choice, _, err := resolveSelection(ctx, a.Store.DB, base, base)
		return choice, err
	}
	choice := *route.Selection
	target, err := configuredProvider(ctx, a.Store.DB, choice.Provider)
	if err != nil {
		return choice, err
	}
	choice.Permission, err = a.personalPermission(ctx, profile, target)
	if err != nil {
		return choice, err
	}
	choice, err = provider.ResolveSelection(choice, base, target)
	if err != nil {
		return choice, invalid(err.Error())
	}
	return choice, nil
}

func (a *App) personalPermission(ctx context.Context, profile model.Profile, target model.Provider) (string, error) {
	if profile.Permission == "" || profile.Provider == target.ID {
		return agentPermissionForProvider(ctx, a.Store.DB, profile, target)
	}
	source, err := store.Get[model.Provider](ctx, a.Store.DB, "SELECT data FROM providers WHERE id=?", profile.Provider)
	if err != nil {
		return "", err
	}
	if source.Type == target.Type {
		return agentPermissionForProvider(ctx, a.Store.DB, profile, target)
	}
	from := a.personalPermissionCatalog(source, profile.Scope)
	permission := profile.Permission
	mode := ""
	if provider.IsCanonicalPermissionPolicy(permission) {
		mode = permission
	} else {
		for _, option := range slices.Concat(from.Permissions, from.LegacyPermissions) {
			if option.ID == permission {
				mode = option.Mode
				break
			}
		}
	}
	ask := ""
	for _, option := range a.personalPermissionCatalog(target, profile.Scope).Permissions {
		if mode != "" && option.Mode == mode {
			return option.ID, nil
		}
		if option.Mode == "ask" {
			ask = option.ID
		}
	}
	switch {
	case mode == "full_access":
		return agentPermissionForProvider(ctx, a.Store.DB, profile, target)
	case ask != "" && (mode == "auto" || mode == "accept_edits"):
		return ask, nil
	default:
		return "", invalid("The selected runtime cannot apply the Agent's permission policy")
	}
}

func (a *App) personalPermissionCatalog(config model.Provider, scope model.Scope) model.Catalog {
	catalog := provider.NormalizeCatalog(config, model.Catalog{})
	if config.Type == "acp" || config.Type == "antigravity" {
		key := catalogKey{config.ID, provider.ConfigurationDirectory(config), workspace.CWD(scope)}
		if cached := a.catalogEntryLocked(key, config).value; cached != nil {
			catalog = *cached
		}
	}
	if settings, err := permissionSettings(a.ctx, a.Store.DB); err == nil {
		catalog = provider.ApplyDefaultPermission(config, catalog, settings.DefaultMode)
	}
	return catalog
}

func personalBinding(install string, config personalConfig) string {
	return hash([3]string{install, config.Region, config.Account})
}

func (a *App) personalHome(install, session string) string {
	return filepath.Join(a.Store.Dir, "personal-channels", install, session)
}

func (a *App) PersonalAction(ctx context.Context, id, action, region string) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	p, config, err := a.personalConfig(ctx, id)
	if err != nil {
		return err
	}
	if a.closed || !p.Enabled && action != "logout" {
		return conflict("Enable the channel plugin first")
	}
	if (action == "login" || action == "connect") && unsupportedPersonalChannel(p) {
		return invalid("Larkx requires a macOS or Linux host with an arm64 or x86_64 processor")
	}
	login := false
	oldSession := config.Session
	cancelBinding := ""
	switch action {
	case "login":
		if config.Account != "" || region != "feishu" && region != "lark" {
			return invalid("Sign out before pairing an account and choose Feishu or Lark")
		}
		login = true
		config.Region, config.Session, config.Listening = region, ID(), false
	case "connect":
		if config.Account == "" || config.Session == "" {
			return conflict("Pair your account first")
		}
		config.Listening = true
	case "pause":
		config.Listening = false
	case "logout":
		if config.Account != "" {
			cancelBinding = personalBinding(id, config)
		}
		config.Account, config.Session, config.Listening = "", "", false
	default:
		return invalid("Unknown channel action")
	}
	if err := a.savePersonal(ctx, id, config, cancelBinding); err != nil {
		return err
	}
	a.stopPersonalLocked(id)
	if oldSession != "" && oldSession != config.Session {
		if err := os.RemoveAll(a.personalHome(id, oldSession)); err != nil {
			return err
		}
	}
	if login || config.Listening {
		a.startPersonalLocked(p, config, login)
	}
	return nil
}

func (a *App) resumePersonalLocked(id string) {
	if a.closed || !a.feishu.started {
		return
	}
	if id != "" {
		if a.personal[id] == nil {
			p, config, err := a.personalConfig(a.ctx, id)
			if err == nil && p.Enabled && !unsupportedPersonalChannel(p) && config.Account != "" && config.Listening {
				a.startPersonalLocked(p, config, false)
			}
		}
		return
	}
	plugins, err := a.Plugins(a.ctx)
	if err == nil {
		for _, p := range plugins {
			if isPersonalChannel(p) {
				a.resumePersonalLocked(p.ID)
			}
		}
	}
}

func (a *App) stopPersonalLocked(id string) {
	if worker := a.personal[id]; worker != nil {
		worker.cancel()
		if worker.process != nil {
			worker.process.Terminate()
		}
		delete(a.personal, id)
	}
}

type personalMessage struct {
	ID, Chat, ChatName, Sender, Text, Kind, Thread, Parent string
	Created                                                int64
}

func sanitizePersonalChatName(name string) string {
	name = strings.ReplaceAll(name, "\x00", "")
	name = strings.Join(strings.Fields(name), " ")
	runes := []rune(name)
	if len(runes) > 80 {
		return string(runes[:80])
	}
	return name
}

func clipPersonalRunes(text string, limit int) string {
	text = strings.Join(strings.Fields(text), " ")
	runes := []rune(text)
	if len(runes) > limit {
		return string(runes[:limit]) + "…"
	}
	return text
}

func (config personalConfig) match(message personalMessage) (model.PersonalChannelRoute, string, string, bool) {
	if !config.Listening || config.Account == "" || message.Sender != config.Account || len(message.Text) > 128<<10 ||
		!personalID.MatchString(message.ID) || !personalID.MatchString(message.Chat) ||
		message.Kind != "dm" && message.Kind != "group" || message.Thread != "" && !personalID.MatchString(message.Thread) ||
		message.Parent != "" && !personalID.MatchString(message.Parent) ||
		len(config.ChatIDs) != 0 && !slices.Contains(config.ChatIDs, message.Chat) {
		return model.PersonalChannelRoute{}, "", "", false
	}
	text := strings.TrimSpace(message.Text)
	fields := strings.Fields(text)
	if len(fields) != 0 {
		for _, route := range config.Routes {
			if route.Enabled && slices.ContainsFunc(route.Commands, func(command string) bool { return strings.EqualFold(command, fields[0]) }) {
				return route, fields[0], strings.TrimSpace(text[len(fields[0]):]), true
			}
		}
	}
	return model.PersonalChannelRoute{}, "", "", false
}

type personalTurn struct {
	install, binding, channelName, remoteChat, chatName, kind string
	conversation, thread, parent, command, signature          string
	prompt, reaction, rawBody                                 string
	chatMode                                                  model.PersonalChannelChatMode
	needsContext                                              bool
}

type personalDestination struct {
	chat          model.Chat
	sessionID     string
	operation     string
	title         string
	sessionTitle  string
	registerScope string
}

func (turn *personalTurn) sourceLabel() string {
	if turn.chatName != "" {
		return turn.chatName
	}
	return turn.remoteChat
}

func (turn *personalTurn) topicTitle(includeSource bool) string {
	if turn.conversation == "dm" || turn.conversation == "chat" {
		return turn.sourceLabel()
	}
	body := clipPersonalRunes(turn.rawBody, 48)
	if includeSource && turn.chatName != "" {
		if body != "" {
			return turn.chatName + " · " + body
		}
		return turn.chatName + " · " + turn.command
	}
	if body == "" {
		return turn.command
	}
	return ""
}

func (turn *personalTurn) channelOrigin() *model.ChannelOrigin {
	return &model.ChannelOrigin{
		Channel:  turn.install,
		ChatID:   turn.remoteChat,
		ChatName: turn.chatName,
		Kind:     turn.kind,
		Command:  turn.command,
	}
}

func (turn *personalTurn) scopedChat(ctx context.Context, tx *sql.Tx, agent, scope string) (model.Chat, error) {
	chat, err := store.Get[model.Chat](ctx, tx, `SELECT c.data FROM personal_channel_chats p
JOIN chats c ON c.id=p.chat_id
WHERE p.binding=? AND p.agent_id=? AND p.scope=?`, turn.binding, agent, scope)
	if errors.Is(err, sql.ErrNoRows) {
		err = nil
	}
	return chat, err
}

func (turn *personalTurn) resolve(ctx context.Context, tx *sql.Tx, agent string) (personalDestination, error) {
	if turn.thread != "" || turn.parent != "" {
		var sessionID, sessionKind, chatData string
		err := tx.QueryRowContext(ctx, `SELECT s.id, s.kind, c.data FROM personal_channel_turns t
JOIN runs r ON r.id=t.run_id JOIN sessions s ON s.id=r.session_id JOIN chats c ON c.id=r.chat_id
WHERE t.binding=? AND t.chat=? AND c.agent_id=? AND ((?<>'' AND t.conversation=?) OR (?<>'' AND t.answer_id=?))
ORDER BY (?<>'' AND t.conversation=?) DESC, t.rowid DESC LIMIT 1`,
			turn.binding, turn.remoteChat, agent,
			turn.thread, turn.thread,
			turn.parent, turn.parent,
			turn.thread, turn.thread,
		).Scan(&sessionID, &sessionKind, &chatData)
		if err == nil {
			var chat model.Chat
			if err := json.Unmarshal([]byte(chatData), &chat); err != nil {
				return personalDestination{}, err
			}
			if sessionKind == "topic" {
				return personalDestination{chat: chat, sessionID: sessionID, operation: "reply"}, nil
			}
			return personalDestination{chat: chat, operation: "main"}, nil
		}
		if !errors.Is(err, sql.ErrNoRows) {
			return personalDestination{}, err
		}
	}
	switch turn.chatMode {
	case model.PersonalChannelChatByChat:
		scope := "chat:" + turn.remoteChat
		chat, err := turn.scopedChat(ctx, tx, agent, scope)
		if err != nil {
			return personalDestination{}, err
		}
		operation, sessionTitle := "topic", turn.topicTitle(false)
		if turn.thread == "" {
			operation, sessionTitle = "main", ""
		}
		registerScope := ""
		if chat.ID == "" {
			registerScope = scope
		}
		return personalDestination{
			chat:          chat,
			operation:     operation,
			title:         turn.channelName + " · " + turn.sourceLabel(),
			sessionTitle:  sessionTitle,
			registerScope: registerScope,
		}, nil
	default:
		scope := "agent"
		chat, err := turn.scopedChat(ctx, tx, agent, scope)
		if err != nil {
			return personalDestination{}, err
		}
		if chat.ID != "" && turn.thread == "" {
			var sessionID string
			err := tx.QueryRowContext(ctx, `SELECT s.id FROM personal_channel_turns t
JOIN runs r ON r.id=t.run_id JOIN sessions s ON s.id=r.session_id
WHERE t.binding=? AND t.chat=? AND r.chat_id=? AND s.kind='topic' AND t.conversation=?
ORDER BY t.rowid DESC LIMIT 1`, turn.binding, turn.remoteChat, chat.ID, turn.conversation).Scan(&sessionID)
			if err == nil {
				return personalDestination{chat: chat, sessionID: sessionID, operation: "reply"}, nil
			}
			if !errors.Is(err, sql.ErrNoRows) {
				return personalDestination{}, err
			}
		}
		registerScope := ""
		if chat.ID == "" {
			registerScope = scope
		}
		return personalDestination{
			chat:          chat,
			operation:     "topic",
			title:         turn.channelName,
			sessionTitle:  turn.topicTitle(true),
			registerScope: registerScope,
		}, nil
	}
}

func (turn *personalTurn) record(ctx context.Context, tx *sql.Tx, runID string) error {
	reactionStatus := "off"
	if turn.reaction != "" {
		reactionStatus = "pending"
	}
	_, err := tx.ExecContext(ctx, `INSERT INTO personal_channel_turns(run_id,binding,chat,conversation,thread,command,signature,context_ready,reaction,reaction_status,chat_name)
VALUES(?,?,?,?,?,?,?,?,?,?,?)`, runID, turn.binding, turn.remoteChat, turn.conversation, turn.thread, turn.command, turn.signature, !turn.needsContext, turn.reaction, reactionStatus, turn.chatName)
	return err
}
