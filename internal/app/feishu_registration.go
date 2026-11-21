package app

import (
	"context"
	"errors"
	"log/slog"
	"time"

	"lever/internal/model"
	"lever/internal/plugin/builtin/lark-bot"
)

type feishuRegistration struct {
	state  model.ChannelRegistration
	cancel context.CancelFunc
}

func (a *App) RegisterFeishu() (model.ChannelView, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	f := &a.feishu
	if a.closed || !f.enabled {
		return model.ChannelView{}, conflict("Enable Lark Bot first")
	}
	if f.config.SecretID != "" {
		return model.ChannelView{}, conflict("A Lark Bot is already configured")
	}
	if current := f.registration; current != nil {
		if current.cancel != nil {
			return a.feishuViewLocked(), nil
		}
		if current.state.AppID != "" {
			return model.ChannelView{}, conflict("Connect the authorized bot using its credentials")
		}
	}

	ctx, cancel := context.WithTimeout(a.ctx, 11*time.Minute)
	job := &feishuRegistration{state: model.ChannelRegistration{Phase: "starting"}, cancel: cancel}
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
		job.cancel()
		job.state = model.ChannelRegistration{Phase: "cancelling"}
	}
}

func (a *App) registerFeishu(ctx context.Context, job *feishuRegistration) {
	result, err := larkbot.Register(ctx, func(link string) {
		a.mu.Lock()
		defer a.mu.Unlock()
		if ctx.Err() == nil {
			job.state = model.ChannelRegistration{Phase: "waiting", URL: link}
		}
	})
	a.mu.Lock()
	defer a.mu.Unlock()
	job.cancel = nil
	f := &a.feishu
	switch {
	case a.closed || !f.enabled || errors.Is(ctx.Err(), context.Canceled):
		job.state = model.ChannelRegistration{Phase: "cancelled", AppID: result.AppID, Brand: result.Brand}
	case errors.Is(err, larkbot.ErrRegistrationDenied):
		job.state = model.ChannelRegistration{Phase: "denied"}
	case errors.Is(err, larkbot.ErrRegistrationExpired) || errors.Is(err, context.DeadlineExceeded):
		job.state = model.ChannelRegistration{Phase: "expired"}
	case err != nil:
		job.state = model.ChannelRegistration{Phase: "failed"}
	default:
		c := channelConfig{AppID: result.AppID, Brand: result.Brand}
		if err := a.saveFeishuCredentialsLocked(a.ctx, c, result.Secret); err != nil {
			slog.Error("save registered Lark Bot", "error", err)
			job.state = model.ChannelRegistration{Phase: "failed", AppID: c.AppID, Brand: c.Brand}
			return
		}
		f.registration = nil
		// The user can also generate a fresh code from the pairing screen.
		f.pair, _ = newChannelPair()
	}
}
