package app

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"database/sql"
	"errors"
	"log/slog"
	"math/big"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"time"
	"unicode/utf8"

	"lever/internal/model"
	"lever/internal/plugin"
	larkbot "lever/internal/plugin/builtin/lark-bot"
	"lever/internal/store"
)

// All mutable channel state is guarded by App.mu. The socket and outbound
// requests run outside the lock; each worker belongs to one bot connection.
type feishuChannel struct {
	bots         []feishuBotConfig
	enabled      bool
	started      bool
	runtimes     map[string]*channelRuntime
	pairs        map[string]channelPair
	registration *feishuRegistration
}

type channelRuntime struct {
	botID    string
	appID    string
	secretID string
	brand    string
	bot      *larkbot.Bot
	ctx      context.Context
	cancel   context.CancelFunc
	state    string
}

type feishuStoreConfig struct {
	// Legacy single-bot fields; migrated into Bots[0] on load.
	AppID    string         `json:"AppID,omitempty"`
	BotName  string         `json:"BotName,omitempty"`
	SecretID string         `json:"SecretID,omitempty"`
	Brand    string         `json:"Brand,omitempty"`
	Binding  channelBinding `json:"Binding,omitempty"`

	// Multi-bot format.
	Bots []feishuBotConfig `json:"Bots,omitempty"`
}

type feishuBotConfig struct {
	ID            string                  `json:"id"`
	AppID         string                  `json:"appId"`
	BotName       string                  `json:"botName,omitempty"`
	BotOpenID     string                  `json:"botOpenId,omitempty"`
	SecretID      string                  `json:"secretId"`
	Brand         string                  `json:"brand,omitempty"`
	Enabled       bool                    `json:"enabled"`
	Binding       channelBinding          `json:"binding"`
	Settings      model.FeishuBotSettings `json:"settings"`
	MissingScopes []string                `json:"missingScopes,omitempty"`
	ChatMap       map[string]string       `json:"chatMap,omitempty"`   // scopeKey -> leverChatID
	ThreadMap     map[string]string       `json:"threadMap,omitempty"` // threadKey -> leverSessionID
}

func (b feishuBotConfig) brand() string {
	if b.Brand == "" {
		return larkbot.Feishu
	}
	return b.Brand
}

func (b feishuBotConfig) deliveryBindingID() string {
	if b.Binding.ID != "" {
		return b.Binding.ID
	}
	return b.ID
}

func (b feishuBotConfig) effectiveAgentID() string {
	if b.Settings.AgentID != "" {
		return b.Settings.AgentID
	}
	return b.Binding.AgentID
}

func (b feishuBotConfig) displayTitle() string {
	if name := strings.TrimSpace(b.Settings.DisplayName); name != "" {
		return name
	}
	if name := strings.TrimSpace(b.BotName); name != "" {
		return name
	}
	return b.AppID
}

type channelBinding struct {
	ID, Name, UserID, ChatID, Tenant string
	AgentID, LeverChatID             string
	Paused                           bool
	LastMessageAt                    string
}

type channelPair struct {
	code      string
	expires   time.Time
	candidate plugin.ChannelMessage
	rejected  map[string]bool
}

type channelInput struct {
	BindingID, MessageID, Text string
}

type feishuTurn struct {
	botID        string
	bindingID    string
	agentID      string
	chatID       string
	chatTitle    string
	sessionID    string
	sessionTitle string
	operation    string
	prompt       string
	context      string
	origin       *model.ChannelOrigin
	scopeKey     string
	threadKey    string
	meta         feishuDeliveryMeta
}

type feishuDeliveryMeta struct {
	BotID        string `json:"botId"`
	RemoteChatID string `json:"remoteChatId,omitempty"`
	RemoteUserID string `json:"remoteUserId,omitempty"`
	ChatType     string `json:"chatType,omitempty"`
	ReplyStyle   string `json:"replyStyle,omitempty"`   // "card" | "text"
	ReplyTarget  string `json:"replyTarget,omitempty"`  // "topic" | "main" | "quote" | "dm_first"
	ReplyMention string `json:"replyMention,omitempty"` // "none" | "requester" | "members"
	HideLocal    bool   `json:"hideLocal,omitempty"`
	ApprovalMode string `json:"approvalMode,omitempty"` // "lever" | "feishu_card"
	ReactionAck  bool   `json:"reactionAck,omitempty"`
	ReactionID   string `json:"reactionId,omitempty"`
}

func defaultFeishuSettings() model.FeishuBotSettings {
	return model.FeishuBotSettings{
		DMMode:           "continuous",
		ReplyStyle:       "card",
		GroupEnabled:     false,
		GroupMention:     "thread_free",
		GroupReplyTarget: "topic",
		DMAccess:         "admin",
		DMWhitelist:      []string{},
		GroupAccess:      "whitelist",
		ReplyMention:     "requester",
		Admins:           []string{},
		ChatOverrides:    []model.FeishuChatOverride{},
		Advanced: model.FeishuBotAdvanced{
			ReactionAck:        true,
			SenderTag:          true,
			HideLocalAddresses: true,
			HistoryLimit:       20,
			TrustSameOwnerBots: false,
			SessionMapping:     "single_chat_topics",
			ApprovalMode:       "lever",
			BlockedUsers:       []string{},
		},
	}
}

func legacyFeishuSettings(agentID, botName string) model.FeishuBotSettings {
	s := defaultFeishuSettings()
	s.DisplayName = botName
	s.AgentID = agentID
	s.ReplyStyle = "text"
	s.GroupEnabled = false
	s.DMAccess = "admin"
	s.ReplyMention = "none"
	s.Advanced.ReactionAck = false
	s.Advanced.SenderTag = false
	s.Advanced.HideLocalAddresses = false
	s.Advanced.HistoryLimit = 0
	return s
}

func applyFeishuPreset(s *model.FeishuBotSettings, preset string) {
	switch preset {
	case "personal":
		s.DMMode = "continuous"
		s.ReplyStyle = "card"
		s.GroupEnabled = false
		s.GroupMention = "at_only"
		s.GroupReplyTarget = "topic"
		s.DMAccess = "admin"
		s.GroupAccess = "whitelist"
		s.ReplyMention = "none"
	case "dev":
		s.DMMode = "continuous"
		s.ReplyStyle = "card"
		s.GroupEnabled = true
		s.GroupMention = "thread_free"
		s.GroupReplyTarget = "topic"
		s.DMAccess = "all"
		s.GroupAccess = "whitelist"
		s.ReplyMention = "requester"
	case "oncall":
		s.DMMode = "topic"
		s.ReplyStyle = "text"
		s.GroupEnabled = true
		s.GroupMention = "yield"
		s.GroupReplyTarget = "main"
		s.DMAccess = "whitelist"
		s.GroupAccess = "whitelist"
		s.ReplyMention = "members"
	}
}

func normalizeFeishuSettings(s *model.FeishuBotSettings) {
	if s.DMMode != "continuous" && s.DMMode != "topic" {
		s.DMMode = "continuous"
	}
	if s.ReplyStyle != "card" && s.ReplyStyle != "text" {
		s.ReplyStyle = "card"
	}
	if s.GroupMention != "at_only" && s.GroupMention != "thread_free" && s.GroupMention != "yield" && s.GroupMention != "free" {
		s.GroupMention = "thread_free"
	}
	if s.GroupReplyTarget != "topic" && s.GroupReplyTarget != "main" && s.GroupReplyTarget != "quote" {
		s.GroupReplyTarget = "topic"
	}
	if s.DMAccess != "admin" && s.DMAccess != "whitelist" && s.DMAccess != "all" {
		s.DMAccess = "admin"
	}
	if s.GroupAccess != "whitelist" && s.GroupAccess != "any" {
		s.GroupAccess = "whitelist"
	}
	if s.ReplyMention != "none" && s.ReplyMention != "requester" && s.ReplyMention != "members" {
		s.ReplyMention = "requester"
	}
	s.DisplayName = strings.TrimSpace(s.DisplayName)
	s.DefaultPrompt = strings.TrimSpace(s.DefaultPrompt)
	s.DMWhitelist = cleanStringList(s.DMWhitelist)
	s.Admins = cleanStringList(s.Admins)
	s.Advanced.BlockedUsers = cleanStringList(s.Advanced.BlockedUsers)
	if s.Advanced.HistoryLimit < 0 {
		s.Advanced.HistoryLimit = 0
	}
	if s.Advanced.HistoryLimit > 50 {
		s.Advanced.HistoryLimit = 50
	}
	if s.Advanced.SessionMapping != "single_chat_topics" && s.Advanced.SessionMapping != "per_feishu_chat" {
		s.Advanced.SessionMapping = "single_chat_topics"
	}
	if s.Advanced.ApprovalMode != "lever" && s.Advanced.ApprovalMode != "feishu_card" {
		s.Advanced.ApprovalMode = "lever"
	}
	if s.ChatOverrides == nil {
		s.ChatOverrides = []model.FeishuChatOverride{}
	}
	for i := range s.ChatOverrides {
		o := &s.ChatOverrides[i]
		if o.ID == "" {
			o.ID = ID()
		}
		o.ChatID = strings.TrimSpace(o.ChatID)
		o.ChatName = strings.TrimSpace(o.ChatName)
		o.Prompt = strings.TrimSpace(o.Prompt)
		if o.PromptMode != "append" && o.PromptMode != "replace" {
			o.PromptMode = "append"
		}
		if o.GroupMention != "" && o.GroupMention != "at_only" && o.GroupMention != "thread_free" && o.GroupMention != "yield" && o.GroupMention != "free" {
			o.GroupMention = ""
		}
		if o.GroupReplyTarget != "" && o.GroupReplyTarget != "topic" && o.GroupReplyTarget != "main" && o.GroupReplyTarget != "quote" && o.GroupReplyTarget != "dm_first" {
			o.GroupReplyTarget = ""
		}
		if o.ReplyStyle != "" && o.ReplyStyle != "card" && o.ReplyStyle != "text" {
			o.ReplyStyle = ""
		}
	}
}

func validateFeishuSettings(s model.FeishuBotSettings) error {
	if utf8.RuneCountInString(s.DisplayName) > 80 {
		return invalid("Bot display name must be at most 80 characters")
	}
	if utf8.RuneCountInString(s.DefaultPrompt) > 4000 || strings.ContainsRune(s.DefaultPrompt, '\x00') {
		return invalid("Bot instructions must be at most 4000 characters and contain no NUL characters")
	}
	if err := validateSelection(s.Selection); err != nil {
		return err
	}
	if len(s.DMWhitelist) > 256 || len(s.Admins) > 64 || len(s.Advanced.BlockedUsers) > 256 || len(s.ChatOverrides) > 128 {
		return invalid("Too many entries in bot access or group rules")
	}
	seenChats := make(map[string]bool, len(s.ChatOverrides))
	for _, o := range s.ChatOverrides {
		if o.ChatID == "" || len(o.ChatID) > 128 {
			return invalid("Every group rule must specify a valid Feishu chat ID")
		}
		if seenChats[o.ChatID] {
			return invalid("Duplicate group rule for chat " + o.ChatID)
		}
		seenChats[o.ChatID] = true
		if utf8.RuneCountInString(o.Prompt) > 4000 || strings.ContainsRune(o.Prompt, '\x00') {
			return invalid("Group instructions must be at most 4000 characters")
		}
		if err := validateSelection(o.Selection); err != nil {
			return err
		}
	}
	return nil
}

func cleanStringList(items []string) []string {
	out := make([]string, 0, len(items))
	seen := make(map[string]bool, len(items))
	for _, raw := range items {
		item := strings.TrimSpace(raw)
		if item == "" || len(item) > 128 || seen[item] {
			continue
		}
		seen[item] = true
		out = append(out, item)
	}
	return out
}

func (a *App) loadFeishuBots(ctx context.Context) ([]feishuBotConfig, error) {
	stored, err := store.Get[feishuStoreConfig](ctx, a.Store.DB, "SELECT data FROM channel_connections WHERE kind=?", larkbot.ChannelID)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if len(stored.Bots) == 0 && stored.SecretID != "" {
		botID := stored.Binding.ID
		if botID == "" {
			botID = "feishu-primary"
		}
		migrated := feishuBotConfig{
			ID:       botID,
			AppID:    stored.AppID,
			BotName:  stored.BotName,
			SecretID: stored.SecretID,
			Brand:    stored.Brand,
			Enabled:  !stored.Binding.Paused,
			Binding:  stored.Binding,
			Settings: legacyFeishuSettings(stored.Binding.AgentID, stored.BotName),
		}
		return []feishuBotConfig{migrated}, nil
	}
	for i := range stored.Bots {
		if stored.Bots[i].ID == "" {
			stored.Bots[i].ID = ID()
		}
		normalizeFeishuSettings(&stored.Bots[i].Settings)
		if stored.Bots[i].Settings.AgentID == "" && stored.Bots[i].Binding.AgentID != "" {
			stored.Bots[i].Settings.AgentID = stored.Bots[i].Binding.AgentID
		}
	}
	return stored.Bots, nil
}

func saveFeishuBots(ctx context.Context, tx *sql.Tx, bots []feishuBotConfig) error {
	payload := feishuStoreConfig{Bots: bots}
	_, err := tx.ExecContext(ctx, "INSERT INTO channel_connections(kind,data) VALUES(?,?) ON CONFLICT(kind) DO UPDATE SET data=excluded.data", larkbot.ChannelID, store.JSON(payload))
	return err
}

func (a *App) findFeishuBotLocked(id string) (int, *feishuBotConfig) {
	for i := range a.feishu.bots {
		if a.feishu.bots[i].ID == id {
			return i, &a.feishu.bots[i]
		}
	}
	return -1, nil
}

func (a *App) StartChannels() {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.closed || a.feishu.started {
		return
	}
	a.feishu.started = true
	a.resumePersonalLocked("")
	p, err := store.Get[model.Plugin](a.ctx, a.Store.DB, "SELECT data FROM plugins WHERE id=?", larkbot.PluginID)
	if err != nil {
		slog.Error("load Feishu plugin state", "error", err)
		return
	}
	a.feishu.enabled = p.Installed && p.Enabled
	a.syncFeishuRuntimesLocked()
}

func (a *App) syncFeishuRuntimesLocked() {
	f := &a.feishu
	if f.runtimes == nil {
		f.runtimes = make(map[string]*channelRuntime)
	}
	if a.closed || !f.started || !f.enabled {
		for id, rt := range f.runtimes {
			rt.cancel()
			delete(f.runtimes, id)
		}
		return
	}
	active := make(map[string]bool, len(f.bots))
	for _, b := range f.bots {
		if b.SecretID == "" {
			continue
		}
		active[b.ID] = true
		existing := f.runtimes[b.ID]
		if existing != nil && existing.secretID == b.SecretID && existing.appID == b.AppID && existing.brand == b.brand() {
			continue
		}
		a.startFeishuBotRuntimeLocked(b)
	}
	for id, rt := range f.runtimes {
		if !active[id] {
			rt.cancel()
			delete(f.runtimes, id)
		}
	}
}

func (a *App) startFeishuBotRuntimeLocked(cfg feishuBotConfig) {
	f := &a.feishu
	if f.runtimes == nil {
		f.runtimes = make(map[string]*channelRuntime)
	}
	if prev := f.runtimes[cfg.ID]; prev != nil {
		prev.cancel()
		delete(f.runtimes, cfg.ID)
	}
	if a.closed || !f.started || !f.enabled || cfg.SecretID == "" {
		return
	}
	ctx, cancel := context.WithCancel(a.ctx)
	r := &channelRuntime{
		botID:    cfg.ID,
		appID:    cfg.AppID,
		secretID: cfg.SecretID,
		brand:    cfg.brand(),
		ctx:      ctx,
		cancel:   cancel,
		state:    "connecting",
	}
	f.runtimes[cfg.ID] = r
	secret, err := os.ReadFile(a.channelSecretPath(cfg.SecretID))
	if err != nil {
		r.state = "credentials_missing"
		return
	}
	bot := larkbot.New(cfg.AppID, string(secret), cfg.brand())
	r.bot = bot
	needsInfo := cfg.BotName == "" || cfg.BotOpenID == ""
	a.wg.Add(2)
	go func() {
		defer a.wg.Done()
		if needsInfo {
			a.refreshFeishuBotInfo(r, bot)
		}
		setState := func(state string) {
			a.mu.Lock()
			defer a.mu.Unlock()
			if f.runtimes[r.botID] == r && ctx.Err() == nil {
				r.state = state
			}
		}
		_ = r.bot.Listen(ctx, setState, func(ctx context.Context, message plugin.ChannelMessage) error {
			return a.receiveChannelMessage(ctx, r, message)
		})
		setState("error")
	}()
	go func() {
		defer a.wg.Done()
		a.runChannelDeliveries(r)
	}()
}

func (a *App) refreshFeishuBotInfo(r *channelRuntime, bot *larkbot.Bot) {
	name, openID, err := bot.VerifyInfo(r.ctx)
	if err != nil || (name == "" && openID == "") {
		return
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.feishu.runtimes[r.botID] != r || r.ctx.Err() != nil {
		return
	}
	idx, current := a.findFeishuBotLocked(r.botID)
	if idx < 0 {
		return
	}
	updated := *current
	if name != "" {
		updated.BotName = name
	}
	if openID != "" {
		updated.BotOpenID = openID
	}
	bots := append([]feishuBotConfig(nil), a.feishu.bots...)
	bots[idx] = updated
	if err := a.Store.Write(r.ctx, func(tx *sql.Tx) error { return saveFeishuBots(r.ctx, tx, bots) }); err != nil {
		slog.Warn("could not save Lark Bot info", "bot", r.botID, "error", err)
		return
	}
	a.feishu.bots = bots
}

func (a *App) FeishuChannel() model.ChannelView {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.feishuViewLocked()
}

func (a *App) feishuViewLocked() model.ChannelView {
	f := &a.feishu
	v := model.ChannelView{
		Enabled:    f.enabled,
		Connection: "offline",
	}
	if f.registration != nil {
		registration := f.registration.state
		v.Registration = &registration
	}
	if len(f.bots) > 0 {
		v.Bots = make([]model.FeishuBotView, 0, len(f.bots))
		for _, cfg := range f.bots {
			bv := a.botViewLocked(cfg)
			v.Bots = append(v.Bots, bv)
		}
		primary := v.Bots[0]
		v.Configured = true
		v.Connection = primary.Connection
		v.AppID = primary.AppID
		v.Brand = primary.Brand
		v.BotName = primary.BotName
		v.OwnerName = primary.OwnerName
		v.AgentID = primary.Settings.AgentID
		v.ChatID = primary.ChatID
		v.Paused = !primary.Enabled
		v.PairCode = primary.PairCode
		v.PairCandidate = primary.PairCandidate
		v.PairLocked = primary.PairLocked
		v.LastMessageAt = primary.LastMessageAt
	}
	return v
}

func (a *App) botViewLocked(cfg feishuBotConfig) model.FeishuBotView {
	settings := cfg.Settings
	normalizeFeishuSettings(&settings)
	if settings.AgentID == "" {
		settings.AgentID = cfg.Binding.AgentID
	}
	conn := "offline"
	if rt := a.feishu.runtimes[cfg.ID]; rt != nil {
		conn = rt.state
	}
	bv := model.FeishuBotView{
		ID:            cfg.ID,
		AppID:         cfg.AppID,
		Brand:         cfg.brand(),
		BotName:       cfg.BotName,
		Enabled:       cfg.Enabled,
		Connection:    conn,
		OwnerName:     cfg.Binding.Name,
		ChatID:        cfg.Binding.LeverChatID,
		Paired:        cfg.Binding.ID != "",
		LastMessageAt: cfg.Binding.LastMessageAt,
		MissingScopes: append([]string(nil), cfg.MissingScopes...),
		Settings:      settings,
	}
	if p, ok := a.feishu.pairs[cfg.ID]; ok && time.Now().Before(p.expires) {
		bv.PairLocked = len(p.rejected) >= 5
		if p.candidate.UserID != "" {
			bv.PairCandidate = p.candidate.UserID
		} else if !bv.PairLocked {
			bv.PairCode = p.code
		}
	}
	return bv
}

func (a *App) channelSecretPath(id string) string {
	return filepath.Join(a.Store.Dir, "channel-secrets", id)
}

func (a *App) writeSecretFile(secretID, secret string) error {
	path := a.channelSecretPath(secretID)
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return err
	}
	if err := os.WriteFile(path, []byte(secret), 0600); err != nil {
		_ = os.Remove(path)
		return err
	}
	return nil
}

func (a *App) removeSecretFile(secretID string) {
	if secretID == "" {
		return
	}
	if err := os.Remove(a.channelSecretPath(secretID)); err != nil && !errors.Is(err, os.ErrNotExist) {
		slog.Warn("could not remove previous Feishu credentials", "error", err)
	}
}

// CreateFeishuBot adds a new bot with existing credentials, Agent binding, and preset.
func (a *App) CreateFeishuBot(ctx context.Context, input model.FeishuBotCreateInput) (model.ChannelView, error) {
	appID := strings.TrimSpace(input.AppID)
	secret := strings.TrimSpace(input.AppSecret)
	brand := strings.TrimSpace(input.Brand)
	if brand == "" {
		brand = larkbot.Feishu
	}
	if appID == "" || secret == "" || len(appID) > 128 || len(secret) > 512 {
		return model.ChannelView{}, invalid("Enter a valid App ID and App Secret")
	}
	if brand != larkbot.Feishu && brand != larkbot.Lark {
		return model.ChannelView{}, invalid("Choose Feishu or Lark")
	}

	botClient := larkbot.New(appID, secret, brand)
	verifyCtx, cancel := context.WithTimeout(ctx, 12*time.Second)
	defer cancel()
	botName, botOpenID, err := botClient.VerifyInfo(verifyCtx)
	if err != nil {
		return model.ChannelView{}, invalid(err.Error())
	}

	a.mu.Lock()
	defer a.mu.Unlock()
	if a.closed || !a.feishu.enabled {
		return model.ChannelView{}, conflict("Enable the Feishu plugin first")
	}
	for _, existing := range a.feishu.bots {
		if existing.AppID == appID && existing.brand() == brand {
			return model.ChannelView{}, conflict("This Feishu bot is already bound")
		}
	}

	settings := defaultFeishuSettings()
	if input.Settings != nil {
		settings = *input.Settings
	}
	applyFeishuPreset(&settings, input.Preset)
	if name := strings.TrimSpace(input.DisplayName); name != "" {
		settings.DisplayName = name
	} else if settings.DisplayName == "" {
		settings.DisplayName = botName
	}
	if input.AgentID != "" {
		settings.AgentID = input.AgentID
	}
	normalizeFeishuSettings(&settings)
	if err := validateFeishuSettings(settings); err != nil {
		return model.ChannelView{}, err
	}
	if settings.AgentID != "" {
		if err := a.ensureActiveAgent(ctx, settings.AgentID); err != nil {
			return model.ChannelView{}, err
		}
	}

	cfg := feishuBotConfig{
		ID:        ID(),
		AppID:     appID,
		BotName:   botName,
		BotOpenID: botOpenID,
		SecretID:  ID(),
		Brand:     brand,
		Enabled:   true,
		Settings:  settings,
	}
	if err := a.writeSecretFile(cfg.SecretID, secret); err != nil {
		return model.ChannelView{}, err
	}
	bots := append(append([]feishuBotConfig(nil), a.feishu.bots...), cfg)
	if err := a.Store.Write(ctx, func(tx *sql.Tx) error { return saveFeishuBots(ctx, tx, bots) }); err != nil {
		a.removeSecretFile(cfg.SecretID)
		return model.ChannelView{}, err
	}
	a.feishu.bots = bots
	a.startFeishuBotRuntimeLocked(cfg)
	return a.feishuViewLocked(), nil
}

// ConfigureFeishu preserves the legacy single-bot PUT /channels/feishu/bot contract.
func (a *App) ConfigureFeishu(ctx context.Context, appID, secret, brand string) (model.ChannelView, error) {
	appID, secret = strings.TrimSpace(appID), strings.TrimSpace(secret)
	if appID == "" || secret == "" || len(appID) > 128 || len(secret) > 512 {
		return model.ChannelView{}, invalid("Enter a valid App ID and App Secret")
	}
	if brand == "" {
		brand = larkbot.Feishu
	}
	if brand != larkbot.Feishu && brand != larkbot.Lark {
		return model.ChannelView{}, invalid("Choose Feishu or Lark")
	}
	botClient := larkbot.New(appID, secret, brand)
	verifyCtx, cancel := context.WithTimeout(ctx, 12*time.Second)
	defer cancel()
	name, openID, err := botClient.VerifyInfo(verifyCtx)
	if err != nil {
		return model.ChannelView{}, invalid(err.Error())
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	f := &a.feishu
	if a.closed || !f.enabled {
		return model.ChannelView{}, conflict("Enable the Feishu plugin first")
	}
	if f.registration != nil && f.registration.cancel != nil {
		return model.ChannelView{}, conflict("Bot registration is in progress")
	}
	if len(f.bots) == 0 {
		cfg := feishuBotConfig{
			ID:        ID(),
			AppID:     appID,
			BotName:   name,
			BotOpenID: openID,
			Brand:     brand,
			Enabled:   true,
			Settings:  legacyFeishuSettings("", name),
		}
		if err := a.upsertFeishuBotCredentialsLocked(ctx, -1, cfg, secret); err != nil {
			return model.ChannelView{}, err
		}
	} else {
		updated := f.bots[0]
		updated.AppID = appID
		updated.Brand = brand
		updated.BotName = name
		updated.BotOpenID = openID
		if err := a.upsertFeishuBotCredentialsLocked(ctx, 0, updated, secret); err != nil {
			return model.ChannelView{}, err
		}
	}
	f.registration = nil
	return a.feishuViewLocked(), nil
}

func (a *App) upsertFeishuBotCredentialsLocked(ctx context.Context, idx int, next feishuBotConfig, secret string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	var previous feishuBotConfig
	hasPrev := idx >= 0 && idx < len(a.feishu.bots)
	if hasPrev {
		previous = a.feishu.bots[idx]
		if next.AppID != previous.AppID || next.brand() != previous.brand() {
			next.Binding = channelBinding{}
			next.ChatMap = nil
			next.ThreadMap = nil
		}
	}
	newSecretID := previous.SecretID
	if secret != "" {
		newSecretID = ID()
		if err := a.writeSecretFile(newSecretID, secret); err != nil {
			return err
		}
	}
	next.SecretID = newSecretID
	bots := append([]feishuBotConfig(nil), a.feishu.bots...)
	if hasPrev {
		bots[idx] = next
	} else {
		bots = append(bots, next)
	}
	err := a.Store.Write(ctx, func(tx *sql.Tx) error {
		if err := saveFeishuBots(ctx, tx, bots); err != nil {
			return err
		}
		if hasPrev && previous.Binding.ID != next.Binding.ID {
			return cancelChannelDeliveries(ctx, tx, previous.Binding.ID)
		}
		return nil
	})
	if err != nil {
		if secret != "" {
			a.removeSecretFile(newSecretID)
		}
		return err
	}
	if secret != "" && previous.SecretID != "" && previous.SecretID != newSecretID {
		a.removeSecretFile(previous.SecretID)
	}
	a.feishu.bots = bots
	if a.feishu.pairs != nil {
		delete(a.feishu.pairs, next.ID)
	}
	a.startFeishuBotRuntimeLocked(next)
	return nil
}

func (a *App) UpdateFeishuBotCredentials(ctx context.Context, botID string, input model.FeishuBotCredentialsInput) (model.ChannelView, error) {
	appID := strings.TrimSpace(input.AppID)
	secret := strings.TrimSpace(input.AppSecret)
	displayName := strings.TrimSpace(input.DisplayName)
	brand := strings.TrimSpace(input.Brand)

	a.mu.Lock()
	if a.closed || !a.feishu.enabled {
		a.mu.Unlock()
		return model.ChannelView{}, conflict("Enable the Feishu plugin first")
	}
	idx, existing := a.findFeishuBotLocked(botID)
	if idx < 0 {
		a.mu.Unlock()
		return model.ChannelView{}, notFound("Bot not found")
	}
	current := *existing
	if appID == "" {
		appID = current.AppID
	}
	if brand == "" {
		brand = current.brand()
	}
	if brand != larkbot.Feishu && brand != larkbot.Lark {
		a.mu.Unlock()
		return model.ChannelView{}, invalid("Choose Feishu or Lark")
	}
	credsChanged := appID != current.AppID || brand != current.brand() || secret != ""
	secretToVerify := secret
	if credsChanged && secretToVerify == "" {
		raw, err := os.ReadFile(a.channelSecretPath(current.SecretID))
		if err != nil {
			a.mu.Unlock()
			return model.ChannelView{}, invalid("Enter the App Secret to update credentials")
		}
		secretToVerify = string(raw)
	}
	a.mu.Unlock()

	botName, botOpenID := current.BotName, current.BotOpenID
	if credsChanged {
		client := larkbot.New(appID, secretToVerify, brand)
		verifyCtx, cancel := context.WithTimeout(ctx, 12*time.Second)
		defer cancel()
		var err error
		botName, botOpenID, err = client.VerifyInfo(verifyCtx)
		if err != nil {
			return model.ChannelView{}, invalid(err.Error())
		}
	}

	a.mu.Lock()
	defer a.mu.Unlock()
	idx, existing = a.findFeishuBotLocked(botID)
	if idx < 0 {
		return model.ChannelView{}, notFound("Bot not found")
	}
	for i, other := range a.feishu.bots {
		if i != idx && other.AppID == appID && other.brand() == brand {
			return model.ChannelView{}, conflict("Another bot already uses this App ID")
		}
	}
	updated := *existing
	updated.AppID = appID
	updated.Brand = brand
	updated.BotName = botName
	updated.BotOpenID = botOpenID
	if displayName != "" {
		updated.Settings.DisplayName = displayName
	}
	if credsChanged {
		if err := a.upsertFeishuBotCredentialsLocked(ctx, idx, updated, secret); err != nil {
			return model.ChannelView{}, err
		}
	} else {
		bots := append([]feishuBotConfig(nil), a.feishu.bots...)
		bots[idx] = updated
		if err := a.Store.Write(ctx, func(tx *sql.Tx) error { return saveFeishuBots(ctx, tx, bots) }); err != nil {
			return model.ChannelView{}, err
		}
		a.feishu.bots = bots
	}
	return a.feishuViewLocked(), nil
}

func (a *App) UpdateFeishuBotSettings(ctx context.Context, botID string, settings model.FeishuBotSettings) (model.ChannelView, error) {
	normalizeFeishuSettings(&settings)
	if err := validateFeishuSettings(settings); err != nil {
		return model.ChannelView{}, err
	}

	a.mu.Lock()
	defer a.mu.Unlock()
	if a.closed || !a.feishu.enabled {
		return model.ChannelView{}, conflict("Enable the Feishu plugin first")
	}
	idx, existing := a.findFeishuBotLocked(botID)
	if idx < 0 {
		return model.ChannelView{}, notFound("Bot not found")
	}
	if settings.AgentID != "" {
		if err := a.ensureActiveAgent(ctx, settings.AgentID); err != nil {
			return model.ChannelView{}, err
		}
	}
	updated := *existing
	prevAgent := updated.effectiveAgentID()
	updated.Settings = settings
	agentChanged := settings.AgentID != "" && settings.AgentID != prevAgent

	bots := append([]feishuBotConfig(nil), a.feishu.bots...)
	err := a.Store.Write(ctx, func(tx *sql.Tx) error {
		if agentChanged {
			updated.ChatMap = nil
			updated.ThreadMap = nil
			if updated.Binding.ID != "" {
				if err := writeFeishuBotTarget(ctx, tx, &updated, settings.AgentID); err != nil {
					return err
				}
			}
		}
		bots[idx] = updated
		return saveFeishuBots(ctx, tx, bots)
	})
	if err != nil {
		return model.ChannelView{}, err
	}
	a.feishu.bots = bots
	return a.feishuViewLocked(), nil
}

func (a *App) SetFeishuBotEnabled(ctx context.Context, botID string, enabled bool) (model.ChannelView, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.closed || !a.feishu.enabled {
		return model.ChannelView{}, conflict("Enable the Feishu plugin first")
	}
	idx, existing := a.findFeishuBotLocked(botID)
	if idx < 0 {
		return model.ChannelView{}, notFound("Bot not found")
	}
	updated := *existing
	updated.Enabled = enabled
	updated.Binding.Paused = !enabled
	bots := append([]feishuBotConfig(nil), a.feishu.bots...)
	bots[idx] = updated
	if err := a.Store.Write(ctx, func(tx *sql.Tx) error { return saveFeishuBots(ctx, tx, bots) }); err != nil {
		return model.ChannelView{}, err
	}
	a.feishu.bots = bots
	return a.feishuViewLocked(), nil
}

func (a *App) DeleteFeishuBot(ctx context.Context, botID string) (model.ChannelView, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	idx, existing := a.findFeishuBotLocked(botID)
	if idx < 0 {
		return model.ChannelView{}, notFound("Bot not found")
	}
	removed := *existing
	bots := append(append([]feishuBotConfig(nil), a.feishu.bots[:idx]...), a.feishu.bots[idx+1:]...)
	err := a.Store.Write(ctx, func(tx *sql.Tx) error {
		if err := saveFeishuBots(ctx, tx, bots); err != nil {
			return err
		}
		if err := cancelChannelDeliveries(ctx, tx, removed.deliveryBindingID()); err != nil {
			return err
		}
		if removed.Binding.ID != "" && removed.Binding.ID != removed.ID {
			return cancelChannelDeliveries(ctx, tx, removed.ID)
		}
		return nil
	})
	if err != nil {
		return model.ChannelView{}, err
	}
	if rt := a.feishu.runtimes[botID]; rt != nil {
		rt.cancel()
		delete(a.feishu.runtimes, botID)
	}
	if a.feishu.pairs != nil {
		delete(a.feishu.pairs, botID)
	}
	a.feishu.bots = bots
	a.removeSecretFile(removed.SecretID)
	return a.feishuViewLocked(), nil
}

func (a *App) ReconnectFeishuBot(botID string) (model.ChannelView, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.closed || !a.feishu.enabled {
		return model.ChannelView{}, conflict("Enable Lark Bot first")
	}
	idx, existing := a.findFeishuBotLocked(botID)
	if idx < 0 {
		return model.ChannelView{}, notFound("Bot not found")
	}
	a.startFeishuBotRuntimeLocked(*existing)
	return a.feishuViewLocked(), nil
}

func (a *App) ListFeishuBotChats(ctx context.Context, botID string) ([]model.FeishuKnownChat, error) {
	a.mu.Lock()
	rt := a.feishu.runtimes[botID]
	if a.closed || rt == nil || rt.bot == nil {
		a.mu.Unlock()
		return []model.FeishuKnownChat{}, nil
	}
	bot := rt.bot
	a.mu.Unlock()

	callCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	chats, err := bot.ListChats(callCtx)
	if err != nil {
		return []model.FeishuKnownChat{}, nil
	}
	return chats, nil
}

func (a *App) CheckFeishuBotScopes(ctx context.Context, botID string) (model.ChannelView, error) {
	a.mu.Lock()
	idx, existing := a.findFeishuBotLocked(botID)
	rt := a.feishu.runtimes[botID]
	if a.closed || idx < 0 || rt == nil || rt.bot == nil {
		a.mu.Unlock()
		return model.ChannelView{}, conflict("Wait for Lark Bot to connect")
	}
	bot := rt.bot
	needsGroupMsg := existing.Settings.GroupEnabled && (existing.Settings.GroupMention == "yield" || existing.Settings.GroupMention == "free" || existing.Settings.Advanced.HistoryLimit > 0)
	probeChatID := ""
	for _, o := range existing.Settings.ChatOverrides {
		if o.Enabled && o.ChatID != "" {
			probeChatID = o.ChatID
			break
		}
	}
	a.mu.Unlock()

	callCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	missing := bot.CheckScopes(callCtx, probeChatID, needsGroupMsg)

	a.mu.Lock()
	defer a.mu.Unlock()
	idx, existing = a.findFeishuBotLocked(botID)
	if idx < 0 {
		return model.ChannelView{}, notFound("Bot not found")
	}
	bots := append([]feishuBotConfig(nil), a.feishu.bots...)
	bots[idx].MissingScopes = missing
	if err := a.Store.Write(ctx, func(tx *sql.Tx) error { return saveFeishuBots(ctx, tx, bots) }); err != nil {
		return model.ChannelView{}, err
	}
	a.feishu.bots = bots
	return a.feishuViewLocked(), nil
}

// =========================================================================
// Pairing & Legacy Single-Bot Wrappers (100% compatible with existing API)
// =========================================================================

func (a *App) primaryBotIDLocked() (string, error) {
	if len(a.feishu.bots) == 0 {
		return "", conflict("Configure Lark Bot first")
	}
	return a.feishu.bots[0].ID, nil
}

func (a *App) PairFeishu() (model.ChannelView, error) {
	a.mu.Lock()
	id, err := a.primaryBotIDLocked()
	a.mu.Unlock()
	if err != nil {
		return model.ChannelView{}, err
	}
	return a.PairFeishuBot(id)
}

func (a *App) PairFeishuBot(botID string) (model.ChannelView, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	f := &a.feishu
	idx, existing := a.findFeishuBotLocked(botID)
	if idx < 0 {
		return model.ChannelView{}, notFound("Bot not found")
	}
	rt := f.runtimes[botID]
	if a.closed || !f.enabled || rt == nil || rt.state != "online" {
		return model.ChannelView{}, conflict("Wait for Lark Bot to connect")
	}
	if existing.Binding.ID != "" {
		return model.ChannelView{}, conflict("Unbind the current Feishu private chat first")
	}
	pair, err := newChannelPair()
	if err != nil {
		return model.ChannelView{}, err
	}
	if f.pairs == nil {
		f.pairs = make(map[string]channelPair)
	}
	f.pairs[botID] = pair
	return a.feishuViewLocked(), nil
}

func newChannelPair() (channelPair, error) {
	// Nine digits, single candidate and explicit local confirmation.
	n, err := rand.Int(rand.Reader, big.NewInt(900_000_000))
	if err != nil {
		return channelPair{}, err
	}
	return channelPair{
		code: n.Add(n, big.NewInt(100_000_000)).String(), expires: time.Now().Add(5 * time.Minute),
		rejected: make(map[string]bool, 5),
	}, nil
}

func (a *App) ConfirmFeishuPair(ctx context.Context, input model.ChannelPairInput) (model.ChannelView, error) {
	a.mu.Lock()
	id, err := a.primaryBotIDLocked()
	a.mu.Unlock()
	if err != nil {
		return model.ChannelView{}, err
	}
	return a.ConfirmFeishuBotPair(ctx, id, input)
}

func (a *App) ConfirmFeishuBotPair(ctx context.Context, botID string, input model.ChannelPairInput) (model.ChannelView, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	f := &a.feishu
	idx, existing := a.findFeishuBotLocked(botID)
	if idx < 0 {
		return model.ChannelView{}, notFound("Bot not found")
	}
	pair := f.pairs[botID]
	if a.closed || !f.enabled || existing.Binding.ID != "" || input.Candidate == "" || pair.candidate.UserID != input.Candidate || !time.Now().Before(pair.expires) {
		return model.ChannelView{}, conflict("Generate a new pairing code and send it to the bot")
	}
	if (input.AgentID == "" && input.NewAgent == nil) || (input.AgentID != "" && input.NewAgent != nil) {
		return model.ChannelView{}, invalid("Create an Agent or choose an existing one")
	}
	name := strings.TrimSpace(input.Name)
	if name == "" {
		name = "DM"
	}
	if len([]rune(name)) > 60 {
		return model.ChannelView{}, invalid("Use up to 60 characters for the private chat name")
	}
	m := pair.candidate
	updated := *existing
	updated.Binding = channelBinding{ID: ID(), Name: name, UserID: m.UserID, ChatID: m.ChatID, Tenant: m.Tenant, Paused: !updated.Enabled}
	bots := append([]feishuBotConfig(nil), f.bots...)
	if draft := input.NewAgent; draft != nil {
		agentName := strings.TrimSpace(updated.BotName)
		if agentName == "" || len(agentName) > 100 {
			agentName = "Lark Bot"
		}
		agent := model.Agent{Name: agentName, Profile: model.Profile{
			Provider: draft.Provider, Scope: model.Scope{Roots: []model.Root{{Path: draft.Directory}}},
			Skills: []string{}, Delegations: []model.DelegationRule{},
		}}
		if _, err := a.saveAgentLocked(ctx, agent, func(tx *sql.Tx, saved model.Agent) error {
			updated.Settings.AgentID = saved.ID
			if err := writeFeishuBotTarget(ctx, tx, &updated, saved.ID); err != nil {
				return err
			}
			bots[idx] = updated
			return saveFeishuBots(ctx, tx, bots)
		}); err != nil {
			return model.ChannelView{}, err
		}
	} else {
		err := a.Store.Write(ctx, func(tx *sql.Tx) error {
			agent, err := store.Get[model.Agent](ctx, tx, "SELECT data FROM agents WHERE id=?", input.AgentID)
			if errors.Is(err, sql.ErrNoRows) || err == nil && agent.Archived {
				return invalid("Choose an active Agent")
			}
			if err != nil {
				return err
			}
			updated.Settings.AgentID = input.AgentID
			if err := writeFeishuBotTarget(ctx, tx, &updated, input.AgentID); err != nil {
				return err
			}
			bots[idx] = updated
			return saveFeishuBots(ctx, tx, bots)
		})
		if err != nil {
			return model.ChannelView{}, err
		}
	}
	f.bots = bots
	delete(f.pairs, botID)
	return a.feishuViewLocked(), nil
}

func (a *App) SetFeishuAgent(ctx context.Context, agentID string) (model.ChannelView, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if len(a.feishu.bots) == 0 || a.closed || !a.feishu.enabled || a.feishu.bots[0].Binding.ID == "" {
		return model.ChannelView{}, conflict("Bind a Feishu private chat first")
	}
	updated := a.feishu.bots[0]
	if agentID != updated.Binding.AgentID {
		bots := append([]feishuBotConfig(nil), a.feishu.bots...)
		err := a.Store.Write(ctx, func(tx *sql.Tx) error {
			agent, err := store.Get[model.Agent](ctx, tx, "SELECT data FROM agents WHERE id=?", agentID)
			if errors.Is(err, sql.ErrNoRows) || err == nil && agent.Archived {
				return invalid("Choose an active Agent")
			}
			if err != nil {
				return err
			}
			updated.Settings.AgentID = agentID
			updated.ChatMap = nil
			updated.ThreadMap = nil
			if err := writeFeishuBotTarget(ctx, tx, &updated, agentID); err != nil {
				return err
			}
			bots[0] = updated
			return saveFeishuBots(ctx, tx, bots)
		})
		if err != nil {
			return model.ChannelView{}, err
		}
		a.feishu.bots = bots
	}
	return a.feishuViewLocked(), nil
}

func (a *App) ensureActiveAgent(ctx context.Context, agentID string) error {
	agent, err := store.Get[model.Agent](ctx, a.Store.DB, "SELECT data FROM agents WHERE id=?", agentID)
	if errors.Is(err, sql.ErrNoRows) || (err == nil && agent.Archived) {
		return invalid("Choose an active Agent")
	}
	return err
}

func checkDesktopChat(chat model.Chat) error {
	if chat.Channel == larkbot.ChannelID {
		return conflict("Continue this conversation in its messaging channel")
	}
	return nil
}

func writeFeishuBotTarget(ctx context.Context, tx *sql.Tx, bot *feishuBotConfig, agentID string) error {
	platform := "Feishu"
	if bot.brand() == larkbot.Lark {
		platform = "Lark"
	}
	label := bot.Binding.Name
	if label == "" {
		label = bot.displayTitle()
	}
	chat := model.Chat{ID: ID(), AgentID: agentID, Title: platform + " · " + label, Source: "channel", Channel: larkbot.ChannelID, CreatedAt: now(), UpdatedAt: now()}
	bot.Binding.AgentID, bot.Binding.LeverChatID = agentID, chat.ID
	if _, err := tx.ExecContext(ctx, "INSERT INTO chats(id,agent_id,data) VALUES(?,?,?)", chat.ID, agentID, store.JSON(chat)); err != nil {
		return err
	}
	return store.Event(tx, model.Event{Type: "chats", ChatID: chat.ID})
}

func (a *App) PauseFeishu(ctx context.Context, paused bool) (model.ChannelView, error) {
	a.mu.Lock()
	if len(a.feishu.bots) == 0 || a.feishu.bots[0].Binding.ID == "" {
		a.mu.Unlock()
		return model.ChannelView{}, conflict("Bind a Feishu private chat first")
	}
	id := a.feishu.bots[0].ID
	a.mu.Unlock()
	return a.SetFeishuBotEnabled(ctx, id, !paused)
}

func (a *App) ReconnectFeishu() (model.ChannelView, error) {
	a.mu.Lock()
	id, err := a.primaryBotIDLocked()
	a.mu.Unlock()
	if err != nil {
		return model.ChannelView{}, err
	}
	return a.ReconnectFeishuBot(id)
}

func (a *App) UnbindFeishu(ctx context.Context) (model.ChannelView, error) {
	a.mu.Lock()
	if len(a.feishu.bots) == 0 || a.feishu.bots[0].Binding.ID == "" {
		a.mu.Unlock()
		return model.ChannelView{}, conflict("Bind a Feishu private chat first")
	}
	id := a.feishu.bots[0].ID
	a.mu.Unlock()
	return a.UnbindFeishuBotDM(ctx, id)
}

func (a *App) UnbindFeishuBotDM(ctx context.Context, botID string) (model.ChannelView, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	f := &a.feishu
	idx, existing := a.findFeishuBotLocked(botID)
	if idx < 0 || a.closed || !f.enabled || existing.Binding.ID == "" {
		return model.ChannelView{}, conflict("Bind a Feishu private chat first")
	}
	updated := *existing
	bindingID := updated.Binding.ID
	updated.Binding = channelBinding{}
	bots := append([]feishuBotConfig(nil), f.bots...)
	bots[idx] = updated
	err := a.Store.Write(ctx, func(tx *sql.Tx) error {
		if err := saveFeishuBots(ctx, tx, bots); err != nil {
			return err
		}
		return cancelChannelDeliveries(ctx, tx, bindingID)
	})
	if err != nil {
		return model.ChannelView{}, err
	}
	f.bots = bots
	delete(f.pairs, botID)
	a.startFeishuBotRuntimeLocked(updated)
	return a.feishuViewLocked(), nil
}

func cancelChannelDeliveries(ctx context.Context, tx *sql.Tx, bindingID string) error {
	if bindingID == "" {
		return nil
	}
	_, err := tx.ExecContext(ctx, "UPDATE channel_deliveries SET status='cancelled' WHERE binding_id=? AND status IN ('pending','failed')", bindingID)
	return err
}

func (a *App) TestFeishu(ctx context.Context) error {
	a.mu.Lock()
	if len(a.feishu.bots) == 0 {
		a.mu.Unlock()
		return conflict("Bind a Feishu private chat first")
	}
	id := a.feishu.bots[0].ID
	a.mu.Unlock()
	return a.TestFeishuBot(ctx, id)
}

func (a *App) TestFeishuBot(ctx context.Context, botID string) error {
	a.mu.Lock()
	idx, existing := a.findFeishuBotLocked(botID)
	rt := a.feishu.runtimes[botID]
	if a.closed || idx < 0 || rt == nil || rt.bot == nil {
		a.mu.Unlock()
		return conflict("Bind a Feishu private chat first")
	}
	targetChat := existing.Binding.ChatID
	targetOpenID := ""
	if targetChat == "" {
		for _, admin := range existing.Settings.Admins {
			if strings.HasPrefix(admin, "ou_") {
				targetOpenID = admin
				break
			}
		}
	}
	if targetChat == "" && targetOpenID == "" {
		for _, o := range existing.Settings.ChatOverrides {
			if o.Enabled && o.ChatID != "" {
				targetChat = o.ChatID
				break
			}
		}
	}
	if targetChat == "" && targetOpenID == "" {
		a.mu.Unlock()
		return conflict("Pair a private chat, add an admin Open ID, or enable a group rule first")
	}
	a.mu.Unlock()

	callCtx, cancel := context.WithTimeout(ctx, 12*time.Second)
	defer cancel()
	stop := context.AfterFunc(rt.ctx, cancel)
	defer stop()
	if rt.ctx.Err() != nil {
		return conflict("The Feishu connection has changed")
	}
	text := "Lever · Lark Bot 连接测试 / Connection test"
	if targetOpenID != "" {
		return rt.bot.Deliver(callCtx, plugin.ChannelSendOptions{
			OpenID:     targetOpenID,
			DeliveryID: ID(),
			Text:       text,
		})
	}
	return rt.bot.Send(callCtx, targetChat, ID(), text)
}

// =========================================================================
// Inbound Message Routing & Policy Engine
// =========================================================================

func (a *App) receiveChannelMessage(ctx context.Context, r *channelRuntime, m plugin.ChannelMessage) error {
	a.mu.Lock()
	f := &a.feishu
	if a.closed || f.runtimes[r.botID] != r || ctx.Err() != nil {
		a.mu.Unlock()
		return ctx.Err()
	}
	idx, existing := a.findFeishuBotLocked(r.botID)
	if idx < 0 {
		a.mu.Unlock()
		return nil
	}
	cfg := *existing
	b := cfg.Binding
	s := cfg.Settings
	normalizeFeishuSettings(&s)

	// 1. Handle /pair command strictly on p2p + user messages when not yet paired.
	if b.ID == "" && strings.HasPrefix(m.Text, "/pair ") {
		if m.ChatType == "p2p" && m.SenderType == "user" {
			if f.pairs == nil {
				f.pairs = make(map[string]channelPair)
			}
			p := f.pairs[cfg.ID]
			if code, ok := strings.CutPrefix(m.Text, "/pair "); ok && p.code != "" && len(p.rejected) < 5 && p.candidate.UserID == "" && time.Now().Before(p.expires) {
				if subtle.ConstantTimeCompare([]byte(p.code), []byte(strings.TrimSpace(code))) == 1 {
					p.candidate = m
				} else {
					p.rejected[m.ID] = true
				}
				f.pairs[cfg.ID] = p
			}
		}
		a.mu.Unlock()
		return nil
	}

	// 2. Bot must be enabled and bound to an Agent.
	agentID := cfg.effectiveAgentID()
	if !cfg.Enabled || b.Paused || agentID == "" || strings.HasPrefix(m.Text, "/pair ") {
		a.mu.Unlock()
		return nil
	}

	// 3. Sender validation (blocklist & bot-to-bot trust).
	if slices.Contains(s.Advanced.BlockedUsers, m.UserID) {
		a.mu.Unlock()
		return nil
	}
	if m.SenderType != "user" {
		if !s.Advanced.TrustSameOwnerBots || !a.isSameOwnerBotLocked(cfg.ID, m.UserID) {
			a.mu.Unlock()
			return nil
		}
	}

	// 4. Determine DM vs Group admission, override, trigger, and effective settings.
	var override *model.FeishuChatOverride
	isGroup := m.ChatType == "group"
	if !isGroup {
		if !canAccessFeishuDM(cfg, s, m) {
			a.mu.Unlock()
			return nil
		}
	} else {
		if !s.GroupEnabled {
			a.mu.Unlock()
			return nil
		}
		for i := range s.ChatOverrides {
			if s.ChatOverrides[i].ChatID == m.ChatID {
				o := s.ChatOverrides[i]
				override = &o
				break
			}
		}
		if override != nil && !override.Enabled {
			a.mu.Unlock()
			return nil
		}
		if s.GroupAccess == "whitelist" && override == nil {
			a.mu.Unlock()
			return nil
		}
		mentionMode := s.GroupMention
		if override != nil && override.GroupMention != "" {
			mentionMode = override.GroupMention
		}
		if !matchesGroupMention(cfg, mentionMode, m) {
			a.mu.Unlock()
			return nil
		}
	}

	// 5. Clean @ mention tokens from message text.
	cleanText := stripFeishuMentions(m.Text, m.Mentions)
	if cleanText == "" {
		a.mu.Unlock()
		return nil
	}

	// 6. Admin /reset command clears active thread/chat session routing.
	if cleanText == "/reset" && isFeishuAdmin(cfg, s, m.UserID) {
		if cfg.ThreadMap != nil {
			delete(cfg.ThreadMap, threadMapKey(m))
			a.feishu.bots[idx] = cfg
		}
		a.mu.Unlock()
		a.wg.Add(1)
		go func() {
			defer a.wg.Done()
			rctx, cancel := context.WithTimeout(r.ctx, 10*time.Second)
			defer cancel()
			_ = r.bot.Reply(rctx, m.ID, hash(m.ID+"-reset")[:40], "已重置当前会话上下文。")
		}()
		return nil
	}

	// 7. Resolve effective model selection, prompt, reply style/target, Lever chat & session.
	var sel *model.Selection
	if s.Selection != nil {
		cp := *s.Selection
		sel = &cp
	}
	if override != nil && override.Selection != nil {
		cp := *override.Selection
		sel = &cp
	}

	replyStyle := s.ReplyStyle
	if override != nil && override.ReplyStyle != "" {
		replyStyle = override.ReplyStyle
	}
	replyTarget := "quote"
	if !isGroup {
		if s.DMMode == "topic" {
			replyTarget = "topic"
		}
	} else {
		replyTarget = s.GroupReplyTarget
		if override != nil && override.GroupReplyTarget != "" {
			replyTarget = override.GroupReplyTarget
		}
	}

	prompt := composeFeishuPrompt(s, override)
	deliveryBindingID := cfg.deliveryBindingID()
	scopeKey, existingChatID, chatTitle, threadKey, existingSessionID, op, sessionTitle := resolveFeishuRouting(cfg, s, override, m, isGroup)

	// Optional reaction ack (async, non-blocking).
	reactionAck := s.Advanced.ReactionAck
	historyLimit := 0
	if isGroup && s.Advanced.HistoryLimit > 0 && existingSessionID == "" {
		historyLimit = s.Advanced.HistoryLimit
	}
	senderTag := isGroup && s.Advanced.SenderTag
	chatLabel := m.ChatID
	if override != nil && override.ChatName != "" {
		chatLabel = override.ChatName
	}

	// Fetch group history outside lock if needed (fast bounded timeout).
	var historyContext string
	if historyLimit > 0 && r.bot != nil {
		botClient := r.bot
		a.mu.Unlock()
		hctx, hcancel := context.WithTimeout(ctx, 1500*time.Millisecond)
		hist, err := botClient.FetchHistory(hctx, m.ChatID, historyLimit)
		hcancel()
		if err == nil {
			historyContext = hist
		}
		a.mu.Lock()
		if a.closed || a.feishu.runtimes[r.botID] != r || ctx.Err() != nil {
			a.mu.Unlock()
			return ctx.Err()
		}
		idx, existing = a.findFeishuBotLocked(r.botID)
		if idx < 0 {
			a.mu.Unlock()
			return nil
		}
	}
	defer a.mu.Unlock()

	var contextParts []string
	if senderTag {
		contextParts = append(contextParts, "[发言人 OpenID: "+m.UserID+"]")
	}
	if historyContext != "" {
		contextParts = append(contextParts, historyContext)
	}

	turn := feishuTurn{
		botID:        cfg.ID,
		bindingID:    deliveryBindingID,
		agentID:      agentID,
		chatID:       existingChatID,
		chatTitle:    chatTitle,
		sessionID:    existingSessionID,
		sessionTitle: sessionTitle,
		operation:    op,
		prompt:       prompt,
		context:      strings.Join(contextParts, "\n"),
		origin: &model.ChannelOrigin{
			Channel:  larkbot.ChannelID,
			ChatID:   m.ChatID,
			ChatName: chatLabel,
			Kind:     m.ChatType,
		},
		scopeKey:  scopeKey,
		threadKey: threadKey,
		meta: feishuDeliveryMeta{
			BotID:        cfg.ID,
			RemoteChatID: m.ChatID,
			RemoteUserID: m.UserID,
			ChatType:     m.ChatType,
			ReplyStyle:   replyStyle,
			ReplyTarget:  replyTarget,
			ReplyMention: s.ReplyMention,
			HideLocal:    s.Advanced.HideLocalAddresses,
			ApprovalMode: s.Advanced.ApprovalMode,
			ReactionAck:  reactionAck,
		},
	}

	origin := channelInput{deliveryBindingID, m.ID, cleanText}
	input := model.SendInput{
		CommandID: cfg.brand() + ":" + hash([3]string{cfg.AppID, m.Tenant, m.ID}),
		Operation: op,
		Text:      cleanText,
		Delivery:  "queue",
		Selection: sel,
	}
	if existingChatID != "" {
		input.ChatID = existingChatID
		if op == "reply" {
			input.SessionID = existingSessionID
		}
	} else {
		input.AgentID = agentID
	}

	run, err := a.sendLocked(ctx, input, sendOrigin{channel: &origin, feishu: &turn})
	if err == nil {
		// Persist runtime chat/thread mappings and LastMessageAt in memory.
		updated := a.feishu.bots[idx]
		previous, _ := time.Parse(time.RFC3339Nano, updated.Binding.LastMessageAt)
		received, _ := time.Parse(time.RFC3339Nano, run.CreatedAt)
		if received.After(previous) {
			updated.Binding.LastMessageAt = run.CreatedAt
		}
		if scopeKey != "" && run.ChatID != "" {
			if updated.ChatMap == nil {
				updated.ChatMap = make(map[string]string)
			}
			updated.ChatMap[scopeKey] = run.ChatID
		}
		if threadKey != "" && run.SessionID != "" {
			if updated.ThreadMap == nil {
				updated.ThreadMap = make(map[string]string)
			}
			updated.ThreadMap[threadKey] = run.SessionID
		}
		a.feishu.bots[idx] = updated

		if reactionAck && r.bot != nil {
			runID := run.ID
			msgID := m.ID
			botClient := r.bot
			a.wg.Add(1)
			go func() {
				defer a.wg.Done()
				rctx, cancel := context.WithTimeout(r.ctx, 6*time.Second)
				defer cancel()
				if reactionID, err := botClient.AddReaction(rctx, msgID, "OnIt"); err == nil && reactionID != "" {
					_ = a.Store.Write(a.ctx, func(tx *sql.Tx) error {
						_, err := tx.ExecContext(a.ctx, "UPDATE feishu_delivery_meta SET data=json_set(data,'$.reactionId',?) WHERE run_id=?", reactionID, runID)
						return err
					})
				}
			}()
		}
		return nil
	}

	var userError *Error
	if errors.As(err, &userError) {
		if errors.Is(err, errCommandConflict) {
			return nil
		}
		// The socket ACK must not wait for an outbound API call.
		a.wg.Add(1)
		go func() {
			defer a.wg.Done()
			rctx, cancel := context.WithTimeout(r.ctx, 12*time.Second)
			defer cancel()
			a.mu.Lock()
			_, cur := a.findFeishuBotLocked(r.botID)
			current := a.feishu.runtimes[r.botID] == r && cur != nil && cur.deliveryBindingID() == deliveryBindingID
			a.mu.Unlock()
			if current {
				_ = r.bot.Reply(rctx, m.ID, hash(origin)[:40], "请在 Lever 检查 Agent 或恢复对话后重试。\nCheck the Agent or resume the conversation in Lever.")
			}
		}()
		return nil
	}
	return err
}

func (a *App) isSameOwnerBotLocked(selfBotID, senderOpenID string) bool {
	for _, b := range a.feishu.bots {
		if b.ID != selfBotID && b.BotOpenID != "" && b.BotOpenID == senderOpenID {
			return true
		}
	}
	return false
}

func isFeishuAdmin(cfg feishuBotConfig, s model.FeishuBotSettings, userID string) bool {
	if cfg.Binding.UserID != "" && cfg.Binding.UserID == userID {
		return true
	}
	return slices.Contains(s.Admins, userID)
}

func canAccessFeishuDM(cfg feishuBotConfig, s model.FeishuBotSettings, m plugin.ChannelMessage) bool {
	// Legacy paired DM enforces exact tenant + chat match when dmAccess == "admin" and no extra admins configured.
	if cfg.Binding.ID != "" && s.DMAccess == "admin" && len(s.Admins) == 0 {
		return cfg.Binding.UserID == m.UserID && cfg.Binding.ChatID == m.ChatID && cfg.Binding.Tenant == m.Tenant
	}
	if isFeishuAdmin(cfg, s, m.UserID) {
		return true
	}
	switch s.DMAccess {
	case "all":
		return true
	case "whitelist":
		return slices.Contains(s.DMWhitelist, m.UserID)
	default:
		return false
	}
}

func matchesGroupMention(cfg feishuBotConfig, mode string, m plugin.ChannelMessage) bool {
	botMentioned := false
	for _, mention := range m.Mentions {
		if cfg.BotOpenID != "" && mention.OpenID == cfg.BotOpenID {
			botMentioned = true
			break
		}
		if cfg.BotName != "" && strings.EqualFold(mention.Name, cfg.BotName) {
			botMentioned = true
			break
		}
	}
	switch mode {
	case "free":
		return true
	case "yield":
		return botMentioned || len(m.Mentions) == 0
	case "thread_free":
		if botMentioned {
			return true
		}
		if m.RootID != "" && cfg.ThreadMap != nil && cfg.ThreadMap[m.ChatID+":"+m.RootID] != "" {
			return true
		}
		return false
	default: // "at_only"
		return botMentioned
	}
}

func stripFeishuMentions(text string, mentions []plugin.ChannelMention) string {
	out := text
	for _, m := range mentions {
		if m.Key != "" {
			out = strings.ReplaceAll(out, m.Key, "")
		}
	}
	return strings.TrimSpace(out)
}

func composeFeishuPrompt(s model.FeishuBotSettings, override *model.FeishuChatOverride) string {
	var parts []string
	defaultP := strings.TrimSpace(s.DefaultPrompt)
	groupP := ""
	if override != nil {
		groupP = strings.TrimSpace(override.Prompt)
	}
	if groupP != "" && override.PromptMode == "replace" {
		parts = append(parts, groupP)
	} else {
		if defaultP != "" {
			parts = append(parts, defaultP)
		}
		if groupP != "" {
			parts = append(parts, groupP)
		}
	}
	if s.Advanced.HideLocalAddresses {
		parts = append(parts, "不要在回复中暴露本机绝对文件路径、localhost 或内网地址。")
	}
	return strings.Join(parts, "\n\n")
}

func threadMapKey(m plugin.ChannelMessage) string {
	if m.RootID != "" {
		return m.ChatID + ":" + m.RootID
	}
	return m.ChatID + ":" + m.ID
}

func resolveFeishuRouting(cfg feishuBotConfig, s model.FeishuBotSettings, override *model.FeishuChatOverride, m plugin.ChannelMessage, isGroup bool) (scopeKey, chatID, chatTitle, threadKey, sessionID, op, sessionTitle string) {
	platform := "Feishu"
	if cfg.brand() == larkbot.Lark {
		platform = "Lark"
	}
	// Legacy paired DM always continues in Binding.LeverChatID main session unless DMMode == "topic".
	if !isGroup && cfg.Binding.ID != "" && cfg.Binding.ChatID == m.ChatID && cfg.Binding.LeverChatID != "" {
		chatID = cfg.Binding.LeverChatID
		if s.DMMode == "topic" {
			threadKey = threadMapKey(m)
			if cfg.ThreadMap != nil && m.RootID != "" && cfg.ThreadMap[m.ChatID+":"+m.RootID] != "" {
				sessionID = cfg.ThreadMap[m.ChatID+":"+m.RootID]
				op = "reply"
			} else {
				op = "topic"
			}
		} else {
			op = "main"
		}
		return "", chatID, "", threadKey, sessionID, op, ""
	}

	groupLabel := m.ChatID
	if override != nil && override.ChatName != "" {
		groupLabel = override.ChatName
	}

	if s.Advanced.SessionMapping == "per_feishu_chat" {
		scopeKey = "chat:" + m.ChatID
		if isGroup {
			chatTitle = platform + " · " + groupLabel
		} else {
			chatTitle = platform + " · " + cfg.displayTitle() + " DM"
		}
	} else {
		scopeKey = "bot:" + cfg.ID
		chatTitle = platform + " · " + cfg.displayTitle()
	}

	if cfg.ChatMap != nil {
		chatID = cfg.ChatMap[scopeKey]
	}

	// Determine main vs topic session inside the resolved Lever Chat.
	useTopic := false
	if !isGroup {
		useTopic = s.DMMode == "topic" || (s.Advanced.SessionMapping == "single_chat_topics" && chatID != "")
	} else {
		replyTarget := s.GroupReplyTarget
		if override != nil && override.GroupReplyTarget != "" {
			replyTarget = override.GroupReplyTarget
		}
		useTopic = replyTarget == "topic" || s.Advanced.SessionMapping == "single_chat_topics" || m.RootID != ""
	}

	if !useTopic {
		op = "main"
		return
	}

	if m.RootID != "" {
		threadKey = m.ChatID + ":" + m.RootID
	} else if !isGroup && s.DMMode == "continuous" {
		threadKey = m.ChatID + ":dm"
	} else if isGroup && s.GroupReplyTarget == "main" {
		threadKey = m.ChatID + ":main"
	} else {
		threadKey = m.ChatID + ":" + m.ID
	}

	if chatID != "" && cfg.ThreadMap != nil && cfg.ThreadMap[threadKey] != "" {
		sessionID = cfg.ThreadMap[threadKey]
		op = "reply"
		return
	}
	op = "topic"
	if isGroup {
		sessionTitle = groupLabel
	} else {
		sessionTitle = cfg.displayTitle() + " DM"
	}
	return
}

func recordFeishuMessage(ctx context.Context, tx *sql.Tx, bindingID, at string, turn *feishuTurn, run model.Run) error {
	stored, err := store.Get[feishuStoreConfig](ctx, tx, "SELECT data FROM channel_connections WHERE kind=?", larkbot.ChannelID)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return err
	}
	changed := false
	for i := range stored.Bots {
		b := &stored.Bots[i]
		match := b.Binding.ID == bindingID || b.ID == bindingID || (turn != nil && b.ID == turn.botID)
		if !match {
			continue
		}
		b.Binding.LastMessageAt = at
		if turn != nil {
			if turn.scopeKey != "" && run.ChatID != "" {
				if b.ChatMap == nil {
					b.ChatMap = make(map[string]string)
				}
				b.ChatMap[turn.scopeKey] = run.ChatID
			}
			if turn.threadKey != "" && run.SessionID != "" {
				if b.ThreadMap == nil {
					b.ThreadMap = make(map[string]string)
				}
				b.ThreadMap[turn.threadKey] = run.SessionID
			}
		}
		changed = true
		break
	}
	if changed {
		if err := saveFeishuBots(ctx, tx, stored.Bots); err != nil {
			return err
		}
	}
	if turn != nil {
		if _, err := tx.ExecContext(ctx, "INSERT INTO feishu_delivery_meta(run_id,data) VALUES(?,?) ON CONFLICT(run_id) DO UPDATE SET data=excluded.data", run.ID, store.JSON(turn.meta)); err != nil {
			return err
		}
	}
	return nil
}
