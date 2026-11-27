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
		blocked := skillReferenceDisabled(ref, disabled)
		if !blocked && filepath.Base(ref.Path) == model.SkillEntry && skillDirectoryAvailable(filepath.Dir(ref.Path)) {
			name, _, _ := skillMetadata(filepath.Dir(ref.Path))
			blocked = model.SkillDisabled(disabled, name)
		}
		if blocked {
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

func (a *App) prepareSkillReferences(ctx context.Context, q store.Queryer, references []model.Reference, profile model.Profile, scope model.Scope, target model.Provider, shared bool) ([]model.Reference, error) {
	bound := slices.Clone(references)
	pathsByProvider := map[string]map[string]bool{}
	for i, ref := range bound {
		if ref.Kind != "skill" {
			continue
		}
		if ref.Provider == "" {
			return nil, invalid("A Skill reference requires its source runtime")
		}
		foreign := ref.Provider != target.ID
		switch {
		case foreign && ref.Path == "":
			skill, err := a.resolveNamedSkill(ctx, q, profile, scope, ref)
			if errors.Is(err, errSkillUnavailable) {
				return nil, invalid(fmt.Sprintf("Cannot find SKILL.md for %q in the source Agent's skills", ref.Name))
			}
			if err != nil {
				return nil, err
			}
			bound[i].Path = filepath.Join(skill.Path, model.SkillEntry)
		case shared && (foreign || !provider.Capabilities(target.Type).Skills):
			entry, err := os.Lstat(ref.Path)
			if !filepath.IsAbs(ref.Path) || filepath.Base(ref.Path) != model.SkillEntry || err != nil || !entry.Mode().IsRegular() {
				return nil, invalid(fmt.Sprintf("Skill %q needs an available SKILL.md to be shared across runtimes", ref.Name))
			}
		case !foreign && target.Type == "codex":
			if !filepath.IsAbs(ref.Path) {
				return nil, invalid("A Codex skill requires its absolute path")
			}
		case !foreign && target.Type == "claude":
			continue
		default:
			paths := pathsByProvider[ref.Provider]
			if paths == nil {
				source := target
				var err error
				if foreign {
					source, _, err = lookupProvider(ctx, q, ref.Provider)
					if err != nil {
						return nil, err
					}
				}
				paths, err = a.skillReferencePaths(ctx, q, scope, source)
				if err != nil {
					return nil, err
				}
				pathsByProvider[ref.Provider] = paths
			}
			dir := filepath.Dir(ref.Path)
			if (paths[dir] || slices.Contains(profile.Skills, dir)) && ref.Path == filepath.Join(dir, model.SkillEntry) && skillDirectoryAvailable(dir) {
				name := withSkillMetadata(skillAt(dir, false)).Name
				label := strings.TrimPrefix(ref.Name, skillBundlePluginName+":")
				if name == ref.Name || foreign && (name == label || filepath.Base(dir) == label) {
					continue
				}
			}
			return nil, invalid(fmt.Sprintf("Skill %q is no longer available in this session's skill sources", ref.Name))
		}
	}
	return bound, nil
}

func (a *App) validateReferences(ctx context.Context, q store.Queryer, references []model.Reference, session model.Session, agent model.Agent, config model.Provider) error {
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
			continue
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
				if !session.DelegationDepthAllowsMore() {
					return invalid("The referenced Agent is not a configured collaborator for this conversation")
				}
				if slices.Contains(session.DelegationChain, a.delegationChainKey(ref.DeviceID, ref.ID)) {
					return invalid("The referenced Agent is already an ancestor in this delegation chain")
				}
				defaults, err := delegationSettings(ctx, q)
				if err != nil {
					return err
				}
				policy := agent.Profile.EffectiveDelegationPolicy(defaults)
				if ref.DeviceID != "" {
					if !notes.IDPattern.MatchString(ref.DeviceID) {
						return invalid("Invalid Lever reference")
					}
					allowed := false
					switch policy {
					case model.DelegationPolicyAll:
						allowed = agent.Profile.AllowsRemoteDelegation()
					case model.DelegationPolicySelected:
						_, allowed = findDelegationRule(agent.Profile.Delegations, ref.DeviceID, ref.ID)
					}
					if !allowed {
						return invalid("The referenced Agent is not a configured collaborator for this conversation")
					}
					continue
				}
				allowed := false
				switch policy {
				case model.DelegationPolicyAll:
					allowed = ref.ID != agent.ID
				case model.DelegationPolicySelected:
					_, allowed = findDelegationRule(agent.Profile.Delegations, "", ref.ID)
				}
				if !allowed {
					return invalid("The referenced Agent is not a configured collaborator for this conversation")
				}
				query = "SELECT 1 FROM agents WHERE id=? AND NOT json_extract(data,'$.archived') AND coalesce(json_extract(data,'$.profile.acceptDelegations'),1)=1"
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
