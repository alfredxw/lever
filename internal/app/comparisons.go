package app

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"log/slog"
	"path/filepath"
	"slices"

	"lever/internal/model"
	"lever/internal/store"
)

func (a *App) SendComparison(ctx context.Context, input model.ComparisonInput) (model.Comparison, error) {
	var comparison model.Comparison
	if err := validateMessage(input.CommandID, input.Text, input.AttachmentIDs, input.References, input.Quote); err != nil {
		return comparison, err
	}
	if (input.ChatID == "") == (input.AgentID == "") {
		return comparison, invalid("Choose a Chat or the Agent for a new Chat")
	}
	if len(input.AgentIDs) < 2 || len(input.AgentIDs) > model.MaxComparisonAgents {
		return comparison, invalid(fmt.Sprintf("Choose between 2 and %d Agents to compare", model.MaxComparisonAgents))
	}
	seen := map[string]bool{}
	for _, id := range input.AgentIDs {
		if id == "" || seen[id] {
			return comparison, invalid("Choose distinct Agents to compare")
		}
		seen[id] = true
		if input.Selections != nil && input.Selections[id].Provider == "" {
			return comparison, invalid("Choose a runtime for each comparison Agent")
		}
	}
	if input.Selections != nil && len(input.Selections) != len(input.AgentIDs) {
		return comparison, invalid("Runtime selections must belong to the comparison Agents")
	}

	a.mu.Lock()
	defer a.mu.Unlock()
	if a.closed {
		return comparison, conflict("Backend is shutting down")
	}
	digest := hash(input)
	fresh := false
	noteErr := a.validateNoteReferences(ctx, input.References)
	err := a.Store.Write(ctx, func(tx *sql.Tx) error {
		var savedID, savedDigest string
		err := tx.QueryRowContext(ctx, "SELECT id,input_hash FROM comparisons WHERE command_id=?", input.CommandID).Scan(&savedID, &savedDigest)
		if err == nil {
			if savedDigest != digest {
				return errCommandConflict
			}
			comparison, err = store.Get[model.Comparison](ctx, tx, "SELECT data FROM comparisons WHERE id=?", savedID)
			return err
		}
		if !errors.Is(err, sql.ErrNoRows) {
			return err
		}
		if noteErr != nil {
			return noteErr
		}

		chat := model.Chat{ID: ID(), AgentID: input.AgentID, Title: "New chat", Source: "user", CreatedAt: now()}
		if input.ChatID != "" {
			chat, err = store.Get[model.Chat](ctx, tx, "SELECT data FROM chats WHERE id=?", input.ChatID)
			if err != nil {
				return err
			}
		}
		if err := checkDesktopChat(chat); err != nil {
			return err
		}
		owner, err := store.Get[model.Agent](ctx, tx, "SELECT data FROM agents WHERE id=?", chat.AgentID)
		if err != nil {
			return err
		}
		if owner.Archived {
			return conflict("Agent is archived")
		}
		sourceSession := model.Session{Scope: owner.Profile.Scope}
		if input.SharedScope && input.ChatID != "" {
			main, err := store.Get[model.Session](ctx, tx, "SELECT data FROM sessions WHERE chat_id=? AND kind='main'", chat.ID)
			if err == nil {
				sourceSession = main
			} else if !errors.Is(err, sql.ErrNoRows) {
				return err
			}
		}
		chat.UpdatedAt = now()
		if input.ChatID == "" {
			if _, err := tx.Exec("INSERT INTO chats(id,agent_id,data) VALUES(?,?,?)", chat.ID, chat.AgentID, store.JSON(chat)); err != nil {
				return err
			}
		}
		quote, err := resolveQuote(ctx, tx, input.Quote)
		if err != nil {
			return err
		}
		if quote != nil && len(input.Text)+len(quote.Text) > 1<<20 {
			return invalid("Reply and quoted message must total at most 1 MiB")
		}
		files, err := a.messageAttachments(ctx, tx, chat.ID, chat.AgentID, input.AttachmentIDs)
		if err != nil {
			return err
		}

		comparison = model.Comparison{ID: ID(), ChatID: chat.ID}
		for _, id := range input.AgentIDs {
			agent, err := store.Get[model.Agent](ctx, tx, "SELECT data FROM agents WHERE id=?", id)
			if err != nil {
				return err
			}
			if agent.Archived {
				return conflict(agent.Name + " is archived")
			}
			run, err := a.addComparisonTopic(ctx, tx, comparison.ID, chat, sourceSession, owner.Profile, agent, input, files, quote)
			if err != nil {
				var e *Error
				if errors.As(err, &e) {
					return &Error{e.Status, fmt.Sprintf("%s: %s", agent.Name, e.Message)}
				}
				return err
			}
			comparison.SessionIDs = append(comparison.SessionIDs, run.SessionID)
			if comparison.Sequence == 0 {
				comparison.Sequence = run.Sequence
				comparison.Message = *run.UserMessage()
				comparison.Message.References = input.References
				if err := store.SeedChatTitle(tx, &chat, run, model.Run{}); err != nil {
					return err
				}
			}
		}
		if _, err := tx.Exec("INSERT INTO comparisons(id,chat_id,position,command_id,input_hash,data) VALUES(?,?,?,?,?,?)", comparison.ID, chat.ID, comparison.Sequence, input.CommandID, digest, store.JSON(comparison)); err != nil {
			return err
		}
		if _, err := tx.Exec("UPDATE chats SET data=? WHERE id=?", store.JSON(chat), chat.ID); err != nil {
			return err
		}
		fresh = true
		return store.Event(tx, model.Event{Type: "comparison", ChatID: chat.ID})
	})
	if err != nil {
		return model.Comparison{}, err
	}
	if fresh {
		for _, sessionID := range comparison.SessionIDs {
			if err := a.advanceQueueLocked(sessionID); err != nil {
				slog.Error("start accepted comparison Topic", "session", sessionID, "error", err)
				if err := a.pauseQueueLocked(a.ctx, sessionID); err != nil {
					slog.Error("pause comparison Topic queue", "session", sessionID, "error", err)
				}
			}
		}
	}
	return comparison, nil
}

func (a *App) addComparisonTopic(ctx context.Context, tx *sql.Tx, comparisonID string, source model.Chat, sourceSession model.Session, ownerProfile model.Profile, agent model.Agent, input model.ComparisonInput, files []model.Attachment, quote *model.MessageQuote) (model.Run, error) {
	var run model.Run
	profile := agent.Profile
	defaults := model.Selection{Provider: profile.Provider, Model: profile.Model, Permission: profile.Permission}
	choice := input.Selections[agent.ID]
	selection, config, err := resolveSelection(ctx, tx, choice.Selection, defaults)
	if err != nil {
		return run, err
	}
	session := model.Session{
		ID: ID(), ChatID: source.ID, AgentID: agent.ID, Kind: "topic", Scope: profile.Scope,
		Selection: selection, CreatedAt: source.UpdatedAt,
		Comparison: &model.ComparisonOrigin{ID: comparisonID, ChatID: source.ID, ModelName: choice.ModelName},
	}
	if input.SharedScope {
		session.Scope = sourceSession.Scope
		session.WorkingCopyID = sourceSession.WorkingCopyID
		session.WorkingCopyName = sourceSession.WorkingCopyName
	}
	if err := a.checkSessionScope(session); err != nil {
		return run, err
	}
	refs := slices.Clone(input.References)
	for i, ref := range refs {
		if ref.Kind == "skill" && ref.Provider != config.ID && ref.Path == "" {
			// Resolve name-only suggestions where the user picked them. A recipient
			// can have a different package under the same name.
			skill, err := a.resolveNamedSkill(ctx, tx, ownerProfile, sourceSession.Scope, ref)
			if errors.Is(err, errSkillUnavailable) {
				return run, invalid(fmt.Sprintf("Cannot find SKILL.md for %q in the source Agent's skills", ref.Name))
			}
			if err != nil {
				return run, err
			}
			refs[i].Path = filepath.Join(skill.Path, model.SkillEntry)
		}
	}
	if err := a.validateReferences(ctx, tx, refs, session, agent, config, true); err != nil {
		return run, err
	}
	if err := validateSkillReferences(refs, profile.DisabledSkills); err != nil {
		return run, err
	}
	if agent.ID != source.AgentID {
		session.ChatID = ID()
	}
	run = model.Run{
		ID: ID(), SessionID: session.ID, ChatID: session.ChatID, AgentID: agent.ID, ComparisonID: comparisonID,
		Input: input.Text, Selection: selection, Attachments: files, References: refs, Quote: quote,
		Status: "queued", Items: []model.Item{}, Operation: "topic", CreatedAt: session.CreatedAt,
	}
	if session.ChatID != source.ID {
		chat := model.Chat{ID: session.ChatID, AgentID: agent.ID, Title: store.ChatTitle(run), Source: "comparison", CreatedAt: session.CreatedAt, UpdatedAt: session.CreatedAt}
		if _, err := tx.Exec("INSERT INTO chats(id,agent_id,data,title_run_id) VALUES(?,?,?,?)", chat.ID, agent.ID, store.JSON(chat), run.ID); err != nil {
			return run, err
		}
	}
	if _, err := tx.Exec("INSERT INTO sessions(id,chat_id,kind,data) VALUES(?,?,?,?)", session.ID, session.ChatID, session.Kind, store.JSON(session)); err != nil {
		return run, err
	}
	if err := store.InsertRun(tx, &run, run.ID, hash(run)); err != nil {
		return run, err
	}
	return run, linkRunAttachments(tx, run)
}
