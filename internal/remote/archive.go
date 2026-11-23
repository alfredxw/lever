package remote

import (
	"context"
	"database/sql"
	"errors"

	"path"
	"strings"
	"unicode/utf8"

	"lever/internal/model"
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

func projectBatch(ctx context.Context, s *store.Store, m p.Membership, base int64, full bool) (batch, error) {
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
	b.full = full || base < retained || base > b.version
	if !b.full && b.version == base {
		return b, nil
	}
	var rows *sql.Rows
	if b.full {
		rows, err = tx.QueryContext(ctx, `WITH shared AS(SELECT id FROM chats WHERE json_extract(data,'$.sharedScope.hubId')=?1 AND json_extract(data,'$.sharedScope.spaceId')=?2)
SELECT 'agent',agent_id FROM hub_exposed_agents WHERE hub=?1 AND space=?2
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
	r := p.Record{ID: o.id, Kind: o.kind}
	// An incremental tombstone cannot accidentally read an object if it moved out of scope.
	scope := sharedChatScope
	args := []any{o.id, m.Hub.ID, m.SpaceID}
	if privateController != "" {
		if o.kind == "agent" {
			return r, sql.ErrNoRows
		}
		scope = privateChatScope
		args = append(args, privateController)
		r.Private = true
	}
	switch o.kind {
	case "agent":
		a, err := store.Get[model.Agent](ctx, tx, "SELECT a.data FROM agents a JOIN hub_exposed_agents e ON e.agent_id=a.id WHERE a.id=? AND e.hub=? AND e.space=? AND coalesce(json_extract(a.data,'$.archived'),0)=0", args...)
		if err != nil {
			return r, err
		}
		r.Title, _ = clipped(a.Name, 512)
		if a.Avatar != nil && (a.Avatar.Kind == "emoji" || a.Avatar.Kind == "monogram") {
			r.Avatar, _ = clipped(a.Avatar.Value, 32)
		}
		r.Provider = a.Profile.Provider
		r.Model = a.Profile.Model
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
		c, err := store.Get[model.Chat](ctx, tx, "SELECT c.data FROM chats c WHERE c.id=? AND "+scope, args...)
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
		s, err := store.Get[model.Session](ctx, tx, "SELECT s.data FROM sessions s JOIN chats c ON c.id=s.chat_id WHERE s.id=? AND "+scope, args...)
		if err != nil {
			return r, err
		}
		r.ChatID = s.ChatID
		r.AgentID = s.AgentID
		r.Type = s.Kind
		r.Title, _ = clipped(s.Title, 2048)
		r.WorkingCopyID = s.WorkingCopyID
		r.WorkingCopyName, _ = clipped(s.WorkingCopyName, 512)
		r.CreatedAt = s.CreatedAt
		r.QueuePaused = s.QueuePaused
		if err = tx.QueryRow("SELECT coalesce(json_extract(activity,'$.unreadSequence'),0) FROM sessions WHERE id=?", s.ID).Scan(&r.UnreadSequence); err != nil {
			return r, err
		}
	case "run":
		run, err := store.Get[model.Run](ctx, tx, "SELECT r.data FROM runs r JOIN chats c ON c.id=r.chat_id WHERE r.id=? AND "+scope, args...)
		if err != nil {
			return r, err
		}
		r.AgentID = run.AgentID
		r.ChatID = run.ChatID
		r.SessionID = run.SessionID
		r.CanSteer = run.CanSteer || run.SteerPending
		r.Status = run.Status
		r.Superseded = run.Superseded
		r.Sequence = run.Sequence
		r.CreatedAt = run.CreatedAt
		r.UpdatedAt = run.FinishedAt
		r.Text, r.Truncated = clipped(run.Input, 48<<10)
		r.Error, _ = clipped(run.Error, 2048)
		addFiles := func(files []model.DiffFile) {
			for _, f := range files {
				if len(r.Files) >= 128 {
					r.Truncated = true
					break
				}
				name, _ := clipped(path.Base(strings.ReplaceAll(f.Path, "\\", "/")), 256)
				r.Files = append(r.Files, p.FileStat{Name: name, Additions: f.Additions, Deletions: f.Deletions})
			}
		}
		if run.TurnDiff != nil && run.TurnDiff.Reported {
			addFiles(run.TurnDiff.Files)
		} else {
			for _, change := range run.Changes {
				addFiles(change.Files)
			}
		}
		budget := 128 << 10
		for _, i := range run.Items {
			if budget <= 0 || len(r.Items) == 256 {
				r.Truncated = true
				break
			}
			if i.Kind == "user" && i.Message != nil {
				i.Text = i.Message.Input
			}
			title, ct := clipped(i.Title, 1024)
			text, cx := clipped(i.Text, min(12<<10, budget))
			budget -= len(text) + len(title)
			r.Items = append(r.Items, p.Item{ID: i.ID, Kind: i.Kind, Title: title, Text: text, Truncated: ct || cx})
		}
	case "request":
		q, err := store.Get[model.Request](ctx, tx, "SELECT q.data FROM requests q JOIN chats c ON c.id=q.chat_id WHERE q.id=? AND "+scope, args...)
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
			v.Text, _ = clipped(v.Text, 1024)
			question := p.Question{ID: v.ID, Text: v.Text, Multiple: v.Multiple}
			for idx, opt := range v.Options {
				if idx >= 32 {
					r.Truncated = true
					break
				}
				opt.Label, _ = clipped(opt.Label, 256)
				question.Options = append(question.Options, p.Option{ID: opt.ID, Name: opt.Label})
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

const sharedChatScope = "json_extract(c.data,'$.sharedScope.hubId')=? AND json_extract(c.data,'$.sharedScope.spaceId')=?"
const privateChatScope = "json_type(c.data,'$.sharedScope') IS NULL AND EXISTS(SELECT 1 FROM remote_private_chats g WHERE g.chat=c.id AND g.hub=? AND g.space=? AND g.controller=?)"
