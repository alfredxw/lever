// The peer API is shared by the pinned LAN listener and authenticated Hub tunnel.
// Only these business routes can be addressed through either transport.
package remote

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"runtime"
	"runtime/debug"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"lever/internal/app"
	"lever/internal/eventstream"
	"lever/internal/model"
	p "lever/internal/remoteproto"
	"lever/internal/store"
)

type peerActor struct {
	scope        model.SharedScope
	user, device string
	draining     bool
	lan          *p.Grant
}

type peerPolicy struct {
	level    p.AccessLevel
	readOnly bool
}

func (h *Host) peerPolicy(ctx context.Context, a peerActor) (peerPolicy, error) {
	var out peerPolicy
	// A direct grant remains revocable even while an event stream is open.
	var direct, lan bool
	var epoch int64
	var trustedKey []byte
	err := h.App.Store.DB.QueryRowContext(ctx, `SELECT x.level,x.read_only,m.origin='',m.lan,m.policy,t.pub
		FROM remote_memberships m JOIN remote_access x USING(hub,space)
		LEFT JOIN remote_trusted_controllers t ON (t.hub,t.space,t.controller)=(m.hub,m.space,?3)
		WHERE m.hub=?1 AND m.space=?2 AND json_extract(m.credential,'$.userId')=?4
		AND json_extract(m.credential,'$.role') IN ('workstation','executor')
		AND (m.origin='' OR json_extract(m.credential,'$.spaceKind')='personal')
		AND (x.confirm=0 OR t.controller IS NOT NULL)`, a.scope.HubID, a.scope.SpaceID, a.device, a.user).Scan(&out.level, &out.readOnly, &direct, &lan, &epoch, &trustedKey)
	if err != nil {
		return out, err
	}
	if g := a.lan; g != nil {
		if !lan || epoch != g.Policy || ((direct || g.Expires <= time.Now().Unix()) && !bytes.Equal(g.Controller.PublicKey, trustedKey)) {
			return out, sql.ErrNoRows
		}
	}
	return out, nil
}

func (h *Host) descriptor(ctx context.Context, m p.Membership) (p.NodeDescriptor, error) {
	n := p.NodeDescriptor{NodeID: h.App.Store.DeviceID, Platform: runtime.GOOS, Online: true, CanControl: m.Role.Controls(), ProtocolVersion: p.Version, MinCompatibleProtocol: p.Version, Features: []string{p.FeaturePeer, p.FeatureFiles, p.FeatureWorkspaceAssets, p.FeatureManage, p.FeatureTerminal, p.FeatureDelegate, p.FeatureGit, p.FeatureHotCache, p.FeatureChatControls, p.FeatureHealth, p.FeatureAgentSkills, p.FeatureDelegationTargets}}
	n.Name, _ = os.Hostname()
	n.LeverVersion = h.App.Version
	if n.LeverVersion == "" {
		if build, ok := debug.ReadBuildInfo(); ok {
			n.LeverVersion = build.Main.Version
		}
	}
	err := h.App.Store.DB.QueryRowContext(ctx, `SELECT substr(key,33,32),coalesce(x.level,'none'),coalesce(x.read_only,0),CASE WHEN x.confirm=0 AND (m.origin='' OR json_extract(m.credential,'$.spaceKind')='personal') THEN m.epoch||':'||clock.visibility ELSE '' END,clock.revision FROM remote_identity,peer_clock clock,remote_memberships m LEFT JOIN remote_access x USING(hub,space) WHERE m.hub=? AND m.space=?`, m.Hub.ID, m.SpaceID).Scan(&n.PublicKey, &n.AccessLevel, &n.ReadOnlyFS, &n.CacheEpoch, &n.CacheRevision)
	if n.CacheEpoch == "" {
		n.CacheRevision = 0
	}
	if !m.Role.Executes() {
		n.AccessLevel = p.AccessNone
	}
	var delegation bool
	if err == nil && m.Role.Executes() {
		err = h.App.Store.DB.QueryRowContext(ctx, "SELECT allow_delegation FROM remote_memberships WHERE hub=? AND space=?", m.Hub.ID, m.SpaceID).Scan(&delegation)
	}
	if err == nil && n.AccessLevel == p.AccessAdmin {
		n.BrowseRoots, err = store.List[p.BrowseRootInfo](ctx, h.App.Store.DB, "SELECT json_object('id',id,'name',name) FROM remote_browse_roots ORDER BY name,id")
	}
	n.DelegationEnabled = &delegation
	return n, err
}

type peerRequest struct {
	host   *Host
	actor  peerActor
	policy peerPolicy
}
type peerEndpoint func(*peerRequest, http.ResponseWriter, *http.Request) (any, error)
type actorContextKey struct{}

func (h *Host) peerRoutes() http.Handler {
	mux := http.NewServeMux()
	handle := func(pattern string, level p.AccessLevel, resource string, endpoint peerEndpoint) {
		mux.HandleFunc(pattern, func(w http.ResponseWriter, r *http.Request) {
			a, ok := r.Context().Value(actorContextKey{}).(peerActor)
			if !ok {
				http.Error(w, "paired device required", 403)
				return
			}
			policy, err := h.peerPolicy(r.Context(), a)
			if err != nil || !policy.level.Allows(level) {
				http.Error(w, "target device has not granted access", 403)
				return
			}
			req := &peerRequest{host: h, actor: a, policy: policy}
			if resource != "" {
				if _, err = req.target(r.Context(), resource, r.PathValue("id")); err != nil {
					peerError(w, err)
					return
				}
			}
			if a.draining && r.Method != "GET" && (r.URL.Path == "/peer/v1/messages" || r.URL.Path == "/peer/v1/delegations" || r.PathValue("action") == "retry" || r.PathValue("action") == "resume") {
				http.Error(w, "device is draining", 409)
				return
			}
			w.Header().Set("Cache-Control", "no-store")
			result, err := endpoint(req, w, r)
			if err != nil {
				peerError(w, err)
				return
			}
			if result != nil {
				w.Header().Set("Content-Type", "application/json")
				writeLANJSON(w, r, result)
			}
		})
	}
	handle("GET /peer/v1/delegation-targets", p.AccessChat, "", (*peerRequest).delegationTargets)
	handle("GET /peer/v1/cache/index", p.AccessChat, "", (*peerRequest).cacheIndex)
	handle("GET /peer/v1/health", p.AccessChat, "", func(*peerRequest, http.ResponseWriter, *http.Request) (any, error) { return true, nil })
	handle("GET /peer/v1/overview", p.AccessChat, "", (*peerRequest).overview)
	handle("GET /peer/v1/chats/{id}", p.AccessChat, "chat", (*peerRequest).chat)
	handle("GET /peer/v1/chats/{id}/topics/page", p.AccessChat, "chat", (*peerRequest).topics)
	handle("GET /peer/v1/sessions/{id}/context", p.AccessChat, "session", (*peerRequest).sessionContext)
	handle("GET /peer/v1/sessions/{id}/runs", p.AccessChat, "session", (*peerRequest).runs)
	handle("GET /peer/v1/runs/{id}", p.AccessChat, "run", (*peerRequest).run)
	handle("POST /peer/v1/delegations", p.AccessChat, "", (*peerRequest).delegate)
	handle("GET /peer/v1/events", p.AccessChat, "", (*peerRequest).events)
	handle("POST /peer/v1/messages", p.AccessChat, "", (*peerRequest).message)
	handle("GET /peer/v1/commands/{id}", p.AccessChat, "", (*peerRequest).receipt)
	handle("POST /peer/v1/runs/{id}/{action}", p.AccessChat, "run", (*peerRequest).runAction)
	handle("POST /peer/v1/requests/{id}/answer", p.AccessChat, "request", (*peerRequest).answer)
	handle("POST /peer/v1/sessions/{id}/queue/resume", p.AccessChat, "session", (*peerRequest).resumeQueue)
	handle("POST /peer/v1/read", p.AccessChat, "", (*peerRequest).read)
	handle("POST /peer/v1/chats/{id}/attachments", p.AccessWorkspace, "chat", (*peerRequest).upload)
	handle("POST /peer/v1/agents/{id}/attachments", p.AccessWorkspace, "agent", (*peerRequest).upload)
	handle("GET /peer/v1/runs/{id}/preview", p.AccessWorkspace, "run", (*peerRequest).runPreview)
	handle("GET /peer/v1/attachments/{id}", p.AccessWorkspace, "attachment", (*peerRequest).attachment)
	handle("GET /peer/v1/attachments/{id}/preview", p.AccessWorkspace, "attachment", (*peerRequest).attachment)
	handle("GET /peer/v1/agents/{id}/composer", p.AccessChat, "agent", (*peerRequest).composer)
	handle("GET /peer/v1/agents/{id}/changes", p.AccessChat, "agent", (*peerRequest).changes)
	handle("GET /peer/v1/agents/{id}/files", p.AccessWorkspace, "agent", (*peerRequest).files)
	handle("GET /peer/v1/agents/{id}/files/search", p.AccessWorkspace, "agent", (*peerRequest).searchFiles)
	handle("POST /peer/v1/agents/{id}/files", p.AccessWorkspace, "agent", (*peerRequest).changeFile)
	handle("POST /peer/v1/agents/{id}/files/operation", p.AccessWorkspace, "agent", (*peerRequest).changeFile)
	handle("GET /peer/v1/agents/{id}/file", p.AccessWorkspace, "agent", (*peerRequest).file)
	handle("PUT /peer/v1/agents/{id}/file", p.AccessWorkspace, "agent", (*peerRequest).file)
	for _, route := range []string{"providers", "providers/{id}/models", "projects", "skills", "fs/browse"} {
		handle("GET /peer/v1/"+route, p.AccessAdmin, "", (*peerRequest).adminInfo)
	}
	handle("GET /peer/v1/agents/{id}/terminal", p.AccessAdmin, "agent", (*peerRequest).terminal)
	handle("POST /peer/v1/agents", p.AccessAdmin, "", (*peerRequest).saveAgent)
	handle("PUT /peer/v1/agents/{id}", p.AccessAdmin, "agent", (*peerRequest).saveAgent)
	for _, route := range []string{"git-roots", "git-summary", "diff", "branches", "commits"} {
		handle("GET /peer/v1/agents/{id}/"+route, p.AccessWorkspace, "agent", (*peerRequest).git)
	}
	return mux
}

func (h *Host) servePeer(w http.ResponseWriter, r *http.Request, a peerActor) {
	h.peerOnce.Do(func() { h.peerMux = h.peerRoutes() })
	h.peerMux.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), actorContextKey{}, a)))
}

func peerError(w http.ResponseWriter, err error) {
	var ae *app.Error
	switch {
	case errors.As(err, &ae):
		http.Error(w, ae.Message, ae.Status)
	case errors.Is(err, sql.ErrNoRows), errors.Is(err, os.ErrNotExist):
		http.NotFound(w, nil)
	case errors.Is(err, os.ErrPermission):
		http.Error(w, "target device has not granted access", 403)
	default:
		http.Error(w, "owner could not complete the request", 500)
	}
}

func (q *peerRequest) target(ctx context.Context, kind, id string) (string, error) {
	query := "SELECT chat_id FROM peer_chats WHERE hub=?1 AND space=?2 AND chat_id=?3"
	switch kind {
	case "agent":
		query = "SELECT agent_id FROM peer_agents WHERE hub=?1 AND space=?2 AND agent_id=?3"
	case "attachment":
		query = `SELECT v.chat_id FROM peer_chats v JOIN attachments a USING(chat_id) WHERE v.hub=?1 AND v.space=?2 AND a.id=?3
			UNION ALL SELECT v.agent_id FROM peer_agents v JOIN draft_attachments a USING(agent_id) WHERE v.hub=?1 AND v.space=?2 AND a.id=?3`
	case "session", "run", "request":
		query = "SELECT v.chat_id FROM peer_chats v JOIN " + kind + "s r USING(chat_id) WHERE v.hub=?1 AND v.space=?2 AND r.id=?3"
	}
	var result string
	err := q.host.App.Store.DB.QueryRowContext(ctx, query, q.actor.scope.HubID, q.actor.scope.SpaceID, id).Scan(&result)
	return result, err
}

type NodeOverview = p.NodeOverview

func (q *peerRequest) overview(_ http.ResponseWriter, r *http.Request) (any, error) {
	ctx := r.Context()
	scope := q.actor.scope
	st := q.host.App.Store
	m, err := store.Get[p.Membership](ctx, st.DB, "SELECT credential FROM remote_memberships WHERE hub=? AND space=?", scope.HubID, scope.SpaceID)
	if err != nil {
		return nil, err
	}
	n, err := q.host.descriptor(ctx, m)
	if err != nil {
		return nil, err
	}
	n.Draining = q.actor.draining
	out := NodeOverview{Node: n}
	tx, err := st.DB.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	args := []any{scope.HubID, scope.SpaceID}
	out.Agents, err = store.List[model.Agent](ctx, tx, "SELECT data FROM agents WHERE id IN (SELECT agent_id FROM peer_agents WHERE hub=? AND space=?) ORDER BY id", args...)
	if err != nil {
		return nil, err
	}
	for i := range out.Agents {
		agent := &out.Agents[i]
		agent.Profile.WorktreeSetup = nil
		agent.Profile.Delegations = nil
		if q.policy.level != p.AccessAdmin {
			agent.Profile.Instructions = ""
			agent.Profile.Skills = nil
			agent.Profile.DisabledSkills = nil
		}
		if !q.policy.level.Allows(p.AccessWorkspace) {
			agent.Profile.Scope = model.Scope{}
		}
	}
	visible := "(SELECT chat_id FROM peer_chats WHERE hub=? AND space=?)"
	out.Chats, err = store.List[model.Chat](ctx, tx, "SELECT "+store.ChatDisplayData+" FROM chats WHERE id IN "+visible+" ORDER BY json_extract(data,'$.updatedAt') DESC", args...)
	if err != nil {
		return nil, err
	}
	out.Conversations, err = store.List[model.Conversation](ctx, tx, store.ConversationQuery+" WHERE s.activity IS NOT NULL AND c.id IN "+visible, args...)
	if err != nil {
		return nil, err
	}
	if r.URL.Query().Get("progress") == "1" {
		active, err := store.List[p.Record](ctx, tx, `SELECT json_object('kind','run','id',r.id,'chatId',r.chat_id,
            'agentId',r.agent_id,'sessionId',r.session_id,'createdAt',json_extract(r.data,'$.createdAt'),'status',r.status,
            'pendingCount',(SELECT count(*) FROM requests WHERE run_id=r.id AND status='pending'),
            'stepCount',(SELECT count(*) FROM json_each(r.data,'$.items') WHERE value->>'kind' NOT IN ('text','user')))
            FROM runs r WHERE r.status IN ('starting','running','waiting_user','cancelling','paused')
            AND coalesce(json_extract(r.data,'$.superseded'),0)=0 AND r.chat_id IN `+visible+` ORDER BY r.sequence DESC`, args...)
		if err != nil {
			return nil, err
		}
		if active == nil {
			active = []p.Record{}
		}
		out.ActiveRuns = &active
	}
	err = tx.QueryRow("SELECT coalesce(max(sequence),0) FROM events").Scan(&out.Cursor)
	out.TagResources()
	return out, err
}

func (q *peerRequest) cacheIndex(w http.ResponseWriter, r *http.Request) (any, error) {
	value, err := q.overview(w, r)
	if err != nil {
		return nil, err
	}
	view := value.(NodeOverview)
	if view.Node.CacheEpoch == "" {
		return nil, os.ErrPermission
	}
	for i := range view.Agents {
		a := &view.Agents[i]
		a.Profile = model.Profile{Description: a.Profile.Description, Provider: a.Profile.Provider, Model: a.Profile.Model, AcceptDelegations: a.Profile.AcceptDelegations}
	}
	index := p.CacheIndex{NodeOverview: view, Revisions: map[string]int64{}}
	rows, err := q.host.App.Store.DB.QueryContext(r.Context(), `SELECT v.chat_id,coalesce(g.revision,1) FROM peer_chats v LEFT JOIN peer_chat_revisions g ON g.chat_id=v.chat_id WHERE v.hub=? AND v.space=?`, q.actor.scope.HubID, q.actor.scope.SpaceID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var id string
		var seq int64
		if err = rows.Scan(&id, &seq); err != nil {
			return nil, err
		}
		index.Revisions[id] = seq
	}
	return index, rows.Err()
}

func peerPage(r *http.Request) (int64, int, error) {
	q := r.URL.Query()
	var before int64
	limit := 40
	var err error
	if q.Has("before") {
		before, err = strconv.ParseInt(q.Get("before"), 10, 64)
		if err != nil || before < 0 {
			return 0, 0, &app.Error{Status: 400, Message: "invalid page cursor"}
		}
	}
	if q.Has("limit") {
		limit, err = strconv.Atoi(q.Get("limit"))
		if err != nil || limit < 1 || limit > 40 {
			return 0, 0, &app.Error{Status: 400, Message: "page size must be between 1 and 40"}
		}
	}
	return before, limit, nil
}
func peerRun(r *model.Run) {
	r.ChannelPrompt = ""
	r.ChannelContext = ""
	r.Channel = nil
	r.TurnDiff = nil
	r.Changes = nil
	r.NativeTurnID = nil
	r.WaitingOn = nil
	r.ScopePaths = nil
}
func filterRunsAfter(runs []model.Run, afterSeq int64) []model.Run {
	if afterSeq <= 0 || len(runs) == 0 {
		return runs
	}
	out := make([]model.Run, 0, len(runs))
	for _, r := range runs {
		if r.Sequence > afterSeq || r.Status == "starting" || r.Status == "running" || r.Status == "waiting_user" || r.Status == "cancelling" || r.Status == "unknown" || r.Status == "queued" {
			out = append(out, r)
		}
	}
	return out
}
func stripLazySteps(r *model.Run) {
	if len(r.Items) == 0 {
		return
	}
	kept := make([]model.Item, 0, 4)
	steps := 0
	for _, it := range r.Items {
		if it.Kind == "text" || it.Kind == "user" {
			kept = append(kept, it)
		} else {
			steps++
		}
	}
	r.Items = kept
	r.StepCount = steps
}
func (q *peerRequest) chat(_ http.ResponseWriter, r *http.Request) (any, error) {
	b, l, e := peerPage(r)
	if e != nil {
		return nil, e
	}
	afterSeq, _ := strconv.ParseInt(r.URL.Query().Get("after"), 10, 64)
	lazySteps := r.URL.Query().Get("steps") == "lazy"
	page, e := q.host.App.Store.ChatPage(r.Context(), r.PathValue("id"), b, l)
	page.Runs = filterRunsAfter(page.Runs, afterSeq)
	for i := range page.Runs {
		peerRun(&page.Runs[i])
		if lazySteps {
			stripLazySteps(&page.Runs[i])
		}
	}
	for i := range page.Sessions {
		page.Sessions[i].NativeID = ""
		if !q.policy.level.Allows(p.AccessWorkspace) {
			page.Sessions[i].Scope = model.Scope{}
		}
	}
	if e != nil {
		return nil, e
	}
	page.Requests, e = q.pageRequests(r.Context(), page.Chat.ID, "", page.Runs)
	return page, e
}
func (q *peerRequest) pageRequests(ctx context.Context, chat, session string, runs []model.Run) ([]model.Request, error) {
	ids := make([]string, 0, len(runs))
	for _, run := range runs {
		ids = append(ids, run.ID)
	}
	return store.List[model.Request](ctx, q.host.App.Store.DB, `SELECT q.data FROM requests q
		JOIN runs r ON r.id=q.run_id WHERE (?1='' OR q.chat_id=?1) AND (?2='' OR r.session_id=?2)
		AND (q.status='pending' OR q.run_id IN (SELECT value FROM json_each(?3))) ORDER BY q.rowid`, chat, session, store.JSON(ids))
}
func (q *peerRequest) topics(_ http.ResponseWriter, r *http.Request) (any, error) {
	b, l, e := peerPage(r)
	if e != nil {
		return nil, e
	}
	return q.host.App.Store.ChatTopicsPage(r.Context(), r.PathValue("id"), b, l)
}
func (q *peerRequest) runs(_ http.ResponseWriter, r *http.Request) (any, error) {
	b, l, e := peerPage(r)
	if e != nil {
		return nil, e
	}
	afterSeq, _ := strconv.ParseInt(r.URL.Query().Get("after"), 10, 64)
	lazySteps := r.URL.Query().Get("steps") == "lazy"
	page, e := q.host.App.Store.SessionRunPage(r.Context(), r.PathValue("id"), b, l)
	page.Runs = filterRunsAfter(page.Runs, afterSeq)
	for i := range page.Runs {
		peerRun(&page.Runs[i])
		if lazySteps {
			stripLazySteps(&page.Runs[i])
		}
	}
	if e != nil {
		return nil, e
	}
	requests, err := q.pageRequests(r.Context(), "", r.PathValue("id"), page.Runs)
	return struct {
		model.SessionRuns
		Requests []model.Request `json:"requests"`
	}{page, requests}, err
}
func peerBody(w http.ResponseWriter, r *http.Request, v any) error {
	limit := int64(p.MaxFrame)
	if r.Method == "PUT" && strings.HasSuffix(r.URL.Path, "/file") {
		limit = p.MaxPeerBody
	}
	d := json.NewDecoder(http.MaxBytesReader(w, r.Body, limit))
	if err := d.Decode(v); err != nil {
		return &app.Error{Status: 400, Message: "invalid request body"}
	}
	if err := d.Decode(new(any)); err != io.EOF {
		return &app.Error{Status: 400, Message: "unexpected trailing JSON"}
	}
	return nil
}
func (q *peerRequest) apply(r *http.Request, i p.Intent) (p.Receipt, error) {
	if _, err := uuid.Parse(i.ID); err != nil {
		return p.Receipt{}, &app.Error{Status: 400, Message: "commandId must be a UUID"}
	}
	i.DeviceID = q.host.App.Store.DeviceID
	i.ActorUserID = q.actor.user
	i.OriginDeviceID = q.actor.device
	q.host.configMu.Lock()
	defer q.host.configMu.Unlock()
	policy, err := q.host.peerPolicy(r.Context(), q.actor)
	if err != nil {
		return p.Receipt{}, os.ErrPermission
	}
	if len(i.AttachmentIDs) > 0 && !policy.level.Allows(p.AccessWorkspace) {
		return p.Receipt{}, os.ErrPermission
	}
	kind, id := "chat", i.ChatID
	if id == "" {
		kind, id = "agent", i.AgentID
	}
	if _, err := q.target(r.Context(), kind, id); err != nil {
		return p.Receipt{}, err
	}
	if r.URL.Path == "/peer/v1/delegations" {
		ctx := r.Context()
		if previous, e := q.host.App.RemoteReceipt(ctx, model.SharedScope{HubID: q.host.App.Store.DeviceID, SpaceID: app.PeerCommandSpace}, i); !errors.Is(e, sql.ErrNoRows) {
			return previous, e
		}
		if previous, e := q.reviewReceipt(ctx, i.ID, &i); !errors.Is(e, sql.ErrNoRows) {
			return previous, e
		}
		auto, e := q.host.delegationPermitted(ctx, q.actor.scope, i)
		if e != nil {
			return p.Receipt{}, e
		}
		if !auto {
			eligible, e := q.host.delegationAllowed(ctx, q.actor.scope, i, true)
			if e != nil {
				return p.Receipt{}, e
			}
			if !eligible {
				return p.Receipt{}, os.ErrPermission
			}
			pending := p.Receipt{ID: i.ID, Status: "pending"}
			_, e = q.host.App.Store.DB.ExecContext(ctx, "INSERT INTO peer_delegation_reviews(hub,space,id,intent,grant,receipt) VALUES(?,?,?,?,?,?)", q.actor.scope.HubID, q.actor.scope.SpaceID, i.ID, store.JSON(i), store.JSON(q.actor.lan), store.JSON(pending))
			return pending, e
		}
	}
	return q.host.App.ApplyPeer(r.Context(), q.actor.scope, i)
}
func (q *peerRequest) message(w http.ResponseWriter, r *http.Request) (any, error) {
	var in struct {
		References    []p.Reference     `json:"references"`
		WorkingCopyID string            `json:"workingCopyId"`
		CommandID     string            `json:"commandId"`
		AgentID       string            `json:"agentId"`
		ChatID        string            `json:"chatId"`
		SessionID     string            `json:"sessionId"`
		Operation     string            `json:"operation"`
		Delivery      string            `json:"delivery"`
		Text          string            `json:"text"`
		Selection     *p.ModelSelection `json:"selection"`
		AttachmentIDs []string          `json:"attachmentIds"`
	}
	if err := peerBody(w, r, &in); err != nil {
		return nil, err
	}
	return q.apply(r, p.Intent{ID: in.CommandID, Kind: "send", AgentID: in.AgentID, ChatID: in.ChatID, SessionID: in.SessionID, Operation: in.Operation, Delivery: in.Delivery, Text: in.Text, Selection: in.Selection, AttachmentIDs: in.AttachmentIDs, References: in.References, WorkingCopyID: in.WorkingCopyID})
}
func (q *peerRequest) receipt(_ http.ResponseWriter, r *http.Request) (any, error) {
	scope := q.actor.scope
	receipt, err := store.Get[p.Receipt](r.Context(), q.host.App.Store.DB, `SELECT r.receipt FROM remote_commands r JOIN peer_chats v ON v.chat_id=json_extract(r.receipt,'$.chatId') WHERE v.hub=? AND v.space=? AND r.id=? AND r.hub=? AND r.space=?`, scope.HubID, scope.SpaceID, r.PathValue("id"), q.host.App.Store.DeviceID, app.PeerCommandSpace)
	if errors.Is(err, sql.ErrNoRows) {
		return q.reviewReceipt(r.Context(), r.PathValue("id"), nil)
	}
	return receipt, err
}
func (q *peerRequest) command(w http.ResponseWriter, r *http.Request, resource, kind string) (any, error) {
	var in struct {
		CommandID string `json:"commandId"`
		p.Answer
	}
	if err := peerBody(w, r, &in); err != nil {
		return nil, err
	}
	id := r.PathValue("id")
	chat, err := q.target(r.Context(), resource, id)
	if err != nil {
		return nil, err
	}
	i := p.Intent{ID: in.CommandID, Kind: kind, ChatID: chat}
	switch resource {
	case "run":
		i.RunID = id
	case "session":
		i.SessionID = id
	case "request":
		i.RequestID = id
		i.Answer = &in.Answer
	}
	return q.apply(r, i)
}
func (q *peerRequest) runAction(w http.ResponseWriter, r *http.Request) (any, error) {
	kind, ok := map[string]string{"pause": "pause", "retry": "retry", "resume": "resume", "stop": "stop", "resolve": "resolve_unknown", "approvals": "allow_run"}[r.PathValue("action")]
	if !ok {
		return nil, sql.ErrNoRows
	}
	return q.command(w, r, "run", kind)
}
func (q *peerRequest) answer(w http.ResponseWriter, r *http.Request) (any, error) {
	return q.command(w, r, "request", "answer")
}
func (q *peerRequest) resumeQueue(w http.ResponseWriter, r *http.Request) (any, error) {
	return q.command(w, r, "session", "resume_queue")
}
func (q *peerRequest) read(w http.ResponseWriter, r *http.Request) (any, error) {
	var in struct {
		Items []model.ReadMark `json:"items"`
	}
	if e := peerBody(w, r, &in); e != nil {
		return nil, e
	}
	if len(in.Items) > 500 {
		return nil, &app.Error{Status: 400, Message: "too many read cursors"}
	}
	for _, mark := range in.Items {
		if _, e := q.target(r.Context(), "session", mark.SessionID); e != nil {
			return nil, e
		}
	}
	return true, q.host.App.MarkSessionsRead(r.Context(), in.Items)
}

func (q *peerRequest) events(w http.ResponseWriter, r *http.Request) (any, error) {
	chat := r.URL.Query().Get("chat")
	ctx := r.Context()
	if chat != "" {
		if _, err := q.target(ctx, "chat", chat); err != nil {
			return nil, err
		}
	}
	_ = http.NewResponseController(w).SetWriteDeadline(time.Time{})
	eventstream.Serve(w, r, q.host.App.Store, func() bool {
		_, err := q.host.peerPolicy(ctx, q.actor)
		return err == nil
	}, func(e *model.Event) (bool, error) {
		if e.ChatID == "" || (chat != "" && e.ChatID != chat) {
			return false, nil
		}
		e.NodeID = q.host.App.Store.DeviceID
		_, err := q.target(ctx, "chat", e.ChatID)
		if errors.Is(err, sql.ErrNoRows) {
			return false, nil
		}
		if e.Run != nil {
			run := *e.Run
			peerRun(&run)
			e.Run = &run
		}
		return err == nil, err
	})
	return nil, nil
}

// Chat exposes the scoped model choices needed by the composer. Provider
// configuration and credentials are available only to local management.
func (q *peerRequest) composer(_ http.ResponseWriter, r *http.Request) (any, error) {
	return q.host.composerMeta(r.Context(), p.Grant{HubID: q.actor.scope.HubID, SpaceID: q.actor.scope.SpaceID, Controller: p.Identity{ID: q.actor.device}}, r.PathValue("id"), "", "", "")
}
