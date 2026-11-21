package app

import (
	"context"
	"log/slog"
	"time"

	"lever/internal/model"
	"lever/internal/store"
)

func (a *App) checkIdleCompactions() {
	tick := time.NewTicker(30 * time.Second)
	defer tick.Stop()
	for a.ctx.Err() == nil {
		if err := a.compactDueSessions(a.ctx, time.Now()); err != nil && a.ctx.Err() == nil {
			slog.Warn("check Claude idle compaction", "error", err)
		}
		select {
		case <-a.ctx.Done():
			return
		case <-tick.C:
		}
	}
}

func (a *App) compactDueSessions(ctx context.Context, at time.Time) error {
	// Start with opted-in providers. Only a completed native turn can own
	// a cache window. A newer message, pending work, or a handoff revokes it.
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.closed {
		return nil
	}
	type candidate struct{ Run, Chat, Session, Kind string }
	due, err := store.List[candidate](ctx, a.Store.DB, `SELECT json_object('run',r.id,'chat',s.chat_id,'session',s.id,'kind',s.kind)
FROM providers p JOIN plugins pl ON pl.id=p.data->>'pluginId'
CROSS JOIN sessions s CROSS JOIN runs r ON r.id=s.data->>'$.runtime.context.cacheRunId'
JOIN agents a ON a.id=r.agent_id JOIN chats c ON c.id=s.chat_id
WHERE p.data->>'type'='claude' AND p.data->>'idleCompaction'='beforeCacheExpires'
AND p.data->>'enabled' AND pl.data->>'enabled' AND pl.data->>'installed'
AND s.data->>'$.selection.provider'=p.id AND r.data->>'$.selection.provider'=p.id
AND s.data->>'nativeId'<>'' AND coalesce(s.data->>'queuePaused',0)=0
AND coalesce(s.data->>'$.runtime.goal.status','')<>'active'
AND s.data->>'$.runtime.context.used'>=200000 AND s.data->>'$.runtime.context.promptCacheExpiresAt' BETWEEN ? AND ?
AND coalesce(a.data->>'archived',0)=0 AND c.data->>'channel' IS NULL AND c.data->>'taskId' IS NULL
AND s.data->>'comparison' IS NULL AND s.data->>'parentRunId' IS NULL AND s.data->>'taskId' IS NULL
AND r.status='completed' AND r.session_id=s.id AND coalesce(r.data->>'superseded',0)=0
AND r.data->>'automationId' IS NULL AND r.data->>'task' IS NULL AND r.data->>'input' NOT LIKE '/compact%'
AND r.sequence=(SELECT MAX(sequence) FROM runs WHERE session_id=s.id)
AND NOT EXISTS(SELECT 1 FROM runs b WHERE b.session_id=s.id AND b.status IN ('queued','starting','running','waiting_user','unknown','steering','cancelling'))
AND NOT EXISTS(SELECT 1 FROM json_each(r.data,'$.items') WHERE value->>'kind'='subagent' AND value->>'status' NOT IN ('completed','failed','cancelled','interrupted'))`,
		at.UnixMilli()+1, at.Add(2*time.Minute).UnixMilli())
	if err != nil {
		return err
	}
	for _, item := range due {
		if a.hasActiveSessionLocked(item.Session) {
			continue
		}
		operation := "main"
		if item.Kind == "topic" {
			operation = "reply"
		}
		_, err := a.sendLocked(ctx, model.SendInput{
			CommandID: "idle-compact-" + item.Run, ChatID: item.Chat, SessionID: item.Session,
			Operation: operation, Text: "/compact",
		}, sendOrigin{idleCompaction: true})
		if err != nil {
			slog.Warn("compact idle Claude session", "session", item.Session, "error", err)
		}
	}
	return nil
}
