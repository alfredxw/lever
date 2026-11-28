package remote

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"unicode/utf8"

	"lever/internal/model"
	"lever/internal/provider"
	p "lever/internal/remoteproto"
	"lever/internal/store"
)

type batch struct {
	epoch   string
	version int64
	full    bool
	changes []p.Change
}
type object struct{ kind, id string }

func projectBatch(ctx context.Context, s *store.Store, m p.Membership, base int64, full bool, previousEpoch string) (batch, error) {
	var b batch
	tx, err := s.DB.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return b, err
	}
	defer tx.Rollback()
	var retained int64
	if err = tx.QueryRow("SELECT epoch,version,acked FROM remote_memberships WHERE hub=? AND space=? AND credential IS NOT NULL", m.Hub.ID, m.SpaceID).Scan(&b.epoch, &b.version, &retained); err != nil {
		return b, err
	}
	b.full = full || previousEpoch != b.epoch || base < retained || base > b.version
	if !b.full && b.version == base {
		return b, nil
	}
	var rows *sql.Rows
	if b.full {
		rows, err = tx.QueryContext(ctx, `WITH shared AS(SELECT id FROM chats WHERE json_extract(data,'$.sharedScope.hubId')=?1 AND json_extract(data,'$.sharedScope.spaceId')=?2)
SELECT 'agent',a.id FROM agents a JOIN remote_memberships m ON m.hub=?1 AND m.space=?2
WHERE coalesce(json_extract(a.data,'$.archived'),0)=0 AND coalesce(json_extract(a.data,'$.localOnly'),0)=0 AND (m.expose_all=1 OR EXISTS(SELECT 1 FROM hub_exposed_agents e WHERE e.hub=m.hub AND e.space=m.space AND e.agent_id=a.id))
UNION ALL SELECT 'chat',id FROM shared UNION ALL SELECT 'session',id FROM sessions WHERE chat_id IN shared
UNION ALL SELECT 'run',id FROM runs WHERE chat_id IN shared UNION ALL SELECT 'request',id FROM requests WHERE chat_id IN shared`, m.Hub.ID, m.SpaceID)
	} else {
		rows, err = tx.QueryContext(ctx, "SELECT kind,object_id FROM shared_sync_log WHERE hub=? AND space=? AND version>? ORDER BY version", m.Hub.ID, m.SpaceID, base)
	}
	if err != nil {
		return b, err
	}
	var objects []object
	for rows.Next() {
		var o object
		if err = rows.Scan(&o.kind, &o.id); err != nil {
			rows.Close()
			return b, err
		}
		objects = append(objects, o)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return b, err
	}
	for _, o := range objects {
		rec, err := project(ctx, tx, m, o, "")
		if errors.Is(err, sql.ErrNoRows) {
			b.changes = append(b.changes, p.Change{Record: p.Record{Kind: o.kind, ID: o.id}, Deleted: true})
			continue
		}
		if err != nil {
			return b, err
		}
		b.changes = append(b.changes, p.Change{Record: rec})
	}
	return b, nil
}
func clipped(s string, max int) (string, bool) {
	if len(s) <= max {
		return s, false
	}
	for max > 0 && !utf8.RuneStart(s[max]) {
		max--
	}
	return s[:max], true
}
func project(ctx context.Context, tx *sql.Tx, m p.Membership, o object, privateController string) (p.Record, error) {
	return projectWithOpts(ctx, tx, m, o, privateController, false)
}
func projectWithOpts(ctx context.Context, tx *sql.Tx, m p.Membership, o object, privateController string, lazySteps bool) (p.Record, error) {
	r := p.Record{ID: o.id, Kind: o.kind}
	// An incremental tombstone cannot accidentally read an object if it moved out of scope.
	scope := sharedChatScope
	args := []any{o.id, m.Hub.ID, m.SpaceID}
	if privateController != "" {
		if o.kind == "agent" {
			return r, sql.ErrNoRows
		}
		scope = privateChatCond("?2", "?3", "?4")
		args = append(args, privateController)
		r.Private = true
	}
	switch o.kind {
	case "agent":
		a, err := store.Get[model.Agent](ctx, tx, `SELECT a.data FROM agents a JOIN remote_memberships m ON m.hub=?2 AND m.space=?3
WHERE a.id=?1 AND coalesce(json_extract(a.data,'$.archived'),0)=0 AND coalesce(json_extract(a.data,'$.localOnly'),0)=0
AND (m.expose_all=1 OR EXISTS(SELECT 1 FROM hub_exposed_agents e WHERE e.hub=m.hub AND e.space=m.space AND e.agent_id=a.id))`, args...)
		if err != nil {
			return r, err
		}
		r.Title, _ = clipped(a.Name, 512)
		if a.Avatar != nil {
			val, _ := clipped(a.Avatar.Value, 128)
			col, _ := clipped(a.Avatar.Color, 64)
			r.AvatarSpec = &p.AvatarSpec{Kind: a.Avatar.Kind, Value: val, Color: col}
			if a.Avatar.Kind == "emoji" || a.Avatar.Kind == "monogram" {
				r.Avatar, _ = clipped(a.Avatar.Value, 32)
			}
		}
		r.Description, _ = clipped(a.Profile.Description, 512)
		r.Provider = a.Profile.Provider
		r.Model = a.Profile.Model
		var providerType string
		_ = tx.QueryRowContext(ctx, "SELECT coalesce(json_extract(data,'$.type'),'') FROM providers WHERE id=?", a.Profile.Provider).Scan(&providerType)
		effectivePermission := a.Profile.Permission
		if effectivePermission == "" {
			var defaultMode string
			_ = tx.QueryRowContext(ctx, "SELECT coalesce(json_extract(value,'$.defaultMode'),'') FROM settings WHERE key='permission_settings'").Scan(&defaultMode)
			if defaultMode == string(model.DefaultPermissionYOLO) {
				effectivePermission = "full_access"
			} else {
				effectivePermission = "auto"
			}
		}
		r.Permission = provider.NormalizePermissionMode(providerType, effectivePermission)
		if a.Profile.Provider != "" {
			hidden := map[string]bool{}
			if prov, err := store.Get[model.Provider](ctx, tx, "SELECT data FROM providers WHERE id=?", a.Profile.Provider); err == nil {
				for _, h := range prov.HiddenModels {
					hidden[h] = true
				}
			}
			if cat, err := store.Get[model.Catalog](ctx, tx, "SELECT data FROM provider_catalogs WHERE provider_id=? ORDER BY length(data) DESC LIMIT 1", a.Profile.Provider); err == nil {
				for _, mInfo := range cat.Models {
					if mInfo.ID == "" || hidden[mInfo.ID] {
						continue
					}
					if len(r.Models) >= 48 {
						break
					}
					name, _ := clipped(mInfo.Name, 128)
					r.Models = append(r.Models, p.ModelOption{
						ID:            mInfo.ID,
						Name:          name,
						ResolvedModel: mInfo.ResolvedModel,
						Efforts:       mInfo.Efforts,
						DefaultEffort: mInfo.DefaultEffort,
						Fast:          mInfo.Fast,
					})
				}
			}
		}
		if !a.Profile.CanAcceptDelegations() {
			accept := false
			r.AcceptDelegations = &accept
		}
		groups, err := store.List[model.DirectoryGroup](ctx, tx, "SELECT data FROM working_copies WHERE agent_id=? ORDER BY id", a.ID)
		if err != nil {
			return r, err
		}
		for _, g := range groups {
			if !g.Archived {
				r.Groups = append(r.Groups, p.Group{ID: g.ID, Name: g.Name})
			}
		}
	case "chat":
		c, err := store.Get[model.Chat](ctx, tx, "SELECT c.data FROM chats c WHERE c.id=?1 AND "+scope, args...)
		if err != nil {
			return r, err
		}
		r.AgentID = c.AgentID
		r.Title, _ = clipped(c.Title, 2048)
		r.Type = c.Source
		r.CreatedAt = c.CreatedAt
		r.UpdatedAt = c.UpdatedAt
		if c.SharedTaskRef != nil {
			r.TaskID = c.SharedTaskRef.TaskID
			r.DispatchID = c.SharedTaskRef.DispatchID
		}
	case "session":
		s, err := store.Get[model.Session](ctx, tx, "SELECT s.data FROM sessions s JOIN chats c ON c.id=s.chat_id WHERE s.id=?1 AND "+scope, args...)
		if err != nil {
			return r, err
		}
		r.ChatID = s.ChatID
		r.AgentID = s.AgentID
		r.Type = s.Kind
		r.Title, _ = clipped(s.Title, 2048)
		r.WorkingCopyID = s.WorkingCopyID
		r.WorkingCopyName, _ = clipped(s.WorkingCopyName, 512)
		r.SourceRunID = s.SourceRunID
		r.CreatedAt = s.CreatedAt
		r.QueuePaused = s.QueuePaused
		r.Provider = s.Selection.Provider
		r.Model = s.Selection.Model
		r.Effort = s.Selection.Effort
		r.Fast = s.Selection.Fast
		var preview, messageAt, activityTitle string
		if err = tx.QueryRow(`SELECT
			coalesce(json_extract(activity,'$.unreadSequence'),0),
			coalesce(json_extract(activity,'$.readSequence'),0),
			coalesce(json_extract(activity,'$.clearedSequence'),0),
			coalesce(json_extract(activity,'$.preview'),''),
			coalesce(json_extract(activity,'$.messageAt'),''),
			coalesce(json_extract(activity,'$.title'),'')
			FROM sessions WHERE id=?`, s.ID).Scan(&r.UnreadSequence, &r.ReadSequence, &r.ClearedSequence, &preview, &messageAt, &activityTitle); err != nil {
			return r, err
		}
		if r.Title == "" && activityTitle != "" {
			r.Title, _ = clipped(activityTitle, 2048)
		}
		r.Preview, _ = clipped(preview, 512)
		r.MessageAt = messageAt
		sessionCleared := r.ClearedSequence > 0 && r.ClearedSequence >= r.UnreadSequence
		var activeStatus string
		if sessionCleared {
			// A paused session that has already been cleared is treated as stopped & cleared,
			// not paused/uncleared. Only genuinely running/waiting runs override cleared state.
			if err := tx.QueryRow(`SELECT status FROM runs WHERE session_id=?
				AND status IN ('waiting_user','running','starting','cancelling','unknown')
				ORDER BY CASE status WHEN 'waiting_user' THEN 0 WHEN 'running' THEN 1 WHEN 'starting' THEN 2 ELSE 3 END, sequence DESC LIMIT 1`, s.ID).Scan(&activeStatus); err == nil {
				r.ActiveStatus = activeStatus
			}
			r.QueuePaused = false
		} else if err := tx.QueryRow(`SELECT status FROM runs WHERE session_id=?
			AND status IN ('waiting_user','running','starting','cancelling','unknown','queued','paused')
			ORDER BY CASE status WHEN 'waiting_user' THEN 0 WHEN 'running' THEN 1 WHEN 'starting' THEN 2 WHEN 'paused' THEN 3 WHEN 'queued' THEN 4 ELSE 5 END, sequence DESC LIMIT 1`, s.ID).Scan(&activeStatus); err == nil {
			r.ActiveStatus = activeStatus
		}
		_ = tx.QueryRow(`SELECT COUNT(*) FROM requests WHERE chat_id=? AND status='pending' AND json_extract(data,'$.sessionId')=?`, s.ChatID, s.ID).Scan(&r.PendingCount)
		_ = tx.QueryRow(`SELECT COUNT(*) FROM runs WHERE session_id=? AND status NOT IN ('steering','steered','cancelled') AND coalesce(json_extract(data,'$.superseded'),0)=0`, s.ID).Scan(&r.ReplyCount)
	case "run":
		run, err := store.Get[model.Run](ctx, tx, "SELECT r.data FROM runs r JOIN chats c ON c.id=r.chat_id WHERE r.id=?1 AND "+scope, args...)
		if err != nil {
			return r, err
		}
		r.AgentID = run.AgentID
		r.ChatID = run.ChatID
		r.SessionID = run.SessionID
		r.Provider = run.Selection.Provider
		r.Model = run.Selection.Model
		r.Effort = run.Selection.Effort
		r.Fast = run.Selection.Fast
		for _, att := range run.Attachments {
			name, _ := clipped(att.Name, 256)
			r.Attachments = append(r.Attachments, p.AttachmentRef{
				ID:        att.ID,
				Name:      name,
				MediaType: att.MediaType,
				Size:      att.Size,
			})
		}
		r.CanSteer = run.CanSteer || run.SteerPending
		r.Status = run.Status
		if r.Status == "paused" {
			var unreadSeq, clearedSeq int64
			if err := tx.QueryRow(`SELECT coalesce(json_extract(activity,'$.unreadSequence'),0), coalesce(json_extract(activity,'$.clearedSequence'),0) FROM sessions WHERE id=?`, run.SessionID).Scan(&unreadSeq, &clearedSeq); err == nil {
				if clearedSeq > 0 && clearedSeq >= unreadSeq {
					r.Status = "interrupted"
				}
			}
		}
		r.Superseded = run.Superseded
		r.Sequence = run.Sequence
		r.CreatedAt = run.CreatedAt
		r.UpdatedAt = run.FinishedAt
		r.Text, r.Truncated = clipped(run.Input, 48<<10)
		r.Error, _ = clipped(run.Error, 2048)
		var diff p.DiffSummary
		addDiff := func(files []model.DiffFile) {
			for _, f := range files {
				diff.Files++
				diff.Additions += f.Additions
				diff.Deletions += f.Deletions
			}
		}
		if run.TurnDiff != nil && run.TurnDiff.Reported {
			addDiff(run.TurnDiff.Files)
		} else {
			for _, change := range run.Changes {
				addDiff(change.Files)
			}
		}
		if diff.Files > 0 || diff.Additions > 0 || diff.Deletions > 0 {
			r.Diff = &diff
		}
		r.Items, r.StepCount, r.Truncated = projectRunItems(run.Items, r.Truncated, !lazySteps)
	case "request":
		q, err := store.Get[model.Request](ctx, tx, "SELECT q.data FROM requests q JOIN chats c ON c.id=q.chat_id WHERE q.id=?1 AND "+scope, args...)
		if err != nil {
			return r, err
		}
		r.ChatID = q.ChatID
		r.SessionID = q.SessionID
		r.RunID = q.RunID
		r.Title, _ = clipped(q.Title, 1024)
		r.Text, r.Truncated = clipped(q.Detail, 48<<10)
		r.Status = q.Status
		r.AnsweredByUserID = q.AnsweredByUserID
		r.Type = q.Kind
		for idx, v := range q.Options {
			if idx >= 64 {
				r.Truncated = true
				break
			}
			v.Name, _ = clipped(v.Name, 512)
			r.Options = append(r.Options, p.Option{ID: v.ID, Name: v.Name, Allow: v.Allow})
		}
		for idx, v := range q.Questions {
			if idx >= 32 {
				r.Truncated = true
				break
			}
			v.Header, _ = clipped(v.Header, 256)
			v.Text, _ = clipped(v.Text, 2048)
			v.InitialAnswer, _ = clipped(v.InitialAnswer, 2048)
			v.Placeholder, _ = clipped(v.Placeholder, 256)
			question := p.Question{
				ID:            v.ID,
				Header:        v.Header,
				Text:          v.Text,
				Multiple:      v.Multiple,
				AllowCustom:   v.AllowCustom,
				Required:      v.Required,
				InitialAnswer: v.InitialAnswer,
				Placeholder:   v.Placeholder,
				Secret:        v.Secret,
			}
			for idx, opt := range v.Options {
				if idx >= 32 {
					r.Truncated = true
					break
				}
				opt.Label, _ = clipped(opt.Label, 256)
				opt.Description, _ = clipped(opt.Description, 512)
				opt.Preview, _ = clipped(opt.Preview, 2048)
				question.Options = append(question.Options, p.Option{ID: opt.ID, Name: opt.Label, Description: opt.Description, Preview: opt.Preview})
			}
			r.Questions = append(r.Questions, question)
		}
		if q.Answer != nil {
			r.Answer = &p.Answer{Allow: q.Answer.Allow, OptionID: q.Answer.OptionID, Answers: q.Answer.Answers}
		}
		if q.AllowOnce != nil {
			r.AllowOnce = &p.Answer{Allow: q.AllowOnce.Allow, OptionID: q.AllowOnce.OptionID, Answers: q.AllowOnce.Answers}
		}
	default:
		return r, errors.New("unknown archive object " + o.kind)
	}
	return r, nil
}

// projectRunItems projects a run's items in original chronological order while guaranteeing
// that visible text replies and steered user messages are NEVER starved or dropped by
// verbose intermediate tool/reasoning logs. When includeSteps is false (two-stage lazy
// hydration), intermediate tool/reasoning items are omitted and summarized via stepCount.
func projectRunItems(items []model.Item, alreadyTruncated bool, includeSteps bool) ([]p.Item, int, bool) {
	if len(items) == 0 {
		return nil, 0, alreadyTruncated
	}
	const (
		textTotalBudget = 256 << 10
		textItemLimit   = 64 << 10
		toolTotalBudget = 48 << 10
		toolTextLimit   = 1536
		toolTitleLimit  = 256
		maxToolItems    = 256
	)
	projected := make([]*p.Item, len(items))
	truncated := alreadyTruncated
	stepCount := 0

	// Pass 1: prioritize text & user items from the end backwards so the final answer
	// always receives full budget first.
	textBudget := textTotalBudget
	for idx := len(items) - 1; idx >= 0; idx-- {
		it := items[idx]
		if it.Kind != "text" && it.Kind != "user" {
			stepCount++
			continue
		}
		rawText := it.Text
		if it.Kind == "user" && it.Message != nil {
			rawText = it.Message.Input
		}
		title, ct := clipped(it.Title, 512)
		var text string
		var cx bool
		if textBudget > 0 {
			text, cx = clipped(rawText, min(textItemLimit, textBudget))
			textBudget -= len(text)
		} else if rawText != "" {
			cx = true
		}
		if ct || cx {
			truncated = true
		}
		projected[idx] = &p.Item{ID: it.ID, Kind: it.Kind, Title: title, Text: text, Truncated: ct || cx}
	}

	// Pass 2: optionally project non-text steps (tool/reasoning) under a separate compact budget.
	if includeSteps {
		toolBudget := toolTotalBudget
		toolCount := 0
		for idx := len(items) - 1; idx >= 0; idx-- {
			it := items[idx]
			if it.Kind == "text" || it.Kind == "user" {
				continue
			}
			if toolCount >= maxToolItems {
				truncated = true
				continue
			}
			toolCount++
			title, ct := clipped(it.Title, toolTitleLimit)
			var text string
			var cx bool
			if toolBudget > 0 && it.Text != "" {
				text, cx = clipped(it.Text, min(toolTextLimit, toolBudget))
				toolBudget -= len(text)
			} else if it.Text != "" {
				cx = true
			}
			if ct || cx {
				truncated = true
			}
			projected[idx] = &p.Item{ID: it.ID, Kind: it.Kind, Title: title, Text: text, Truncated: ct || cx}
		}
	}

	out := make([]p.Item, 0, len(items))
	for _, item := range projected {
		if item != nil {
			out = append(out, *item)
		}
	}
	return out, stepCount, truncated
}

// projectRunSteps projects ONLY the intermediate execution steps (tool/reasoning) for on-demand
// lazy expansion when the user taps "N 个执行步骤".
func projectRunSteps(items []model.Item) []p.Item {
	const (
		stepTotalBudget = 128 << 10
		stepTextLimit   = 4 << 10
		stepTitleLimit  = 384
		maxSteps        = 256
	)
	projected := make([]*p.Item, len(items))
	budget := stepTotalBudget
	count := 0
	for idx := len(items) - 1; idx >= 0; idx-- {
		it := items[idx]
		if it.Kind == "text" || it.Kind == "user" {
			continue
		}
		if count >= maxSteps {
			break
		}
		count++
		title, ct := clipped(it.Title, stepTitleLimit)
		var text string
		var cx bool
		if budget > 0 && it.Text != "" {
			text, cx = clipped(it.Text, min(stepTextLimit, budget))
			budget -= len(text)
		} else if it.Text != "" {
			cx = true
		}
		projected[idx] = &p.Item{ID: it.ID, Kind: it.Kind, Title: title, Text: text, Truncated: ct || cx}
	}
	out := make([]p.Item, 0, count)
	for _, item := range projected {
		if item != nil {
			out = append(out, *item)
		}
	}
	return out
}

const remotelyVisibleChat = "coalesce(json_extract(c.data,'$.localOnly'),0)=0 AND EXISTS(SELECT 1 FROM agents visible_agent WHERE visible_agent.id=c.agent_id AND coalesce(json_extract(visible_agent.data,'$.localOnly'),0)=0)"
const sharedChatScope = remotelyVisibleChat + " AND json_extract(c.data,'$.sharedScope.hubId')=?2 AND json_extract(c.data,'$.sharedScope.spaceId')=?3"

func sharedChatCond(hubP, spaceP string) string {
	return remotelyVisibleChat + " AND " + fmt.Sprintf("json_extract(c.data,'$.sharedScope.hubId')=%s AND json_extract(c.data,'$.sharedScope.spaceId')=%s", hubP, spaceP)
}

func privateChatCond(hubP, spaceP, ctrlP string) string {
	return remotelyVisibleChat + " AND " + fmt.Sprintf(`json_type(c.data,'$.sharedScope') IS NULL AND (
		EXISTS(SELECT 1 FROM remote_private_chats g WHERE g.chat=c.id AND g.hub=%[1]s AND g.space=%[2]s AND g.controller=%[3]s)
		OR EXISTS(SELECT 1 FROM remote_memberships m
			JOIN remote_trusted_controllers t USING(hub,space)
			JOIN agents a ON a.id=c.agent_id
			WHERE m.hub=%[1]s AND m.space=%[2]s AND m.origin='' AND t.controller=%[3]s
			AND coalesce(json_extract(a.data,'$.archived'),0)=0 AND coalesce(json_extract(a.data,'$.localOnly'),0)=0
			AND (m.expose_all=1 OR EXISTS(SELECT 1 FROM hub_exposed_agents e WHERE e.hub=m.hub AND e.space=m.space AND e.agent_id=a.id))))`, hubP, spaceP, ctrlP)
}
