package cli

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"

	"lever/internal/app"
	"lever/internal/model"
)

func runAgent(args []string, dataDir string, in io.Reader, out, errOut io.Writer) error {
	if len(args) == 0 || args[0] == "--help" || args[0] == "-h" {
		fmt.Fprintln(out, "Usage: lever agent list [--full] [--archived] [flags]")
		fmt.Fprintln(out, "       lever agent get --id <id> [flags]")
		fmt.Fprintln(out, "       lever agent create --name <name> --provider <id> --root <dir> [--root <dir2>...] [--model <m>] [--permission <p>] [--instructions <text>] [flags]")
		fmt.Fprintln(out, "       lever agent update --id <id> [--name <name>] [--provider <id>] [--model <m>] [--permission <p>] [--instructions <text>] [--archive=true|false] [flags]")
		return nil
	}
	token := strings.TrimSpace(os.Getenv(executionTokenEnv))
	switch args[0] {
	case "list":
		flags := flag.NewFlagSet("lever agent list", flag.ContinueOnError)
		flags.SetOutput(errOut)
		flags.StringVar(&dataDir, "data-dir", dataDir, "Lever data directory (or LEVER_DATA_DIR)")
		var full, archived bool
		flags.BoolVar(&full, "full", false, "Return full Agent profiles")
		flags.BoolVar(&archived, "archived", false, "Include archived Agents (requires --full)")
		if err := parseFlags(flags, args[1:]); err != nil {
			if errors.Is(err, flag.ErrHelp) {
				return nil
			}
			return err
		}
		query := url.Values{}
		if full {
			query.Set("full", "true")
		}
		if archived {
			query.Set("full", "true")
			query.Set("archived", "true")
		}
		path := "/agents"
		if encoded := query.Encode(); encoded != "" {
			path += "?" + encoded
		}
		reqToken := ""
		if full || archived {
			reqToken = token
		}
		return request(dataDir, http.MethodGet, path, reqToken, nil, out)
	case "get":
		flags := flag.NewFlagSet("lever agent get", flag.ContinueOnError)
		flags.SetOutput(errOut)
		flags.StringVar(&dataDir, "data-dir", dataDir, "Lever data directory (or LEVER_DATA_DIR)")
		var id string
		flags.StringVar(&id, "id", "", "Agent ID (required)")
		if err := parseFlags(flags, args[1:]); err != nil {
			if errors.Is(err, flag.ErrHelp) {
				return nil
			}
			return err
		}
		id = strings.TrimSpace(id)
		if id == "" {
			return errors.New("--id is required")
		}
		return request(dataDir, http.MethodGet, "/agents/"+url.PathEscape(id), token, nil, out)
	case "create":
		flags := flag.NewFlagSet("lever agent create", flag.ContinueOnError)
		flags.SetOutput(errOut)
		flags.StringVar(&dataDir, "data-dir", dataDir, "Lever data directory (or LEVER_DATA_DIR)")
		var jsonRaw, name, providerID, modelID, permission, instructions string
		var roots stringList
		flags.StringVar(&jsonRaw, "json", "", "Full model.Agent JSON payload, or '-' to read stdin")
		flags.StringVar(&name, "name", "", "Agent name (required without --json)")
		flags.StringVar(&providerID, "provider", "", "Provider ID, e.g. codex, claude, pi, antigravity (required without --json)")
		flags.Var(&roots, "root", "Scope directory path (repeatable; at least one required without --json)")
		flags.StringVar(&modelID, "model", "", "Default model ID")
		flags.StringVar(&permission, "permission", "", "Default permission policy")
		flags.StringVar(&instructions, "instructions", "", "Agent instructions")
		if err := parseFlags(flags, args[1:]); err != nil {
			if errors.Is(err, flag.ErrHelp) {
				return nil
			}
			return err
		}
		var agent model.Agent
		if strings.TrimSpace(jsonRaw) != "" {
			if err := readJSONArg(jsonRaw, in, 2<<20, &agent); err != nil {
				return err
			}
		} else {
			if strings.TrimSpace(name) == "" || strings.TrimSpace(providerID) == "" || len(roots) == 0 {
				return errors.New("--name, --provider, and at least one --root are required")
			}
			scopeRoots := make([]model.Root, 0, len(roots))
			for _, dir := range roots {
				scopeRoots = append(scopeRoots, model.Root{Path: dir})
			}
			agent = model.Agent{
				Name: strings.TrimSpace(name),
				Profile: model.Profile{
					Scope:        model.Scope{Roots: scopeRoots},
					Provider:     strings.TrimSpace(providerID),
					Model:        strings.TrimSpace(modelID),
					Permission:   strings.TrimSpace(permission),
					Instructions: instructions,
					Skills:       []string{},
					Delegations:  []model.DelegationRule{},
				},
			}
		}
		return request(dataDir, http.MethodPost, "/agents", token, agent, out)
	case "update":
		flags := flag.NewFlagSet("lever agent update", flag.ContinueOnError)
		flags.SetOutput(errOut)
		flags.StringVar(&dataDir, "data-dir", dataDir, "Lever data directory (or LEVER_DATA_DIR)")
		var id, jsonRaw, name, providerID, modelID, permission, instructions string
		var roots stringList
		var archive optionalBool
		flags.StringVar(&id, "id", "", "Agent ID (required)")
		flags.StringVar(&jsonRaw, "json", "", "Full model.Agent JSON payload, or '-' to read stdin")
		flags.StringVar(&name, "name", "", "Updated Agent name")
		flags.StringVar(&providerID, "provider", "", "Updated provider ID")
		flags.StringVar(&modelID, "model", "", "Updated default model ID")
		flags.StringVar(&permission, "permission", "", "Updated permission policy")
		flags.StringVar(&instructions, "instructions", "", "Updated instructions")
		flags.Var(&roots, "root", "Replace scope roots (repeatable)")
		flags.Var(&archive, "archive", "Archive or unarchive Agent (true/false)")
		if err := parseFlags(flags, args[1:]); err != nil {
			if errors.Is(err, flag.ErrHelp) {
				return nil
			}
			return err
		}
		id = strings.TrimSpace(id)
		if id == "" {
			return errors.New("--id is required")
		}
		var agent model.Agent
		if strings.TrimSpace(jsonRaw) != "" {
			if err := readJSONArg(jsonRaw, in, 2<<20, &agent); err != nil {
				return err
			}
			if agent.UpdatedAt == "" {
				var current model.Agent
				if err := requestDecode(context.Background(), dataDir, http.MethodGet, "/agents/"+url.PathEscape(id), token, nil, nil, 10*time.Second, &current); err != nil {
					return err
				}
				agent.UpdatedAt = current.UpdatedAt
			}
		} else {
			if err := requestDecode(context.Background(), dataDir, http.MethodGet, "/agents/"+url.PathEscape(id), token, nil, nil, 10*time.Second, &agent); err != nil {
				return err
			}
			setFlags := map[string]bool{}
			flags.Visit(func(f *flag.Flag) { setFlags[f.Name] = true })
			if setFlags["name"] {
				agent.Name = strings.TrimSpace(name)
			}
			if setFlags["provider"] {
				agent.Profile.Provider = strings.TrimSpace(providerID)
			}
			if setFlags["model"] {
				agent.Profile.Model = strings.TrimSpace(modelID)
			}
			if setFlags["permission"] {
				agent.Profile.Permission = strings.TrimSpace(permission)
			}
			if setFlags["instructions"] {
				agent.Profile.Instructions = instructions
			}
			if len(roots) > 0 {
				nextRoots := make([]model.Root, 0, len(roots))
				for _, dir := range roots {
					nextRoots = append(nextRoots, model.Root{Path: dir})
				}
				agent.Profile.Roots = nextRoots
				agent.Profile.PrimaryRootID = ""
			}
			if archive.set {
				agent.Archived = archive.value
			}
		}
		return request(dataDir, http.MethodPut, "/agents/"+url.PathEscape(id), token, agent, out)
	default:
		return fmt.Errorf("unknown agent command %q", args[0])
	}
}

func runProviders(args []string, dataDir string, out, errOut io.Writer) error {
	if len(args) == 0 || args[0] == "--help" || args[0] == "-h" {
		fmt.Fprintln(out, "Usage: lever providers list [--login] [flags]")
		fmt.Fprintln(out, "       lever providers models --provider <id> [--cwd <dir>] [--refresh] [flags]")
		return nil
	}
	token := strings.TrimSpace(os.Getenv(executionTokenEnv))
	switch args[0] {
	case "list":
		flags := flag.NewFlagSet("lever providers list", flag.ContinueOnError)
		flags.SetOutput(errOut)
		flags.StringVar(&dataDir, "data-dir", dataDir, "Lever data directory (or LEVER_DATA_DIR)")
		var checkLogin bool
		flags.BoolVar(&checkLogin, "login", false, "Probe login status for available providers")
		if err := parseFlags(flags, args[1:]); err != nil {
			if errors.Is(err, flag.ErrHelp) {
				return nil
			}
			return err
		}
		path := "/providers"
		if checkLogin {
			path += "?login=true"
		}
		return requestWithTimeout(dataDir, http.MethodGet, path, token, nil, nil, 30*time.Second, out)
	case "models":
		flags := flag.NewFlagSet("lever providers models", flag.ContinueOnError)
		flags.SetOutput(errOut)
		flags.StringVar(&dataDir, "data-dir", dataDir, "Lever data directory (or LEVER_DATA_DIR)")
		var providerID, cwd string
		var refresh bool
		flags.StringVar(&providerID, "provider", "", "Provider ID (required)")
		flags.StringVar(&cwd, "cwd", "", "Working directory context for model discovery")
		flags.BoolVar(&refresh, "refresh", false, "Bypass cached model catalog")
		if err := parseFlags(flags, args[1:]); err != nil {
			if errors.Is(err, flag.ErrHelp) {
				return nil
			}
			return err
		}
		providerID = strings.TrimSpace(providerID)
		if providerID == "" {
			return errors.New("--provider is required")
		}
		query := url.Values{}
		if strings.TrimSpace(cwd) != "" {
			query.Set("cwd", strings.TrimSpace(cwd))
		}
		if refresh {
			query.Set("refresh", "true")
		}
		path := "/providers/" + url.PathEscape(providerID) + "/models"
		if encoded := query.Encode(); encoded != "" {
			path += "?" + encoded
		}
		return requestWithTimeout(dataDir, http.MethodGet, path, token, nil, nil, 30*time.Second, out)
	default:
		return fmt.Errorf("unknown providers command %q", args[0])
	}
}

func runWorkItems(args []string, dataDir string, out, errOut io.Writer) error {
	if len(args) == 0 || args[0] == "--help" || args[0] == "-h" {
		fmt.Fprintln(out, "Usage: lever work-items list [--agent <id>] [--done=true|false] [flags]")
		fmt.Fprintln(out, "       lever work-items get --id <id> [flags]")
		fmt.Fprintln(out, "       lever work-items create --agent <id> --title <title> [--body <text>] [--request-key <key>] [flags]")
		fmt.Fprintln(out, "       lever work-items update --id <id> [--title ...] [--body ...] [--project ...] [--priority ...] [--assignee ...] [--done=true|false] [flags]")
		fmt.Fprintln(out, "       lever work-items dispatch --id <id> --agent <id> [--note <text>] [--working-copy <id>] [--provider ...] [--model ...] [--effort ...] [--permission ...] [flags]")
		return nil
	}
	token := strings.TrimSpace(os.Getenv(executionTokenEnv))
	switch args[0] {
	case "list":
		flags := flag.NewFlagSet("lever work-items list", flag.ContinueOnError)
		flags.SetOutput(errOut)
		flags.StringVar(&dataDir, "data-dir", dataDir, "Lever data directory (or LEVER_DATA_DIR)")
		var agentID string
		var done optionalBool
		flags.StringVar(&agentID, "agent", "", "Filter by Agent ID")
		flags.Var(&done, "done", "Filter by completion status (true/false)")
		if err := parseFlags(flags, args[1:]); err != nil {
			if errors.Is(err, flag.ErrHelp) {
				return nil
			}
			return err
		}
		query := url.Values{}
		if strings.TrimSpace(agentID) != "" {
			query.Set("agent", strings.TrimSpace(agentID))
		}
		if done.set {
			query.Set("done", done.String())
		}
		path := "/work-items"
		if encoded := query.Encode(); encoded != "" {
			path += "?" + encoded
		}
		return request(dataDir, http.MethodGet, path, token, nil, out)
	case "get":
		flags := flag.NewFlagSet("lever work-items get", flag.ContinueOnError)
		flags.SetOutput(errOut)
		flags.StringVar(&dataDir, "data-dir", dataDir, "Lever data directory (or LEVER_DATA_DIR)")
		var id string
		flags.StringVar(&id, "id", "", "Work item ID (required)")
		if err := parseFlags(flags, args[1:]); err != nil {
			if errors.Is(err, flag.ErrHelp) {
				return nil
			}
			return err
		}
		id = strings.TrimSpace(id)
		if id == "" {
			return errors.New("--id is required")
		}
		return request(dataDir, http.MethodGet, "/work-items/"+url.PathEscape(id), token, nil, out)
	case "create":
		flags := flag.NewFlagSet("lever work-items create", flag.ContinueOnError)
		flags.SetOutput(errOut)
		flags.StringVar(&dataDir, "data-dir", dataDir, "Lever data directory (or LEVER_DATA_DIR)")
		var item model.WorkItemInput
		var agentID string
		flags.StringVar(&agentID, "agent", "", "Agent ID from lever agent list (required)")
		flags.StringVar(&item.Title, "title", "", "Work item title (required)")
		flags.StringVar(&item.Body, "body", "", "Description for the Agent")
		flags.StringVar(&item.RequestKey, "request-key", "", "Stable key to reuse when retrying a creation")
		if err := parseFlags(flags, args[1:]); err != nil {
			if errors.Is(err, flag.ErrHelp) {
				return nil
			}
			return err
		}
		agentID = strings.TrimSpace(agentID)
		if agentID == "" || strings.TrimSpace(item.Title) == "" {
			return errors.New("--agent and --title are required")
		}
		return request(dataDir, http.MethodPost, "/agents/"+url.PathEscape(agentID)+"/work-items", "", item, out)
	case "update":
		flags := flag.NewFlagSet("lever work-items update", flag.ContinueOnError)
		flags.SetOutput(errOut)
		flags.StringVar(&dataDir, "data-dir", dataDir, "Lever data directory (or LEVER_DATA_DIR)")
		var id, title, body, project, priority, assignee string
		var done optionalBool
		flags.StringVar(&id, "id", "", "Work item ID (required)")
		flags.StringVar(&title, "title", "", "Updated title")
		flags.StringVar(&body, "body", "", "Updated body")
		flags.StringVar(&project, "project", "", "Updated project")
		flags.StringVar(&priority, "priority", "", "Updated priority (urgent, high, medium, low, or empty)")
		flags.StringVar(&assignee, "assignee", "", "Updated assignee Agent ID")
		flags.Var(&done, "done", "Completion state (true/false)")
		if err := parseFlags(flags, args[1:]); err != nil {
			if errors.Is(err, flag.ErrHelp) {
				return nil
			}
			return err
		}
		id = strings.TrimSpace(id)
		if id == "" {
			return errors.New("--id is required")
		}
		setFlags := map[string]bool{}
		flags.Visit(func(f *flag.Flag) { setFlags[f.Name] = true })
		var update model.WorkItemUpdate
		if setFlags["title"] {
			update.Title = &title
		}
		if setFlags["body"] {
			update.Body = &body
		}
		if setFlags["project"] {
			update.Project = &project
		}
		if setFlags["priority"] {
			p := model.WorkItemPriority(strings.TrimSpace(priority))
			update.Priority = &p
		}
		if setFlags["assignee"] {
			update.AssigneeAgentID = &assignee
		}
		if done.set {
			v := done.value
			update.Done = &v
		}
		return request(dataDir, http.MethodPatch, "/work-items/"+url.PathEscape(id), token, update, out)
	case "dispatch":
		flags := flag.NewFlagSet("lever work-items dispatch", flag.ContinueOnError)
		flags.SetOutput(errOut)
		flags.StringVar(&dataDir, "data-dir", dataDir, "Lever data directory (or LEVER_DATA_DIR)")
		var id, agentID, workingCopyID, note, commandID string
		var sel selectionFlags
		flags.StringVar(&id, "id", "", "Work item ID (required)")
		flags.StringVar(&agentID, "agent", "", "Target Agent ID (required)")
		flags.StringVar(&workingCopyID, "working-copy", "", "Optional working copy ID")
		flags.StringVar(&note, "note", "", "Optional dispatch note")
		flags.StringVar(&commandID, "command-id", "", "Optional idempotency command ID")
		sel.register(flags)
		if err := parseFlags(flags, args[1:]); err != nil {
			if errors.Is(err, flag.ErrHelp) {
				return nil
			}
			return err
		}
		id = strings.TrimSpace(id)
		agentID = strings.TrimSpace(agentID)
		if id == "" || agentID == "" {
			return errors.New("--id and --agent are required")
		}
		if strings.TrimSpace(commandID) == "" {
			commandID = app.ID()
		}
		input := model.ExternalTaskDispatch{
			CommandID:     strings.TrimSpace(commandID),
			AgentID:       agentID,
			WorkingCopyID: strings.TrimSpace(workingCopyID),
			Selection:     sel.toSelection(),
			Note:          note,
		}
		return request(dataDir, http.MethodPost, "/work-items/"+url.PathEscape(id)+"/dispatch", token, input, out)
	default:
		return fmt.Errorf("unknown work-items command %q", args[0])
	}
}

func runNotes(args []string, dataDir string, in io.Reader, out, errOut io.Writer) error {
	if len(args) == 0 || args[0] == "--help" || args[0] == "-h" {
		fmt.Fprintln(out, "Usage: lever notes list [flags]")
		fmt.Fprintln(out, "       lever notes get --id <id> [flags]")
		fmt.Fprintln(out, "       lever notes create --title <title> [--text <markdown|->] [--directory <dir>] [flags]")
		return nil
	}
	token := strings.TrimSpace(os.Getenv(executionTokenEnv))
	switch args[0] {
	case "list":
		flags := flag.NewFlagSet("lever notes list", flag.ContinueOnError)
		flags.SetOutput(errOut)
		flags.StringVar(&dataDir, "data-dir", dataDir, "Lever data directory (or LEVER_DATA_DIR)")
		if err := parseFlags(flags, args[1:]); err != nil {
			if errors.Is(err, flag.ErrHelp) {
				return nil
			}
			return err
		}
		return request(dataDir, http.MethodGet, "/notes", token, nil, out)
	case "get":
		flags := flag.NewFlagSet("lever notes get", flag.ContinueOnError)
		flags.SetOutput(errOut)
		flags.StringVar(&dataDir, "data-dir", dataDir, "Lever data directory (or LEVER_DATA_DIR)")
		var id string
		flags.StringVar(&id, "id", "", "Note ID (required)")
		if err := parseFlags(flags, args[1:]); err != nil {
			if errors.Is(err, flag.ErrHelp) {
				return nil
			}
			return err
		}
		id = strings.TrimSpace(id)
		if id == "" {
			return errors.New("--id is required")
		}
		return request(dataDir, http.MethodGet, "/notes/"+url.PathEscape(id), token, nil, out)
	case "create":
		flags := flag.NewFlagSet("lever notes create", flag.ContinueOnError)
		flags.SetOutput(errOut)
		flags.StringVar(&dataDir, "data-dir", dataDir, "Lever data directory (or LEVER_DATA_DIR)")
		var id, title, text, dir string
		flags.StringVar(&id, "id", "", "Optional note ID")
		flags.StringVar(&title, "title", "", "Note title (required)")
		flags.StringVar(&text, "text", "", "Optional initial note text (or '-' to read stdin)")
		flags.StringVar(&dir, "directory", "", "Optional note directory")
		if err := parseFlags(flags, args[1:]); err != nil {
			if errors.Is(err, flag.ErrHelp) {
				return nil
			}
			return err
		}
		title = strings.TrimSpace(title)
		if title == "" {
			return errors.New("--title is required")
		}
		body, err := readTextArg(text, in, 1<<20)
		if err != nil {
			return err
		}
		if strings.TrimSpace(id) == "" {
			id = app.ID()
		}
		note := model.TaskNote{
			ID:        strings.TrimSpace(id),
			Title:     title,
			Directory: strings.TrimSpace(dir),
		}
		if body != "" {
			paragraphs := strings.Split(body, "\n")
			content := make([]map[string]any, 0, len(paragraphs))
			for _, line := range paragraphs {
				node := map[string]any{"type": "paragraph"}
				if line != "" {
					node["content"] = []map[string]any{{"type": "text", "text": line}}
				}
				content = append(content, node)
			}
			rawDoc, err := json.Marshal(map[string]any{"type": "doc", "content": content})
			if err != nil {
				return err
			}
			note.Content = rawDoc
		}
		return request(dataDir, http.MethodPost, "/notes", token, note, out)
	default:
		return fmt.Errorf("unknown notes command %q", args[0])
	}
}
