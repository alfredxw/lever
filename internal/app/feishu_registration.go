package app

import (
	"context"
	"errors"
	"log/slog"
	"time"

	"lever/internal/model"
	larkbot "lever/internal/plugin/builtin/lark-bot"
)

type feishuRegistration struct {
	state      model.ChannelRegistration
	cancel     context.CancelFunc
	multiBot   bool
	draftInput model.FeishuRegistrationInput
}

func (a *App) RegisterFeishu() (model.ChannelView, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	f := &a.feishu
	if a.closed || !f.enabled {
		return model.ChannelView{}, conflict("Enable Lark Bot first")
	}
	if len(f.bots) > 0 {
		return model.ChannelView{}, conflict("A Lark Bot is already configured")
	}
	return a.startFeishuRegistrationLocked(false, model.FeishuRegistrationInput{})
}

func (a *App) validateFeishuRegistrationDraft(ctx context.Context, input model.FeishuRegistrationInput) error {
	settings := resolveFeishuCreateSettings(input.Settings, input.Preset, input.DisplayName, input.AgentID, "")
	if err := validateFeishuSettings(settings); err != nil {
		return err
	}
	if settings.AgentID != "" {
		if err := a.ensureActiveAgent(ctx, settings.AgentID); err != nil {
			return err
		}
	}
	return nil
}

func (a *App) RegisterFeishuBot(ctx context.Context, input model.FeishuRegistrationInput) (model.ChannelView, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	f := &a.feishu
	if a.closed || !f.enabled {
		return model.ChannelView{}, conflict("Enable Lark Bot first")
	}
	if err := a.validateFeishuRegistrationDraft(ctx, input); err != nil {
		return model.ChannelView{}, err
	}
	return a.startFeishuRegistrationLocked(true, input)
}

func (a *App) UpdateFeishuRegistrationDraft(ctx context.Context, input model.FeishuRegistrationInput) (model.ChannelView, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	f := &a.feishu
	if a.closed || !f.enabled {
		return model.ChannelView{}, conflict("Enable Lark Bot first")
	}
	if err := a.validateFeishuRegistrationDraft(ctx, input); err != nil {
		return model.ChannelView{}, err
	}
	if current := f.registration; current != nil && current.cancel != nil && current.multiBot {
		current.draftInput = input
	}
	return a.feishuViewLocked(), nil
}

func (a *App) startFeishuRegistrationLocked(multiBot bool, input model.FeishuRegistrationInput) (model.ChannelView, error) {
	f := &a.feishu
	if current := f.registration; current != nil {
		if current.cancel != nil {
			if multiBot && current.multiBot {
				current.draftInput = input
			}
			return a.feishuViewLocked(), nil
		}
		if !multiBot && current.state.AppID != "" {
			return model.ChannelView{}, conflict("Connect the authorized bot using its credentials")
		}
	}

	ctx, cancel := context.WithTimeout(a.ctx, 11*time.Minute)
	job := &feishuRegistration{
		state:      model.ChannelRegistration{Phase: "starting", Brand: input.Brand},
		cancel:     cancel,
		multiBot:   multiBot,
		draftInput: input,
	}
	f.registration = job
	a.wg.Add(1)
	go func() {
		defer a.wg.Done()
		defer cancel()
		a.registerFeishu(ctx, job)
	}()
	return a.feishuViewLocked(), nil
}

func (a *App) CancelFeishuRegistration() model.ChannelView {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.cancelFeishuRegistrationLocked()
	return a.feishuViewLocked()
}

func (a *App) cancelFeishuRegistrationLocked() {
	if job := a.feishu.registration; job != nil && job.cancel != nil {
		cancel := job.cancel
		job.cancel = nil
		cancel()
		job.state = model.ChannelRegistration{Phase: "cancelling"}
	}
}

func (a *App) registerFeishu(ctx context.Context, job *feishuRegistration) {
	result, err := larkbot.Register(ctx, func(link string) {
		a.mu.Lock()
		defer a.mu.Unlock()
		if a.feishu.registration == job && ctx.Err() == nil {
			job.state = model.ChannelRegistration{Phase: "waiting", URL: link}
		}
	})
	a.mu.Lock()
	defer a.mu.Unlock()
	job.cancel = nil
	f := &a.feishu
	if f.registration != job {
		return
	}
	switch {
	case a.closed || !f.enabled || errors.Is(ctx.Err(), context.Canceled):
		job.state = model.ChannelRegistration{Phase: "cancelled", AppID: result.AppID, Brand: result.Brand}
	case errors.Is(err, larkbot.ErrRegistrationDenied):
		job.state = model.ChannelRegistration{Phase: "denied"}
	case errors.Is(err, larkbot.ErrRegistrationExpired) || errors.Is(err, context.DeadlineExceeded):
		job.state = model.ChannelRegistration{Phase: "expired"}
	case err != nil:
		slog.Warn("register Lark Bot", "error", err)
		job.state = model.ChannelRegistration{Phase: "failed"}
	default:
		// Check if same AppID+Brand already exists; update credentials in place if so.
		existingIdx := -1
		for i, b := range f.bots {
			if b.AppID == result.AppID && b.brand() == result.Brand {
				existingIdx = i
				break
			}
		}
		var cfg feishuBotConfig
		if existingIdx >= 0 {
			cfg = f.bots[existingIdx]
		} else {
			settings := legacyFeishuSettings("", "")
			if job.multiBot {
				settings = resolveFeishuCreateSettings(
					job.draftInput.Settings,
					job.draftInput.Preset,
					job.draftInput.DisplayName,
					job.draftInput.AgentID,
					"",
				)
			}
			cfg = feishuBotConfig{
				ID:       ID(),
				AppID:    result.AppID,
				Brand:    result.Brand,
				Enabled:  true,
				Settings: settings,
			}
		}
		if err := a.upsertFeishuBotCredentialsLocked(a.ctx, existingIdx, cfg, result.Secret); err != nil {
			slog.Error("save registered Lark Bot", "error", err)
			job.state = model.ChannelRegistration{Phase: "failed", AppID: cfg.AppID, Brand: cfg.Brand}
			return
		}
		f.registration = nil
		if !job.multiBot || cfg.Settings.AgentID == "" {
			if f.pairs == nil {
				f.pairs = make(map[string]channelPair)
			}
			if pair, perr := newChannelPair(); perr == nil {
				f.pairs[cfg.ID] = pair
			}
		}
	}
}
