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
	"strings"
	"time"

	"lever/internal/model"
	"lever/internal/plugin"
	"lever/internal/plugin/builtin/lark-bot"
	"lever/internal/store"
)

// All mutable channel state is guarded by App.mu. The socket and outbound
// requests run outside the lock; each worker belongs to one connection.
type feishuChannel struct {
	config       channelConfig
	enabled      bool
	started      bool
	runtime      *channelRuntime
	pair         channelPair
	registration *feishuRegistration
}

type channelRuntime struct {
	bot    plugin.ChannelAdapter
	ctx    context.Context
	cancel context.CancelFunc
	state  string
}

type channelConfig struct {
	AppID, BotName, SecretID, Brand string
	Binding                         channelBinding
}

func (c channelConfig) brand() string {
	if c.Brand == "" {
		return larkbot.Feishu
	}
	return c.Brand
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

func (a *App) loadChannel(ctx context.Context) (channelConfig, error) {
	c, err := store.Get[channelConfig](ctx, a.Store.DB, "SELECT data FROM channel_connections WHERE kind=?", larkbot.ChannelID)
	if errors.Is(err, sql.ErrNoRows) {
		return c, nil
	}
	return c, err
}

func saveChannel(ctx context.Context, tx *sql.Tx, c channelConfig) error {
	_, err := tx.ExecContext(ctx, "INSERT INTO channel_connections(kind,data) VALUES(?,?) ON CONFLICT(kind) DO UPDATE SET data=excluded.data", larkbot.ChannelID, store.JSON(c))
	return err
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
	a.startFeishuLocked()
}

func (a *App) startFeishuLocked() {
	f := &a.feishu
	if f.runtime != nil {
		f.runtime.cancel()
		f.runtime = nil
	}
	if a.closed || !f.started || !f.enabled || f.config.SecretID == "" {
		return
	}
	ctx, cancel := context.WithCancel(a.ctx)
	r := &channelRuntime{ctx: ctx, cancel: cancel, state: "connecting"}
	f.runtime = r
	secret, err := os.ReadFile(a.channelSecretPath(f.config.SecretID))
	if err != nil {
		r.state = "credentials_missing"
		return
	}
	bot := larkbot.New(f.config.AppID, string(secret), f.config.brand())
	r.bot = bot
	needsBotName := f.config.BotName == ""
	a.wg.Add(2)
	go func() {
		defer a.wg.Done()
		if needsBotName {
			a.refreshFeishuBotName(r, bot)
		}
		state := func(state string) {
			a.mu.Lock()
			defer a.mu.Unlock()
			if f.runtime == r && ctx.Err() == nil {
				r.state = state
			}
		}
		_ = r.bot.Listen(ctx, state, func(ctx context.Context, message plugin.ChannelMessage) error {
			return a.receiveChannelMessage(ctx, r, message)
		})
		state("error")
	}()
	go func() {
		defer a.wg.Done()
		a.runChannelDeliveries(r)
	}()
}

func (a *App) refreshFeishuBotName(r *channelRuntime, bot *larkbot.Bot) {
	name, err := bot.Verify(r.ctx)
	if err != nil || name == "" {
		return
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	f := &a.feishu
	if f.runtime != r || r.ctx.Err() != nil {
		return
	}
	c := f.config
	c.BotName = name
	if err := a.Store.Write(r.ctx, func(tx *sql.Tx) error { return saveChannel(r.ctx, tx, c) }); err != nil {
		slog.Warn("could not save Lark Bot name", "error", err)
		return
	}
	f.config = c
}

func (a *App) FeishuChannel() model.ChannelView {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.feishuViewLocked()
}

func (a *App) feishuViewLocked() model.ChannelView {
	f := &a.feishu
	c, b := f.config, f.config.Binding
	v := model.ChannelView{
		Configured: c.SecretID != "", Enabled: f.enabled, Connection: "offline", AppID: c.AppID, Brand: c.brand(), BotName: c.BotName,
		OwnerName: b.Name, AgentID: b.AgentID, ChatID: b.LeverChatID, Paused: b.Paused, LastMessageAt: b.LastMessageAt,
	}
	if f.runtime != nil {
		v.Connection = f.runtime.state
	}
	if f.registration != nil {
		registration := f.registration.state
		v.Registration = &registration
	}
	if p := f.pair; time.Now().Before(p.expires) {
		v.PairLocked = len(p.rejected) >= 5
		if p.candidate.UserID != "" {
			v.PairCandidate = p.candidate.UserID
		} else if !v.PairLocked {
			v.PairCode = p.code
		}
	}
	return v
}

func (a *App) channelSecretPath(id string) string {
	return filepath.Join(a.Store.Dir, "channel-secrets", id)
}

func (a *App) ConfigureFeishu(ctx context.Context, appID, secret, brand string) (model.ChannelView, error) {
	appID, secret = strings.TrimSpace(appID), strings.TrimSpace(secret)
	if appID == "" || secret == "" || len(appID) > 128 || len(secret) > 512 {
		return model.ChannelView{}, invalid("Enter a valid App ID and App Secret")
	}
	c := channelConfig{AppID: appID, Brand: brand}
	if c.brand() != larkbot.Feishu && c.brand() != larkbot.Lark {
		return model.ChannelView{}, invalid("Choose Feishu or Lark")
	}
	bot := larkbot.New(appID, secret, c.brand())
	verifyCtx, cancel := context.WithTimeout(ctx, 12*time.Second)
	defer cancel()
	name, err := bot.Verify(verifyCtx)
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
	c.BotName = name
	if err := a.saveFeishuCredentialsLocked(ctx, c, secret); err != nil {
		return model.ChannelView{}, err
	}
	f.registration = nil
	return a.feishuViewLocked(), nil
}

func (a *App) saveFeishuCredentialsLocked(ctx context.Context, c channelConfig, secret string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	f := &a.feishu
	previous := f.config
	c.SecretID = ID()
	if c.AppID == previous.AppID && c.brand() == previous.brand() {
		c.Binding = previous.Binding
	}
	path := a.channelSecretPath(c.SecretID)
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return err
	}
	if err := os.WriteFile(path, []byte(secret), 0600); err != nil {
		_ = os.Remove(path)
		return err
	}
	err := a.Store.Write(ctx, func(tx *sql.Tx) error {
		if err := saveChannel(ctx, tx, c); err != nil {
			return err
		}
		if previous.Binding.ID != c.Binding.ID {
			return cancelChannelDeliveries(ctx, tx, previous.Binding.ID)
		}
		return nil
	})
	if err != nil {
		_ = os.Remove(path)
		return err
	}
	if previous.SecretID != "" {
		if err := os.Remove(a.channelSecretPath(previous.SecretID)); err != nil && !errors.Is(err, os.ErrNotExist) {
			slog.Warn("could not remove previous Feishu credentials", "error", err)
		}
	}
	f.config, f.pair = c, channelPair{}
	a.startFeishuLocked()
	return nil
}

func (a *App) PairFeishu() (model.ChannelView, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	f := &a.feishu
	if a.closed || !f.enabled || f.runtime == nil || f.runtime.state != "online" {
		return model.ChannelView{}, conflict("Wait for Lark Bot to connect")
	}
	if f.config.Binding.ID != "" {
		return model.ChannelView{}, conflict("Unbind the current Feishu private chat first")
	}
	pair, err := newChannelPair()
	if err != nil {
		return model.ChannelView{}, err
	}
	f.pair = pair
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
	defer a.mu.Unlock()
	f := &a.feishu
	if a.closed || !f.enabled || f.config.Binding.ID != "" || input.Candidate == "" || f.pair.candidate.UserID != input.Candidate || !time.Now().Before(f.pair.expires) {
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
	m := f.pair.candidate
	c := f.config
	c.Binding = channelBinding{ID: ID(), Name: name, UserID: m.UserID, ChatID: m.ChatID, Tenant: m.Tenant}
	if draft := input.NewAgent; draft != nil {
		agentName := strings.TrimSpace(c.BotName)
		if agentName == "" || len(agentName) > 100 {
			agentName = "Lark Bot"
		}
		agent := model.Agent{Name: agentName, Profile: model.Profile{
			Provider: draft.Provider, Scope: model.Scope{Roots: []model.Root{{Path: draft.Directory}}},
			Skills: []string{}, Delegations: []model.DelegationRule{},
		}}
		if _, err := a.saveAgentLocked(ctx, agent, func(tx *sql.Tx, saved model.Agent) error {
			return writeFeishuTarget(ctx, tx, &c, saved.ID)
		}); err != nil {
			return model.ChannelView{}, err
		}
	} else if err := a.saveFeishuTarget(ctx, &c, input.AgentID); err != nil {
		return model.ChannelView{}, err
	}
	f.config, f.pair = c, channelPair{}
	return a.feishuViewLocked(), nil
}

func (a *App) SetFeishuAgent(ctx context.Context, agentID string) (model.ChannelView, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	c := a.feishu.config
	if a.closed || !a.feishu.enabled || c.Binding.ID == "" {
		return model.ChannelView{}, conflict("Bind a Feishu private chat first")
	}
	if agentID != c.Binding.AgentID {
		if err := a.saveFeishuTarget(ctx, &c, agentID); err != nil {
			return model.ChannelView{}, err
		}
		a.feishu.config = c
	}
	return a.feishuViewLocked(), nil
}

func (a *App) saveFeishuTarget(ctx context.Context, c *channelConfig, agentID string) error {
	return a.Store.Write(ctx, func(tx *sql.Tx) error {
		agent, err := store.Get[model.Agent](ctx, tx, "SELECT data FROM agents WHERE id=?", agentID)
		if errors.Is(err, sql.ErrNoRows) || err == nil && agent.Archived {
			return invalid("Choose an active Agent")
		}
		if err != nil {
			return err
		}
		return writeFeishuTarget(ctx, tx, c, agentID)
	})
}

func checkDesktopChat(chat model.Chat) error {
	if chat.Channel == larkbot.ChannelID {
		return conflict("Continue this conversation in its messaging channel")
	}
	return nil
}

func writeFeishuTarget(ctx context.Context, tx *sql.Tx, c *channelConfig, agentID string) error {
	platform := "Feishu"
	if c.brand() == larkbot.Lark {
		platform = "Lark"
	}
	chat := model.Chat{ID: ID(), AgentID: agentID, Title: platform + " · " + c.Binding.Name, Source: "channel", Channel: larkbot.ChannelID, CreatedAt: now(), UpdatedAt: now()}
	c.Binding.AgentID, c.Binding.LeverChatID = agentID, chat.ID
	if _, err := tx.ExecContext(ctx, "INSERT INTO chats(id,agent_id,data) VALUES(?,?,?)", chat.ID, agentID, store.JSON(chat)); err != nil {
		return err
	}
	if err := saveChannel(ctx, tx, *c); err != nil {
		return err
	}
	return store.Event(tx, model.Event{Type: "chats", ChatID: chat.ID})
}

func (a *App) PauseFeishu(ctx context.Context, paused bool) (model.ChannelView, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	c := a.feishu.config
	if a.closed || !a.feishu.enabled || c.Binding.ID == "" {
		return model.ChannelView{}, conflict("Bind a Feishu private chat first")
	}
	c.Binding.Paused = paused
	if err := a.Store.Write(ctx, func(tx *sql.Tx) error { return saveChannel(ctx, tx, c) }); err != nil {
		return model.ChannelView{}, err
	}
	a.feishu.config = c
	return a.feishuViewLocked(), nil
}

func (a *App) ReconnectFeishu() (model.ChannelView, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.closed || !a.feishu.enabled || a.feishu.config.SecretID == "" {
		return model.ChannelView{}, conflict("Configure Lark Bot first")
	}
	a.startFeishuLocked()
	return a.feishuViewLocked(), nil
}

func (a *App) UnbindFeishu(ctx context.Context) (model.ChannelView, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	f := &a.feishu
	if a.closed || !f.enabled || f.config.Binding.ID == "" {
		return model.ChannelView{}, conflict("Bind a Feishu private chat first")
	}
	c := f.config
	bindingID := c.Binding.ID
	c.Binding = channelBinding{}
	err := a.Store.Write(ctx, func(tx *sql.Tx) error {
		if err := saveChannel(ctx, tx, c); err != nil {
			return err
		}
		return cancelChannelDeliveries(ctx, tx, bindingID)
	})
	if err != nil {
		return model.ChannelView{}, err
	}
	f.config, f.pair = c, channelPair{}
	a.startFeishuLocked()
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
	b, r := a.feishu.config.Binding, a.feishu.runtime
	if a.closed || b.ID == "" || r == nil || r.bot == nil {
		a.mu.Unlock()
		return conflict("Bind a Feishu private chat first")
	}
	a.mu.Unlock()
	callCtx, cancel := context.WithTimeout(ctx, 12*time.Second)
	defer cancel()
	stop := context.AfterFunc(r.ctx, cancel)
	defer stop()
	if r.ctx.Err() != nil {
		return conflict("The Feishu connection has changed")
	}
	return r.bot.Send(callCtx, b.ChatID, ID(), "Lever · Lark Bot 连接测试 / Connection test")
}

func (a *App) receiveChannelMessage(ctx context.Context, r *channelRuntime, m plugin.ChannelMessage) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	f := &a.feishu
	if a.closed || r != f.runtime || ctx.Err() != nil {
		return ctx.Err()
	}
	b := f.config.Binding
	if b.ID == "" {
		p := &f.pair
		if code, ok := strings.CutPrefix(m.Text, "/pair "); ok && p.code != "" && len(p.rejected) < 5 && p.candidate.UserID == "" && time.Now().Before(p.expires) {
			if subtle.ConstantTimeCompare([]byte(p.code), []byte(strings.TrimSpace(code))) == 1 {
				p.candidate = m
			} else {
				p.rejected[m.ID] = true
			}
		}
		return nil
	}
	if b.Paused || b.UserID != m.UserID || b.ChatID != m.ChatID || b.Tenant != m.Tenant || strings.HasPrefix(m.Text, "/pair ") {
		return nil
	}
	origin := channelInput{b.ID, m.ID, m.Text}
	input := model.SendInput{ChatID: b.LeverChatID, CommandID: f.config.brand() + ":" + hash([3]string{f.config.AppID, m.Tenant, m.ID}), Operation: "main", Text: m.Text, Delivery: "queue"}
	run, err := a.sendLocked(ctx, input, sendOrigin{channel: &origin})
	if err == nil {
		previous, _ := time.Parse(time.RFC3339Nano, b.LastMessageAt)
		received, _ := time.Parse(time.RFC3339Nano, run.CreatedAt)
		if received.After(previous) {
			f.config.Binding.LastMessageAt = run.CreatedAt
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
			ctx, cancel := context.WithTimeout(r.ctx, 12*time.Second)
			defer cancel()
			a.mu.Lock()
			current := a.feishu.runtime == r && a.feishu.config.Binding.ID == b.ID
			a.mu.Unlock()
			if current {
				_ = r.bot.Reply(ctx, m.ID, hash(origin)[:40], "请在 Lever 检查 Agent 或恢复对话后重试。\nCheck the Agent or resume the conversation in Lever.")
			}
		}()
		return nil
	}
	return err
}

func recordFeishuMessage(ctx context.Context, tx *sql.Tx, bindingID, at string) error {
	_, err := tx.ExecContext(ctx, "UPDATE channel_connections SET data=json_set(data,'$.Binding.LastMessageAt',?) WHERE kind=? AND json_extract(data,'$.Binding.ID')=?", at, larkbot.ChannelID, bindingID)
	return err
}
