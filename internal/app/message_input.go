package app

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"slices"
	"strings"

	"lever/internal/model"
	"lever/internal/notes"
	"lever/internal/provider"
	"lever/internal/store"
	"lever/internal/workspace"
)

func skillReferenceDisabled(ref model.Reference, disabled []string) bool {
	return model.SkillDisabled(disabled, ref.Name) || (ref.Path != "" && model.SkillDisabled(disabled, filepath.Base(filepath.Dir(ref.Path))))
}

func validateSkillReferences(references []model.Reference, disabled []string) error {
	if len(disabled) == 0 {
		return nil
	}
	for _, ref := range references {
		if ref.Kind != "skill" {
			continue
		}
		if skillReferenceDisabled(ref, disabled) {
			return invalid(fmt.Sprintf("Skill %q is disabled for this Agent. Remove its reference or enable it in Profile.", ref.Name))
		}
	}
	return nil
}

func validateMessage(commandID, text string, attachments []string, references []model.Reference, quote *model.MessageQuote) error {
	if commandID == "" || len(commandID) > 100 {
		return invalid("A stable commandId is required")
	}
	if (strings.TrimSpace(text) == "" && len(attachments) == 0 && len(references) == 0 && quote == nil) || len(text) > 1<<20 {
		return invalid("Include a message, attachment or reference (text up to 1 MiB)")
	}
	if len(attachments) > MaxAttachments {
		return invalid("A message can have up to 8 attachments")
	}
	if len(references) > 32 {
		return invalid("A message can have up to 32 references")
	}
	return nil
}

func (a *App) supportsMCP(session model.Session, config model.Provider) bool {
	supported := provider.ConfiguredCapabilities(config).MCP
	key := catalogKey{config.ID, provider.ConfigurationDirectory(config), workspace.CWD(session.Scope)}
	if entry := a.catalogs[key]; entry != nil && entry.confirmed {
		supported = entry.value.Capabilities.MCP
	}
	return supported
}

func (a *App) validateReferences(ctx context.Context, q store.Queryer, references []model.Reference, session model.Session, agent model.Agent, config model.Provider, shareSkills bool) error {
	var skillPaths map[string]bool
	if slices.ContainsFunc(references, model.Reference.RequiresMCP) && !a.supportsMCP(session, config) {
		return invalid("This runtime cannot use Lever references. Choose a runtime with MCP support.")
	}
	for _, ref := range references {
		if ref.Name == "" || len(ref.Name) > 4096 || len(ref.Path) > 4096 {
			return invalid("Invalid reference")
		}
		switch ref.Kind {
		case "browserElement":
			element := ref.Element
			if element == nil || element.Tag == "" || len(element.Tag) > 128 || element.Selector == "" || len(element.Selector) > 4096 || len(element.Text) > 1024 || len(element.URL) > 8192 {
				return invalid("Invalid browser element")
			}
			page, err := url.Parse(element.URL)
			if err != nil || (page.Scheme != "https" && page.Scheme != "http") || page.Hostname() == "" || page.User != nil || page.RawQuery != "" || page.Fragment != "" {
				return invalid("Invalid browser element address")
			}
		case "file":
			path, err := filepath.EvalSymlinks(ref.Path)
			if err != nil || !filepath.IsAbs(path) {
				return invalid("Referenced file is unavailable")
			}
			allowed := false
			for _, root := range session.Roots {
				allowed = allowed || workspace.Contains(root.Path, path)
			}
			if !allowed {
				return invalid("Referenced file is outside this session's scope")
			}
		case "skill":
			if ref.Provider != config.ID && (!shareSkills || ref.Provider == "") {
				return invalid("Reselect skills for the current runtime")
			}
			native := provider.Capabilities(config.Type).Skills
			switch {
			case shareSkills && (ref.Provider != config.ID || !native):
				entry, err := os.Lstat(ref.Path)
				if !filepath.IsAbs(ref.Path) || filepath.Base(ref.Path) != model.SkillEntry || err != nil || !entry.Mode().IsRegular() {
					return invalid(fmt.Sprintf("Skill %q needs an available SKILL.md to be shared across runtimes", ref.Name))
				}
			case !native || config.Type == "pi":
				if skillPaths == nil {
					var err error
					skillPaths, err = a.skillReferencePaths(ctx, session.Scope, config)
					if err != nil {
						return err
					}
				}
				dir := filepath.Dir(ref.Path)
				if (skillPaths[dir] || slices.Contains(agent.Profile.Skills, dir)) && ref.Path == filepath.Join(dir, model.SkillEntry) {
					if skill := describeSkill(skillAt(dir, false)); skill.Available && skill.Name == ref.Name {
						break
					}
				}
				return invalid(fmt.Sprintf("Skill %q is no longer available in this session's skill sources", ref.Name))
			case config.Type == "codex" && !filepath.IsAbs(ref.Path):
				return invalid("A Codex skill requires its absolute path")
			}
		default:
			if !ref.RequiresMCP() || !notes.IDPattern.MatchString(ref.ID) {
				return invalid("Invalid Lever reference")
			}
			var query string
			switch ref.Kind {
			case "chat":
				query = "SELECT 1 FROM sessions WHERE id=? AND kind='main'"
			case "topic":
				query = "SELECT 1 FROM sessions WHERE id=? AND kind='topic'"
			case "agent":
				if _, allowed := delegationRule(session.ParentRunID, agent.Profile.Delegations, ref.ID); !allowed {
					return invalid("The referenced Agent is not a configured collaborator for this conversation")
				}
				query = "SELECT 1 FROM agents WHERE id=? AND NOT json_extract(data,'$.archived')"
			case "workItem":
				query = "SELECT 1 FROM work_items WHERE id=?"
			case "externalTask":
				query = "SELECT 1 FROM external_tasks WHERE id=?"
			case "automationTask":
				query = "SELECT 1 FROM automation_runs WHERE id=? AND work_item=1 AND run_id IS NOT NULL"
			case "note", "noteTask":
				continue // Checked against the Notes snapshot before entering this transaction.
			}
			var exists int
			err := q.QueryRowContext(ctx, query, ref.ID).Scan(&exists)
			if errors.Is(err, sql.ErrNoRows) {
				return invalid("Referenced source is unavailable: " + ref.Name)
			}
			if err != nil {
				return err
			}
		}
	}
	return nil
}

func (a *App) messageAttachments(ctx context.Context, tx *sql.Tx, chatID, agentID string, ids []string) ([]model.Attachment, error) {
	files := []model.Attachment{}
	seen := map[string]bool{}
	var total int64
	for _, id := range ids {
		if seen[id] {
			return nil, invalid("Duplicate attachment")
		}
		seen[id] = true
		file, err := store.Get[model.Attachment](ctx, tx, "SELECT data FROM attachments WHERE id=?", id)
		if errors.Is(err, sql.ErrNoRows) {
			file, err = store.Get[model.Attachment](ctx, tx, "SELECT data FROM draft_attachments WHERE id=? AND agent_id=?", id, agentID)
			if err != nil {
				return nil, err
			}
			file.ChatID = chatID
			if err = insertAttachment(ctx, tx, file); err != nil {
				return nil, err
			}
			if _, err = tx.Exec("DELETE FROM draft_attachments WHERE id=?", file.ID); err != nil {
				return nil, err
			}
		}
		if err != nil {
			return nil, err
		}
		if file.ChatID != chatID {
			return nil, invalid("Attachment belongs to another Chat")
		}
		if _, err := os.Stat(a.AttachmentPath(file)); err != nil {
			return nil, invalid("Attachment is no longer available: " + file.Name)
		}
		total += file.Size
		files = append(files, file)
	}
	if total > MaxAttachmentBytes {
		return nil, invalid("Attachments must total at most 20 MiB per message")
	}
	return files, nil
}

func linkRunAttachments(tx *sql.Tx, run model.Run) error {
	for _, file := range run.Attachments {
		if _, err := tx.Exec("INSERT INTO run_attachments(run_id,attachment_id) VALUES(?,?)", run.ID, file.ID); err != nil {
			return err
		}
	}
	return nil
}
