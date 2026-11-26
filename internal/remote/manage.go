package remote

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"github.com/google/uuid"
	"lever/internal/store"
	"net/http"
	"net/url"
	"os"
	"runtime"
	"strings"

	"lever/internal/app"
	"lever/internal/device"
	"lever/internal/model"
	p "lever/internal/remoteproto"
)

type Management struct {
	Operation    string            `json:"operation,omitempty"`
	ControllerID string            `json:"controllerId,omitempty"`
	Name         string            `json:"name,omitempty"`
	NoteVersion  string            `json:"noteVersion,omitempty"`
	Enabled      bool              `json:"enabled,omitempty"`
	AllAgents    bool              `json:"allAgents,omitempty"`
	AgentIDs     []string          `json:"agentIds,omitempty"`
	Operations   []string          `json:"operations,omitempty"`
	Action       string            `json:"action"`
	Scope        model.SharedScope `json:"scope"`
	Pair         PairConfig        `json:"pair,omitempty"`
	AgentID      string            `json:"agentId,omitempty"`
	ID           string            `json:"id,omitempty"`
	Method       string            `json:"method,omitempty"`
	Path         string            `json:"path,omitempty"`
	Body         json.RawMessage   `json:"body,omitempty"`
}

func (h *Host) Paired() bool {
	var paired bool
	_ = h.App.Store.DB.QueryRow("SELECT EXISTS(SELECT 1 FROM remote_memberships)").Scan(&paired)
	return paired
}
func (h *Host) Manage(ctx context.Context, in Management) (any, error) {
	switch in.Action {
	case "status":
		return h.Bindings(ctx)
	case "local_info":
		hostName, _ := os.Hostname()
		if hostName == "" {
			hostName = "Lever"
		}
		h.mu.Lock()
		lanAddr, lanError := h.lanAddr, h.lanError
		h.mu.Unlock()
		return map[string]any{
			"deviceId":       h.App.Store.DeviceID,
			"hostName":       hostName,
			"platform":       runtime.GOOS,
			"login":          device.LoginEnabled(h.App.Store.Dir),
			"loginSupported": runtime.GOOS == "darwin" || runtime.GOOS == "windows",
			"lanAddr":        lanAddr,
			"lanError":       lanError,
		}, nil
	case "login":
		return true, device.SetLogin(h.App.Store.Dir, in.Enabled)
	case "lan_ticket":
		h.configMu.Lock()
		defer h.configMu.Unlock()
		return h.IssueLANTicket(ctx)
	case "pair":
		h.configMu.Lock()
		defer h.configMu.Unlock()
		v, err := PairStore(ctx, h.App.Store, in.Pair)
		h.reload()
		return v, err
	}
	if in.Scope.HubID == "" || in.Scope.SpaceID == "" {
		bindings, err := h.Bindings(ctx)
		if err != nil {
			return nil, err
		}
		if len(bindings) == 0 && (in.Action == "lan" || in.Action == "expose_all" || in.Action == "expose" || in.Action == "hide") {
			scope, _, err := h.ensureDirectScope(ctx, in.Action == "lan" && in.Enabled)
			if err != nil {
				return nil, err
			}
			in.Scope = scope
		} else if len(bindings) == 1 {
			in.Scope = bindings[0].SharedScope
		} else {
			return nil, errors.New("select a paired Hub and space")
		}
	}
	st, err := stateFor(ctx, h.App.Store, in.Scope)
	if err != nil {
		return nil, err
	}
	switch in.Action {
	case "trust", "untrust", "rename_trusted", "permission", "set_permissions", "trusted":
		return h.manageController(ctx, st, in)
	case "share_note", "preview_note":
		return h.note(ctx, st, in)
	case "allow_delegation":
		if !st.Membership.Role.Executes() {
			return nil, errors.New("device has no executor role")
		}
		h.configMu.Lock()
		defer h.configMu.Unlock()
		_, err = h.App.Store.DB.ExecContext(ctx, "UPDATE remote_memberships SET allow_delegation=? WHERE hub=? AND space=?", in.Enabled, in.Scope.HubID, in.Scope.SpaceID)
		return true, err
	case "expose_all":
		if !st.Membership.Role.Executes() {
			return nil, errors.New("device has no executor role")
		}
		h.configMu.Lock()
		defer h.configMu.Unlock()
		err = h.App.Store.Write(ctx, func(tx *sql.Tx) error {
			if _, err := tx.Exec("UPDATE remote_memberships SET expose_all=?,version=version+1 WHERE hub=? AND space=?", in.Enabled, in.Scope.HubID, in.Scope.SpaceID); err != nil {
				return err
			}
			_, err := tx.Exec(`INSERT INTO shared_sync_log(hub,space,kind,object_id,version,chat_id)
SELECT m.hub,m.space,'agent',a.id,m.version,'' FROM remote_memberships m CROSS JOIN agents a
WHERE m.hub=? AND m.space=?
ON CONFLICT(hub,space,kind,object_id) DO UPDATE SET version=excluded.version,chat_id=''`, in.Scope.HubID, in.Scope.SpaceID)
			return err
		})
		return true, err
	case "expose", "hide":
		if !st.Membership.Role.Executes() {
			return nil, errors.New("device has no executor role")
		}
		h.configMu.Lock()
		defer h.configMu.Unlock()
		err = h.App.Store.Write(ctx, func(tx *sql.Tx) error {
			if in.Action == "hide" {
				_, err := tx.Exec("DELETE FROM hub_exposed_agents WHERE hub=? AND space=? AND agent_id=?", in.Scope.HubID, in.Scope.SpaceID, in.AgentID)
				return err
			}
			var id string
			if err := tx.QueryRow("SELECT id FROM agents WHERE id=? AND coalesce(json_extract(data,'$.archived'),0)=0", in.AgentID).Scan(&id); err != nil {
				return err
			}
			_, err := tx.Exec("INSERT OR IGNORE INTO hub_exposed_agents VALUES(?,?,?)", in.Scope.HubID, in.Scope.SpaceID, id)
			return err
		})
		return true, err
	case "private_grants":
		return store.List[privateGrant](ctx, h.App.Store.DB, "SELECT json_object('controllerId',g.controller,'chatId',g.chat,'title',json_extract(c.data,'$.title')) FROM remote_private_chats g JOIN chats c ON c.id=g.chat WHERE g.hub=? AND g.space=? ORDER BY g.chat", in.Scope.HubID, in.Scope.SpaceID)
	case "grant_private", "revoke_private":
		if !st.Membership.Role.Executes() {
			return nil, errors.New("executor role required")
		}
		if _, err := uuid.Parse(in.ControllerID); err != nil {
			return nil, errors.New("select a paired controller")
		}
		h.configMu.Lock()
		defer h.configMu.Unlock()
		if in.Action == "revoke_private" {
			_, err := h.App.Store.DB.ExecContext(ctx, "DELETE FROM remote_private_chats WHERE hub=? AND space=? AND chat=? AND controller=?", in.Scope.HubID, in.Scope.SpaceID, in.ID, in.ControllerID)
			return true, err
		}
		err = h.App.Store.Write(ctx, func(tx *sql.Tx) error {
			var id string
			if err := tx.QueryRow("SELECT id FROM chats WHERE id=? AND json_type(data,'$.sharedScope') IS NULL", in.ID).Scan(&id); err != nil {
				return err
			}
			_, err := tx.Exec("INSERT OR IGNORE INTO remote_private_chats VALUES(?,?,?,?)", in.Scope.HubID, in.Scope.SpaceID, in.ControllerID, id)
			return err
		})
		return true, err
	case "lan":
		if !st.Membership.Role.Executes() {
			return nil, errors.New("executor role required")
		}
		_, err = h.App.Store.DB.ExecContext(ctx, "UPDATE remote_memberships SET lan=? WHERE hub=? AND space=?", in.Enabled, in.Scope.HubID, in.Scope.SpaceID)
		if err == nil && in.Enabled {
			_, _ = h.syncLAN(true)
		}
		h.reload()
		return true, err
	case "unpair":
		h.configMu.Lock()
		defer h.configMu.Unlock()
		return true, h.Unpair(ctx, in.Scope)
	case "inbox":
		if !st.Membership.Role.Executes() {
			return nil, errors.New("executor role required")
		}
		local, err := h.lanInbox(ctx, in.Scope)
		if err != nil || st.Origin == "" {
			return local, err
		}
		var others []p.InboxItem
		if err = st.Do(ctx, "GET", st.SpacePath()+"/inbox", nil, &others); err != nil {
			if len(local) > 0 {
				return local, nil
			}
			return nil, err
		}
		seen := map[string]bool{}
		for _, v := range local {
			seen[v.Intent.ID] = true
		}
		for _, v := range others {
			if !seen[v.Intent.ID] {
				local = append(local, v)
			}
		}
		return local, nil
	case "devices":
		var result json.RawMessage
		err := st.Do(ctx, "GET", st.SpacePath()+"/"+in.Action, nil, &result)
		return result, err
	case "accept", "decline":
		h.configMu.Lock()
		defer h.configMu.Unlock()
		if result, ok, err := h.reviewLAN(ctx, in); ok {
			return result, err
		}
		return h.review(ctx, st, in)
	case "control":
		if out, ok, err := h.lanClient.Local(ctx, st, in.Method, in.Path, in.Body); ok {
			return out, err
		}
		return Control(ctx, st, in.Method, in.Path, in.Body)
	default:
		return nil, errors.New("unknown device management action")
	}
}
func Control(ctx context.Context, st p.ClientState, method, path string, body json.RawMessage) (json.RawMessage, error) {
	if !st.Membership.Role.Controls() {
		return nil, errors.New("controller role required")
	}
	if path != "/api/me" {
		root := st.SpacePath() + "/"
		suffix, ok := strings.CutPrefix(path, root)
		if !ok {
			return nil, errors.New("outside paired space")
		}
		switch strings.SplitN(suffix, "/", 2)[0] {
		case "devices", "tasks", "tickets", "commands", "archive":
		default:
			return nil, errors.New("unknown control resource")
		}
	}
	switch method {
	case "GET", "POST", "PATCH", "DELETE":
	default:
		return nil, errors.New("unsupported method")
	}
	var out json.RawMessage
	req, err := st.Request(ctx, method, path, body)
	if err == nil {
		err = p.Exchange(p.Client, req, &out)
	}
	return out, err
}
func (h *Host) review(ctx context.Context, st p.ClientState, in Management) (p.Receipt, error) {
	var out p.Receipt
	target := st.SpacePath() + "/inbox/" + url.PathEscape(in.ID)
	var item p.InboxItem
	if err := st.Do(ctx, "GET", target, nil, &item); err != nil {
		return out, err
	}
	if item.Intent.ID != in.ID || item.Intent.DeviceID != st.Membership.DeviceID || item.Intent.ActorUserID == "" {
		return out, errors.New("invalid command authority")
	}
	switch item.Receipt.Status {
	case "accepted", "failed", "declined", "cancelled":
		return item.Receipt, nil
	}
	if in.Action == "authorized" {
		ok, err := h.permitted(ctx, in.Scope, item.Intent)
		if err != nil || !ok {
			return item.Receipt, err
		}
	}
	if rec, err := h.App.RemoteReceipt(ctx, in.Scope, item.Intent); err == nil {
		if item.Receipt.Status == "pending" && rec.Status == "accepted" {
			// LAN already committed this operation before its reply was lost.
			// Claim the relay copy before publishing that same durable receipt.
			if err := st.Do(ctx, "POST", target, p.Receipt{ID: rec.ID, Status: "reviewing"}, nil); err != nil {
				return rec, err
			}
		}
		return rec, st.Do(ctx, "POST", target, rec, nil)
	} else if !errors.Is(err, sql.ErrNoRows) {
		return out, err
	}
	if in.Action == "decline" {
		out, err := h.App.RememberRemoteDecision(ctx, in.Scope, item.Intent, p.Receipt{ID: in.ID, Status: "declined"})
		if err != nil {
			return out, err
		}
		return out, st.Do(ctx, "POST", target, out, nil)
	}
	out = p.Receipt{ID: in.ID, Status: "reviewing"}
	if err := st.Do(ctx, "POST", target, out, nil); err != nil {
		return out, err
	}
	rec, err := h.App.ReviewRemote(ctx, in.Scope, item.Intent)
	if err != nil {
		var rejection *app.Error
		if errors.As(err, &rejection) || errors.Is(err, sql.ErrNoRows) {
			failed := p.Receipt{ID: in.ID, Status: "failed", Detail: "Host rejected this command"}
			failed, saveErr := h.App.RememberRemoteDecision(ctx, in.Scope, item.Intent, failed)
			if saveErr != nil {
				return out, errors.Join(err, saveErr)
			}
			if reportErr := st.Do(ctx, "POST", target, failed, nil); reportErr != nil {
				return out, errors.Join(err, reportErr)
			}
		}
		return out, err
	}
	return rec, st.Do(ctx, "POST", target, rec, nil)
}
func (h *Host) Handler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		var in Management
		d := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20))
		d.DisallowUnknownFields()
		if err := d.Decode(&in); err != nil {
			http.Error(w, "invalid management request", 400)
			return
		}
		result, err := h.Manage(r.Context(), in)
		if err != nil {
			code := 400
			var e *p.HTTPError
			var ae *app.Error
			if errors.As(err, &ae) {
				code = ae.Status
			}
			if errors.As(err, &e) {
				code = e.Status
			}
			w.WriteHeader(code)
			json.NewEncoder(w).Encode(map[string]string{"error": err.Error()})
			return
		}
		json.NewEncoder(w).Encode(result)
	})
}

type privateGrant struct {
	ControllerID string `json:"controllerId"`
	ChatID       string `json:"chatId"`
	Title        string `json:"title"`
}
