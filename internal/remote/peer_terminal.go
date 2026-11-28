package remote

import (
	"context"
	"net/http"
	"os"

	"github.com/google/uuid"
	"lever/internal/app"
	p "lever/internal/remoteproto"
	"lever/internal/terminal"
	"lever/internal/workspace"
)

func (q *peerRequest) terminal(w http.ResponseWriter, r *http.Request) (any, error) {
	params := r.URL.Query()
	agent, session, id := r.PathValue("id"), params.Get("sessionId"), params.Get("terminalId")
	if _, err := uuid.Parse(id); err != nil {
		return nil, &app.Error{Status: 400, Message: "Invalid terminal ID"}
	}
	if q.policy.readOnly || q.actor.draining {
		return nil, os.ErrPermission
	}
	if session != "" {
		if _, err := q.target(r.Context(), "session", session); err != nil {
			return nil, err
		}
	}
	dirs, release, err := q.host.App.UseScope(r.Context(), agent, session, "", true)
	if err != nil {
		return nil, err
	}
	rootID := params.Get("root")
	if rootID == "" {
		rootID = dirs.PrimaryRootID
	}
	root, err := workspace.Root(dirs, rootID)
	dataDir, dirErr := workspace.Canonical(q.host.App.Store.Dir)
	if err != nil || dirErr != nil || !workspace.PeerAllowsRoot(root, dataDir) {
		release()
		return nil, os.ErrPermission
	}
	key := terminal.Key{Agent: agent, Conversation: session, ID: "peer/" + q.actor.scope.HubID + "/" + q.actor.user + "/" + q.actor.device + "/" + id}
	q.host.App.Terminals.ServeSocket(w, r, key, root, release, nil, terminal.SocketOptions{Shell: true, CheckOrigin: func(r *http.Request) bool { return r.Header.Get("Origin") == "" }, Allowed: func(ctx context.Context) bool {
		policy, e := q.host.peerPolicy(ctx, q.actor)
		if e != nil || !policy.level.Allows(p.AccessAdmin) || policy.readOnly {
			return false
		}
		_, e = q.target(ctx, "agent", agent)
		if e == nil && session != "" {
			_, e = q.target(ctx, "session", session)
		}
		return e == nil
	}})
	return nil, nil
}
