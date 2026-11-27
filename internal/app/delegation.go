package app

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"path/filepath"
	"slices"
	"strings"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
	"lever/internal/model"
	larkbot "lever/internal/plugin/builtin/lark-bot"
	"lever/internal/provider"
	"lever/internal/store"
	"lever/internal/workspace"
)

const (
	sessionTypingTTL      = 8 * time.Second
	maxTypingReceiptDefer = 60 * time.Second
)

type delegationWorkspace struct {
	projectID       string
	scope           model.Scope
	workingCopyID   string
	workingCopyName string
}

type delegationWakeChannel struct {
	bindingID    string
	messageID    string
	feishuMeta   *feishuDeliveryMeta
	personalTurn *personalTurn
}

type delegationReceiptWake struct {
	receipts []model.DelegationReceipt
	channel  *delegationWakeChannel
}

type delegateTargetInfo struct {
	DeviceID      string                    `json:"deviceId,omitempty"`
	DeviceName    string                    `json:"deviceName,omitempty"`
	ID            string                    `json:"id"`
	Name          string                    `json:"name"`
	Description   string                    `json:"description,omitempty"`
	Provider      string                    `json:"provider,omitempty"`
	Model         string                    `json:"model,omitempty"`
	Permission    string                    `json:"permission,omitempty"`
	DefaultBusy   bool                      `json:"defaultBusy,omitempty"`
	WorkingCopies []model.RemoteWorkingCopy `json:"workingCopies,omitempty"`
}

type delegateTargetsInput struct {
	Query    string `json:"query,omitempty" jsonschema:"Optional search text matching agent name, description, or device name"`
	DeviceID string `json:"deviceId,omitempty" jsonschema:"Optional device filter: 'local' for this device, or a remote device ID"`
}

type delegateTargetsResult struct {
	Targets []delegateTargetInfo `json:"targets"`
}

type delegateInput struct {
	DeviceID      string `json:"deviceId,omitempty" jsonschema:"Optional remote device ID from delegate_targets; omit for an Agent on this device"`
	AgentID       string `json:"agentId" jsonschema:"Target Agent ID from delegate_targets or the available delegation list"`
	WorkingCopyID string `json:"workingCopyId,omitempty" jsonschema:"Optional existing directory group / worktree ID from delegate_targets (supported for both local and remote Agents)"`
	RequestKey    string `json:"requestKey" jsonschema:"Stable key for this task within the current turn; reuse it when retrying the same task"`
	Task          string `json:"task" jsonschema:"Self-contained task and necessary context; parent transcript is not shared"`
	Workspace     string `json:"workspace,omitempty" jsonschema:"Workspace scope for local delegations: 'inherit' (default, share current conversation scope/worktree for tight same-task collaboration) or 'agent' (use target Agent's own scope; when the default checkout is busy with another active task, automatically picks an idle pre-created worktree if available). Remote delegations always use 'agent'."`
	AutoWake      *bool  `json:"autoWake,omitempty" jsonschema:"When true (default), automatically wake this conversation with a receipt if the child finishes after this turn ends without its result being collected via delegate_wait"`
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
	DeviceID        string `json:"deviceId,omitempty"`
	DeviceName      string `json:"deviceName,omitempty"`
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

func findDelegationRule(rules []model.DelegationRule, deviceID, agentID string) (model.DelegationRule, bool) {
	for _, rule := range rules {
		if rule.DeviceID == deviceID && rule.AgentID == agentID {
			return rule, true
		}
	}
	return model.DelegationRule{}, false
}

func (a *App) delegationChainKey(deviceID, agentID string) string {
	if deviceID == "" || deviceID == "local" {
		deviceID = a.Store.DeviceID
	}
	return deviceID + ":" + agentID
}

func (e *execution) nextDelegationChain() []string {
	chain := slices.Clone(e.session.DelegationChain)
	selfKey := e.app.delegationChainKey("", e.session.AgentID)
	if !slices.Contains(chain, selfKey) {
		chain = append(chain, selfKey)
	}
	return chain
}

func (e *execution) canDelegate() bool {
	if !e.session.DelegationDepthAllowsMore() {
		return false
	}
	switch e.delegationPolicy {
	case model.DelegationPolicyAll:
		return true
	case model.DelegationPolicySelected:
		return len(e.profile.Delegations) > 0
	default:
		return false
	}
}

func (e *execution) delegationRuleFor(deviceID, agentID string) (model.DelegationRule, bool) {
	if !e.session.DelegationDepthAllowsMore() || agentID == "" {
		return model.DelegationRule{}, false
	}
	if deviceID == "" && agentID == e.session.AgentID {
		return model.DelegationRule{}, false
	}
	if slices.Contains(e.session.DelegationChain, e.app.delegationChainKey(deviceID, agentID)) {
		return model.DelegationRule{}, false
	}
	switch e.delegationPolicy {
	case model.DelegationPolicySelected:
		return findDelegationRule(e.profile.Delegations, deviceID, agentID)
	case model.DelegationPolicyAll:
		if deviceID != "" && !e.profile.AllowsRemoteDelegation() {
			return model.DelegationRule{}, false
		}
		return model.DelegationRule{DeviceID: deviceID, AgentID: agentID, Confirm: false}, true
	default:
		return model.DelegationRule{}, false
	}
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

func (a *App) checkDelegationConcurrency(ctx context.Context, parentSessionID string) error {
	defaults, _ := delegationSettings(ctx, a.Store.DB)
	limit := defaults.EffectiveMaxConcurrent()
	var localActive, remoteActive int
	if err := a.Store.DB.QueryRowContext(ctx, `SELECT COUNT(*) FROM delegation_runs dr
JOIN runs child ON child.id=dr.child_run_id
WHERE dr.parent_session_id=? AND child.status IN ('queued','starting','running','waiting_user','cancelling')`, parentSessionID).Scan(&localActive); err != nil {
		return err
	}
	if err := a.Store.DB.QueryRowContext(ctx, `SELECT COUNT(*) FROM remote_delegation_runs
WHERE parent_session_id=? AND status IN ('queued','starting','running','waiting_user','cancelling')`, parentSessionID).Scan(&remoteActive); err != nil {
		return err
	}
	if localActive+remoteActive >= limit {
		return conflict(fmt.Sprintf("At most %d active delegated tasks may run concurrently in one session; wait for or cancel an existing delegation first", limit))
	}
	return nil
}

func workingCopyBusy(wc model.WorkingCopy) bool {
	return slices.ContainsFunc(wc.Topics, func(t model.CopyTopic) bool { return t.Busy })
}

func (a *App) localTargetWorkingCopies(ctx context.Context, agentID string) []model.RemoteWorkingCopy {
	copies, err := a.WorkingCopies(ctx, agentID)
	if err != nil || len(copies) == 0 {
		return nil
	}
	out := make([]model.RemoteWorkingCopy, 0, len(copies))
	for _, wc := range copies {
		if wc.Archived {
			continue
		}
		state := wc.State
		if wc.Error != "" {
			state = "unavailable"
		}
		out = append(out, model.RemoteWorkingCopy{
			ID:    wc.ID,
			Name:  wc.Name,
			State: state,
			Busy:  workingCopyBusy(wc),
		})
	}
	return out
}

func (a *App) isDefaultScopeBusy(ctx context.Context, target model.Agent) bool {
	targetCWD := workspace.CWD(target.Profile.Scope)
	if targetCWD == "" {
		return false
	}
	targetCWD = filepath.Clean(targetCWD)
	rows, err := a.Store.DB.QueryContext(ctx, `SELECT DISTINCT s.data FROM runs r
JOIN sessions s ON s.id=r.session_id
WHERE r.status IN ('queued','starting','running','waiting_user','cancelling')
  AND COALESCE(json_extract(s.data,'$.workingCopyId'),'')=''`)
	if err != nil {
		return false
	}
	defer rows.Close()
	for rows.Next() {
		var raw string
		if rows.Scan(&raw) != nil {
			continue
		}
		var s model.Session
		if json.Unmarshal([]byte(raw), &s) != nil {
			continue
		}
		cwd := workspace.CWD(s.Scope)
		if cwd != "" && filepath.Clean(cwd) == targetCWD {
			return true
		}
	}
	return false
}

func (a *App) pickIdleLocalWorkingCopy(ctx context.Context, target model.Agent) (*delegationWorkspace, bool) {
	copies, err := a.WorkingCopies(ctx, target.ID)
	if err != nil || len(copies) == 0 {
		return nil, false
	}
	for _, wc := range copies {
		if wc.Archived || wc.State != "ready" || wc.Error != "" || workingCopyBusy(wc) {
			continue
		}
		resolved, err := a.selectGroupForTarget(ctx, a.Store.DB, target, target.Profile.ProjectID, wc.ID)
		if err != nil {
			continue
		}
		return &delegationWorkspace{
			projectID:       target.Profile.ProjectID,
			scope:           cloneScope(resolved.Scope),
			workingCopyID:   resolved.ID,
			workingCopyName: resolved.Name,
		}, true
	}
	return nil, false
}

func (a *App) listEligibleTargets(ctx context.Context, owner *execution, query, deviceFilter string) []delegateTargetInfo {
	targets := []delegateTargetInfo{}
	q := strings.ToLower(strings.TrimSpace(query))
	deviceFilter = strings.TrimSpace(deviceFilter)
	matchesQuery := func(t delegateTargetInfo) bool {
		if q == "" {
			return true
		}
		return strings.Contains(strings.ToLower(t.Name), q) ||
			strings.Contains(strings.ToLower(t.Description), q) ||
			strings.Contains(strings.ToLower(t.DeviceName), q) ||
			strings.Contains(strings.ToLower(t.ID), q)
	}
	wantLocal := deviceFilter == "" || deviceFilter == "local" || deviceFilter == a.Store.DeviceID
	if wantLocal {
		agents, err := store.List[model.Agent](ctx, a.Store.DB, "SELECT data FROM agents WHERE id<>? AND coalesce(json_extract(data,'$.archived'),0)=0 ORDER BY json_extract(data,'$.createdAt')", owner.session.AgentID)
		if err == nil {
			for _, target := range agents {
				if !target.Profile.CanAcceptDelegations() {
					continue
				}
				if _, ok := owner.delegationRuleFor("", target.ID); !ok {
					continue
				}
				var visible bool
				if err := a.Store.DB.QueryRowContext(ctx, `SELECT json_type(c.data,'$.sharedScope') IS NULL OR EXISTS(SELECT 1 FROM remote_memberships m WHERE m.hub=json_extract(c.data,'$.sharedScope.hubId') AND m.space=json_extract(c.data,'$.sharedScope.spaceId') AND (m.expose_all=1 OR EXISTS(SELECT 1 FROM hub_exposed_agents e WHERE e.hub=m.hub AND e.space=m.space AND e.agent_id=?))) FROM chats c WHERE c.id=?`, target.ID, owner.session.ChatID).Scan(&visible); err != nil || !visible {
					continue
				}
				effectivePerm := target.Profile.Permission
				if defSel, err := agentDefaultSelection(ctx, a.Store.DB, target); err == nil && defSel.Permission != "" {
					effectivePerm = defSel.Permission
				}
				info := delegateTargetInfo{
					ID:            target.ID,
					Name:          target.Name,
					Description:   target.Profile.Description,
					Provider:      target.Profile.Provider,
					Model:         target.Profile.Model,
					Permission:    effectivePerm,
					DefaultBusy:   a.isDefaultScopeBusy(ctx, target),
					WorkingCopies: a.localTargetWorkingCopies(ctx, target.ID),
				}
				if matchesQuery(info) {
					targets = append(targets, info)
				}
			}
		}
	}
	wantRemote := deviceFilter != "local" && deviceFilter != a.Store.DeviceID
	if wantRemote && owner.delegationPolicy == model.DelegationPolicySelected {
		hasRemoteRule := slices.ContainsFunc(owner.profile.Delegations, func(r model.DelegationRule) bool { return r.DeviceID != "" })
		wantRemote = hasRemoteRule
	}
	if wantRemote && owner.delegationPolicy == model.DelegationPolicyAll && !owner.profile.AllowsRemoteDelegation() {
		wantRemote = false
	}
	if wantRemote {
		if rc := a.remoteCollaborator(); rc != nil {
			var sharedScope *model.SharedScope
			if chat, err := store.Get[model.Chat](ctx, a.Store.DB, "SELECT data FROM chats WHERE id=?", owner.session.ChatID); err == nil {
				sharedScope = chat.SharedScope
			}
			if remotes, err := rc.ListRemoteTargets(ctx, sharedScope); err == nil {
				for _, rt := range remotes {
					if !rt.Online || rt.Draining {
						continue
					}
					if deviceFilter != "" && rt.DeviceID != deviceFilter {
						continue
					}
					if _, ok := owner.delegationRuleFor(rt.DeviceID, rt.AgentID); !ok {
						continue
					}
					info := delegateTargetInfo{
						DeviceID:      rt.DeviceID,
						DeviceName:    rt.DeviceName,
						ID:            rt.AgentID,
						Name:          rt.Name,
						Description:   rt.Description,
						Provider:      rt.Provider,
						Model:         rt.Model,
						Permission:    rt.PermissionMode,
						DefaultBusy:   rt.DefaultBusy,
						WorkingCopies: rt.WorkingCopies,
					}
					if matchesQuery(info) {
						targets = append(targets, info)
					}
				}
			}
		}
	}
	return targets
}

func (a *App) addDelegationTools(ctx context.Context, server *mcp.Server, owner *execution) {
	targets := a.listEligibleTargets(ctx, owner, "", "")
	hasRemote := slices.ContainsFunc(targets, func(t delegateTargetInfo) bool { return t.DeviceID != "" })
	var startTargetNote string
	if len(targets) <= 8 && !hasRemote {
		startTargetNote = " Available targets: " + store.JSON(targets)
	} else {
		devices := []string{}
		for _, t := range targets {
			if t.DeviceName != "" && !slices.Contains(devices, t.DeviceName) {
				devices = append(devices, t.DeviceName)
			}
		}
		if len(devices) > 0 {
			startTargetNote = fmt.Sprintf(" %d available targets across this device and remote devices (%s). Call delegate_targets to inspect target IDs, descriptions, and available workingCopies before starting.", len(targets), strings.Join(devices, ", "))
		} else {
			startTargetNote = fmt.Sprintf(" %d available targets. Call delegate_targets to inspect target IDs, descriptions, and workingCopies.", len(targets))
		}
	}
	depthNote := "one hop only"
	if owner.delegationMaxDepth > 1 && owner.session.EffectiveDelegationDepth() == 0 {
		depthNote = fmt.Sprintf("up to %d levels deep, no cycles", owner.delegationMaxDepth)
	}
	mcp.AddTool(server, &mcp.Tool{
		Name:        "delegate_targets",
		Description: "Discover available collaborator Agents on this device and connected remote devices, including their IDs, deviceIds, descriptions, models, defaultBusy status, and pre-created workingCopies (with busy flags).",
	}, func(ctx context.Context, _ *mcp.CallToolRequest, in delegateTargetsInput) (*mcp.CallToolResult, *delegateTargetsResult, error) {
		return nil, &delegateTargetsResult{Targets: a.listEligibleTargets(ctx, owner, in.Query, in.DeviceID)}, nil
	})
	mcp.AddTool(server, &mcp.Tool{
		Name: "delegate_start",
		Description: fmt.Sprintf("Start a task on another collaborator Agent (%s; child permissions are capped to this turn's permission level). Omit deviceId for a local Agent (defaults to workspace='inherit' to share the current checkout for tight same-task collaboration; pass workspace='agent' for its own scope—auto-picking an idle pre-created worktree if its default checkout is busy—or pass workingCopyId to target a specific worktree), or pass deviceId (and optional workingCopyId) for a remote device Agent. You may start multiple tasks in parallel, wait with delegate_wait, continue an existing delegation with delegate_reply, inspect child transcripts via read_chat_context, or finish your turn to automatically receive a receipt when autoWake is true (default).", depthNote) + startTargetNote,
	}, func(ctx context.Context, _ *mcp.CallToolRequest, in delegateInput) (*mcp.CallToolResult, *model.Delegation, error) {
		d, err := a.delegate(ctx, owner, in)
		return nil, &d, err
	})
	mcp.AddTool(server, &mcp.Tool{
		Name:        "delegate_reply",
		Description: "Send a follow-up message to an existing delegated conversation (local or remote) owned by this session. Preserves the collaborator's conversation memory and workspace.",
	}, func(ctx context.Context, _ *mcp.CallToolRequest, in delegateReplyInput) (*mcp.CallToolResult, *model.Delegation, error) {
		d, err := a.delegateReply(ctx, owner, in)
		return nil, &d, err
	})
	mcp.AddTool(server, &mcp.Tool{
		Name:        "delegate_wait",
		Description: "Wait for one (id) or multiple (ids) delegated tasks (local or remote) owned by this session and return their current status and output. Defaults to waiting up to 30 seconds (max 120s). For long-running work you can also end your turn and rely on automatic receipt wakeups.",
	}, func(ctx context.Context, _ *mcp.CallToolRequest, in delegateWaitInput) (*mcp.CallToolResult, *delegationWaitResult, error) {
		res, err := a.delegateWait(ctx, owner, in)
		return nil, res, err
	})
	mcp.AddTool(server, &mcp.Tool{
		Name:        "delegate_list",
		Description: "List all delegated conversations (local and remote) started in this session across turns, with their IDs, target Agents/devices, turn counts, statuses, and summaries.",
	}, func(ctx context.Context, _ *mcp.CallToolRequest, _ struct{}) (*mcp.CallToolResult, *delegationListResult, error) {
		res, err := a.delegateList(ctx, owner)
		return nil, res, err
	})
	mcp.AddTool(server, &mcp.Tool{
		Name:        "delegate_cancel",
		Description: "Stop an active delegated task (local or remote) owned by this session.",
	}, func(ctx context.Context, _ *mcp.CallToolRequest, in delegationID) (*mcp.CallToolResult, *model.Delegation, error) {
		d, err := a.ownedDelegation(ctx, owner.session.ID, in.ID)
		if err == nil {
			if d.DeviceID != "" {
				err = a.cancelRemoteDelegation(ctx, d)
			} else {
				_, _ = a.Store.DB.ExecContext(ctx, "UPDATE delegation_runs SET receipt_consumed=1 WHERE delegation_id=? AND child_run_id=?", d.ID, d.RunID)
				err = a.stopLocalDelegationRun(ctx, d.RunID)
			}
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
	if d.AgentID == "" && d.ChatID != "" && d.DeviceID == "" {
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
	in.DeviceID = strings.TrimSpace(in.DeviceID)
	if in.DeviceID == "local" || in.DeviceID == a.Store.DeviceID {
		in.DeviceID = ""
	}
	if in.DeviceID != "" {
		return a.delegateRemote(ctx, parent, in)
	}
	wsMode := strings.TrimSpace(in.Workspace)
	in.WorkingCopyID = strings.TrimSpace(in.WorkingCopyID)
	if in.WorkingCopyID != "" {
		if wsMode == "inherit" {
			return d, invalid("Cannot combine workingCopyId with workspace='inherit'")
		}
		wsMode = "agent"
	} else if wsMode == "" {
		wsMode = "inherit"
	}
	if wsMode != "inherit" && wsMode != "agent" {
		return d, invalid("workspace must be 'inherit' or 'agent'")
	}
	autoWake := true
	if in.AutoWake != nil {
		autoWake = *in.AutoWake
	}
	rule, permitted := parent.delegationRuleFor("", in.AgentID)
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
	var targetScope *delegationWorkspace
	if d.ID == "" {
		if err := a.checkDelegationConcurrency(ctx, parent.session.ID); err != nil {
			return d, err
		}
		target, err := store.Get[model.Agent](ctx, a.Store.DB, "SELECT data FROM agents WHERE id=?", in.AgentID)
		if err != nil {
			return d, invalid("Target agent does not exist")
		}
		if target.Archived {
			return d, conflict("Target agent is archived")
		}
		if !target.Profile.CanAcceptDelegations() {
			return d, invalid("Target agent does not accept delegated tasks")
		}
		if in.WorkingCopyID != "" {
			resolved, err := a.selectGroupForTarget(ctx, a.Store.DB, target, target.Profile.ProjectID, in.WorkingCopyID)
			if err != nil {
				return d, err
			}
			targetScope = &delegationWorkspace{
				projectID:       target.Profile.ProjectID,
				scope:           cloneScope(resolved.Scope),
				workingCopyID:   resolved.ID,
				workingCopyName: resolved.Name,
			}
		} else if wsMode == "agent" && a.isDefaultScopeBusy(ctx, target) {
			if picked, ok := a.pickIdleLocalWorkingCopy(ctx, target); ok {
				targetScope = picked
			}
		}
	} else if in.WorkingCopyID != "" {
		if target, err := store.Get[model.Agent](ctx, a.Store.DB, "SELECT data FROM agents WHERE id=?", in.AgentID); err == nil {
			if resolved, err := a.selectGroupForTarget(ctx, a.Store.DB, target, target.Profile.ProjectID, in.WorkingCopyID); err == nil {
				targetScope = &delegationWorkspace{
					projectID:       target.Profile.ProjectID,
					scope:           cloneScope(resolved.Scope),
					workingCopyID:   resolved.ID,
					workingCopyName: resolved.Name,
				}
			}
		}
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
	delegationScope := targetScope
	if delegationScope == nil && wsMode == "inherit" && len(parent.session.Scope.Roots) > 0 {
		delegationScope = &delegationWorkspace{
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
		if delegationScope != nil {
			d.WorkingCopyID = delegationScope.workingCopyID
			d.WorkingCopyName = delegationScope.workingCopyName
		}
		err = a.Store.Write(ctx, func(tx *sql.Tx) error {
			target, err := store.Get[model.Agent](ctx, tx, "SELECT data FROM agents WHERE id=?", in.AgentID)
			if err != nil {
				return err
			}
			if target.Archived {
				return conflict("Target agent is archived")
			}
			if !target.Profile.CanAcceptDelegations() {
				return invalid("Target agent does not accept delegated tasks")
			}
			d.AgentName = target.Name
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
	parent.mu.Lock()
	maxPerm := provider.NormalizePermissionMode(parent.provider.Type, parent.run.Selection.Permission)
	parent.mu.Unlock()
	run, err := a.sendLocked(ctx, model.SendInput{
		CommandID: model.DelegationCommandPrefix + d.ID,
		ChatID:    d.ChatID,
		Operation: "main",
		Text:      in.Task,
	}, sendOrigin{
		parentRunID:        parent.run.ID,
		delegationScope:    delegationScope,
		maxPermissionMode:  maxPerm,
		delegationDepth:    parent.session.EffectiveDelegationDepth() + 1,
		delegationMaxDepth: min(parent.delegationMaxDepth, 2),
		delegationChain:    parent.nextDelegationChain(),
	})
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
	if _, permitted := parent.delegationRuleFor(d.DeviceID, d.AgentID); !permitted {
		return d, invalid("Target is not allowed by this session's delegation rules")
	}
	if d.DeviceID != "" {
		return a.delegateReplyRemote(ctx, parent, d, in)
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
	if err := a.checkDelegationConcurrency(ctx, parent.session.ID); err != nil {
		return d, err
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
	if !target.Profile.CanAcceptDelegations() {
		return d, invalid("Target agent does not accept delegated tasks")
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
	parent.mu.Lock()
	maxPerm := provider.NormalizePermissionMode(parent.provider.Type, parent.run.Selection.Permission)
	parent.mu.Unlock()
	cmdID := fmt.Sprintf("%s%s:%d:%s", model.DelegationCommandPrefix, d.ID, nextTurn, ID())
	run, err := a.sendLocked(ctx, model.SendInput{
		CommandID: cmdID,
		ChatID:    d.ChatID,
		Operation: "main",
		Text:      in.Message,
	}, sendOrigin{parentRunID: parent.run.ID, maxPermissionMode: maxPerm})
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

	loadAll := func() ([]delegationWaitItem, []*execution, bool, bool, bool, error) {
		items := make([]delegationWaitItem, 0, len(ids))
		var activeExecs []*execution
		allFinished := true
		anyFinished := false
		hasRemote := false
		for _, id := range ids {
			d, err := a.ownedDelegation(ctx, owner.session.ID, id)
			if err != nil {
				return nil, nil, false, false, false, err
			}
			if d.DeviceID != "" {
				hasRemote = true
				var row remoteDelegationRow
				if err := a.loadLatestRemoteDelegationRow(ctx, d.ID, &row); err != nil {
					return nil, nil, false, false, false, err
				}
				d.ChatID, d.SessionID, d.RunID = row.ChatID, row.SessionID, row.RunID
				finished := isDelegationFinished(row.Status)
				if finished {
					anyFinished = true
				} else {
					allFinished = false
				}
				run := model.Run{
					ID:        row.RunID,
					SessionID: row.SessionID,
					ChatID:    row.ChatID,
					AgentID:   row.AgentID,
					Status:    row.Status,
					Error:     row.Error,
					CreatedAt: row.CreatedAt,
				}
				items = append(items, delegationWaitItem{
					Delegation: d,
					Run:        run,
					Output:     row.Output,
					Finished:   finished,
				})
				continue
			}
			run, err := store.Get[model.Run](ctx, a.Store.DB, "SELECT data FROM runs WHERE id=?", d.RunID)
			if err != nil {
				return nil, nil, false, false, false, err
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
		return items, activeExecs, allFinished, anyFinished, hasRemote, nil
	}

	var items []delegationWaitItem
	var allFinished bool
	poll := time.NewTicker(250 * time.Millisecond)
	defer poll.Stop()
	for {
		var activeExecs []*execution
		var anyFinished, hasRemote bool
		var err error
		items, activeExecs, allFinished, anyFinished, hasRemote, err = loadAll()
		if err != nil {
			return nil, err
		}
		if (waitFor == "all" && allFinished) || (waitFor == "any" && anyFinished) {
			break
		}
		if hasRemote {
			a.wakeRemoteDelegations()
		}
		var firstDone <-chan struct{}
		if len(activeExecs) == 1 && !hasRemote {
			firstDone = activeExecs[0].done
		}
		var remoteSig <-chan struct{}
		if hasRemote {
			remoteSig = a.remoteDelegationSignal()
		}
		select {
		case <-firstDone:
		case <-remoteSig:
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
	items, _, allFinished, _, _, err = loadAll()
	if err != nil {
		return nil, err
	}
	// Mark receipts consumed for any terminal child run so Lever will not send a
	// duplicate async wakeup turn after the Lead has already read the result.
	for _, item := range items {
		if item.Finished {
			if item.Delegation.DeviceID != "" {
				_, _ = a.Store.DB.ExecContext(ctx, "UPDATE remote_delegation_runs SET receipt_consumed=1 WHERE delegation_id=? AND status IN ('completed','failed','interrupted','unknown')", item.Delegation.ID)
			} else {
				_, _ = a.Store.DB.ExecContext(ctx, "UPDATE delegation_runs SET receipt_consumed=1 WHERE child_run_id=?", item.Run.ID)
			}
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
	type timedSummary struct {
		createdAt string
		item      delegationSummaryItem
	}
	collected := []timedSummary{}
	rows, err := a.Store.DB.QueryContext(ctx, `SELECT d.data, r.data, COALESCE(json_extract(ag.data,'$.name'),'')
FROM delegations d
JOIN runs parent ON parent.id=d.parent_run_id
JOIN runs r ON r.id=json_extract(d.data,'$.runId')
LEFT JOIN agents ag ON ag.id=r.agent_id
WHERE COALESCE(json_extract(d.data,'$.deviceId'),'')='' AND (COALESCE(json_extract(d.data,'$.parentSessionId'),'')=? OR parent.session_id=?)
ORDER BY COALESCE(json_extract(r.data,'$.createdAt'),'')`, owner.session.ID, owner.session.ID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
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
		collected = append(collected, timedSummary{
			createdAt: run.CreatedAt,
			item: delegationSummaryItem{
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
			},
		})
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	rows.Close()

	remoteRows, err := a.Store.DB.QueryContext(ctx, `SELECT dr.delegation_id, dr.device_id, dr.device_name, dr.agent_id, dr.agent_name,
dr.chat_id, dr.session_id, dr.run_id, dr.turn, dr.status, dr.working_copy_name, dr.summary, dr.error, dr.created_at
FROM remote_delegation_runs dr
WHERE dr.parent_session_id=? AND dr.turn=(SELECT MAX(x.turn) FROM remote_delegation_runs x WHERE x.delegation_id=dr.delegation_id)
ORDER BY dr.created_at`, owner.session.ID)
	if err != nil {
		return nil, err
	}
	defer remoteRows.Close()
	for remoteRows.Next() {
		var item delegationSummaryItem
		var errText, createdAt string
		item.Workspace = "agent"
		if err := remoteRows.Scan(&item.ID, &item.DeviceID, &item.DeviceName, &item.AgentID, &item.AgentName,
			&item.ChatID, &item.SessionID, &item.RunID, &item.Turn, &item.Status, &item.WorkingCopyName, &item.Summary, &errText, &createdAt); err != nil {
			return nil, err
		}
		if item.Summary == "" && errText != "" {
			item.Summary = truncateRunes(errText, 240)
		}
		collected = append(collected, timedSummary{createdAt: createdAt, item: item})
	}
	if err := remoteRows.Err(); err != nil {
		return nil, err
	}
	slices.SortFunc(collected, func(a, b timedSummary) int {
		return strings.Compare(a.createdAt, b.createdAt)
	})
	items := make([]delegationSummaryItem, 0, len(collected))
	for _, c := range collected {
		items = append(items, c.item)
	}
	return &delegationListResult{Delegations: items}, nil
}

func (a *App) cancelParentDelegationWakesLocked(ctx context.Context, parentRunID string) {
	_, _ = a.Store.DB.ExecContext(ctx, "UPDATE delegation_runs SET receipt_consumed=1 WHERE parent_run_id=? AND receipt_consumed=0", parentRunID)
	_, _ = a.Store.DB.ExecContext(ctx, "UPDATE remote_delegation_runs SET receipt_consumed=1 WHERE parent_run_id=? AND receipt_consumed=0", parentRunID)
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

func (a *App) SetSessionTyping(sessionID string, active bool) {
	sessionID = strings.TrimSpace(sessionID)
	if sessionID == "" {
		return
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.closed {
		return
	}
	if active {
		a.typingUntil[sessionID] = time.Now().Add(sessionTypingTTL)
		return
	}
	delete(a.typingUntil, sessionID)
	delete(a.typingDeferSince, sessionID)
	a.scheduleDelegationReceiptsLocked(sessionID, true)
}

func (a *App) hasPendingDelegationReceiptsLocked(parentSessionID string) bool {
	var exists bool
	if err := a.Store.DB.QueryRowContext(a.ctx, `SELECT EXISTS(
		SELECT 1 FROM delegation_runs dr
		JOIN runs parent ON parent.id=dr.parent_run_id
		JOIN runs child ON child.id=dr.child_run_id
		WHERE dr.parent_session_id=? AND dr.auto_wake=1 AND dr.receipt_consumed=0 AND dr.wake_run_id=''
		  AND parent.status IN ('completed','interrupted')
		  AND child.status IN ('completed','failed','interrupted','unknown')
		UNION ALL
		SELECT 1 FROM remote_delegation_runs dr
		JOIN runs parent ON parent.id=dr.parent_run_id
		WHERE dr.parent_session_id=? AND dr.auto_wake=1 AND dr.receipt_consumed=0 AND dr.wake_run_id=''
		  AND parent.status IN ('completed','interrupted')
		  AND dr.status IN ('completed','failed','interrupted','unknown')
	)`, parentSessionID, parentSessionID).Scan(&exists); err != nil {
		return false
	}
	return exists
}

func (a *App) hasActiveDelegationsLocked(parentSessionID string) bool {
	var exists bool
	if err := a.Store.DB.QueryRowContext(a.ctx, `SELECT EXISTS(
		SELECT 1 FROM delegation_runs dr
		JOIN runs child ON child.id=dr.child_run_id
		WHERE dr.parent_session_id=? AND dr.auto_wake=1 AND dr.receipt_consumed=0 AND dr.wake_run_id=''
		  AND child.status IN ('queued','starting','running','waiting_user','cancelling')
		UNION ALL
		SELECT 1 FROM remote_delegation_runs
		WHERE parent_session_id=? AND auto_wake=1 AND receipt_consumed=0 AND wake_run_id=''
		  AND status IN ('queued','starting','running','waiting_user','cancelling')
	)`, parentSessionID, parentSessionID).Scan(&exists); err != nil {
		return false
	}
	return exists
}

func (a *App) armReceiptTimerLocked(parentSessionID string, delay time.Duration, reset bool) {
	if existing := a.receiptTimers[parentSessionID]; existing != nil {
		if !reset {
			return
		}
		existing.Stop()
		delete(a.receiptTimers, parentSessionID)
	}
	var timer *time.Timer
	timer = time.AfterFunc(delay, func() {
		a.mu.Lock()
		defer a.mu.Unlock()
		if a.closed || a.receiptTimers[parentSessionID] != timer {
			return
		}
		delete(a.receiptTimers, parentSessionID)
		a.scheduleDelegationReceiptsLocked(parentSessionID, true)
	})
	a.receiptTimers[parentSessionID] = timer
}

func (a *App) scheduleDelegationReceiptsLocked(parentSessionID string, immediate bool) {
	if a.closed || parentSessionID == "" || a.hasActiveSessionLocked(parentSessionID) {
		return
	}
	if !a.hasPendingDelegationReceiptsLocked(parentSessionID) {
		delete(a.typingDeferSince, parentSessionID)
		if t := a.receiptTimers[parentSessionID]; t != nil {
			t.Stop()
			delete(a.receiptTimers, parentSessionID)
		}
		return
	}
	var hasUserQueued bool
	if err := a.Store.DB.QueryRowContext(a.ctx, `SELECT EXISTS(
		SELECT 1 FROM runs WHERE session_id=? AND status='queued' AND command_id NOT LIKE 'delegation-receipt:%'
	)`, parentSessionID).Scan(&hasUserQueued); err == nil && hasUserQueued {
		return
	}
	nowTime := time.Now()
	if until, ok := a.typingUntil[parentSessionID]; ok && nowTime.Before(until) {
		since, tracked := a.typingDeferSince[parentSessionID]
		if !tracked {
			since = nowTime
			a.typingDeferSince[parentSessionID] = since
		}
		maxUntil := since.Add(maxTypingReceiptDefer)
		if nowTime.Before(maxUntil) {
			wait := until.Sub(nowTime)
			if maxLeft := maxUntil.Sub(nowTime); wait > maxLeft {
				wait = maxLeft
			}
			if wait < 50*time.Millisecond {
				wait = 50 * time.Millisecond
			}
			a.armReceiptTimerLocked(parentSessionID, wait, true)
			return
		}
	}
	delete(a.typingDeferSince, parentSessionID)
	if !immediate && a.delegationCoalesceWindow > 0 && a.hasActiveDelegationsLocked(parentSessionID) {
		a.armReceiptTimerLocked(parentSessionID, a.delegationCoalesceWindow, false)
		return
	}
	if t := a.receiptTimers[parentSessionID]; t != nil {
		t.Stop()
		delete(a.receiptTimers, parentSessionID)
	}
	a.deliverPendingDelegationReceiptsLocked(parentSessionID)
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
	a.scheduleDelegationReceiptsLocked(parentSessionID, false)
}

func (a *App) lookupDelegationWakeChannel(parentChat model.Chat, parentSessionID string, parentRunIDs []string) *delegationWakeChannel {
	var runID, bindingID, messageID string
	// Prefer the most recent triggering parent run that actually originated from a channel.
	for i := len(parentRunIDs) - 1; i >= 0; i-- {
		pid := parentRunIDs[i]
		if pid == "" {
			continue
		}
		if err := a.Store.DB.QueryRowContext(a.ctx, `SELECT run_id, binding_id, message_id FROM channel_deliveries
WHERE run_id=? AND part='answer' LIMIT 1`, pid).Scan(&runID, &bindingID, &messageID); err == nil && bindingID != "" {
			break
		}
	}
	// For channel-bound Feishu chats, fall back to the latest channel turn in this session.
	if bindingID == "" && parentChat.Channel == larkbot.ChannelID {
		_ = a.Store.DB.QueryRowContext(a.ctx, `SELECT d.run_id, d.binding_id, d.message_id FROM channel_deliveries d
JOIN runs r ON r.id=d.run_id
WHERE r.session_id=? AND d.part='answer'
ORDER BY r.sequence DESC LIMIT 1`, parentSessionID).Scan(&runID, &bindingID, &messageID)
	}
	if bindingID == "" {
		return nil
	}
	out := &delegationWakeChannel{
		bindingID: bindingID,
		messageID: messageID,
	}
	if parentChat.Channel == larkbot.ChannelID {
		if meta, err := store.Get[feishuDeliveryMeta](a.ctx, a.Store.DB, "SELECT data FROM feishu_delivery_meta WHERE run_id=?", runID); err == nil {
			meta.ReactionAck = false
			meta.ReactionID = ""
			out.feishuMeta = &meta
		}
		return out
	}
	var turn personalTurn
	if err := a.Store.DB.QueryRowContext(a.ctx, `SELECT binding, chat, conversation, thread, command, signature, chat_name
FROM personal_channel_turns WHERE run_id=?`, runID).Scan(
		&turn.binding, &turn.remoteChat, &turn.conversation, &turn.thread, &turn.command, &turn.signature, &turn.chatName,
	); err == nil && turn.binding != "" {
		turn.needsContext = false
		turn.reaction = ""
		out.personalTurn = &turn
		return out
	}
	return nil
}

func (a *App) deliverPendingDelegationReceiptsLocked(parentSessionID string) {
	if a.closed || parentSessionID == "" || a.hasActiveSessionLocked(parentSessionID) {
		return
	}
	type pendingLocalRow struct {
		drID         string
		delegationID string
		parentRunID  string
		turn         int
		chatTitle    string
		agentName    string
		childRaw     string
	}
	rows, err := a.Store.DB.QueryContext(a.ctx, `SELECT dr.id, dr.delegation_id, dr.parent_run_id, dr.turn,
  COALESCE(json_extract(c.data,'$.title'),''), COALESCE(json_extract(ag.data,'$.name'),''), child.data
FROM delegation_runs dr
JOIN runs parent ON parent.id=dr.parent_run_id
JOIN runs child ON child.id=dr.child_run_id
JOIN chats c ON c.id=child.chat_id
LEFT JOIN agents ag ON ag.id=child.agent_id
WHERE dr.parent_session_id=? AND dr.auto_wake=1 AND dr.receipt_consumed=0 AND dr.wake_run_id=''
  AND parent.status IN ('completed','interrupted')
  AND child.status IN ('completed','failed','interrupted','unknown')
ORDER BY dr.created_at`, parentSessionID)
	if err != nil {
		return
	}
	var pendingLocal []pendingLocalRow
	for rows.Next() {
		var row pendingLocalRow
		if err := rows.Scan(&row.drID, &row.delegationID, &row.parentRunID, &row.turn, &row.chatTitle, &row.agentName, &row.childRaw); err != nil {
			rows.Close()
			return
		}
		pendingLocal = append(pendingLocal, row)
	}
	rows.Close()

	type pendingRemoteRow struct {
		drID         string
		delegationID string
		parentRunID  string
		turn         int
		hubID        string
		spaceID      string
		deviceID     string
		deviceName   string
		agentID      string
		agentName    string
		chatID       string
		sessionID    string
		runID        string
		title        string
		status       string
		output       string
		errText      string
	}
	rRows, err := a.Store.DB.QueryContext(a.ctx, `SELECT dr.id, dr.delegation_id, dr.parent_run_id, dr.turn,
  dr.hub_id, dr.space_id, dr.device_id, dr.device_name, dr.agent_id, dr.agent_name,
  dr.chat_id, dr.session_id, dr.run_id, dr.title, dr.status, dr.output, dr.error
FROM remote_delegation_runs dr
JOIN runs parent ON parent.id=dr.parent_run_id
WHERE dr.parent_session_id=? AND dr.auto_wake=1 AND dr.receipt_consumed=0 AND dr.wake_run_id=''
  AND parent.status IN ('completed','interrupted')
  AND dr.status IN ('completed','failed','interrupted','unknown')
ORDER BY dr.created_at`, parentSessionID)
	if err != nil {
		return
	}
	var pendingRemote []pendingRemoteRow
	for rRows.Next() {
		var row pendingRemoteRow
		if err := rRows.Scan(&row.drID, &row.delegationID, &row.parentRunID, &row.turn,
			&row.hubID, &row.spaceID, &row.deviceID, &row.deviceName, &row.agentID, &row.agentName,
			&row.chatID, &row.sessionID, &row.runID, &row.title, &row.status, &row.output, &row.errText); err != nil {
			rRows.Close()
			return
		}
		pendingRemote = append(pendingRemote, row)
	}
	rRows.Close()

	if len(pendingLocal) == 0 && len(pendingRemote) == 0 {
		return
	}
	parentSession, err := store.Get[model.Session](a.ctx, a.Store.DB, "SELECT data FROM sessions WHERE id=?", parentSessionID)
	if err != nil {
		return
	}
	if parentSession.QueuePaused {
		var hasQueued bool
		if err := a.Store.DB.QueryRowContext(a.ctx, "SELECT EXISTS(SELECT 1 FROM runs WHERE session_id=? AND status='queued')", parentSessionID).Scan(&hasQueued); err != nil || hasQueued {
			return
		}
	}
	parentAgent, err := store.Get[model.Agent](a.ctx, a.Store.DB, "SELECT data FROM agents WHERE id=?", parentSession.AgentID)
	if err != nil || parentAgent.Archived {
		return
	}
	parentChat, err := store.Get[model.Chat](a.ctx, a.Store.DB, "SELECT data FROM chats WHERE id=?", parentSession.ChatID)
	if err != nil {
		return
	}
	receipts := make([]model.DelegationReceipt, 0, len(pendingLocal)+len(pendingRemote))
	var prompt strings.Builder
	prompt.WriteString("[Delegation receipt]\nThe following delegated collaborator task(s) finished. Review the result(s) and continue the workflow. Use delegate_reply to follow up in the same collaborator conversation or read_chat_context(target=<sessionId>) if you need full transcript details.\n")
	localIDs := make([]string, 0, len(pendingLocal))
	remoteIDs := make([]string, 0, len(pendingRemote))
	parentRunIDs := make([]string, 0, len(pendingLocal)+len(pendingRemote))
	const maxOutputBytes = 12 << 10
	for _, row := range pendingLocal {
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
		localIDs = append(localIDs, row.drID)
		parentRunIDs = append(parentRunIDs, row.parentRunID)

		fmt.Fprintf(&prompt, "\n- Agent: %s (%s)\n  Delegation ID: %s (Turn %d)\n  Session ID: %s\n  Status: %s\n",
			row.agentName, child.AgentID, row.delegationID, row.turn, child.SessionID, child.Status)
		if child.Error != "" {
			fmt.Fprintf(&prompt, "  Error: %s\n", child.Error)
		}
		if output != "" {
			trimmed := output
			if len(trimmed) > maxOutputBytes {
				trimmed = trimmed[:maxOutputBytes] + "\n...[truncated; inspect child session via read_chat_context for full output]"
			}
			fmt.Fprintf(&prompt, "  Output:\n%s\n", trimmed)
		}
	}
	for _, row := range pendingRemote {
		summary := truncateRunes(row.output, 240)
		if summary == "" && row.errText != "" {
			summary = truncateRunes(row.errText, 240)
		}
		receipt := model.DelegationReceipt{
			DelegationID: row.delegationID,
			HubID:        row.hubID,
			SpaceID:      row.spaceID,
			DeviceID:     row.deviceID,
			DeviceName:   row.deviceName,
			AgentID:      row.agentID,
			AgentName:    row.agentName,
			ChatID:       row.chatID,
			SessionID:    row.sessionID,
			RunID:        row.runID,
			Turn:         row.turn,
			Status:       row.status,
			Title:        row.title,
			Summary:      summary,
			Error:        row.errText,
		}
		receipts = append(receipts, receipt)
		remoteIDs = append(remoteIDs, row.drID)
		parentRunIDs = append(parentRunIDs, row.parentRunID)

		deviceLabel := row.deviceName
		if deviceLabel == "" {
			deviceLabel = row.deviceID
		}
		fmt.Fprintf(&prompt, "\n- Agent: %s (%s) on device %s (%s)\n  Delegation ID: %s (Turn %d)\n  Session ID: %s\n  Status: %s\n",
			row.agentName, row.agentID, deviceLabel, row.deviceID, row.delegationID, row.turn, row.sessionID, row.status)
		if row.errText != "" {
			fmt.Fprintf(&prompt, "  Error: %s\n", row.errText)
		}
		if row.output != "" {
			trimmed := row.output
			if len(trimmed) > maxOutputBytes {
				trimmed = trimmed[:maxOutputBytes] + "\n...[truncated; inspect remote session via read_chat_context for full output]"
			}
			fmt.Fprintf(&prompt, "  Output:\n%s\n", trimmed)
		}
	}
	if len(receipts) == 0 {
		return
	}
	wakeChannel := a.lookupDelegationWakeChannel(parentChat, parentSessionID, parentRunIDs)
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
	}, sendOrigin{delegationWake: &delegationReceiptWake{receipts: receipts, channel: wakeChannel}})
	if err != nil {
		slog.Warn("deliver delegation receipt", "session", parentSessionID, "error", err)
		return
	}
	if err := a.Store.Write(a.ctx, func(tx *sql.Tx) error {
		for _, id := range localIDs {
			if _, err := tx.ExecContext(a.ctx, "UPDATE delegation_runs SET receipt_consumed=1, wake_run_id=? WHERE id=?", wakeRun.ID, id); err != nil {
				return err
			}
		}
		for _, id := range remoteIDs {
			if _, err := tx.ExecContext(a.ctx, "UPDATE remote_delegation_runs SET receipt_consumed=1, wake_run_id=? WHERE id=?", wakeRun.ID, id); err != nil {
				return err
			}
		}
		return nil
	}); err != nil {
		slog.Warn("record delegation receipt delivery", "session", parentSessionID, "error", err)
	}
}

func (a *App) stopLocalDelegationRun(ctx context.Context, runID string) error {
	if runID == "" {
		return nil
	}
	var status string
	if err := a.Store.DB.QueryRowContext(ctx, "SELECT status FROM runs WHERE id=?", runID).Scan(&status); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil
		}
		return err
	}
	if status == "queued" {
		return a.QueueAction(ctx, runID, "remove", "")
	}
	return a.Stop(ctx, runID)
}

func (a *App) StopDelegation(ctx context.Context, delegationID string) error {
	delegationID = strings.TrimSpace(delegationID)
	if delegationID == "" {
		return invalid("delegation id is required")
	}
	d, err := store.Get[model.Delegation](ctx, a.Store.DB, "SELECT data FROM delegations WHERE id=?", delegationID)
	if err != nil {
		return err
	}
	parentChatID := ""
	if d.ParentSessionID != "" {
		_ = a.Store.DB.QueryRowContext(ctx, "SELECT chat_id FROM sessions WHERE id=?", d.ParentSessionID).Scan(&parentChatID)
	}
	if d.DeviceID != "" {
		if err := a.cancelRemoteDelegation(ctx, d); err != nil {
			return err
		}
	} else {
		_, _ = a.Store.DB.ExecContext(ctx, "UPDATE delegation_runs SET receipt_consumed=1 WHERE delegation_id=? AND child_run_id=?", d.ID, d.RunID)
		if err := a.stopLocalDelegationRun(ctx, d.RunID); err != nil {
			return err
		}
	}
	if parentChatID != "" {
		_ = a.Store.Write(ctx, func(tx *sql.Tx) error {
			return store.Event(tx, model.Event{Type: "delegations", ChatID: parentChatID})
		})
	}
	return nil
}

func (a *App) StopSessionDelegations(ctx context.Context, sessionID string) error {
	sessionID = strings.TrimSpace(sessionID)
	if sessionID == "" {
		return invalid("session id is required")
	}
	var parentChatID string
	if err := a.Store.DB.QueryRowContext(ctx, "SELECT chat_id FROM sessions WHERE id=?", sessionID).Scan(&parentChatID); err != nil {
		return err
	}
	type localTarget struct {
		drID  string
		runID string
	}
	var locals []localTarget
	rows, err := a.Store.DB.QueryContext(ctx, `SELECT dr.id, dr.child_run_id FROM delegation_runs dr
JOIN runs child ON child.id=dr.child_run_id
WHERE dr.parent_session_id=? AND child.status IN ('queued','starting','running','waiting_user','cancelling')`, sessionID)
	if err != nil {
		return err
	}
	for rows.Next() {
		var item localTarget
		if rows.Scan(&item.drID, &item.runID) == nil {
			locals = append(locals, item)
		}
	}
	rows.Close()

	var remoteRowIDs []string
	rRows, err := a.Store.DB.QueryContext(ctx, `SELECT id FROM remote_delegation_runs
WHERE parent_session_id=? AND status IN ('queued','starting','running','waiting_user','cancelling')`, sessionID)
	if err != nil {
		return err
	}
	for rRows.Next() {
		var id string
		if rRows.Scan(&id) == nil {
			remoteRowIDs = append(remoteRowIDs, id)
		}
	}
	rRows.Close()

	for _, item := range locals {
		_, _ = a.Store.DB.ExecContext(ctx, "UPDATE delegation_runs SET receipt_consumed=1 WHERE id=?", item.drID)
		_ = a.stopLocalDelegationRun(ctx, item.runID)
	}
	if len(remoteRowIDs) > 0 {
		for _, id := range remoteRowIDs {
			var row remoteDelegationRow
			if err := a.loadRemoteDelegationRowByID(ctx, id, &row); err != nil {
				continue
			}
			_, _ = a.Store.DB.ExecContext(ctx, "UPDATE remote_delegation_runs SET receipt_consumed=1, pending_cancel=1, updated_at=? WHERE id=?", now(), row.ID)
			_ = a.tryStopRemoteDelegationRow(ctx, row)
		}
		a.StartRemoteDelegationFollower()
		a.wakeRemoteDelegations()
	}
	return a.Store.Write(ctx, func(tx *sql.Tx) error {
		return store.Event(tx, model.Event{Type: "delegations", ChatID: parentChatID})
	})
}

func (a *App) sessionDelegationSnapshot(ctx context.Context, sessionID string) string {
	if sessionID == "" {
		return ""
	}
	type snapItem struct {
		id              string
		agentName       string
		deviceName      string
		sessionID       string
		turn            int
		status          string
		workingCopyName string
		title           string
		summary         string
		pendingRequests int
		createdAt       string
		active          bool
	}
	var activeItems, finishedItems []snapItem

	rows, err := a.Store.DB.QueryContext(ctx, `SELECT d.data, r.data, COALESCE(json_extract(ag.data,'$.name'),''), COALESCE(json_extract(c.data,'$.title'),''),
(SELECT COUNT(*) FROM requests req WHERE req.run_id=r.id AND req.status='pending')
FROM delegations d
JOIN runs parent ON parent.id=d.parent_run_id
JOIN runs r ON r.id=json_extract(d.data,'$.runId')
LEFT JOIN agents ag ON ag.id=r.agent_id
LEFT JOIN chats c ON c.id=r.chat_id
WHERE COALESCE(json_extract(d.data,'$.deviceId'),'')='' AND (COALESCE(json_extract(d.data,'$.parentSessionId'),'')=? OR parent.session_id=?)
ORDER BY COALESCE(json_extract(r.data,'$.createdAt'),'') DESC`, sessionID, sessionID)
	if err == nil {
		for rows.Next() {
			var rawD, rawRun, agentName, title string
			var pendingReqs int
			if rows.Scan(&rawD, &rawRun, &agentName, &title, &pendingReqs) != nil {
				continue
			}
			var d model.Delegation
			var run model.Run
			if json.Unmarshal([]byte(rawD), &d) != nil || json.Unmarshal([]byte(rawRun), &run) != nil {
				continue
			}
			if agentName == "" {
				agentName = d.AgentName
			}
			if agentName == "" {
				agentName = run.AgentID
			}
			summary := truncateRunes(runOutputText(run), 120)
			if summary == "" && run.Error != "" {
				summary = truncateRunes(run.Error, 120)
			}
			item := snapItem{
				id:              d.ID,
				agentName:       agentName,
				sessionID:       d.SessionID,
				turn:            max(1, max(d.Turn, len(d.RunIDs))),
				status:          run.Status,
				workingCopyName: d.WorkingCopyName,
				title:           truncateRunes(title, 80),
				summary:         summary,
				pendingRequests: pendingReqs,
				createdAt:       run.CreatedAt,
				active:          !isDelegationFinished(run.Status),
			}
			if item.active {
				activeItems = append(activeItems, item)
			} else {
				finishedItems = append(finishedItems, item)
			}
		}
		rows.Close()
	}

	rRows, err := a.Store.DB.QueryContext(ctx, `SELECT dr.delegation_id, dr.device_name, dr.device_id, dr.agent_name, dr.agent_id,
dr.session_id, dr.turn, dr.status, dr.working_copy_name, dr.title, dr.summary, dr.error, dr.requests, dr.created_at
FROM remote_delegation_runs dr
WHERE dr.parent_session_id=? AND dr.turn=(SELECT MAX(x.turn) FROM remote_delegation_runs x WHERE x.delegation_id=dr.delegation_id)
ORDER BY dr.created_at DESC`, sessionID)
	if err == nil {
		for rRows.Next() {
			var item snapItem
			var deviceID, agentID, errText, reqsJSON string
			if rRows.Scan(&item.id, &item.deviceName, &deviceID, &item.agentName, &agentID,
				&item.sessionID, &item.turn, &item.status, &item.workingCopyName, &item.title, &item.summary, &errText, &reqsJSON, &item.createdAt) != nil {
				continue
			}
			if item.deviceName == "" {
				item.deviceName = deviceID
			}
			if item.agentName == "" {
				item.agentName = agentID
			}
			if item.summary == "" && errText != "" {
				item.summary = truncateRunes(errText, 120)
			} else {
				item.summary = truncateRunes(item.summary, 120)
			}
			item.title = truncateRunes(item.title, 80)
			if reqsJSON != "" && reqsJSON != "[]" {
				var reqs []model.Request
				if json.Unmarshal([]byte(reqsJSON), &reqs) == nil {
					item.pendingRequests = len(reqs)
				}
			}
			item.active = !isDelegationFinished(item.status)
			if item.active {
				activeItems = append(activeItems, item)
			} else {
				finishedItems = append(finishedItems, item)
			}
		}
		rRows.Close()
	}

	if len(activeItems) == 0 && len(finishedItems) == 0 {
		return ""
	}
	slices.SortFunc(activeItems, func(a, b snapItem) int { return strings.Compare(b.createdAt, a.createdAt) })
	slices.SortFunc(finishedItems, func(a, b snapItem) int { return strings.Compare(b.createdAt, a.createdAt) })

	const maxFinished = 3
	const maxBytes = 1800
	var b strings.Builder
	b.WriteString("<delegation-context>\nBackground delegations owned by this conversation (use delegate_list, delegate_wait, delegate_reply, delegate_cancel, or read_chat_context(target=<sessionId>)):\n")
	writeItem := func(it snapItem) bool {
		var line strings.Builder
		fmt.Fprintf(&line, "- [%s] %s", it.status, it.agentName)
		if it.deviceName != "" {
			fmt.Fprintf(&line, " @%s", it.deviceName)
		}
		fmt.Fprintf(&line, " (id=%s", it.id)
		if it.sessionID != "" {
			fmt.Fprintf(&line, ", session=%s", it.sessionID)
		}
		fmt.Fprintf(&line, ", turn=%d", it.turn)
		if it.workingCopyName != "" {
			fmt.Fprintf(&line, ", worktree=%s", it.workingCopyName)
		}
		if it.pendingRequests > 0 {
			fmt.Fprintf(&line, ", pending_approvals=%d", it.pendingRequests)
		}
		line.WriteString(")")
		desc := it.summary
		if desc == "" {
			desc = it.title
		}
		if desc != "" {
			fmt.Fprintf(&line, ": %s", desc)
		}
		line.WriteString("\n")
		if b.Len()+line.Len()+32 > maxBytes {
			return false
		}
		b.WriteString(line.String())
		return true
	}
	for _, it := range activeItems {
		if !writeItem(it) {
			break
		}
	}
	shownFinished := 0
	for _, it := range finishedItems {
		if shownFinished >= maxFinished {
			break
		}
		if !writeItem(it) {
			break
		}
		shownFinished++
	}
	if extra := len(finishedItems) - shownFinished; extra > 0 {
		fmt.Fprintf(&b, "- ...and %d earlier finished delegation(s); call delegate_list to view all.\n", extra)
	}
	b.WriteString("</delegation-context>")
	return b.String()
}
