package app

import (
	"context"
	"database/sql"
	"errors"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
	"lever/internal/model"
	"lever/internal/store"
)

type delegateInput struct {
	AgentID    string `json:"agentId" jsonschema:"Target Agent ID from the configured delegation list"`
	RequestKey string `json:"requestKey" jsonschema:"Stable key for this task; reuse it when retrying the same task"`
	Task       string `json:"task" jsonschema:"Self-contained task and necessary context; parent transcript is not shared"`
}
type delegationID struct {
	ID string `json:"id" jsonschema:"Delegation ID returned by delegate_start"`
}
type delegationResult struct {
	Delegation model.Delegation `json:"delegation"`
	Run        model.Run        `json:"run"`
}

func (e *execution) canDelegate() bool {
	return e.session.ParentRunID == "" && len(e.profile.Delegations) > 0
}

func delegationRule(parentRunID string, rules []model.DelegationRule, agentID string) (model.DelegationRule, bool) {
	if parentRunID == "" {
		for _, rule := range rules {
			if rule.AgentID == agentID {
				return rule, true
			}
		}
	}
	return model.DelegationRule{}, false
}

func (a *App) addDelegationTools(ctx context.Context, server *mcp.Server, owner *execution) {
	targets := []model.Agent{}
	for _, rule := range owner.profile.Delegations {
		if target, err := store.Get[model.Agent](ctx, a.Store.DB, "SELECT data FROM agents WHERE id=?", rule.AgentID); err == nil && !target.Archived {
			targets = append(targets, model.Agent{ID: target.ID, Name: target.Name})
		}
	}
	mcp.AddTool(server, &mcp.Tool{Name: "delegate_start", Description: "Start a task on another configured Agent. One hop only. Available targets: " + store.JSON(targets)}, func(ctx context.Context, _ *mcp.CallToolRequest, in delegateInput) (*mcp.CallToolResult, *model.Delegation, error) {
		d, err := a.delegate(ctx, owner, in)
		return nil, &d, err
	})
	mcp.AddTool(server, &mcp.Tool{Name: "delegate_wait", Description: "Wait up to 20 seconds for a delegated task and return its current status and output. Repeat if still active."}, func(ctx context.Context, _ *mcp.CallToolRequest, in delegationID) (*mcp.CallToolResult, *delegationResult, error) {
		d, err := a.ownedDelegation(ctx, owner.run.ID, in.ID)
		if err != nil {
			return nil, nil, err
		}
		a.mu.Lock()
		child := a.active[d.RunID]
		a.mu.Unlock()
		if child != nil {
			select {
			case <-child.done:
			case <-time.After(20 * time.Second):
			case <-ctx.Done():
				return nil, nil, ctx.Err()
			case <-owner.ctx.Done():
				return nil, nil, owner.ctx.Err()
			}
		}
		run, err := store.Get[model.Run](ctx, a.Store.DB, "SELECT data FROM runs WHERE id=?", d.RunID)
		return nil, &delegationResult{d, run}, err
	})
	mcp.AddTool(server, &mcp.Tool{Name: "delegate_cancel", Description: "Stop one of this execution's delegated tasks."}, func(ctx context.Context, _ *mcp.CallToolRequest, in delegationID) (*mcp.CallToolResult, *model.Delegation, error) {
		d, err := a.ownedDelegation(ctx, owner.run.ID, in.ID)
		if err == nil {
			err = a.Stop(ctx, d.RunID)
		}
		return nil, &d, err
	})
}

func (a *App) ownedDelegation(ctx context.Context, parent, id string) (model.Delegation, error) {
	return store.Get[model.Delegation](ctx, a.Store.DB, "SELECT data FROM delegations WHERE id=? AND parent_run_id=?", id, parent)
}

func (a *App) delegate(ctx context.Context, parent *execution, in delegateInput) (model.Delegation, error) {
	parent.delegationMu.Lock()
	defer parent.delegationMu.Unlock()
	var d model.Delegation
	if in.RequestKey == "" || len(in.RequestKey) > 100 {
		return d, invalid("requestKey is required (up to 100 bytes)")
	}
	if in.Task == "" {
		return d, invalid("task is required")
	}
	rule, permitted := delegationRule(parent.session.ParentRunID, parent.profile.Delegations, in.AgentID)
	if !permitted {
		return d, invalid("Target is not allowed by this session's delegation rules")
	}
	digest := hash(in)
	existing, err := store.Get[model.Delegation](ctx, a.Store.DB, "SELECT data FROM delegations WHERE parent_run_id=? AND request_key=?", parent.run.ID, in.RequestKey)
	if err == nil {
		var h string
		if err = a.Store.DB.QueryRowContext(ctx, "SELECT input_hash FROM delegations WHERE id=?", existing.ID).Scan(&h); err != nil {
			return d, err
		}
		if h != digest {
			return d, conflict("requestKey is already bound to a different delegation")
		}
		if existing.RunID != "" {
			return existing, nil
		}
		d = existing
	} else if !errors.Is(err, sql.ErrNoRows) {
		return d, err
	}
	if d.ID == "" && rule.Confirm {
		answer, err := parent.Ask(ctx, model.Request{Kind: "approval", Title: "Delegate task", Detail: in.Task, DelegationAgentID: in.AgentID})
		if err != nil {
			return d, err
		}
		if !answer.Allow {
			return d, errors.New("delegation declined")
		}
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	if parent.ctx.Err() != nil {
		return d, parent.ctx.Err()
	}
	if d.ID == "" {
		d = model.Delegation{ID: ID(), ParentRunID: parent.run.ID, ChatID: ID()}
		err = a.Store.Write(ctx, func(tx *sql.Tx) error {
			target, err := store.Get[model.Agent](ctx, tx, "SELECT data FROM agents WHERE id=?", in.AgentID)
			if err != nil {
				return err
			}
			if target.Archived {
				return conflict("Target agent is archived")
			}
			title := []rune(in.Task)
			if len(title) > 48 {
				title = title[:48]
			}
			chat := model.Chat{ID: d.ChatID, AgentID: target.ID, Title: string(title), Source: "delegation", CreatedAt: now(), UpdatedAt: now()}
			if _, err = tx.Exec("INSERT INTO chats(id,agent_id,data) VALUES(?,?,?)", chat.ID, chat.AgentID, store.JSON(chat)); err != nil {
				return err
			}
			_, err = tx.Exec("INSERT INTO delegations(id,parent_run_id,request_key,input_hash,data) VALUES(?,?,?,?,?)", d.ID, parent.run.ID, in.RequestKey, digest, store.JSON(d))
			return err
		})
		if err != nil {
			return d, err
		}
	}
	run, err := a.sendLocked(ctx, model.SendInput{CommandID: model.DelegationCommandPrefix + d.ID, ChatID: d.ChatID, Operation: "main", Text: in.Task}, sendOrigin{parentRunID: parent.run.ID})
	if err != nil {
		return d, err
	}
	d.RunID = run.ID
	d.SessionID = run.SessionID
	err = a.Store.Write(ctx, func(tx *sql.Tx) error {
		_, err := tx.Exec("UPDATE delegations SET data=? WHERE id=?", store.JSON(d), d.ID)
		return err
	})
	return d, err
}
