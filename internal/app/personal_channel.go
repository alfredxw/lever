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

func (a *App) personalConfig(ctx context.Context, id string) (model.Plugin, personalConfig, error) {
	var config personalConfig
	p, err := store.Get[model.Plugin](ctx, a.Store.DB, "SELECT data FROM plugins WHERE id=?", id)
	if err != nil {
		return p, config, err
	}
	if !p.Installed || p.Builtin || len(p.Manifest.Contributes.Channels) != 1 || p.Manifest.Contributes.Channels[0].Driver != plugin.PersonalChannelDriver {
		return p, config, sql.ErrNoRows
	}
	config, err = store.Get[personalConfig](ctx, a.Store.DB, "SELECT data FROM channel_connections WHERE kind=?", id)
	if errors.Is(err, sql.ErrNoRows) {
		return p, personalConfig{Region: "feishu", PersonalChannelSettings: model.PersonalChannelSettings{
			ThreadReply: true, ContextLimit: 20, Signature: "AI · {agent}", Routes: []model.PersonalChannelRoute{}, ChatIDs: []string{},
		}}, nil
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
	} else if worker := a.personal[id]; worker != nil {
		view.State, view.QR = worker.state, worker.qr
	} else if config.Account != "" {
		view.State = "paused"
	}
	if config.Account != "" {
		var last model.PersonalChannelReceipt
		var selection []byte
		err = a.Store.DB.QueryRowContext(ctx, `SELECT t.command,r.chat_id,c.agent_id,d.status,r.status,t.context_ready,t.reaction,t.reaction_status,
json_extract(r.data,'$.selection') FROM personal_channel_turns t
JOIN runs r ON r.id=t.run_id JOIN chats c ON c.id=r.chat_id JOIN channel_deliveries d ON d.run_id=r.id AND d.part='answer'
WHERE t.binding=? ORDER BY t.rowid DESC LIMIT 1`, personalBinding(id, config)).Scan(&last.Command, &last.ChatID, &last.AgentID,
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
	_, config, err := a.personalConfig(ctx, id)
	if err != nil {
		return err
	}
	settings.Prompt = strings.TrimSpace(settings.Prompt)
	if utf8.RuneCountInString(settings.Prompt) > 4000 || strings.ContainsRune(settings.Prompt, '\x00') {
		return invalid("Channel instructions must contain at most 4000 characters and no NUL characters")
	}
	if settings.ContextLimit < 0 || settings.ContextLimit > 50 || len(settings.Signature) > 240 ||
		strings.ContainsAny(settings.Signature, "\r\n") || settings.Reaction != "" && !personalReaction.MatchString(settings.Reaction) ||
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
	base := model.Selection{Provider: profile.Provider, Model: profile.Model, Permission: profile.Permission}
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
	if profile.Provider == target.ID {
		return profile.Permission, nil
	}
	source, err := store.Get[model.Provider](ctx, a.Store.DB, "SELECT data FROM providers WHERE id=?", profile.Provider)
	if err != nil {
		return "", err
	}
	if source.Type == target.Type {
		return profile.Permission, nil
	}
	from := a.personalPermissionCatalog(source, profile.Scope)
	permission := profile.Permission
	if permission == "" {
		permission = from.DefaultPermission
	}
	if permission == "" {
		return "", nil
	}
	mode := ""
	for _, option := range slices.Concat(from.Permissions, from.LegacyPermissions) {
		if option.ID == permission {
			mode = option.Mode
			break
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
		return "", nil
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
			return *cached
		}
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
			if err == nil && p.Enabled && config.Account != "" && config.Listening {
				a.startPersonalLocked(p, config, false)
			}
		}
		return
	}
	plugins, err := a.Plugins(a.ctx)
	if err == nil {
		for _, p := range plugins {
			if !p.Builtin && len(p.Manifest.Contributes.Channels) != 0 {
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
	ID, Chat, Sender, Text, Kind, Thread, Parent string
	Created                                      int64
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
	install, binding, title, remoteChat, conversation, thread, parent, command, signature string
	prompt, reaction                                                                      string
	needsContext                                                                          bool
}

func (turn *personalTurn) chat(ctx context.Context, tx *sql.Tx, agent string) (model.Chat, error) {
	chat, err := store.Get[model.Chat](ctx, tx, `SELECT c.data FROM personal_channel_turns t
JOIN runs r ON r.id=t.run_id JOIN chats c ON c.id=r.chat_id
WHERE t.binding=? AND t.chat=? AND c.agent_id=? AND (t.conversation=? OR (?<>'' AND t.answer_id=?))
ORDER BY (t.conversation=?) DESC, t.rowid DESC LIMIT 1`, turn.binding, turn.remoteChat, agent, turn.conversation, turn.parent, turn.parent, turn.conversation)
	if errors.Is(err, sql.ErrNoRows) {
		err = nil
	}
	return chat, err
}

func (turn *personalTurn) record(ctx context.Context, tx *sql.Tx, runID string) error {
	reactionStatus := "off"
	if turn.reaction != "" {
		reactionStatus = "pending"
	}
	_, err := tx.ExecContext(ctx, `INSERT INTO personal_channel_turns(run_id,binding,chat,conversation,thread,command,signature,context_ready,reaction,reaction_status)
VALUES(?,?,?,?,?,?,?,?,?,?)`, runID, turn.binding, turn.remoteChat, turn.conversation, turn.thread, turn.command, turn.signature, !turn.needsContext, turn.reaction, reactionStatus)
	return err
}
