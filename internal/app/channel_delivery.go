package app

import (
	"context"
	"database/sql"
	"errors"
	"log/slog"
	"regexp"
	"strings"
	"time"

	"lever/internal/model"
	"lever/internal/plugin"
	"lever/internal/store"
)

type channelDelivery struct {
	run       model.Run
	part      string
	messageID string
}

var (
	localHomePathRe = regexp.MustCompile(`(/(?:Users|home)/[^/\s"'` + "`" + `<>]+|[A-Za-z]:\\Users\\[^\\\s"'` + "`" + `<>]+)`)
	localAddrRe     = regexp.MustCompile(`https?://(?:localhost|127\.0\.0\.1|0\.0\.0\.0|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})(?::\d+)?`)
	feishuAtTagRe   = regexp.MustCompile(`<at\b[^>]*>.*?</at>`)
)

func requireLocalTurn(ctx context.Context, tx *sql.Tx, runID, reason string) error {
	var fromChannel bool
	if err := tx.QueryRowContext(ctx, "SELECT EXISTS(SELECT 1 FROM channel_deliveries WHERE run_id=?)", runID).Scan(&fromChannel); err != nil {
		return err
	}
	if fromChannel {
		return conflict(reason)
	}
	return nil
}

func (a *App) runChannelDeliveries(runtime *channelRuntime) {
	changed, unsubscribe := a.Store.Subscribe()
	defer unsubscribe()
	tick := time.NewTicker(5 * time.Second)
	defer tick.Stop()
	for runtime.ctx.Err() == nil {
		a.mu.Lock()
		if a.feishu.runtimes[runtime.botID] != runtime {
			a.mu.Unlock()
			return
		}
		_, cfg := a.findFeishuBotLocked(runtime.botID)
		bindingID := ""
		if cfg != nil {
			bindingID = cfg.deliveryBindingID()
		}
		delivery, err := a.claimChannelDeliveryLocked(runtime.ctx, bindingID)
		a.mu.Unlock()
		if err != nil && runtime.ctx.Err() == nil {
			slog.Error("claim channel reply", "bot", runtime.botID, "error", err)
		}
		if delivery.run.ID != "" {
			a.deliverChannelReply(runtime, delivery)
			continue
		}
		select {
		case <-runtime.ctx.Done():
			return
		case <-changed:
		case <-tick.C:
		}
	}
}

func (a *App) claimChannelDeliveryLocked(ctx context.Context, bindingID string) (channelDelivery, error) {
	var d channelDelivery
	if bindingID == "" {
		return d, nil
	}
	var runID string
	err := a.Store.DB.QueryRowContext(ctx, `
SELECT d.run_id, d.part, d.message_id FROM channel_deliveries d JOIN runs r ON r.id=d.run_id
WHERE d.binding_id=? AND d.status='pending' AND (
  (d.part='request' AND r.status='waiting_user') OR
  (d.part='answer' AND r.status IN ('completed','failed','cancelled','interrupted','unknown'))
)
ORDER BY r.sequence LIMIT 1`, bindingID).Scan(&runID, &d.part, &d.messageID)
	if errors.Is(err, sql.ErrNoRows) {
		return d, nil
	}
	if err != nil {
		return d, err
	}
	err = a.Store.Write(ctx, func(tx *sql.Tx) error {
		run, err := store.Get[model.Run](ctx, tx, "SELECT data FROM runs WHERE id=?", runID)
		if err != nil {
			return err
		}
		// Request resolution can race with the initial query.
		if d.part == "request" && run.Status != "waiting_user" {
			return nil
		}
		if err := setChannelDelivery(ctx, tx, run, d.part, "sending"); err != nil {
			return err
		}
		d.run = run
		return nil
	})
	if err != nil {
		return channelDelivery{}, err
	}
	return d, nil
}

func (a *App) deliverChannelReply(runtime *channelRuntime, d channelDelivery) {
	var meta feishuDeliveryMeta
	hasMeta := false
	if loaded, err := store.Get[feishuDeliveryMeta](runtime.ctx, a.Store.DB, "SELECT data FROM feishu_delivery_meta WHERE run_id=?", d.run.ID); err == nil {
		meta = loaded
		hasMeta = true
	}

	replyText := feishuReplyText(d, meta)
	if meta.HideLocal {
		replyText = redactLocalAddresses(replyText)
	}
	if d.part == "answer" {
		replyText = applyReplyMentionPolicy(replyText, meta)
	}

	opts := plugin.ChannelSendOptions{
		MessageID:  d.messageID,
		DeliveryID: d.run.ID + "-" + d.part,
		Text:       replyText,
		Card:       meta.ReplyStyle == "card",
	}
	if hasMeta {
		switch meta.ReplyTarget {
		case "topic":
			opts.MessageID = d.messageID
			opts.ReplyInThread = true
		case "main":
			if meta.RemoteChatID != "" {
				opts.MessageID = ""
				opts.ChatID = meta.RemoteChatID
			}
		case "dm_first":
			if meta.RemoteUserID != "" {
				opts.MessageID = ""
				opts.OpenID = meta.RemoteUserID
			}
		default: // "quote"
			opts.MessageID = d.messageID
		}
	}

	ctx, cancel := context.WithTimeout(runtime.ctx, 12*time.Second)
	err := runtime.bot.Deliver(ctx, opts)
	cancel()

	// Swap reaction OnIt -> DONE best-effort when answer delivery finishes.
	if err == nil && d.part == "answer" && meta.ReactionAck && runtime.bot != nil {
		rctx, rcancel := context.WithTimeout(runtime.ctx, 6*time.Second)
		if meta.ReactionID != "" {
			_ = runtime.bot.DeleteReaction(rctx, d.messageID, meta.ReactionID)
		}
		_, _ = runtime.bot.AddReaction(rctx, d.messageID, "DONE")
		rcancel()
	}

	status := "sent"
	if errors.Is(err, plugin.ChannelDeliveryUnknown) {
		status = "unknown"
	} else if err != nil {
		status = "failed"
	}
	ctx, cancel = context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	a.mu.Lock()
	defer a.mu.Unlock()
	bindingID := ""
	if _, cfg := a.findFeishuBotLocked(runtime.botID); cfg != nil {
		bindingID = cfg.deliveryBindingID()
	}
	saveErr := a.Store.Write(ctx, func(tx *sql.Tx) error {
		if err != nil && status == "failed" {
			var stillBound bool
			if err := tx.QueryRowContext(ctx, "SELECT EXISTS(SELECT 1 FROM channel_deliveries WHERE run_id=? AND part=? AND binding_id=?)",
				d.run.ID, d.part, bindingID).Scan(&stillBound); err != nil {
				return err
			}
			if !stillBound {
				status = "cancelled"
			}
		}
		return setChannelDelivery(ctx, tx, d.run, d.part, status)
	})
	if saveErr != nil {
		slog.Error("save channel reply receipt", "run", d.run.ID, "error", saveErr)
	}
}

func redactLocalAddresses(text string) string {
	text = localAddrRe.ReplaceAllString(text, "[local-address]")
	text = localHomePathRe.ReplaceAllString(text, "~")
	return text
}

func applyReplyMentionPolicy(text string, meta feishuDeliveryMeta) string {
	if meta.ReplyMention == "none" {
		return strings.TrimSpace(feishuAtTagRe.ReplaceAllString(text, ""))
	}
	if meta.ChatType == "group" && meta.ReplyMention == "requester" && meta.RemoteUserID != "" && meta.ReplyTarget != "dm_first" {
		if !strings.Contains(text, "<at id="+meta.RemoteUserID) && !strings.Contains(text, "user_id=\""+meta.RemoteUserID+"\"") {
			if meta.ReplyStyle == "card" {
				return "<at id=" + meta.RemoteUserID + "></at> " + text
			}
			return "<at user_id=\"" + meta.RemoteUserID + "\"></at> " + text
		}
	}
	return text
}

func feishuReplyText(d channelDelivery, meta feishuDeliveryMeta) string {
	if d.part == "request" && meta.ApprovalMode == "feishu_card" {
		return "⚠️ 当前操作需要人工确认，请在 Lever 中批准或拒绝。\nApproval required — open Lever to allow or deny."
	}
	return channelReply(d)
}

func channelReply(d channelDelivery) string {
	if d.part == "request" {
		return "此轮需要你在 Lever 确认。\nOpen Lever to respond to this turn's request."
	}
	switch d.run.Status {
	case "completed":
		// Only the final visible assistant text after the last tool call.
		var parts []string
		for _, item := range d.run.Items {
			switch item.Kind {
			case "text":
				if text := strings.TrimSpace(item.Text); text != "" {
					parts = append(parts, text)
				}
			case "tool", "user":
				parts = nil
			}
		}
		if len(parts) != 0 {
			return strings.Join(parts, "\n\n")
		}
		return "此轮已完成。打开 Lever 查看。\nFinished. Open Lever for details."
	case "unknown":
		return "此轮状态待确认。请在 Lever 查看。\nCheck this turn's status in Lever."
	case "failed":
		return "此轮执行失败。请在 Lever 查看。\nThis turn failed. Open Lever for details."
	default:
		return "此轮已停止。请在 Lever 查看。\nThis turn stopped. Open Lever for details."
	}
}

func setChannelDelivery(ctx context.Context, tx *sql.Tx, run model.Run, part, status string) error {
	if _, err := tx.ExecContext(ctx, "UPDATE channel_deliveries SET status=? WHERE run_id=? AND part=?", status, run.ID, part); err != nil {
		return err
	}
	if part != "answer" {
		return nil
	}
	return store.Event(tx, model.Event{Type: "channel-delivery", ChatID: run.ChatID, SessionID: run.SessionID})
}

func (a *App) RetryChannelReply(ctx context.Context, runID string) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.closed {
		return conflict("The channel is no longer active")
	}
	var channel string
	if err := a.Store.DB.QueryRowContext(ctx, "SELECT COALESCE(json_extract(c.data,'$.channel'),'') FROM chats c JOIN runs r ON r.chat_id=c.id WHERE r.id=?", runID).Scan(&channel); err != nil {
		return err
	}
	var binding string
	if channel != "feishu" {
		p, config, err := a.personalConfig(ctx, channel)
		if err != nil || !p.Enabled || !config.Listening || config.Account == "" {
			return conflict("The channel is no longer active")
		}
		binding = personalBinding(channel, config)
	} else {
		if !a.feishu.enabled {
			return conflict("The channel is no longer active")
		}
		var deliveryBinding string
		if err := a.Store.DB.QueryRowContext(ctx, "SELECT binding_id FROM channel_deliveries WHERE run_id=? AND part='answer'", runID).Scan(&deliveryBinding); err != nil {
			return conflict("This channel reply is no longer retryable")
		}
		matched := false
		for _, bot := range a.feishu.bots {
			if bot.deliveryBindingID() == deliveryBinding {
				matched = true
				break
			}
		}
		if !matched {
			return conflict("The channel is no longer active")
		}
		binding = deliveryBinding
	}
	return a.Store.Write(ctx, func(tx *sql.Tx) error {
		run, err := store.Get[model.Run](ctx, tx, "SELECT data FROM runs WHERE id=?", runID)
		if err != nil {
			return err
		}
		result, err := tx.ExecContext(ctx, "UPDATE channel_deliveries SET status='pending' WHERE run_id=? AND binding_id=? AND part='answer' AND status='failed'", runID, binding)
		if err != nil {
			return err
		}
		if rows, err := result.RowsAffected(); err != nil {
			return err
		} else if rows == 0 {
			return conflict("This channel reply is no longer retryable")
		}
		return store.Event(tx, model.Event{Type: "channel-delivery", ChatID: run.ChatID, SessionID: run.SessionID})
	})
}
