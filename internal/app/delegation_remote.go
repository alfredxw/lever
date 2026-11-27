package app

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"slices"
	"strings"
	"time"

	"github.com/google/uuid"
	"lever/internal/model"
	"lever/internal/provider"
	p "lever/internal/remoteproto"
	"lever/internal/store"
)

// RemoteCollaborator bridges App delegation to paired Hub/LAN devices without
// importing internal/remote from internal/app.
type RemoteCollaborator interface {
	ListRemoteTargets(ctx context.Context, scope *model.SharedScope) ([]model.RemoteAgentTarget, error)
	SubmitRemoteIntent(ctx context.Context, scope model.SharedScope, intent p.Intent) (p.InboxItem, error)
	LookupRemoteCommand(ctx context.Context, scope model.SharedScope, deviceID, commandID string) (p.InboxItem, error)
	ReadRemoteChat(ctx context.Context, scope model.SharedScope, deviceID, chatID string) ([]p.Record, error)
}

type remoteDelegationRow struct {
	ID              string
	DelegationID    string
	ParentSessionID string
	ParentRunID     string
	CommandID       string
	RequestKey      string
	InputHash       string
	Turn            int
	HubID           string
	SpaceID         string
	DeviceID        string
	DeviceName      string
	AgentID         string
	AgentName       string
	Title           string
	ChatID          string
	SessionID       string
	RunID           string
	Provider        string
	Model           string
	WorkingCopyID   string
	WorkingCopyName string
	Status          string
	Output          string
	Summary         string
	Error           string
	RequestsJSON    string
	AutoWake        bool
	ReceiptConsumed bool
	WakeRunID       string
	PendingCancel   bool
	CreatedAt       string
	UpdatedAt       string
}

func (a *App) SetRemoteCollaborator(rc RemoteCollaborator) {
	a.mu.Lock()
	a.remoteCollab = rc
	a.mu.Unlock()
	a.wakeRemoteDelegations()
}

func (a *App) remoteCollaborator() RemoteCollaborator {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.remoteCollab
}

func (a *App) StartRemoteDelegationFollower() {
	a.mu.Lock()
	if a.closed || a.remoteDelegationStarted {
		a.mu.Unlock()
		return
	}
	a.remoteDelegationStarted = true
	a.mu.Unlock()
	a.wg.Add(1)
	go a.runRemoteDelegationFollower()
}

func (a *App) wakeRemoteDelegations() {
	if a.remoteDelegationWake == nil {
		return
	}
	select {
	case a.remoteDelegationWake <- struct{}{}:
	default:
	}
}

func (a *App) notifyRemoteDelegationWaiters() {
	a.mu.Lock()
	ch := a.remoteDelegationNotify
	a.remoteDelegationNotify = make(chan struct{})
	a.mu.Unlock()
	if ch != nil {
		close(ch)
	}
}

func (a *App) remoteDelegationSignal() <-chan struct{} {
	a.mu.Lock()
	if a.remoteDelegationNotify == nil {
		a.remoteDelegationNotify = make(chan struct{})
	}
	ch := a.remoteDelegationNotify
	a.mu.Unlock()
	return ch
}

func deterministicRemoteCommandID(parts ...string) string {
	return uuid.NewSHA1(uuid.NameSpaceOID, []byte(strings.Join(parts, ":"))).String()
}

func (a *App) RemoteDelegationTargets(ctx context.Context, chatID, agentID string) ([]model.RemoteAgentTarget, error) {
	rc := a.remoteCollaborator()
	if rc == nil {
		return []model.RemoteAgentTarget{}, nil
	}
	var sharedScope *model.SharedScope
	if chatID != "" {
		if chat, err := store.Get[model.Chat](ctx, a.Store.DB, "SELECT data FROM chats WHERE id=?", chatID); err == nil {
			sharedScope = chat.SharedScope
			if agentID == "" {
				agentID = chat.AgentID
			}
		}
	}
	var agent model.Agent
	hasAgent := false
	if agentID != "" {
		if ag, err := store.Get[model.Agent](ctx, a.Store.DB, "SELECT data FROM agents WHERE id=?", agentID); err == nil {
			agent = ag
			hasAgent = true
		}
	}
	all, err := rc.ListRemoteTargets(ctx, sharedScope)
	if err != nil {
		return []model.RemoteAgentTarget{}, nil
	}
	if !hasAgent {
		return all, nil
	}
	defaults, err := delegationSettings(ctx, a.Store.DB)
	if err != nil {
		return nil, err
	}
	policy := agent.Profile.EffectiveDelegationPolicy(defaults)
	if policy == model.DelegationPolicyNone {
		return []model.RemoteAgentTarget{}, nil
	}
	if policy == model.DelegationPolicyAll && !agent.Profile.AllowsRemoteDelegation() {
		return []model.RemoteAgentTarget{}, nil
	}
	out := make([]model.RemoteAgentTarget, 0, len(all))
	for _, target := range all {
		if !target.Online || target.Draining {
			continue
		}
		if policy == model.DelegationPolicySelected {
			if _, ok := findDelegationRule(agent.Profile.Delegations, target.DeviceID, target.AgentID); !ok {
				continue
			}
		}
		out = append(out, target)
	}
	return out, nil
}

func (a *App) delegateRemote(ctx context.Context, parent *execution, in delegateInput) (model.Delegation, error) {
	var d model.Delegation
	rc := a.remoteCollaborator()
	if rc == nil {
		return d, invalid("Remote device collaboration is not configured on this host")
	}
	wsMode := strings.TrimSpace(in.Workspace)
	if wsMode == "inherit" {
		return d, invalid("workspace='inherit' is not supported for remote devices because local paths do not exist there; omit workspace or pass workspace='agent' (and optionally workingCopyId)")
	}
	if wsMode == "" {
		wsMode = "agent"
	}
	if wsMode != "agent" {
		return d, invalid("workspace must be 'agent' for remote devices")
	}
	autoWake := true
	if in.AutoWake != nil {
		autoWake = *in.AutoWake
	}
	rule, permitted := parent.delegationRuleFor(in.DeviceID, in.AgentID)
	if !permitted {
		return d, invalid("Target remote Agent is not allowed by this session's delegation policy")
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
		return existing, nil
	} else if !errors.Is(err, sql.ErrNoRows) {
		return d, err
	}
	if err := a.checkDelegationConcurrency(ctx, parent.session.ID); err != nil {
		return d, err
	}
	parentChat, err := store.Get[model.Chat](ctx, a.Store.DB, "SELECT data FROM chats WHERE id=?", parent.session.ChatID)
	if err != nil {
		return d, err
	}
	targets, err := rc.ListRemoteTargets(ctx, parentChat.SharedScope)
	if err != nil {
		return d, fmt.Errorf("discover remote targets: %w", err)
	}
	var target *model.RemoteAgentTarget
	for i := range targets {
		if targets[i].DeviceID == in.DeviceID && targets[i].AgentID == in.AgentID {
			t := targets[i]
			target = &t
			break
		}
	}
	if target == nil {
		return d, invalid("Target remote Agent was not found in this space")
	}
	if !target.Online || target.Draining {
		return d, conflict("Target remote device is offline or paused")
	}
	workingCopyID := strings.TrimSpace(in.WorkingCopyID)
	workingCopyName := ""
	if workingCopyID != "" {
		found := false
		for _, wc := range target.WorkingCopies {
			if wc.ID == workingCopyID && wc.State != "unavailable" {
				found = true
				workingCopyName = wc.Name
				break
			}
		}
		if !found {
			return d, invalid("Target workingCopyId is unavailable on the remote Agent")
		}
	} else if target.DefaultBusy {
		for _, wc := range target.WorkingCopies {
			if (wc.State == "" || wc.State == "ready") && !wc.Busy {
				workingCopyID = wc.ID
				workingCopyName = wc.Name
				break
			}
		}
	}
	if rule.Confirm {
		label := target.Name
		if target.DeviceName != "" {
			label = target.DeviceName + " · " + target.Name
		}
		answer, err := parent.Ask(ctx, model.Request{Kind: "approval", Title: "Delegate task to " + label, Detail: in.Task, DelegationAgentID: in.AgentID})
		if err != nil {
			return d, err
		}
		if !answer.Allow {
			return d, errors.New("delegation declined")
		}
	}
	if parent.ctx.Err() != nil {
		return d, parent.ctx.Err()
	}

	parentAgentName := ""
	if ag, err := store.Get[model.Agent](ctx, a.Store.DB, "SELECT data FROM agents WHERE id=?", parent.session.AgentID); err == nil {
		parentAgentName = ag.Name
	}
	titleRunes := []rune(strings.TrimSpace(in.Task))
	if len(titleRunes) > 48 {
		titleRunes = titleRunes[:48]
	}
	title := string(titleRunes)

	d = model.Delegation{
		ID:              ID(),
		ParentSessionID: parent.session.ID,
		ParentRunID:     parent.run.ID,
		HubID:           target.HubID,
		SpaceID:         target.SpaceID,
		DeviceID:        target.DeviceID,
		DeviceName:      target.DeviceName,
		AgentID:         target.AgentID,
		AgentName:       target.Name,
		Turn:            1,
		Workspace:       "agent",
		WorkingCopyID:   workingCopyID,
		WorkingCopyName: workingCopyName,
		AutoWake:        autoWake,
	}
	cmdID := deterministicRemoteCommandID("lever:delegate", parent.run.ID, in.RequestKey)
	rowID := ID()
	wakeInt := 0
	if autoWake {
		wakeInt = 1
	}
	ts := now()
	err = a.Store.Write(ctx, func(tx *sql.Tx) error {
		if _, err := tx.Exec("INSERT INTO delegations(id,parent_run_id,request_key,input_hash,data) VALUES(?,?,?,?,?)", d.ID, parent.run.ID, in.RequestKey, digest, store.JSON(d)); err != nil {
			return err
		}
		if _, err := tx.Exec(`INSERT INTO remote_delegation_runs(
id,delegation_id,parent_session_id,parent_run_id,command_id,request_key,input_hash,turn,
hub_id,space_id,device_id,device_name,agent_id,agent_name,title,provider,model,working_copy_id,working_copy_name,
status,auto_wake,receipt_consumed,wake_run_id,pending_cancel,created_at,updated_at)
VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'starting',?,0,'',0,?,?)`,
			rowID, d.ID, parent.session.ID, parent.run.ID, cmdID, in.RequestKey, digest, 1,
			target.HubID, target.SpaceID, target.DeviceID, target.DeviceName, target.AgentID, target.Name,
			title, target.Provider, target.Model, workingCopyID, workingCopyName, wakeInt, ts, ts); err != nil {
			return err
		}
		return store.Event(tx, model.Event{Type: "delegations", ChatID: parent.session.ChatID})
	})
	if err != nil {
		return d, err
	}

	parent.mu.Lock()
	maxPerm := provider.NormalizePermissionMode(parent.provider.Type, parent.run.Selection.Permission)
	parent.mu.Unlock()
	intent := p.Intent{
		ID:            cmdID,
		Kind:          "send",
		DeviceID:      target.DeviceID,
		AgentID:       target.AgentID,
		WorkingCopyID: workingCopyID,
		Operation:     "main",
		Text:          in.Task,
		Delegation: &p.DelegationOrigin{
			DeviceID:          a.Store.DeviceID,
			DeviceName:        a.deviceName(),
			AgentID:           parent.session.AgentID,
			AgentName:         parentAgentName,
			ChatID:            parent.session.ChatID,
			SessionID:         parent.session.ID,
			RunID:             parent.run.ID,
			DelegationID:      d.ID,
			MaxPermissionMode: maxPerm,
			Depth:             parent.session.EffectiveDelegationDepth() + 1,
			MaxDepth:          min(parent.delegationMaxDepth, 2),
			Chain:             parent.nextDelegationChain(),
		},
	}
	scope := model.SharedScope{HubID: target.HubID, SpaceID: target.SpaceID}
	item, err := rc.SubmitRemoteIntent(ctx, scope, intent)
	if err != nil {
		_ = a.markRemoteDelegationFailed(ctx, parent.session.ChatID, rowID, err.Error())
		return d, err
	}
	item = a.awaitInitialRemoteReceipt(ctx, rc, scope, target.DeviceID, cmdID, item)
	switch item.Receipt.Status {
	case "accepted":
		d.ChatID = item.Receipt.ChatID
		d.SessionID = item.Receipt.SessionID
		d.RunID = item.Receipt.RunID
		d.RunIDs = []string{item.Receipt.RunID}
		_ = a.Store.Write(ctx, func(tx *sql.Tx) error {
			if _, err := tx.Exec("UPDATE delegations SET data=? WHERE id=?", store.JSON(d), d.ID); err != nil {
				return err
			}
			if _, err := tx.Exec("UPDATE remote_delegation_runs SET chat_id=?,session_id=?,run_id=?,status='running',updated_at=? WHERE id=?",
				d.ChatID, d.SessionID, d.RunID, now(), rowID); err != nil {
				return err
			}
			return store.Event(tx, model.Event{Type: "delegations", ChatID: parent.session.ChatID})
		})
	case "declined", "failed", "cancelled":
		msg := item.Receipt.Detail
		if msg == "" {
			msg = "Remote host " + item.Receipt.Status + " the delegation"
		}
		_ = a.markRemoteDelegationFailed(ctx, parent.session.ChatID, rowID, msg)
		return d, errors.New(msg)
	default:
		// Still pending/reviewing on remote host; follower will track until accepted or declined.
		_ = a.Store.Write(ctx, func(tx *sql.Tx) error {
			if _, err := tx.Exec("UPDATE remote_delegation_runs SET status='queued',updated_at=? WHERE id=?", now(), rowID); err != nil {
				return err
			}
			return store.Event(tx, model.Event{Type: "delegations", ChatID: parent.session.ChatID})
		})
	}
	a.StartRemoteDelegationFollower()
	a.wakeRemoteDelegations()
	return d, nil
}

func (a *App) delegateReplyRemote(ctx context.Context, parent *execution, d model.Delegation, in delegateReplyInput) (model.Delegation, error) {
	rc := a.remoteCollaborator()
	if rc == nil {
		return d, invalid("Remote device collaboration is not configured on this host")
	}
	if d.ChatID == "" {
		return d, conflict("Remote delegation has not been accepted by the target device yet")
	}
	autoWake := true
	if in.AutoWake != nil {
		autoWake = *in.AutoWake
	}
	digest := hash(in)
	var existingRunID, existingHash string
	var existingTurn int
	err := a.Store.DB.QueryRowContext(ctx, "SELECT run_id, input_hash, turn FROM remote_delegation_runs WHERE parent_run_id=? AND request_key=?", parent.run.ID, in.RequestKey).Scan(&existingRunID, &existingHash, &existingTurn)
	if err == nil {
		if existingHash != digest {
			return d, conflict("requestKey is already bound to a different delegation")
		}
		d.RunID = existingRunID
		d.Turn = existingTurn
		return d, nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return d, err
	}
	if err := a.checkDelegationConcurrency(ctx, parent.session.ID); err != nil {
		return d, err
	}
	if parent.ctx.Err() != nil {
		return d, parent.ctx.Err()
	}

	nextTurn := max(d.Turn, len(d.RunIDs)) + 1
	if nextTurn < 2 {
		nextTurn = 2
	}
	parentAgentName := ""
	if ag, err := store.Get[model.Agent](ctx, a.Store.DB, "SELECT data FROM agents WHERE id=?", parent.session.AgentID); err == nil {
		parentAgentName = ag.Name
	}
	titleRunes := []rune(strings.TrimSpace(in.Message))
	if len(titleRunes) > 48 {
		titleRunes = titleRunes[:48]
	}
	cmdID := deterministicRemoteCommandID("lever:delegate-reply", d.ID, parent.run.ID, in.RequestKey)
	rowID := ID()
	wakeInt := 0
	if autoWake {
		wakeInt = 1
	}
	ts := now()
	var prevProvider, prevModel string
	_ = a.Store.DB.QueryRowContext(ctx, "SELECT provider, model FROM remote_delegation_runs WHERE delegation_id=? ORDER BY turn DESC LIMIT 1", d.ID).Scan(&prevProvider, &prevModel)
	err = a.Store.Write(ctx, func(tx *sql.Tx) error {
		if _, err := tx.Exec(`INSERT INTO remote_delegation_runs(
id,delegation_id,parent_session_id,parent_run_id,command_id,request_key,input_hash,turn,
hub_id,space_id,device_id,device_name,agent_id,agent_name,title,chat_id,session_id,provider,model,working_copy_id,working_copy_name,
status,auto_wake,receipt_consumed,wake_run_id,pending_cancel,created_at,updated_at)
VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'starting',?,0,'',0,?,?)`,
			rowID, d.ID, parent.session.ID, parent.run.ID, cmdID, in.RequestKey, digest, nextTurn,
			d.HubID, d.SpaceID, d.DeviceID, d.DeviceName, d.AgentID, d.AgentName, string(titleRunes),
			d.ChatID, d.SessionID, prevProvider, prevModel, d.WorkingCopyID, d.WorkingCopyName, wakeInt, ts, ts); err != nil {
			return err
		}
		return store.Event(tx, model.Event{Type: "delegations", ChatID: parent.session.ChatID})
	})
	if err != nil {
		return d, err
	}

	parent.mu.Lock()
	maxPerm := provider.NormalizePermissionMode(parent.provider.Type, parent.run.Selection.Permission)
	parent.mu.Unlock()
	intent := p.Intent{
		ID:        cmdID,
		Kind:      "send",
		DeviceID:  d.DeviceID,
		AgentID:   d.AgentID,
		ChatID:    d.ChatID,
		Operation: "main",
		Text:      in.Message,
		Delegation: &p.DelegationOrigin{
			DeviceID:          a.Store.DeviceID,
			DeviceName:        a.deviceName(),
			AgentID:           parent.session.AgentID,
			AgentName:         parentAgentName,
			ChatID:            parent.session.ChatID,
			SessionID:         parent.session.ID,
			RunID:             parent.run.ID,
			DelegationID:      d.ID,
			MaxPermissionMode: maxPerm,
			Depth:             parent.session.EffectiveDelegationDepth() + 1,
			MaxDepth:          min(parent.delegationMaxDepth, 2),
			Chain:             parent.nextDelegationChain(),
		},
	}
	scope := model.SharedScope{HubID: d.HubID, SpaceID: d.SpaceID}
	item, err := rc.SubmitRemoteIntent(ctx, scope, intent)
	if err != nil {
		_ = a.markRemoteDelegationFailed(ctx, parent.session.ChatID, rowID, err.Error())
		return d, err
	}
	item = a.awaitInitialRemoteReceipt(ctx, rc, scope, d.DeviceID, cmdID, item)
	switch item.Receipt.Status {
	case "accepted":
		d.RunID = item.Receipt.RunID
		if item.Receipt.SessionID != "" {
			d.SessionID = item.Receipt.SessionID
		}
		d.Turn = nextTurn
		d.RunIDs = append(d.RunIDs, d.RunID)
		d.AutoWake = autoWake
		_ = a.Store.Write(ctx, func(tx *sql.Tx) error {
			if _, err := tx.Exec("UPDATE delegations SET data=? WHERE id=?", store.JSON(d), d.ID); err != nil {
				return err
			}
			if _, err := tx.Exec("UPDATE remote_delegation_runs SET session_id=?,run_id=?,status='running',updated_at=? WHERE id=?",
				d.SessionID, d.RunID, now(), rowID); err != nil {
				return err
			}
			return store.Event(tx, model.Event{Type: "delegations", ChatID: parent.session.ChatID})
		})
	case "declined", "failed", "cancelled":
		msg := item.Receipt.Detail
		if msg == "" {
			msg = "Remote host " + item.Receipt.Status + " the delegation follow-up"
		}
		_ = a.markRemoteDelegationFailed(ctx, parent.session.ChatID, rowID, msg)
		return d, errors.New(msg)
	default:
		d.Turn = nextTurn
		d.AutoWake = autoWake
		_ = a.Store.Write(ctx, func(tx *sql.Tx) error {
			if _, err := tx.Exec("UPDATE delegations SET data=? WHERE id=?", store.JSON(d), d.ID); err != nil {
				return err
			}
			if _, err := tx.Exec("UPDATE remote_delegation_runs SET status='queued',updated_at=? WHERE id=?", now(), rowID); err != nil {
				return err
			}
			return store.Event(tx, model.Event{Type: "delegations", ChatID: parent.session.ChatID})
		})
	}
	a.StartRemoteDelegationFollower()
	a.wakeRemoteDelegations()
	return d, nil
}

func (a *App) awaitInitialRemoteReceipt(ctx context.Context, rc RemoteCollaborator, scope model.SharedScope, deviceID, commandID string, item p.InboxItem) p.InboxItem {
	if item.Receipt.Status != "pending" && item.Receipt.Status != "reviewing" {
		return item
	}
	deadline := time.Now().Add(1500 * time.Millisecond)
	ticker := time.NewTicker(80 * time.Millisecond)
	defer ticker.Stop()
	for time.Now().Before(deadline) {
		select {
		case <-ctx.Done():
			return item
		case <-ticker.C:
			if next, err := rc.LookupRemoteCommand(ctx, scope, deviceID, commandID); err == nil {
				item = next
				if item.Receipt.Status != "pending" && item.Receipt.Status != "reviewing" {
					return item
				}
			}
		}
	}
	return item
}

func (a *App) markRemoteDelegationFailed(ctx context.Context, parentChatID, rowID, message string) error {
	return a.Store.Write(ctx, func(tx *sql.Tx) error {
		if _, err := tx.Exec("UPDATE remote_delegation_runs SET status='failed',error=?,summary=?,receipt_consumed=1,updated_at=? WHERE id=?",
			message, truncateRunes(message, 180), now(), rowID); err != nil {
			return err
		}
		return store.Event(tx, model.Event{Type: "delegations", ChatID: parentChatID})
	})
}

func (a *App) cancelRemoteDelegation(ctx context.Context, d model.Delegation) error {
	var row remoteDelegationRow
	if err := a.loadLatestRemoteDelegationRow(ctx, d.ID, &row); err != nil {
		return err
	}
	_, _ = a.Store.DB.ExecContext(ctx, "UPDATE remote_delegation_runs SET receipt_consumed=1,pending_cancel=1,updated_at=? WHERE id=?", now(), row.ID)
	a.StartRemoteDelegationFollower()
	a.wakeRemoteDelegations()
	return a.tryStopRemoteDelegationRow(ctx, row)
}

func (a *App) stopRemoteDelegationsForParentLocked(ctx context.Context, parentRunID string) {
	_, _ = a.Store.DB.ExecContext(ctx, "UPDATE remote_delegation_runs SET receipt_consumed=1,pending_cancel=1,updated_at=? WHERE parent_run_id=? AND status IN ('queued','starting','running','waiting_user')", now(), parentRunID)
	a.wakeRemoteDelegations()
}

func (a *App) tryStopRemoteDelegationRow(ctx context.Context, row remoteDelegationRow) error {
	rc := a.remoteCollaborator()
	if rc == nil || row.ChatID == "" || row.RunID == "" {
		return nil
	}
	scope := model.SharedScope{HubID: row.HubID, SpaceID: row.SpaceID}
	cmdID := deterministicRemoteCommandID("lever:delegate-stop", row.ID, row.RunID)
	_, err := rc.SubmitRemoteIntent(ctx, scope, p.Intent{
		ID:       cmdID,
		Kind:     "stop",
		DeviceID: row.DeviceID,
		ChatID:   row.ChatID,
		RunID:    row.RunID,
	})
	if err != nil {
		return err
	}
	_, _ = a.Store.DB.ExecContext(ctx, "UPDATE remote_delegation_runs SET pending_cancel=0,updated_at=? WHERE id=?", now(), row.ID)
	return nil
}

func (a *App) AnswerRemoteDelegationRequest(ctx context.Context, rowID, requestID string, answer *model.Answer, allowRun bool) error {
	rc := a.remoteCollaborator()
	if rc == nil {
		return invalid("Remote device collaboration is not configured on this host")
	}
	var row remoteDelegationRow
	if err := a.loadRemoteDelegationRowByID(ctx, rowID, &row); err != nil {
		return err
	}
	if row.ChatID == "" || row.RunID == "" {
		return conflict("Remote delegation is not ready")
	}
	scope := model.SharedScope{HubID: row.HubID, SpaceID: row.SpaceID}
	intent := p.Intent{
		ID:       ID(),
		DeviceID: row.DeviceID,
		ChatID:   row.ChatID,
		RunID:    row.RunID,
	}
	if allowRun {
		intent.Kind = "allow_run"
	} else {
		if requestID == "" || answer == nil {
			return invalid("requestId and answer are required")
		}
		intent.Kind = "answer"
		intent.RequestID = requestID
		intent.Answer = &p.Answer{
			Allow:    answer.Allow,
			OptionID: answer.OptionID,
			Answers:  answer.Answers,
		}
	}
	if _, err := rc.SubmitRemoteIntent(ctx, scope, intent); err != nil {
		return err
	}
	a.wakeRemoteDelegations()
	return nil
}

func (a *App) StopRemoteDelegation(ctx context.Context, rowID string) error {
	var row remoteDelegationRow
	if err := a.loadRemoteDelegationRowByID(ctx, rowID, &row); err != nil {
		return err
	}
	_, _ = a.Store.DB.ExecContext(ctx, "UPDATE remote_delegation_runs SET pending_cancel=1,updated_at=? WHERE id=?", now(), row.ID)
	a.StartRemoteDelegationFollower()
	a.wakeRemoteDelegations()
	return a.tryStopRemoteDelegationRow(ctx, row)
}

func (a *App) loadRemoteDelegationRowByID(ctx context.Context, id string, row *remoteDelegationRow) error {
	var autoWake, consumed, pendingCancel int
	err := a.Store.DB.QueryRowContext(ctx, `SELECT id,delegation_id,parent_session_id,parent_run_id,command_id,request_key,input_hash,turn,
hub_id,space_id,device_id,device_name,agent_id,agent_name,title,chat_id,session_id,run_id,provider,model,working_copy_id,working_copy_name,
status,output,summary,error,requests,auto_wake,receipt_consumed,wake_run_id,pending_cancel,created_at,updated_at
FROM remote_delegation_runs WHERE id=?`, id).Scan(
		&row.ID, &row.DelegationID, &row.ParentSessionID, &row.ParentRunID, &row.CommandID, &row.RequestKey, &row.InputHash, &row.Turn,
		&row.HubID, &row.SpaceID, &row.DeviceID, &row.DeviceName, &row.AgentID, &row.AgentName, &row.Title, &row.ChatID, &row.SessionID, &row.RunID,
		&row.Provider, &row.Model, &row.WorkingCopyID, &row.WorkingCopyName, &row.Status, &row.Output, &row.Summary, &row.Error, &row.RequestsJSON,
		&autoWake, &consumed, &row.WakeRunID, &pendingCancel, &row.CreatedAt, &row.UpdatedAt,
	)
	row.AutoWake = autoWake != 0
	row.ReceiptConsumed = consumed != 0
	row.PendingCancel = pendingCancel != 0
	return err
}

func (a *App) loadLatestRemoteDelegationRow(ctx context.Context, delegationID string, row *remoteDelegationRow) error {
	var autoWake, consumed, pendingCancel int
	err := a.Store.DB.QueryRowContext(ctx, `SELECT id,delegation_id,parent_session_id,parent_run_id,command_id,request_key,input_hash,turn,
hub_id,space_id,device_id,device_name,agent_id,agent_name,title,chat_id,session_id,run_id,provider,model,working_copy_id,working_copy_name,
status,output,summary,error,requests,auto_wake,receipt_consumed,wake_run_id,pending_cancel,created_at,updated_at
FROM remote_delegation_runs WHERE delegation_id=? ORDER BY turn DESC LIMIT 1`, delegationID).Scan(
		&row.ID, &row.DelegationID, &row.ParentSessionID, &row.ParentRunID, &row.CommandID, &row.RequestKey, &row.InputHash, &row.Turn,
		&row.HubID, &row.SpaceID, &row.DeviceID, &row.DeviceName, &row.AgentID, &row.AgentName, &row.Title, &row.ChatID, &row.SessionID, &row.RunID,
		&row.Provider, &row.Model, &row.WorkingCopyID, &row.WorkingCopyName, &row.Status, &row.Output, &row.Summary, &row.Error, &row.RequestsJSON,
		&autoWake, &consumed, &row.WakeRunID, &pendingCancel, &row.CreatedAt, &row.UpdatedAt,
	)
	row.AutoWake = autoWake != 0
	row.ReceiptConsumed = consumed != 0
	row.PendingCancel = pendingCancel != 0
	return err
}

func (a *App) runRemoteDelegationFollower() {
	defer a.wg.Done()
	for {
		active := a.pollRemoteDelegations(a.ctx)
		delay := 5 * time.Second
		if active {
			delay = 350 * time.Millisecond
		}
		timer := time.NewTimer(delay)
		select {
		case <-a.ctx.Done():
			timer.Stop()
			return
		case <-a.remoteDelegationWake:
			timer.Stop()
		case <-timer.C:
		}
	}
}

func (a *App) pollRemoteDelegations(ctx context.Context) bool {
	rc := a.remoteCollaborator()
	if rc == nil || ctx.Err() != nil {
		return false
	}
	rows, err := a.Store.DB.QueryContext(ctx, `SELECT id FROM remote_delegation_runs
WHERE status IN ('queued','starting','running','waiting_user','cancelling') OR pending_cancel=1
ORDER BY created_at`)
	if err != nil {
		return false
	}
	var ids []string
	for rows.Next() {
		var id string
		if rows.Scan(&id) == nil {
			ids = append(ids, id)
		}
	}
	rows.Close()
	if len(ids) == 0 {
		return false
	}
	for _, id := range ids {
		if ctx.Err() != nil {
			return false
		}
		var row remoteDelegationRow
		if err := a.loadRemoteDelegationRowByID(ctx, id, &row); err != nil {
			continue
		}
		a.syncRemoteDelegationRow(ctx, rc, row)
	}
	return true
}

func isPermanentRemoteError(err error) bool {
	var httpErr *p.HTTPError
	if errors.As(err, &httpErr) {
		return httpErr.Status == http.StatusForbidden || httpErr.Status == http.StatusUnauthorized || httpErr.Status == http.StatusNotFound
	}
	return false
}

func remoteRecordOutput(rec p.Record) string {
	var parts []string
	for _, item := range rec.Items {
		if item.Kind == "text" && strings.TrimSpace(item.Text) != "" {
			parts = append(parts, strings.TrimSpace(item.Text))
		}
	}
	return strings.TrimSpace(strings.Join(parts, "\n\n"))
}

func remoteRecordToModelRequest(rec p.Record) model.Request {
	req := model.Request{
		ID:               rec.ID,
		RunID:            rec.RunID,
		ChatID:           rec.ChatID,
		SessionID:        rec.SessionID,
		Kind:             rec.Type,
		Title:            rec.Title,
		Detail:           rec.Text,
		Status:           rec.Status,
		AnsweredByUserID: rec.AnsweredByUserID,
		Questions:        make([]model.Question, 0, len(rec.Questions)),
	}
	for _, q := range rec.Questions {
		mq := model.Question{ID: q.ID, Text: q.Text, Multiple: q.Multiple, Options: make([]model.QuestionOption, 0, len(q.Options))}
		for _, opt := range q.Options {
			mq.Options = append(mq.Options, model.QuestionOption{ID: opt.ID, Label: opt.Name})
		}
		req.Questions = append(req.Questions, mq)
	}
	for _, opt := range rec.Options {
		req.Options = append(req.Options, model.RequestOption{ID: opt.ID, Name: opt.Name, Allow: opt.Allow})
	}
	if rec.AllowOnce != nil {
		req.AllowOnce = &model.Answer{Allow: rec.AllowOnce.Allow, OptionID: rec.AllowOnce.OptionID, Answers: rec.AllowOnce.Answers}
	}
	if rec.Answer != nil {
		req.Answer = &model.Answer{Allow: rec.Answer.Allow, OptionID: rec.Answer.OptionID, Answers: rec.Answer.Answers}
	}
	return req
}

func (a *App) syncRemoteDelegationRow(ctx context.Context, rc RemoteCollaborator, row remoteDelegationRow) {
	scope := model.SharedScope{HubID: row.HubID, SpaceID: row.SpaceID}
	parentChatID := ""
	_ = a.Store.DB.QueryRowContext(ctx, "SELECT chat_id FROM sessions WHERE id=?", row.ParentSessionID).Scan(&parentChatID)

	if row.PendingCancel && row.RunID != "" && row.ChatID != "" {
		if err := a.tryStopRemoteDelegationRow(ctx, row); err != nil && isPermanentRemoteError(err) {
			_, _ = a.Store.DB.ExecContext(ctx, "UPDATE remote_delegation_runs SET pending_cancel=0,updated_at=? WHERE id=?", now(), row.ID)
		}
	}

	// Phase 1: Command not yet accepted by remote Host.
	if row.RunID == "" || row.ChatID == "" {
		item, err := rc.LookupRemoteCommand(ctx, scope, row.DeviceID, row.CommandID)
		if err != nil {
			if isPermanentRemoteError(err) {
				a.finalizeRemoteDelegationError(ctx, parentChatID, row, err.Error())
			}
			return
		}
		switch item.Receipt.Status {
		case "accepted":
			row.ChatID = item.Receipt.ChatID
			row.SessionID = item.Receipt.SessionID
			row.RunID = item.Receipt.RunID
			row.Status = "running"
			if err := a.Store.Write(ctx, func(tx *sql.Tx) error {
				if d, err := store.Get[model.Delegation](ctx, tx, "SELECT data FROM delegations WHERE id=?", row.DelegationID); err == nil {
					d.ChatID, d.SessionID, d.RunID = row.ChatID, row.SessionID, row.RunID
					if !slices.Contains(d.RunIDs, row.RunID) {
						d.RunIDs = append(d.RunIDs, row.RunID)
					}
					_, _ = tx.Exec("UPDATE delegations SET data=? WHERE id=?", store.JSON(d), d.ID)
				}
				if _, err := tx.Exec("UPDATE remote_delegation_runs SET chat_id=?,session_id=?,run_id=?,status='running',updated_at=? WHERE id=?",
					row.ChatID, row.SessionID, row.RunID, now(), row.ID); err != nil {
					return err
				}
				return store.Event(tx, model.Event{Type: "delegations", ChatID: parentChatID})
			}); err == nil {
				a.notifyRemoteDelegationWaiters()
			}
			if row.PendingCancel {
				_ = a.tryStopRemoteDelegationRow(ctx, row)
			}
		case "declined", "failed", "cancelled":
			msg := item.Receipt.Detail
			if msg == "" {
				msg = "Remote host " + item.Receipt.Status + " the delegation"
			}
			a.finalizeRemoteDelegationError(ctx, parentChatID, row, msg)
		}
		return
	}

	// Phase 2: Accepted; follow remote run progress via archive.
	records, err := rc.ReadRemoteChat(ctx, scope, row.DeviceID, row.ChatID)
	if err != nil {
		if isPermanentRemoteError(err) {
			a.finalizeRemoteDelegationError(ctx, parentChatID, row, err.Error())
		}
		return
	}
	var runRec *p.Record
	pendingReqs := []model.Request{}
	for i := range records {
		r := records[i]
		if r.Kind == "run" && r.ID == row.RunID {
			copyRec := r
			runRec = &copyRec
		}
		if r.Kind == "request" && r.RunID == row.RunID && r.Status == "pending" {
			pendingReqs = append(pendingReqs, remoteRecordToModelRequest(r))
		}
	}
	if runRec == nil {
		return
	}
	nextStatus := runRec.Status
	if nextStatus == "" {
		nextStatus = row.Status
	}
	nextOutput := remoteRecordOutput(*runRec)
	nextError := runRec.Error
	nextSummary := truncateRunes(nextOutput, 180)
	if nextSummary == "" && nextError != "" {
		nextSummary = truncateRunes(nextError, 180)
	}
	nextReqsJSON := store.JSON(pendingReqs)
	changed := nextStatus != row.Status || nextOutput != row.Output || nextError != row.Error || nextReqsJSON != row.RequestsJSON
	if !changed {
		return
	}
	terminal := isDelegationFinished(nextStatus)
	if err := a.Store.Write(ctx, func(tx *sql.Tx) error {
		pendingCancel := 0
		if row.PendingCancel && !terminal {
			pendingCancel = 1
		}
		if _, err := tx.Exec(`UPDATE remote_delegation_runs
SET status=?,output=?,summary=?,error=?,requests=?,pending_cancel=?,updated_at=? WHERE id=?`,
			nextStatus, nextOutput, nextSummary, nextError, nextReqsJSON, pendingCancel, now(), row.ID); err != nil {
			return err
		}
		if parentChatID != "" {
			return store.Event(tx, model.Event{Type: "delegations", ChatID: parentChatID})
		}
		return nil
	}); err != nil {
		slog.Warn("update remote delegation row", "id", row.ID, "error", err)
		return
	}
	a.notifyRemoteDelegationWaiters()
	if terminal {
		a.mu.Lock()
		a.scheduleDelegationReceiptsLocked(row.ParentSessionID, false)
		a.mu.Unlock()
	}
}

func (a *App) finalizeRemoteDelegationError(ctx context.Context, parentChatID string, row remoteDelegationRow, msg string) {
	if err := a.Store.Write(ctx, func(tx *sql.Tx) error {
		if _, err := tx.Exec(`UPDATE remote_delegation_runs
SET status='failed',error=?,summary=?,requests='[]',pending_cancel=0,updated_at=? WHERE id=?`,
			msg, truncateRunes(msg, 180), now(), row.ID); err != nil {
			return err
		}
		if parentChatID != "" {
			return store.Event(tx, model.Event{Type: "delegations", ChatID: parentChatID})
		}
		return nil
	}); err != nil {
		return
	}
	a.notifyRemoteDelegationWaiters()
	a.mu.Lock()
	a.scheduleDelegationReceiptsLocked(row.ParentSessionID, false)
	a.mu.Unlock()
}

func (a *App) deviceName() string {
	if host, err := os.Hostname(); err == nil && host != "" {
		return host
	}
	return a.Store.DeviceID
}
