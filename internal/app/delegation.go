package app

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
	"lever/internal/model"
	"lever/internal/store"
)

type delegationWorkspace struct {
	projectID       string
	scope           model.Scope
	workingCopyID   string
	workingCopyName string
}

type delegationReceiptWake struct {
	receipts []model.DelegationReceipt
}

type delegateTargetInfo struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Description string `json:"description,omitempty"`
	Provider    string `json:"provider,omitempty"`
	Model       string `json:"model,omitempty"`
	Permission  string `json:"permission,omitempty"`
}

type delegateInput struct {
	AgentID    string `json:"agentId" jsonschema:"Target Agent ID from the configured delegation list"`
	RequestKey string `json:"requestKey" jsonschema:"Stable key for this task within the current turn; reuse it when retrying the same task"`
	Task       string `json:"task" jsonschema:"Self-contained task and necessary context; parent transcript is not shared"`
	Workspace  string `json:"workspace,omitempty" jsonschema:"Workspace scope: 'inherit' (default, share current conversation scope/worktree) or 'agent' (use target Agent's own scope)"`
	AutoWake   *bool  `json:"autoWake,omitempty" jsonschema:"When true (default), automatically wake this conversation with a receipt if the child finishes after this turn ends without its result being collected via delegate_wait"`
}

type delegateReplyInput struct {
	ID         string `json:"id" jsonschema:"Delegation ID returned by delegate_start or delegate_list"`
	RequestKey string `json:"requestKey" jsonschema:"Stable key for this follow-up within the current turn; reuse it when retrying"`
	Message    string `json:"message" jsonschema:"Follow-up instructions, feedback, or review comments for the collaborator"`
	AutoWake   *bool  `json:"autoWake,omitempty" jsonschema:"When true (default), automatically wake this conversation with a receipt if this turn finishes after the parent turn ends without collecting the result"`
}

type delegateWaitInput struct {
	ID             string   `json:"id,omitempty" jsonschema:"Single Delegation ID returned by delegate_start"`
	IDs            []string `json:"ids,omitempty" jsonschema:"Multiple Delegation IDs to wait on in parallel"`
	WaitFor        string   `json:"waitFor,omitempty" jsonschema:"When waiting on multiple IDs: 'all' (default) waits until all finish or timeout; 'any' returns as soon as any finishes"`
	TimeoutSeconds int      `json:"timeoutSeconds,omitempty" jsonschema:"Seconds to wait before returning current progress (default 30, max 120)"`
}

type delegationID struct {
	ID string `json:"id" jsonschema:"Delegation ID returned by delegate_start or delegate_list"`
}

type delegationWaitItem struct {
	Delegation model.Delegation `json:"delegation"`
	Run        model.Run        `json:"run"`
	Output     string           `json:"output,omitempty"`
	Finished   bool             `json:"finished"`
}

type delegationWaitResult struct {
	Delegation  *model.Delegation    `json:"delegation,omitempty"`
	Run         *model.Run           `json:"run,omitempty"`
	Output      string               `json:"output,omitempty"`
	Results     []delegationWaitItem `json:"results"`
	AllFinished bool                 `json:"allFinished"`
}

type delegationSummaryItem struct {
	ID              string `json:"id"`
	AgentID         string `json:"agentId"`
	AgentName       string `json:"agentName"`
	ChatID          string `json:"chatId"`
	SessionID       string `json:"sessionId"`
	RunID           string `json:"runId"`
	Turn            int    `json:"turn"`
	Status          string `json:"status"`
	Workspace       string `json:"workspace,omitempty"`
	WorkingCopyName string `json:"workingCopyName,omitempty"`
	Summary         string `json:"summary,omitempty"`
}

type delegationListResult struct {
	Delegations []delegationSummaryItem `json:"delegations"`
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

func runOutputText(run model.Run) string {
	var parts []string
	for _, item := range run.Items {
		if item.Kind == "text" && strings.TrimSpace(item.Text) != "" {
			parts = append(parts, strings.TrimSpace(item.Text))
		}
	}
	return strings.TrimSpace(strings.Join(parts, "\n\n"))
}

func truncateRunes(text string, limit int) string {
	collapsed := strings.Join(strings.Fields(text), " ")
	runes := []rune(collapsed)
	if len(runes) <= limit {
		return collapsed
	}
	return string(runes[:limit-1]) + "…"
}

func isDelegationFinished(status string) bool {
	return !model.Active(status) && status != "queued"
}

func (a *App) addDelegationTools(ctx context.Context, server *mcp.Server, owner *execution) {
	targets := []delegateTargetInfo{}
	for _, rule := range owner.profile.Delegations {
		if target, err := store.Get[model.Agent](ctx, a.Store.DB, "SELECT data FROM agents WHERE id=?", rule.AgentID); err == nil && !target.Archived {
			var visible bool
			if err := a.Store.DB.QueryRowContext(ctx, `SELECT json_type(c.data,'$.sharedScope') IS NULL OR EXISTS(SELECT 1 FROM hub_exposed_agents WHERE hub=json_extract(c.data,'$.sharedScope.hubId') AND space=json_extract(c.data,'$.sharedScope.spaceId') AND agent_id=?) FROM chats c WHERE c.id=?`, target.ID, owner.session.ChatID).Scan(&visible); err == nil && visible {
				targets = append(targets, delegateTargetInfo{
					ID:          target.ID,
					Name:        target.Name,
					Description: target.Profile.Description,
					Provider:    target.Profile.Provider,
					Model:       target.Profile.Model,
					Permission:  target.Profile.Permission,
				})
			}
		}
	}
	mcp.AddTool(server, &mcp.Tool{
		Name: "delegate_start",
		Description: "Start a task on another configured collaborator Agent (one hop only). Defaults to workspace='inherit' (shares this conversation's scope/worktree); pass workspace='agent' for the collaborator's own scope. You may start multiple tasks in parallel, wait with delegate_wait, continue an existing delegation with delegate_reply, or finish your turn to automatically receive a receipt when autoWake is true (default). Available targets: " + store.JSON(targets),
	}, func(ctx context.Context, _ *mcp.CallToolRequest, in delegateInput) (*mcp.CallToolResult, *model.Delegation, error) {
		d, err := a.delegate(ctx, owner, in)
		return nil, &d, err
	})
	mcp.AddTool(server, &mcp.Tool{
		Name:        "delegate_reply",
		Description: "Send a follow-up message to an existing delegated conversation owned by this session (including delegations started in earlier turns). Preserves the collaborator's conversation memory and workspace.",
	}, func(ctx context.Context, _ *mcp.CallToolRequest, in delegateReplyInput) (*mcp.CallToolResult, *model.Delegation, error) {
		d, err := a.delegateReply(ctx, owner, in)
		return nil, &d, err
	})
	mcp.AddTool(server, &mcp.Tool{
		Name:        "delegate_wait",
		Description: "Wait for one (id) or multiple (ids) delegated tasks owned by this session and return their current status and output. Defaults to waiting up to 30 seconds (max 120s). For long-running work you can also end your turn and rely on automatic receipt wakeups.",
	}, func(ctx context.Context, _ *mcp.CallToolRequest, in delegateWaitInput) (*mcp.CallToolResult, *delegationWaitResult, error) {
		res, err := a.delegateWait(ctx, owner, in)
		return nil, res, err
	})
	mcp.AddTool(server, &mcp.Tool{
		Name:        "delegate_list",
		Description: "List all delegated conversations started in this session across turns, with their IDs, target Agents, turn counts, statuses, and summaries.",
	}, func(ctx context.Context, _ *mcp.CallToolRequest, _ struct{}) (*mcp.CallToolResult, *delegationListResult, error) {
		res, err := a.delegateList(ctx, owner)
		return nil, res, err
	})
	mcp.AddTool(server, &mcp.Tool{
		Name:        "delegate_cancel",
		Description: "Stop an active delegated task owned by this session.",
	}, func(ctx context.Context, _ *mcp.CallToolRequest, in delegationID) (*mcp.CallToolResult, *model.Delegation, error) {
		d, err := a.ownedDelegation(ctx, owner.session.ID, in.ID)
		if err == nil {
			_, _ = a.Store.DB.ExecContext(ctx, "UPDATE delegation_runs SET receipt_consumed=1 WHERE delegation_id=? AND child_run_id=?", d.ID, d.RunID)
			err = a.Stop(ctx, d.RunID)
		}
		return nil, &d, err
	})
}

func (a *App) ownedDelegation(ctx context.Context, parentSessionID, id string) (model.Delegation, error) {
	if strings.TrimSpace(id) == "" {
		return model.Delegation{}, invalid("delegation id is required")
	}
	d, err := store.Get[model.Delegation](ctx, a.Store.DB, `SELECT d.data FROM delegations d
JOIN runs parent ON parent.id=d.parent_run_id
WHERE d.id=? AND (COALESCE(json_extract(d.data,'$.parentSessionId'),'')=? OR parent.session_id=?)`, id, parentSessionID, parentSessionID)
	if err != nil {
		return d, err
	}
	if d.AgentID == "" && d.ChatID != "" {
		if chat, chatErr := store.Get[model.Chat](ctx, a.Store.DB, "SELECT data FROM chats WHERE id=?", d.ChatID); chatErr == nil {
			d.AgentID = chat.AgentID
		}
	}
	if d.ParentSessionID == "" {
		d.ParentSessionID = parentSessionID
	}
	if d.Turn == 0 {
		d.Turn = max(1, len(d.RunIDs))
	}
	return d, nil
}

func (a *App) delegate(ctx context.Context, parent *execution, in delegateInput) (model.Delegation, error) {
	parent.delegationMu.Lock()
	defer parent.delegationMu.Unlock()
	var d model.Delegation
	if in.RequestKey == "" || len(in.RequestKey) > 100 {
		return d, invalid("requestKey is required (up to 100 bytes)")
	}
	if strings.TrimSpace(in.Task) == "" {
		return d, invalid("task is required")
	}
	wsMode := strings.TrimSpace(in.Workspace)
	if wsMode == "" {
		wsMode = "inherit"
	}
	if wsMode != "inherit" && wsMode != "agent" {
		return d, invalid("workspace must be 'inherit' or 'agent'")
	}
	autoWake := true
	if in.AutoWake != nil {
		autoWake = *in.AutoWake
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
	var inherited *delegationWorkspace
	if wsMode == "inherit" && len(parent.session.Scope.Roots) > 0 {
		inherited = &delegationWorkspace{
			projectID:       parent.session.ProjectID,
			scope:           cloneScope(parent.session.Scope),
			workingCopyID:   parent.session.WorkingCopyID,
			workingCopyName: parent.session.WorkingCopyName,
		}
	}
	if d.ID == "" {
		d = model.Delegation{
			ID:              ID(),
			ParentSessionID: parent.session.ID,
			ParentRunID:     parent.run.ID,
			AgentID:         in.AgentID,
			ChatID:          ID(),
			Workspace:       wsMode,
			AutoWake:        autoWake,
		}
		if inherited != nil {
			d.WorkingCopyName = inherited.workingCopyName
		}
		err = a.Store.Write(ctx, func(tx *sql.Tx) error {
			target, err := store.Get[model.Agent](ctx, tx, "SELECT data FROM agents WHERE id=?", in.AgentID)
			if err != nil {
				return err
			}
			if target.Archived {
				return conflict("Target agent is archived")
			}
			title := []rune(strings.TrimSpace(in.Task))
			if len(title) > 48 {
				title = title[:48]
			}
			chat := model.Chat{ID: d.ChatID, AgentID: target.ID, Title: string(title), Source: "delegation", CreatedAt: now(), UpdatedAt: now()}
			parentChat, err := store.Get[model.Chat](ctx, tx, "SELECT data FROM chats WHERE id=?", parent.session.ChatID)
			if err != nil {
				return err
			}
			if parentChat.SharedScope != nil {
				if err = checkExposed(tx, *parentChat.SharedScope, target.ID); err != nil {
					return err
				}
				chat.SharedScope = parentChat.SharedScope
			}
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
	run, err := a.sendLocked(ctx, model.SendInput{
		CommandID: model.DelegationCommandPrefix + d.ID,
		ChatID:    d.ChatID,
		Operation: "main",
		Text:      in.Task,
	}, sendOrigin{parentRunID: parent.run.ID, delegationScope: inherited})
	if err != nil {
		return d, err
	}
	d.RunID = run.ID
	d.SessionID = run.SessionID
	d.Turn = 1
	d.RunIDs = []string{run.ID}
	wakeInt := 0
	if autoWake {
		wakeInt = 1
	}
	err = a.Store.Write(ctx, func(tx *sql.Tx) error {
		if _, err := tx.Exec("UPDATE delegations SET data=? WHERE id=?", store.JSON(d), d.ID); err != nil {
			return err
		}
		if _, err := tx.Exec(`INSERT OR IGNORE INTO delegation_runs(id,delegation_id,parent_session_id,parent_run_id,child_run_id,request_key,input_hash,turn,auto_wake,receipt_consumed,wake_run_id,created_at)
VALUES(?,?,?,?,?,?,?,?,?,0,'',?)`, ID(), d.ID, parent.session.ID, parent.run.ID, run.ID, in.RequestKey, digest, 1, wakeInt, now()); err != nil {
			return err
		}
		return store.Event(tx, model.Event{Type: "delegations", ChatID: parent.session.ChatID})
	})
	return d, err
}

func (a *App) delegateReply(ctx context.Context, parent *execution, in delegateReplyInput) (model.Delegation, error) {
	parent.delegationMu.Lock()
	defer parent.delegationMu.Unlock()
	var d model.Delegation
	if in.RequestKey == "" || len(in.RequestKey) > 100 {
		return d, invalid("requestKey is required (up to 100 bytes)")
	}
	if strings.TrimSpace(in.Message) == "" {
		return d, invalid("message is required")
	}
	autoWake := true
	if in.AutoWake != nil {
		autoWake = *in.AutoWake
	}
	d, err := a.ownedDelegation(ctx, parent.session.ID, in.ID)
	if err != nil {
		return d, err
	}
	rule, permitted := delegationRule(parent.session.ParentRunID, parent.profile.Delegations, d.AgentID)
	if !permitted {
		return d, invalid("Target is not allowed by this session's delegation rules")
	}
	digest := hash(in)
	var existingChildRunID, existingHash string
	var existingTurn int
	err = a.Store.DB.QueryRowContext(ctx, "SELECT child_run_id, input_hash, turn FROM delegation_runs WHERE parent_run_id=? AND request_key=?", parent.run.ID, in.RequestKey).Scan(&existingChildRunID, &existingHash, &existingTurn)
	if err == nil {
		if existingHash != digest {
			return d, conflict("requestKey is already bound to a different delegation")
		}
		d.RunID = existingChildRunID
		d.Turn = existingTurn
		return d, nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return d, err
	}
	if rule.Confirm {
		answer, err := parent.Ask(ctx, model.Request{Kind: "approval", Title: "Delegate follow-up", Detail: in.Message, DelegationAgentID: d.AgentID})
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
	target, err := store.Get[model.Agent](ctx, a.Store.DB, "SELECT data FROM agents WHERE id=?", d.AgentID)
	if err != nil {
		return d, err
	}
	if target.Archived {
		return d, conflict("Target agent is archived")
	}
	// Reload fresh delegation metadata under lock so turn numbers serialize cleanly.
	d, err = a.ownedDelegation(ctx, parent.session.ID, in.ID)
	if err != nil {
		return d, err
	}
	nextTurn := max(d.Turn, len(d.RunIDs)) + 1
	if nextTurn < 2 {
		nextTurn = 2
	}
	cmdID := fmt.Sprintf("%s%s:%d:%s", model.DelegationCommandPrefix, d.ID, nextTurn, ID())
	run, err := a.sendLocked(ctx, model.SendInput{
		CommandID: cmdID,
		ChatID:    d.ChatID,
		Operation: "main",
		Text:      in.Message,
	}, sendOrigin{parentRunID: parent.run.ID})
	if err != nil {
		return d, err
	}
	d.RunID = run.ID
	d.SessionID = run.SessionID
	d.Turn = nextTurn
	d.RunIDs = append(d.RunIDs, run.ID)
	d.AutoWake = autoWake
	wakeInt := 0
	if autoWake {
		wakeInt = 1
	}
	err = a.Store.Write(ctx, func(tx *sql.Tx) error {
		if _, err := tx.Exec("UPDATE delegations SET data=? WHERE id=?", store.JSON(d), d.ID); err != nil {
			return err
		}
		if _, err := tx.Exec(`INSERT INTO delegation_runs(id,delegation_id,parent_session_id,parent_run_id,child_run_id,request_key,input_hash,turn,auto_wake,receipt_consumed,wake_run_id,created_at)
VALUES(?,?,?,?,?,?,?,?,?,0,'',?)`, ID(), d.ID, parent.session.ID, parent.run.ID, run.ID, in.RequestKey, digest, nextTurn, wakeInt, now()); err != nil {
			return err
		}
		return store.Event(tx, model.Event{Type: "delegations", ChatID: parent.session.ChatID})
	})
	return d, err
}

func (a *App) delegateWait(ctx context.Context, owner *execution, in delegateWaitInput) (*delegationWaitResult, error) {
	ids := make([]string, 0, 1+len(in.IDs))
	seen := map[string]bool{}
	addID := func(raw string) {
		id := strings.TrimSpace(raw)
		if id != "" && !seen[id] {
			seen[id] = true
			ids = append(ids, id)
		}
	}
	addID(in.ID)
	for _, id := range in.IDs {
		addID(id)
	}
	if len(ids) == 0 {
		return nil, invalid("Provide id or ids to wait on")
	}
	if len(ids) > 20 {
		return nil, invalid("Wait on up to 20 delegations at once")
	}
	waitFor := strings.TrimSpace(in.WaitFor)
	if waitFor == "" {
		waitFor = "all"
	}
	if waitFor != "all" && waitFor != "any" {
		return nil, invalid("waitFor must be 'all' or 'any'")
	}
	timeout := in.TimeoutSeconds
	if timeout <= 0 {
		timeout = 30
	}
	if timeout > 120 {
		timeout = 120
	}
	deadline := time.NewTimer(time.Duration(timeout) * time.Second)
	defer deadline.Stop()

	loadAll := func() ([]delegationWaitItem, []*execution, bool, bool, error) {
		items := make([]delegationWaitItem, 0, len(ids))
		var activeExecs []*execution
		allFinished := true
		anyFinished := false
		for _, id := range ids {
			d, err := a.ownedDelegation(ctx, owner.session.ID, id)
			if err != nil {
				return nil, nil, false, false, err
			}
			run, err := store.Get[model.Run](ctx, a.Store.DB, "SELECT data FROM runs WHERE id=?", d.RunID)
			if err != nil {
				return nil, nil, false, false, err
			}
			finished := isDelegationFinished(run.Status)
			if finished {
				anyFinished = true
			} else {
				allFinished = false
				a.mu.Lock()
				if child := a.active[d.RunID]; child != nil {
					activeExecs = append(activeExecs, child)
				}
				a.mu.Unlock()
			}
			items = append(items, delegationWaitItem{
				Delegation: d,
				Run:        run,
				Output:     runOutputText(run),
				Finished:   finished,
			})
		}
		return items, activeExecs, allFinished, anyFinished, nil
	}

	var items []delegationWaitItem
	var allFinished bool
	poll := time.NewTicker(250 * time.Millisecond)
	defer poll.Stop()
	for {
		var activeExecs []*execution
		var anyFinished bool
		var err error
		items, activeExecs, allFinished, anyFinished, err = loadAll()
		if err != nil {
			return nil, err
		}
		if (waitFor == "all" && allFinished) || (waitFor == "any" && anyFinished) {
			break
		}
		var firstDone <-chan struct{}
		if len(activeExecs) == 1 {
			firstDone = activeExecs[0].done
		}
		select {
		case <-firstDone:
		case <-poll.C:
		case <-deadline.C:
			goto done
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-owner.ctx.Done():
			return nil, owner.ctx.Err()
		}
	}
done:
	// Reload once after waking so returned run state is completely fresh.
	var err error
	items, _, allFinished, _, err = loadAll()
	if err != nil {
		return nil, err
	}
	// Mark receipts consumed for any terminal child run so Lever will not send a
	// duplicate async wakeup turn after the Lead has already read the result.
	for _, item := range items {
		if item.Finished {
			_, _ = a.Store.DB.ExecContext(ctx, "UPDATE delegation_runs SET receipt_consumed=1 WHERE child_run_id=?", item.Run.ID)
		}
	}
	result := &delegationWaitResult{
		Results:     items,
		AllFinished: allFinished,
	}
	if len(items) == 1 {
		d := items[0].Delegation
		r := items[0].Run
		result.Delegation = &d
		result.Run = &r
		result.Output = items[0].Output
	}
	return result, nil
}

func (a *App) delegateList(ctx context.Context, owner *execution) (*delegationListResult, error) {
	rows, err := a.Store.DB.QueryContext(ctx, `SELECT d.data, r.data, COALESCE(json_extract(ag.data,'$.name'),'')
FROM delegations d
JOIN runs parent ON parent.id=d.parent_run_id
JOIN runs r ON r.id=json_extract(d.data,'$.runId')
LEFT JOIN agents ag ON ag.id=r.agent_id
WHERE COALESCE(json_extract(d.data,'$.parentSessionId'),'')=? OR parent.session_id=?
ORDER BY COALESCE(json_extract(r.data,'$.createdAt'),'')`, owner.session.ID, owner.session.ID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []delegationSummaryItem{}
	for rows.Next() {
		var rawD, rawRun, agentName string
		if err := rows.Scan(&rawD, &rawRun, &agentName); err != nil {
			return nil, err
		}
		var d model.Delegation
		var run model.Run
		if err := json.Unmarshal([]byte(rawD), &d); err != nil {
			return nil, err
		}
		if err := json.Unmarshal([]byte(rawRun), &run); err != nil {
			return nil, err
		}
		turn := max(1, max(d.Turn, len(d.RunIDs)))
		summary := truncateRunes(runOutputText(run), 240)
		if summary == "" && run.Error != "" {
			summary = truncateRunes(run.Error, 240)
		}
		items = append(items, delegationSummaryItem{
			ID:              d.ID,
			AgentID:         run.AgentID,
			AgentName:       agentName,
			ChatID:          d.ChatID,
			SessionID:       d.SessionID,
			RunID:           run.ID,
			Turn:            turn,
			Status:          run.Status,
			Workspace:       d.Workspace,
			WorkingCopyName: d.WorkingCopyName,
			Summary:         summary,
		})
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return &delegationListResult{Delegations: items}, nil
}

func (a *App) cancelParentDelegationWakesLocked(ctx context.Context, parentRunID string) {
	_, _ = a.Store.DB.ExecContext(ctx, "UPDATE delegation_runs SET receipt_consumed=1 WHERE parent_run_id=? AND receipt_consumed=0", parentRunID)
}

func (a *App) delegationChildRunsForParent(ctx context.Context, parentRunID string) map[string]bool {
	out := map[string]bool{}
	rows, err := a.Store.DB.QueryContext(ctx, "SELECT child_run_id FROM delegation_runs WHERE parent_run_id=?", parentRunID)
	if err != nil {
		return out
	}
	defer rows.Close()
	for rows.Next() {
		var id string
		if rows.Scan(&id) == nil {
			out[id] = true
		}
	}
	return out
}

func (a *App) onDelegatedChildFinishedLocked(childRun model.Run) {
	if a.closed {
		return
	}
	var parentSessionID string
	err := a.Store.DB.QueryRowContext(a.ctx, `SELECT parent_session_id FROM delegation_runs
WHERE child_run_id=? AND auto_wake=1 AND receipt_consumed=0 AND wake_run_id=''`, childRun.ID).Scan(&parentSessionID)
	if err != nil {
		return
	}
	if a.hasActiveSessionLocked(parentSessionID) {
		// Parent is still actively running and may consume this via delegate_wait.
		// If it finishes cleanly without reading it, deliverPendingDelegationReceiptsLocked will deliver it.
		return
	}
	a.deliverPendingDelegationReceiptsLocked(parentSessionID)
}

func (a *App) deliverPendingDelegationReceiptsLocked(parentSessionID string) {
	if a.closed || parentSessionID == "" || a.hasActiveSessionLocked(parentSessionID) {
		return
	}
	type pendingRow struct {
		drID         string
		delegationID string
		turn         int
		chatTitle    string
		agentName    string
		childRaw     string
	}
	rows, err := a.Store.DB.QueryContext(a.ctx, `SELECT dr.id, dr.delegation_id, dr.turn,
  COALESCE(json_extract(c.data,'$.title'),''), COALESCE(json_extract(ag.data,'$.name'),''), child.data
FROM delegation_runs dr
JOIN runs parent ON parent.id=dr.parent_run_id
JOIN runs child ON child.id=dr.child_run_id
JOIN chats c ON c.id=child.chat_id
LEFT JOIN agents ag ON ag.id=child.agent_id
WHERE dr.parent_session_id=? AND dr.auto_wake=1 AND dr.receipt_consumed=0 AND dr.wake_run_id=''
  AND parent.status='completed'
  AND child.status IN ('completed','failed','interrupted','unknown')
ORDER BY dr.created_at`, parentSessionID)
	if err != nil {
		return
	}
	var pending []pendingRow
	for rows.Next() {
		var row pendingRow
		if err := rows.Scan(&row.drID, &row.delegationID, &row.turn, &row.chatTitle, &row.agentName, &row.childRaw); err != nil {
			rows.Close()
			return
		}
		pending = append(pending, row)
	}
	rows.Close()
	if len(pending) == 0 {
		return
	}
	parentSession, err := store.Get[model.Session](a.ctx, a.Store.DB, "SELECT data FROM sessions WHERE id=?", parentSessionID)
	if err != nil || parentSession.QueuePaused {
		return
	}
	parentAgent, err := store.Get[model.Agent](a.ctx, a.Store.DB, "SELECT data FROM agents WHERE id=?", parentSession.AgentID)
	if err != nil || parentAgent.Archived {
		return
	}
	receipts := make([]model.DelegationReceipt, 0, len(pending))
	var prompt strings.Builder
	prompt.WriteString("[Delegation receipt]\nThe following delegated collaborator task(s) finished. Review the result(s) and continue the workflow. Use delegate_reply to follow up in the same collaborator conversation or read_chat_context if you need full transcript details.\n")
	drIDs := make([]string, 0, len(pending))
	for _, row := range pending {
		var child model.Run
		if err := json.Unmarshal([]byte(row.childRaw), &child); err != nil {
			continue
		}
		output := runOutputText(child)
		summary := truncateRunes(output, 240)
		if summary == "" && child.Error != "" {
			summary = truncateRunes(child.Error, 240)
		}
		receipt := model.DelegationReceipt{
			DelegationID: row.delegationID,
			AgentID:      child.AgentID,
			AgentName:    row.agentName,
			ChatID:       child.ChatID,
			SessionID:    child.SessionID,
			RunID:        child.ID,
			Turn:         row.turn,
			Status:       child.Status,
			Title:        row.chatTitle,
			Summary:      summary,
			Error:        child.Error,
		}
		receipts = append(receipts, receipt)
		drIDs = append(drIDs, row.drID)

		fmt.Fprintf(&prompt, "\n- Agent: %s (%s)\n  Delegation ID: %s (Turn %d)\n  Status: %s\n",
			row.agentName, child.AgentID, row.delegationID, row.turn, child.Status)
		if child.Error != "" {
			fmt.Fprintf(&prompt, "  Error: %s\n", child.Error)
		}
		if output != "" {
			const maxOutputBytes = 12 << 10
			trimmed := output
			if len(trimmed) > maxOutputBytes {
				trimmed = trimmed[:maxOutputBytes] + "\n...[truncated; inspect child session for full output]"
			}
			fmt.Fprintf(&prompt, "  Output:\n%s\n", trimmed)
		}
	}
	if len(receipts) == 0 {
		return
	}
	op := "main"
	targetSessionID := ""
	if parentSession.Kind == "topic" {
		op = "reply"
		targetSessionID = parentSession.ID
	}
	wakeRun, err := a.sendLocked(a.ctx, model.SendInput{
		CommandID: "delegation-receipt:" + ID(),
		ChatID:    parentSession.ChatID,
		SessionID: targetSessionID,
		Operation: op,
		Text:      prompt.String(),
	}, sendOrigin{delegationWake: &delegationReceiptWake{receipts: receipts}})
	if err != nil {
		slog.Warn("deliver delegation receipt", "session", parentSessionID, "error", err)
		return
	}
	if err := a.Store.Write(a.ctx, func(tx *sql.Tx) error {
		for _, id := range drIDs {
			if _, err := tx.ExecContext(a.ctx, "UPDATE delegation_runs SET receipt_consumed=1, wake_run_id=? WHERE id=?", wakeRun.ID, id); err != nil {
				return err
			}
		}
		return nil
	}); err != nil {
		slog.Warn("record delegation receipt delivery", "session", parentSessionID, "error", err)
	}
}
