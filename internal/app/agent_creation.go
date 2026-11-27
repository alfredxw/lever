package app

import (
	"context"
	"database/sql"
	"strings"

	"github.com/modelcontextprotocol/go-sdk/mcp"

	"lever/internal/model"
	"lever/internal/store"
)

type agentCreateInput struct {
	Name         string `json:"name" jsonschema:"Name of the new Agent"`
	Instructions string `json:"instructions,omitempty" jsonschema:"Instructions for the Agent's ongoing responsibilities"`
	RequestKey   string `json:"requestKey" jsonschema:"Stable key for this creation; reuse it when retrying"`
}

type agentCreateResult struct {
	AgentID string `json:"agentId"`
	Name    string `json:"name"`
}

func (e *execution) canCreateAgentLocked() bool {
	return e.acceptsPermissionChanges() && e.permissionChange == nil && e.run.Selection.Permission != "read_only"
}

func (a *App) addAgentCreationTool(server *mcp.Server, owner *execution) {
	mcp.AddTool(server, &mcp.Tool{
		Name: "agent_create",
		Description: "Create a persistent Lever Agent when the user asks for one. " +
			"It uses this conversation's directories, the current runtime, and that runtime's default permissions. " +
			"Creating the Agent leaves it ready for the user to open and chat with.",
	}, func(ctx context.Context, _ *mcp.CallToolRequest, input agentCreateInput) (*mcp.CallToolResult, *agentCreateResult, error) {
		created, err := a.createAgentFromRun(ctx, owner, input)
		if err != nil {
			return nil, nil, err
		}
		return nil, &agentCreateResult{AgentID: created.AgentID, Name: created.Name}, nil
	})
}

func (a *App) createAgentFromRun(ctx context.Context, owner *execution, input agentCreateInput) (model.CreatedAgent, error) {
	input.Name = strings.TrimSpace(input.Name)
	input.Instructions = strings.TrimSpace(input.Instructions)
	input.RequestKey = strings.TrimSpace(input.RequestKey)
	var created model.CreatedAgent
	if input.RequestKey == "" || len(input.RequestKey) > 100 || strings.ContainsAny(input.RequestKey, "\r\n\x00") {
		return created, invalid("A request key of up to 100 bytes is required")
	}
	digest := hash(input)

	// Stop and permission changes must not race the creation transaction.
	a.mu.Lock()
	defer a.mu.Unlock()
	owner.mu.Lock()
	defer owner.mu.Unlock()
	if a.closed || a.active[owner.run.ID] != owner || !owner.canCreateAgentLocked() {
		return created, conflict("Agent creation requires an active run with write permissions")
	}
	for _, previous := range owner.run.CreatedAgents {
		if previous.RequestKey == input.RequestKey {
			if previous.InputHash != digest {
				return created, conflict("This request key already belongs to a different Agent creation")
			}
			return previous, nil
		}
	}

	scope := model.Scope{Roots: make([]model.Root, 0, len(owner.session.Roots))}
	for _, root := range owner.session.Roots {
		id := ID()
		scope.Roots = append(scope.Roots, model.Root{ID: id, Path: root.Path})
		if root.ID == owner.session.PrimaryRootID {
			scope.PrimaryRootID = id
		}
	}
	agent := model.Agent{Name: input.Name, Profile: model.Profile{
		Scope:        scope,
		Provider:     owner.run.Selection.Provider,
		Model:        owner.run.Selection.Model,
		Effort:       owner.run.Selection.Effort,
		Fast:         owner.run.Selection.Fast,
		Instructions: input.Instructions,
		Skills:       []string{},
		Delegations:  []model.DelegationRule{},
	}}
	next := owner.run
	_, err := a.saveAgentLocked(ctx, agent, func(tx *sql.Tx, saved model.Agent) error {
		// Canonicalization must still resolve to the directories this Run owns.
		for i, root := range saved.Profile.Roots {
			if root.Path != owner.session.Roots[i].Path {
				return conflict("A working directory has changed: " + owner.session.Roots[i].Path)
			}
		}
		created = model.CreatedAgent{AgentID: saved.ID, Name: saved.Name, RequestKey: input.RequestKey, InputHash: digest}
		next.CreatedAgents = append(next.CreatedAgents, created)
		return store.SaveRun(tx, next)
	})
	if err != nil {
		return model.CreatedAgent{}, err
	}
	owner.run.CreatedAgents = next.CreatedAgents
	owner.dirty = false
	return created, nil
}
