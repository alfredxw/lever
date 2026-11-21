package app

import (
	"crypto/subtle"
	"net/http"

	"github.com/modelcontextprotocol/go-sdk/mcp"
	"lever/internal/provider"
)

func (a *App) activeExecutionByToken(authHeader string) *execution {
	if authHeader == "" {
		return nil
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	for _, e := range a.active {
		if subtle.ConstantTimeCompare([]byte(authHeader), []byte("Bearer "+e.token)) == 1 && e.ctx.Err() == nil {
			return e
		}
	}
	return nil
}

func (a *App) MCP(w http.ResponseWriter, r *http.Request) {
	owner := a.activeExecutionByToken(r.Header.Get("Authorization"))
	if owner == nil || !provider.Capabilities(owner.provider.Type).MCP {
		http.Error(w, "Invalid or expired execution capability", http.StatusUnauthorized)
		return
	}
	server := mcp.NewServer(&mcp.Implementation{Name: "lever", Version: "0.1.0"}, nil)
	a.addChatContextTools(server, owner)
	owner.mu.Lock()
	writable := owner.run.Selection.Permission != "read_only"
	hasTask := owner.run.Task != nil && owner.run.Task.Record != ""
	owner.mu.Unlock()
	if writable {
		a.addWorkItemTool(server, owner)
		a.addAgentCreationTool(server, owner)
		if hasTask {
			owner.addTaskCompletionTool(server)
		}
	}
	if owner.canDelegate() {
		a.addDelegationTools(r.Context(), server, owner)
	}
	mcp.NewStreamableHTTPHandler(func(*http.Request) *mcp.Server { return server }, &mcp.StreamableHTTPOptions{Stateless: true}).ServeHTTP(w, r)
}
