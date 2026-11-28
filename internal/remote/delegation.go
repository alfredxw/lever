package remote

import (
	"context"
	"encoding/json"
	"errors"
	"net/url"
	"slices"
	"strings"

	"lever/internal/model"
	p "lever/internal/remoteproto"
)

func (h *Host) ListRemoteTargets(ctx context.Context, scope *model.SharedScope) ([]model.RemoteAgentTarget, error) {
	bindings, err := h.Bindings(ctx)
	if err != nil {
		return nil, err
	}
	out, handled := h.nativeDelegationTargets(ctx, scope)
	for _, b := range bindings {
		if b.Direct || !b.Role.Controls() {
			continue
		}
		if scope != nil && (b.HubID != scope.HubID || b.SpaceID != scope.SpaceID) {
			continue
		}
		st, err := stateFor(ctx, h.App.Store, b.SharedScope)
		if err != nil {
			continue
		}
		var devices []p.Device
		if err := st.Do(ctx, "GET", st.SpacePath()+"/devices", nil, &devices); err != nil {
			continue
		}
		for _, d := range devices {
			if d.ID == h.App.Store.DeviceID || d.Revoked || !d.Role.Executes() {
				continue
			}
			if handled[d.ID] {
				continue
			}
			if d.Node != nil && d.Node.Supports(p.FeatureDelegationTargets) && d.Online {
				var rows []model.RemoteAgentTarget
				if st.Do(ctx, "GET", st.SpacePath()+"/nodes/"+url.PathEscape(d.ID)+"/delegation-targets", nil, &rows) == nil {
					identifyTargets(rows, b.SharedScope, d.ID, d.Name, d.Online, d.Draining)
					out = append(out, rows...)
				}
				continue
			}
			var records []p.Record
			if err := st.Do(ctx, "GET", st.SpacePath()+"/archive/"+url.PathEscape(d.ID), nil, &records); err != nil {
				continue
			}
			// Track which pre-created working copies and agent default checkouts currently have active runs.
			sessionByID := make(map[string]p.Record)
			for _, rec := range records {
				if rec.Kind == "session" {
					sessionByID[rec.ID] = rec
				}
			}
			busyGroups := map[string]bool{}
			busyAgentDefault := map[string]bool{}
			for _, rec := range records {
				if rec.Kind == "run" && model.Active(rec.Status) {
					if sess, ok := sessionByID[rec.SessionID]; ok {
						if sess.WorkingCopyID != "" {
							busyGroups[sess.WorkingCopyID] = true
						} else if sess.AgentID != "" {
							busyAgentDefault[sess.AgentID] = true
						}
					} else if rec.AgentID != "" {
						busyAgentDefault[rec.AgentID] = true
					}
				}
			}
			for _, rec := range records {
				if rec.Kind != "agent" {
					continue
				}
				if rec.AcceptDelegations != nil && !*rec.AcceptDelegations {
					continue
				}
				wcs := make([]model.RemoteWorkingCopy, 0, len(rec.Groups))
				for _, g := range rec.Groups {
					wcs = append(wcs, model.RemoteWorkingCopy{ID: g.ID, Name: g.Name, State: g.State, Busy: busyGroups[g.ID]})
				}
				out = append(out, model.RemoteAgentTarget{
					HubID:          b.HubID,
					SpaceID:        b.SpaceID,
					SpaceKind:      b.SpaceKind,
					DeviceID:       d.ID,
					DeviceName:     d.Name,
					Online:         d.Online,
					Draining:       d.Draining,
					AgentID:        rec.ID,
					Name:           rec.Title,
					Avatar:         rec.Avatar,
					Description:    rec.Description,
					Provider:       rec.Provider,
					Model:          rec.Model,
					PermissionMode: rec.Permission,
					DefaultBusy:    busyAgentDefault[rec.ID],
					WorkingCopies:  wcs,
				})
			}
		}
	}
	slices.SortFunc(out, func(a, b model.RemoteAgentTarget) int {
		if c := strings.Compare(a.DeviceName, b.DeviceName); c != 0 {
			return c
		}
		if c := strings.Compare(a.Name, b.Name); c != 0 {
			return c
		}
		return strings.Compare(a.AgentID, b.AgentID)
	})
	return out, nil
}

func (h *Host) SubmitRemoteIntent(ctx context.Context, scope model.SharedScope, intent p.Intent) (p.InboxItem, error) {
	var item p.InboxItem
	if node, ok := h.delegationNode(&scope, intent.DeviceID); ok {
		err := peerJSON(ctx, node, "POST", "/delegations", intent, &item.Receipt)
		return item, err
	}

	st, err := stateFor(ctx, h.App.Store, scope)
	if err != nil {
		return item, err
	}
	if !st.Membership.Role.Controls() {
		return item, errors.New("controller role required for remote delegation")
	}
	body, err := json.Marshal(intent)
	if err != nil {
		return item, err
	}
	path := st.SpacePath() + "/commands"
	if raw, ok, err := h.lanClient.Local(ctx, st, "POST", path, body); ok {
		if err == nil && json.Unmarshal(raw, &item) == nil {
			return item, nil
		}
	}
	err = st.Do(ctx, "POST", path, intent, &item)
	return item, err
}

func (h *Host) LookupRemoteCommand(ctx context.Context, scope model.SharedScope, deviceID, commandID string) (p.InboxItem, error) {
	var item p.InboxItem
	if node, ok := h.delegationNode(&scope, deviceID); ok {
		err := peerJSON(ctx, node, "GET", "/commands/"+url.PathEscape(commandID), nil, &item.Receipt)
		return item, err
	}

	st, err := stateFor(ctx, h.App.Store, scope)
	if err != nil {
		return item, err
	}
	path := st.SpacePath() + "/commands/" + url.PathEscape(deviceID) + "/" + url.PathEscape(commandID)
	if raw, ok, err := h.lanClient.Local(ctx, st, "GET", path, nil); ok {
		if err == nil && json.Unmarshal(raw, &item) == nil {
			return item, nil
		}
	}
	err = st.Do(ctx, "GET", path, nil, &item)
	return item, err
}

func (h *Host) ReadRemoteChat(ctx context.Context, scope model.SharedScope, deviceID, chatID string) ([]p.Record, error) {
	var records []p.Record
	st, err := stateFor(ctx, h.App.Store, scope)
	if err != nil {
		return nil, err
	}
	path := st.SpacePath() + "/archive/" + url.PathEscape(deviceID) + "?chat=" + url.QueryEscape(chatID)
	if raw, ok, err := h.lanClient.Local(ctx, st, "GET", path, nil); ok {
		if err == nil && json.Unmarshal(raw, &records) == nil {
			return records, nil
		}
	}
	err = st.Do(ctx, "GET", path, nil, &records)
	return records, err
}
