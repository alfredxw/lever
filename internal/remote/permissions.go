package remote

import (
	"context"
	"crypto/ed25519"
	"database/sql"
	"errors"
	"net/url"
	"strings"

	"github.com/google/uuid"
	"lever/internal/model"
	p "lever/internal/remoteproto"
	"lever/internal/store"
)

type trustedController struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Permissions []struct {
		AgentID string `json:"agentId"`
		Action  string `json:"action"`
	} `json:"permissions"`
}

func (h *Host) manageController(ctx context.Context, st p.ClientState, in Management) (any, error) {
	m := st.Membership
	if !m.Role.Executes() {
		return nil, errors.New("executor role required")
	}
	if in.Action == "pending_controllers" {
		return store.List[trustedController](ctx, h.App.Store.DB, `SELECT json_object('id',controller,'name',name,'permissions',json_array()) FROM remote_pending_controllers WHERE hub=? AND space=? ORDER BY name,controller`, m.Hub.ID, m.SpaceID)
	}
	if in.Action == "trusted" {
		return store.List[trustedController](ctx, h.App.Store.DB, `SELECT json_object('id',t.controller,'name',t.name,'permissions',
			(SELECT json_group_array(json_object('agentId',p.agent_id,'action',p.action)) FROM remote_control_permissions p WHERE (p.hub,p.space,p.controller)=(t.hub,t.space,t.controller)))
			FROM remote_trusted_controllers t WHERE t.hub=? AND t.space=? ORDER BY t.name,t.controller`, m.Hub.ID, m.SpaceID)
	}
	if _, err := uuid.Parse(in.ControllerID); err != nil {
		return nil, errors.New("select a paired personal controller")
	}
	h.configMu.Lock()
	defer h.configMu.Unlock()
	args := []any{m.Hub.ID, m.SpaceID, in.ControllerID}
	switch in.Action {
	case "discard_controller":
		_, err := h.App.Store.DB.ExecContext(ctx, "DELETE FROM remote_pending_controllers WHERE hub=? AND space=? AND controller=?", args...)
		return true, err
	case "trust":
		if st.Origin == "" {
			return true, h.App.Store.Write(ctx, func(tx *sql.Tx) error {
				var pub []byte
				var name string
				if err := tx.QueryRow("SELECT pub,name FROM remote_pending_controllers WHERE hub=? AND space=? AND controller=?", args...).Scan(&pub, &name); err != nil {
					return err
				}
				if err := saveLANController(tx, in.Scope, p.Identity{ID: in.ControllerID, PublicKey: pub}, name, false); err != nil {
					return err
				}
				if err := approveReturnPeer(tx, in.Scope.HubID, in.Scope.SpaceID, in.ControllerID); err != nil {
					return err
				}
				_, err := tx.Exec("DELETE FROM remote_pending_controllers WHERE hub=? AND space=? AND controller=?", args...)
				return err
			})
		}
		var d p.Device
		if err := st.Do(ctx, "GET", st.SpacePath()+"/controllers/"+url.PathEscape(in.ControllerID), nil, &d); err != nil {
			return nil, err
		}
		if d.ID != in.ControllerID || len(d.PublicKey) != ed25519.PublicKeySize {
			return nil, errors.New("invalid personal controller")
		}
		res, err := h.App.Store.DB.ExecContext(ctx, "INSERT INTO remote_trusted_controllers VALUES(?,?,?,?,?) ON CONFLICT(hub,space,controller) DO UPDATE SET name=excluded.name WHERE pub=excluded.pub", m.Hub.ID, m.SpaceID, d.ID, d.PublicKey, d.Name)
		if err != nil {
			return nil, err
		}
		if n, _ := res.RowsAffected(); n == 0 {
			return nil, errors.New("controller identity changed; remove its prior trust first")
		}
		return true, nil
	case "untrust":
		_, err := h.App.Store.DB.ExecContext(ctx, "DELETE FROM remote_trusted_controllers WHERE hub=? AND space=? AND controller=?", args...)
		return true, err
	case "rename_trusted":
		name := strings.TrimSpace(in.Name)
		if name == "" || len(name) > 80 {
			return nil, errors.New("invalid device name")
		}
		_, err := h.App.Store.DB.ExecContext(ctx, "UPDATE remote_trusted_controllers SET name=? WHERE hub=? AND space=? AND controller=?", name, m.Hub.ID, m.SpaceID, in.ControllerID)
		return true, err
	case "permission":
		if !validRemoteOperation(in.Operation) {
			return nil, errors.New("unsupported remote permission")
		}
		if in.AgentID == "" {
			return nil, errors.New("select an agent")
		}
		args = append(args, in.AgentID, in.Operation)
		query := "DELETE FROM remote_control_permissions WHERE hub=? AND space=? AND controller=? AND agent_id=? AND action=?"
		if in.Enabled {
			query = "INSERT INTO remote_control_permissions VALUES(?,?,?,?,?) ON CONFLICT DO NOTHING"
		}
		_, err := h.App.Store.DB.ExecContext(ctx, query, args...)
		return true, err
	case "set_permissions":
		for _, op := range in.Operations {
			if !validRemoteOperation(op) {
				return nil, errors.New("unsupported remote permission")
			}
		}
		err := h.App.Store.Write(ctx, func(tx *sql.Tx) error {
			var trusted bool
			if err := tx.QueryRow("SELECT EXISTS(SELECT 1 FROM remote_trusted_controllers WHERE hub=? AND space=? AND controller=?)", m.Hub.ID, m.SpaceID, in.ControllerID).Scan(&trusted); err != nil {
				return err
			}
			if !trusted {
				return errors.New("controller is not trusted")
			}
			if _, err := tx.Exec("DELETE FROM remote_control_permissions WHERE hub=? AND space=? AND controller=?", m.Hub.ID, m.SpaceID, in.ControllerID); err != nil {
				return err
			}
			if in.AllAgents {
				for _, op := range in.Operations {
					if _, err := tx.Exec("INSERT OR IGNORE INTO remote_control_permissions VALUES(?,?,?,'*',?)", m.Hub.ID, m.SpaceID, in.ControllerID, op); err != nil {
						return err
					}
				}
				return nil
			}
			for _, agentID := range in.AgentIDs {
				if agentID == "" || agentID == "*" {
					continue
				}
				for _, op := range in.Operations {
					if _, err := tx.Exec("INSERT OR IGNORE INTO remote_control_permissions VALUES(?,?,?,?,?)", m.Hub.ID, m.SpaceID, in.ControllerID, agentID, op); err != nil {
						return err
					}
				}
			}
			return nil
		})
		return true, err
	}
	return nil, errors.New("unknown controller setting")
}

func validRemoteOperation(op string) bool {
	switch op {
	case "send", "answer", "allow_run", "resume_queue", "resolve_unknown", "stop", "dispatch_task":
		return true
	default:
		return false
	}
}

func (h *Host) permitted(ctx context.Context, scope model.SharedScope, i p.Intent) (bool, error) {
	if i.Delegation != nil {
		return h.delegationPermitted(ctx, scope, i)
	}
	if !i.Private && validRemoteOperation(i.Kind) && i.ActorUserID != "" {
		var owner bool
		err := h.App.Store.DB.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM remote_access JOIN remote_memberships m USING(hub,space)
			WHERE hub=? AND space=? AND confirm=0 AND json_extract(credential,'$.userId')=?
			AND (m.origin='' OR json_extract(credential,'$.spaceKind')='personal'))`, scope.HubID, scope.SpaceID, i.ActorUserID).Scan(&owner)
		if err != nil || owner {
			// ReviewRemote checks the actual Chat, Agent exposure and child IDs
			// against the local database before committing the action.
			return owner, err
		}
	}
	if i.OriginDeviceID == "" {
		return false, nil
	}
	if i.Private {
		// Private (device-only) chats only auto-authorize in Direct LAN mode (origin='')
		// where nothing ever leaves the user's Wi-Fi and the controller has explicit permission.
		if i.ChatID == "" {
			return false, nil
		}
		var ok bool
		err := h.App.Store.DB.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM chats c
			JOIN remote_memberships m ON m.hub=? AND m.space=? AND m.origin=''
			JOIN remote_control_permissions p ON p.hub=m.hub AND p.space=m.space AND p.controller=? AND p.action=? AND (p.agent_id='*' OR p.agent_id=c.agent_id)
			JOIN agents a ON a.id=c.agent_id
			WHERE c.id=? AND json_type(c.data,'$.sharedScope') IS NULL
			AND json_extract(m.credential,'$.userId')=?
			AND coalesce(json_extract(a.data,'$.archived'),0)=0 AND coalesce(json_extract(a.data,'$.localOnly'),0)=0
			AND (m.expose_all=1 OR EXISTS(SELECT 1 FROM hub_exposed_agents e WHERE e.hub=m.hub AND e.space=m.space AND e.agent_id=a.id)))`,
			scope.HubID, scope.SpaceID, i.OriginDeviceID, i.Kind, i.ChatID, i.ActorUserID).Scan(&ok)
		return ok, err
	}
	// For existing chats the owning Agent comes from the local database.
	// Wildcard agent_id='*' follows whichever non-archived Agents are exposed to this space.
	var ok bool
	err := h.App.Store.DB.QueryRowContext(ctx, `WITH target(agent_id) AS (
			SELECT CASE WHEN ?='' THEN ? ELSE (SELECT agent_id FROM chats WHERE id=? AND json_extract(data,'$.sharedScope.hubId')=? AND json_extract(data,'$.sharedScope.spaceId')=?) END
		)
		SELECT EXISTS(SELECT 1 FROM remote_control_permissions p
			JOIN remote_memberships m USING(hub,space)
			JOIN target t ON (p.agent_id='*' OR p.agent_id=t.agent_id)
			JOIN agents a ON a.id=t.agent_id
			WHERE p.hub=? AND p.space=? AND p.controller=? AND p.action=? AND json_extract(m.credential,'$.userId')=?
			AND coalesce(json_extract(a.data,'$.archived'),0)=0 AND coalesce(json_extract(a.data,'$.localOnly'),0)=0
			AND (m.expose_all=1 OR EXISTS(SELECT 1 FROM hub_exposed_agents e WHERE e.hub=m.hub AND e.space=m.space AND e.agent_id=a.id)))`,
		i.ChatID, i.AgentID, i.ChatID, scope.HubID, scope.SpaceID,
		scope.HubID, scope.SpaceID, i.OriginDeviceID, i.Kind, i.ActorUserID).Scan(&ok)
	if err != nil || ok {
		return ok, err
	}
	return h.delegationPermitted(ctx, scope, i)
}

func (h *Host) delegationPermitted(ctx context.Context, scope model.SharedScope, i p.Intent) (bool, error) {
	return h.delegationAllowed(ctx, scope, i, false)
}

func (h *Host) delegationAllowed(ctx context.Context, scope model.SharedScope, i p.Intent, reviewed bool) (bool, error) {
	if i.Private || i.OriginDeviceID == "" || i.ActorUserID == "" {
		return false, nil
	}
	var allowedMembership bool
	err := h.App.Store.DB.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM remote_memberships
		WHERE hub=? AND space=? AND (allow_delegation=1 OR ?)
		AND json_extract(credential,'$.userId')=?
		AND coalesce(nullif(json_extract(credential,'$.spaceKind'),''),'personal')='personal')`,
		scope.HubID, scope.SpaceID, reviewed, i.ActorUserID).Scan(&allowedMembership)
	if err != nil || !allowedMembership {
		return false, err
	}
	if i.Kind == "send" && i.ChatID == "" {
		if i.Delegation == nil || i.Delegation.DeviceID != i.OriginDeviceID {
			return false, nil
		}
		var ok bool
		err = h.App.Store.DB.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM agents a
			JOIN remote_memberships m ON m.hub=? AND m.space=?
			WHERE a.id=? AND coalesce(json_extract(a.data,'$.archived'),0)=0 AND coalesce(json_extract(a.data,'$.localOnly'),0)=0
			AND coalesce(json_extract(a.data,'$.profile.acceptDelegations'),1)=1
			AND (m.expose_all=1 OR EXISTS(SELECT 1 FROM hub_exposed_agents e WHERE e.hub=m.hub AND e.space=m.space AND e.agent_id=a.id)))`,
			scope.HubID, scope.SpaceID, i.AgentID).Scan(&ok)
		return ok, err
	}
	if i.ChatID == "" {
		return false, nil
	}
	switch i.Kind {
	case "send":
		if i.Delegation == nil || i.Delegation.DeviceID != i.OriginDeviceID {
			return false, nil
		}
	case "stop", "answer", "allow_run":
	default:
		return false, nil
	}
	var ok bool
	err = h.App.Store.DB.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM chats c
		JOIN sessions s ON s.chat_id=c.id AND s.kind='main'
		JOIN agents a ON a.id=c.agent_id
		JOIN remote_memberships m ON m.hub=? AND m.space=?
		WHERE c.id=? AND (json_type(c.data,'$.sharedScope') IS NULL OR (json_extract(c.data,'$.sharedScope.hubId')=? AND json_extract(c.data,'$.sharedScope.spaceId')=?))
		AND json_extract(s.data,'$.delegatedFrom.deviceId')=?
		AND (?='stop' OR (coalesce(json_extract(a.data,'$.archived'),0)=0 AND coalesce(json_extract(a.data,'$.localOnly'),0)=0
			AND (m.expose_all=1 OR EXISTS(SELECT 1 FROM hub_exposed_agents e WHERE e.hub=m.hub AND e.space=m.space AND e.agent_id=a.id)))))`,
		scope.HubID, scope.SpaceID, i.ChatID, scope.HubID, scope.SpaceID, i.OriginDeviceID, i.Kind).Scan(&ok)
	return ok, err
}

func (h *Host) acceptOffer(ctx context.Context, st p.ClientState, f p.Frame) {
	// A grant can be removed between delivery and execution. Serialize against
	// the settings action and recheck the actual intent fetched from the Hub.
	h.configMu.Lock()
	defer h.configMu.Unlock()
	_, _ = h.review(ctx, st, Management{Action: "authorized", Scope: model.SharedScope{HubID: st.Membership.Hub.ID, SpaceID: st.Membership.SpaceID}, ID: f.RPCID})
}
