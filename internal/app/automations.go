package app

import (
	"bytes"
	"context"
	"crypto/subtle"
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"reflect"
	"slices"
	"strings"
	"time"
	"unicode/utf8"

	"lever/internal/model"
	"lever/internal/store"
)

const (
	MaxAutomationEventBytes = 16 << 10
	maxAutomationBatch      = 50
	maxAutomationPending    = 1000
	maxAutomationTargets    = 20
)

const automationPluginJoin = ` LEFT JOIN plugins p ON p.id=json_extract(a.data,'$.trigger.source.pluginId')`
const automationPluginEnabled = `COALESCE(json_extract(p.data,'$.enabled') AND json_extract(p.data,'$.installed'),0)`

const automationProjection = `SELECT json_patch(a.data, json_object(
  'id',a.id, 'enabled',json(CASE a.state WHEN 'active' THEN 'true' ELSE 'false' END),
  'nextAt',a.next_at, 'eventToken',NULLIF(a.event_token,''), 'error',NULLIF(a.error,''),
  'boundChatId',a.bound_chat_id,
  'boundChats',json(COALESCE(NULLIF(a.bound_chats,''),'{}')),
  'sourceReady',json(CASE WHEN src.cursor<>'' THEN 'true' ELSE 'false' END),
  'sourceDisabled',json(CASE WHEN src.automation_id IS NOT NULL AND NOT ` + automationPluginEnabled + ` THEN 'true' ELSE 'false' END),
  'sourceError',NULLIF(src.error,''),
  'sourceSecrets',json(src.secret_fields),
  'pendingEvents',(SELECT COUNT(*) FROM automation_events e WHERE e.automation_id=a.id AND e.payload IS NOT NULL)`
const automationFrom = `)) FROM automations a LEFT JOIN automation_event_sources src ON src.automation_id=a.id` +
	automationPluginJoin + ` WHERE a.state <> 'archived'`

func (a *App) Automations(ctx context.Context) ([]model.Automation, error) {
	return store.List[model.Automation](ctx, a.Store.DB, automationProjection+`,
  'recentRuns',(SELECT json_group_array(json_object('runId',run_id,'targetId',target_id,'agentId',agent_id,'status',status,'createdAt',created_at)) FROM (
    SELECT ar.run_id, NULLIF(ar.target_id,'') AS target_id,
      COALESCE(NULLIF(ar.agent_id,''), r.agent_id) AS agent_id,
      COALESCE(r.status,NULLIF(ar.status,''),'cancelled') AS status, ar.created_at
    FROM automation_runs ar LEFT JOIN runs r ON r.id=ar.run_id
    WHERE ar.automation_id=a.id ORDER BY ar.rowid DESC LIMIT 14
  ))`+automationFrom+" ORDER BY a.rowid DESC")
}

func (a *App) Automation(ctx context.Context, id string) (model.Automation, error) {
	return store.Get[model.Automation](ctx, a.Store.DB, automationProjection+`,
  'recentRuns',(SELECT json_group_array(json_object('runId',run_id,'targetId',target_id,'agentId',agent_id,'status',status,'createdAt',created_at)) FROM (
    SELECT ar.run_id, NULLIF(ar.target_id,'') AS target_id,
      COALESCE(NULLIF(ar.agent_id,''), r.agent_id) AS agent_id,
      COALESCE(r.status,NULLIF(ar.status,''),'cancelled') AS status, ar.created_at
    FROM automation_runs ar LEFT JOIN runs r ON r.id=ar.run_id
    WHERE ar.automation_id=a.id ORDER BY ar.rowid DESC LIMIT 14
  ))`+automationFrom+" AND a.id=?", id)
}

func getAutomation(ctx context.Context, q store.Queryer, id string) (model.Automation, error) {
	return store.Get[model.Automation](ctx, q, automationProjection+automationFrom+" AND a.id=?", id)
}

func normalizeAutomationSelection(s *model.Selection) (*model.Selection, error) {
	if s == nil {
		return nil, nil
	}
	v := model.Selection{
		Provider:   strings.TrimSpace(s.Provider),
		Model:      strings.TrimSpace(s.Model),
		Permission: strings.TrimSpace(s.Permission),
		Effort:     strings.TrimSpace(s.Effort),
		Fast:       s.Fast,
	}
	if v == (model.Selection{}) {
		return nil, nil
	}
	if len(v.Provider) > 256 || strings.ContainsAny(v.Provider, "\x00\r\n") {
		return nil, invalid("Invalid runtime options")
	}
	if err := validateSelection(&v); err != nil {
		return nil, err
	}
	return &v, nil
}

func mergeAutomationSelection(override *model.Selection, base model.Selection) *model.Selection {
	if override == nil {
		return nil
	}
	sel := *override
	if sel.Provider == "" {
		sel.Provider = base.Provider
	}
	if sel.Provider == base.Provider {
		if sel.Model == "" {
			sel.Model = base.Model
			if sel.Effort == "" {
				sel.Effort = base.Effort
			}
			if !sel.Fast {
				sel.Fast = base.Fast
			}
		}
		if sel.Permission == "" {
			sel.Permission = base.Permission
		}
	}
	return &sel
}

func (a *App) SaveAutomation(ctx context.Context, id string, input model.AutomationInput) (model.Automation, error) {
	input.Name, input.Prompt = strings.TrimSpace(input.Name), strings.TrimSpace(input.Prompt)
	if input.Name == "" || utf8.RuneCountInString(input.Name) > 80 || input.Prompt == "" || len(input.Prompt) > 32<<10 {
		return model.Automation{}, invalid("Enter a name up to 80 characters and a prompt up to 32 KiB")
	}
	switch input.NotifyPolicy {
	case "":
		if input.Quiet {
			input.NotifyPolicy = "silent"
		}
	case "silent":
		input.Quiet = true
	case "always", "actionable":
		input.Quiet = false
	default:
		return model.Automation{}, invalid("Choose a valid notification policy")
	}
	switch input.DeliveryMode {
	case "", "deliver", "audit", "propose", "curate":
	default:
		return model.Automation{}, invalid("Choose a valid delivery mode")
	}
	var calendar automationCalendar
	switch input.Trigger.Kind {
	case "schedule":
		var err error
		calendar, err = parseAutomationSchedule(input.Trigger.Schedule)
		if err != nil {
			return model.Automation{}, err
		}
		slices.Sort(input.Trigger.Schedule.Weekdays)
		input.Trigger.Schedule.Weekdays = slices.Compact(input.Trigger.Schedule.Weekdays)
		if len(input.Trigger.Schedule.Weekdays) == 0 || len(input.Trigger.Schedule.Weekdays) == 7 {
			input.Trigger.Schedule.Weekdays = nil
		}
		input.Trigger.BatchSize = 0
		input.Trigger.Source = nil
	case "event":
		input.Trigger.Schedule = nil
		if input.Trigger.BatchSize == 0 {
			input.Trigger.BatchSize = 1
		}
		if input.Trigger.BatchSize < 1 || input.Trigger.BatchSize > maxAutomationBatch {
			return model.Automation{}, invalid("Choose a batch size from 1 to 50")
		}
	default:
		return model.Automation{}, invalid("Choose a time or event trigger")
	}
	if input.Destination.Mode == "" {
		input.Destination.Mode = "topic"
	}
	if len(input.Targets) > maxAutomationTargets {
		return model.Automation{}, invalid("Use up to 20 execution targets")
	}
	var err error
	if input.Selection, err = normalizeAutomationSelection(input.Selection); err != nil {
		return model.Automation{}, err
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	if len(input.Targets) > 0 {
		seenTargets := make(map[string]bool, len(input.Targets))
		for i := range input.Targets {
			target := &input.Targets[i]
			target.ID = strings.TrimSpace(target.ID)
			if target.ID == "" || seenTargets[target.ID] {
				target.ID = ID()
			}
			seenTargets[target.ID] = true
			target.Prompt = strings.TrimSpace(target.Prompt)
			if len(target.Prompt) > 4<<10 {
				return model.Automation{}, invalid("Target instructions can be up to 4 KiB")
			}
			if target.Selection, err = normalizeAutomationSelection(target.Selection); err != nil {
				return model.Automation{}, err
			}
			dst := model.AutomationDestination{
				Mode:          input.Destination.Mode,
				AgentID:       target.AgentID,
				ChatID:        target.ChatID,
				WorkingCopyID: target.WorkingCopyID,
			}
			effectiveSelection := target.Selection
			if effectiveSelection == nil {
				effectiveSelection = input.Selection
			}
			if err := a.validateAutomationDestination(ctx, &dst, effectiveSelection); err != nil {
				return model.Automation{}, err
			}
			target.AgentID, target.ChatID, target.WorkingCopyID = dst.AgentID, dst.ChatID, dst.WorkingCopyID
		}
		input.Destination.AgentID = input.Targets[0].AgentID
		input.Destination.ChatID = input.Targets[0].ChatID
		input.Destination.WorkingCopyID = input.Targets[0].WorkingCopyID
	} else {
		if err := a.validateAutomationDestination(ctx, &input.Destination, input.Selection); err != nil {
			return model.Automation{}, err
		}
	}
	var saved model.Automation
	creating := id == ""
	if creating {
		id = ID()
	}
	var credentials automationCredentialChange
	err = a.Store.Write(ctx, func(tx *sql.Tx) error {
		old := model.Automation{Enabled: true}
		if !creating {
			var err error
			old, err = getAutomation(ctx, tx, id)
			if err != nil {
				return err
			}
		}
		if input.WorkItem == nil {
			tracked := !creating && old.CreatesWorkItem()
			input.WorkItem = &tracked
		}
		source, err := a.prepareAutomationSource(ctx, tx, id, old.Trigger.Source, input.Trigger.Source)
		if err != nil {
			return err
		}
		sourceChanged := !reflect.DeepEqual(old.Trigger.Source, input.Trigger.Source)
		nextAt, token := old.NextAt, old.EventToken
		if input.Trigger.Kind == "schedule" {
			token = ""
			if !reflect.DeepEqual(old.Trigger.Schedule, input.Trigger.Schedule) {
				nextAt = automationUnix(calendar.firstSlot(time.Now()))
				if nextAt == 0 {
					return invalid("Choose a future run time")
				}
				if !old.Enabled {
					nextAt = 0
				}
			}
		} else {
			nextAt = 0
			if input.Trigger.Source != nil {
				token = ""
			} else if token == "" {
				token = ID() + ID()
			}
		}
		if old.Trigger.Kind == "event" && (input.Trigger.Kind != "event" || sourceChanged) {
			if _, err := tx.ExecContext(ctx, "DELETE FROM automation_events WHERE automation_id=?", id); err != nil {
				return err
			}
		}
		bound := old.BoundChatID
		if !usesDedicatedChat(input.Destination) || input.Destination.AgentID != old.Destination.AgentID ||
			(input.Destination.Mode == "chat" && input.Destination.WorkingCopyID != old.Destination.WorkingCopyID) {
			bound = ""
		}
		boundChats := retainBoundChats(old, input)
		if _, err := tx.ExecContext(ctx, `INSERT INTO automations(id,data,state,next_at,event_token,bound_chat_id,bound_chats)
VALUES(?,?,'active',NULLIF(?,0),?,NULLIF(?,''),?) ON CONFLICT(id) DO UPDATE SET
data=excluded.data,next_at=excluded.next_at,event_token=excluded.event_token,
bound_chat_id=excluded.bound_chat_id,bound_chats=excluded.bound_chats,error=''`,
			id, store.JSON(input), nextAt, token, bound, store.JSON(boundChats)); err != nil {
			return err
		}
		if source != nil || old.Trigger.Source != nil {
			if err := a.saveAutomationSource(ctx, tx, id, source, sourceChanged, &credentials); err != nil {
				return err
			}
		}
		saved, err = getAutomation(ctx, tx, id)
		if err != nil {
			return err
		}
		return store.Event(tx, model.Event{Type: "automations"})
	})
	a.finishAutomationCredentials(credentials, err)
	return saved, err
}

func retainBoundChats(old model.Automation, input model.AutomationInput) map[string]string {
	out := map[string]string{}
	if len(input.Targets) == 0 || input.Destination.Mode == "newChat" {
		return out
	}
	oldTargets := make(map[string]model.AutomationTarget, len(old.Targets))
	for _, t := range old.Targets {
		oldTargets[t.ID] = t
	}
	for _, t := range input.Targets {
		if t.ChatID != "" {
			continue
		}
		chatID := old.BoundChats[t.ID]
		prev, hadPrev := oldTargets[t.ID]
		if chatID == "" && !hadPrev && len(old.Targets) == 0 && t.AgentID == old.Destination.AgentID && old.BoundChatID != "" {
			chatID = old.BoundChatID
			prev = model.AutomationTarget{AgentID: old.Destination.AgentID, WorkingCopyID: old.Destination.WorkingCopyID}
			hadPrev = true
		}
		if chatID != "" && hadPrev && prev.AgentID == t.AgentID &&
			(input.Destination.Mode != "chat" || prev.WorkingCopyID == t.WorkingCopyID) {
			out[t.ID] = chatID
		}
	}
	return out
}

func usesDedicatedChat(destination model.AutomationDestination) bool {
	return destination.Mode != "newChat" && destination.ChatID == ""
}

func (a *App) validateAutomationDestination(ctx context.Context, destination *model.AutomationDestination, selection *model.Selection) error {
	switch destination.Mode {
	case "chat", "topic":
		if destination.ChatID != "" {
			chat, err := store.Get[model.Chat](ctx, a.Store.DB, "SELECT data FROM chats WHERE id=?", destination.ChatID)
			if errors.Is(err, sql.ErrNoRows) || chat.Channel != "" || (destination.AgentID != "" && chat.AgentID != destination.AgentID) {
				return invalid("Select an existing Lever Chat owned by this Agent")
			}
			if err != nil {
				return err
			}
			destination.AgentID = chat.AgentID
			if destination.Mode == "chat" {
				destination.WorkingCopyID = ""
			}
		}
	case "newChat":
		destination.ChatID = ""
	default:
		return invalid("Choose a Chat destination")
	}
	agent, err := store.Get[model.Agent](ctx, a.Store.DB, "SELECT data FROM agents WHERE id=?", destination.AgentID)
	if errors.Is(err, sql.ErrNoRows) || agent.Archived {
		return invalid("Select an active Agent")
	}
	if err != nil {
		return err
	}
	if destination.WorkingCopyID != "" {
		if _, err = a.selectGroup(ctx, a.Store.DB, agent, destination.WorkingCopyID); err != nil {
			return err
		}
	}
	if selection != nil {
		base, err := agentDefaultSelection(ctx, a.Store.DB, agent)
		if err != nil {
			return err
		}
		merged := mergeAutomationSelection(selection, base)
		if merged.Permission == "" && merged.Provider != "" && merged.Provider != base.Provider {
			if targetCfg, err := configuredProvider(ctx, a.Store.DB, merged.Provider); err == nil {
				if perm, err := agentPermissionForProvider(ctx, a.Store.DB, agent.Profile, targetCfg); err == nil && perm != "" {
					merged.Permission = perm
				}
			}
		}
		if _, _, err := resolveSelection(ctx, a.Store.DB, *merged, base); err != nil {
			return err
		}
	}
	return nil
}

func (a *App) SetAutomationEnabled(ctx context.Context, id string, enabled bool) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	plan, err := getAutomation(ctx, a.Store.DB, id)
	if err != nil || plan.Enabled == enabled {
		return err
	}
	state, nextAt := "paused", int64(0)
	if enabled {
		state = "active"
		if len(plan.Targets) > 0 {
			for _, target := range plan.EffectiveTargets() {
				dst := model.AutomationDestination{
					Mode:          plan.Destination.Mode,
					AgentID:       target.AgentID,
					ChatID:        target.ChatID,
					WorkingCopyID: target.WorkingCopyID,
				}
				sel := target.Selection
				if sel == nil {
					sel = plan.Selection
				}
				if err := a.validateAutomationDestination(ctx, &dst, sel); err != nil {
					return err
				}
			}
		} else if err := a.validateAutomationDestination(ctx, &plan.Destination, plan.Selection); err != nil {
			return err
		}
		if plan.Trigger.Kind == "schedule" {
			calendar, err := parseAutomationSchedule(plan.Trigger.Schedule)
			if err != nil {
				return err
			}
			nextAt = automationUnix(calendar.firstSlot(time.Now()))
			if nextAt == 0 {
				return invalid("Edit the automation and choose a future run time")
			}
		}
	}
	return a.Store.Write(ctx, func(tx *sql.Tx) error {
		if _, err := tx.ExecContext(ctx, "UPDATE automations SET state=?,next_at=NULLIF(?,0),error='' WHERE id=?", state, nextAt, id); err != nil {
			return err
		}
		return store.Event(tx, model.Event{Type: "automations"})
	})
}

func (a *App) ArchiveAutomation(ctx context.Context, id string) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	var credentials automationCredentialChange
	err := a.Store.Write(ctx, func(tx *sql.Tx) error {
		if _, err := tx.ExecContext(ctx, "UPDATE automations SET state='archived',next_at=NULL,event_token='' WHERE id=?", id); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, "DELETE FROM automation_events WHERE automation_id=?", id); err != nil {
			return err
		}
		if err := a.saveAutomationSource(ctx, tx, id, nil, false, &credentials); err != nil {
			return err
		}
		return store.Event(tx, model.Event{Type: "automations"})
	})
	a.finishAutomationCredentials(credentials, err)
	return err
}

func (a *App) AppendAutomationEvent(ctx context.Context, id, token, key string, payload json.RawMessage) error {
	return a.appendAutomationEvent(ctx, id, token, true, key, payload)
}

func (a *App) AppendLocalAutomationEvent(ctx context.Context, id, key string, payload json.RawMessage) error {
	return a.appendAutomationEvent(ctx, id, "", false, key, payload)
}

func (a *App) appendAutomationEvent(ctx context.Context, id, token string, requireToken bool, key string, payload json.RawMessage) error {
	var compact bytes.Buffer
	if len(payload) > MaxAutomationEventBytes || !utf8.Valid(payload) || json.Compact(&compact, payload) != nil {
		return invalid("Send a JSON event up to 16 KiB")
	}
	if len(key) > 200 || !utf8.ValidString(key) {
		return invalid("Idempotency-Key can have up to 200 bytes")
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.Store.Write(ctx, func(tx *sql.Tx) error {
		plan, err := getAutomation(ctx, tx, id)
		if requireToken {
			if errors.Is(err, sql.ErrNoRows) || (err == nil && (plan.EventToken == "" || subtle.ConstantTimeCompare([]byte(token), []byte(plan.EventToken)) != 1)) {
				return &Error{http.StatusUnauthorized, "Invalid automation event token"}
			}
		} else if err == nil && (plan.Trigger.Kind != "event" || plan.Trigger.Source != nil || plan.EventToken == "") {
			return invalid("This automation does not accept custom events")
		}
		if err != nil {
			return err
		}
		if key != "" {
			var exists bool
			if err := tx.QueryRowContext(ctx, "SELECT EXISTS(SELECT 1 FROM automation_events WHERE automation_id=? AND event_key=?)", id, key).Scan(&exists); err != nil || exists {
				return err
			}
		}
		if !plan.Enabled {
			return conflict("This automation is paused")
		}
		if plan.PendingEvents >= maxAutomationPending {
			return &Error{http.StatusTooManyRequests, "This automation has too many events waiting to run"}
		}
		if _, err := tx.ExecContext(ctx, "INSERT INTO automation_events(automation_id,event_key,payload) VALUES(?,NULLIF(?,''),?)", id, key, compact.String()); err != nil {
			return err
		}
		return store.Event(tx, model.Event{Type: "automations"})
	})
}
