package app

import (
	"context"
	"database/sql"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strings"

	"lever/internal/model"
	"lever/internal/store"
	"lever/internal/workspace"
)

type removedSkillPaths map[string]bool

func loadRemovedSkillPaths(ctx context.Context, q store.Queryer) (removedSkillPaths, error) {
	paths, err := store.List[string](ctx, q, "SELECT json_quote(path) FROM removed_skill_directories")
	if err != nil {
		return nil, err
	}
	removed := make(removedSkillPaths, len(paths))
	for _, path := range paths {
		removed[path] = true
	}
	return removed, nil
}

func (paths removedSkillPaths) blocksSync(root, dir string) bool {
	for path := range paths {
		if workspace.Contains(root, path) && overlap(path, dir) {
			return true
		}
	}
	return false
}

func (a *App) DeleteSkill(ctx context.Context, id string, deleteFiles bool) (model.SkillRemovalResult, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	entries, err := a.librarySkillEntries(ctx)
	if err != nil {
		return model.SkillRemovalResult{}, err
	}
	skill, ok := entries[id]
	if !ok {
		return model.SkillRemovalResult{}, sql.ErrNoRows
	}
	if deleteFiles && !skillDirectoryAvailable(skill.Path) {
		return model.SkillRemovalResult{}, conflict("Skill directory or SKILL.md has changed. Uncheck file deletion to remove the Skill from the library.")
	}
	return a.removeSkillDirectory(ctx, skillRemoval{
		path: skill.Path, deleteFiles: deleteFiles, exclude: !deleteFiles || skill.SubscriptionID != "",
	})
}

type skillRemoval struct {
	path          string
	deleteFiles   bool
	exclude       bool
	unsubscribeID string
}

func (a *App) checkSkillDeletionPath(ctx context.Context, path string) error {
	roots, err := a.skillLibraryRoots(ctx)
	if err != nil {
		return err
	}
	home, err := workspace.Canonical("~")
	if err != nil {
		return err
	}
	data, err := workspace.Canonical(a.Store.Dir)
	if err != nil {
		return err
	}
	for _, root := range append(roots, model.Root{Path: home}, model.Root{Path: data}) {
		if workspace.Contains(path, root.Path) {
			return conflict("This directory contains a workspace, home or Lever data root. Uncheck file deletion to keep it.")
		}
	}
	if workspace.Contains(data, path) {
		for _, collection := range []string{"skills", "skill-subscriptions"} {
			root := filepath.Join(data, collection)
			if path != root && workspace.Contains(root, path) {
				return nil
			}
		}
		return conflict("This directory is part of Lever's data. Uncheck file deletion to keep it.")
	}
	return nil
}

func (a *App) removeSkillDirectory(ctx context.Context, removal skillRemoval) (model.SkillRemovalResult, error) {
	path := removal.path
	if removal.deleteFiles {
		if err := a.checkSkillDeletionPath(ctx, path); err != nil {
			return model.SkillRemovalResult{}, err
		}
	}
	root, original := filepath.Dir(path), filepath.Base(path)
	var staged string
	err := a.Store.Write(ctx, func(tx *sql.Tx) error {
		prefix := path + string(filepath.Separator)
		if removal.unsubscribeID != "" {
			res, err := tx.ExecContext(ctx, "DELETE FROM skill_subscriptions WHERE id=?", removal.unsubscribeID)
			if err != nil {
				return err
			}
			if n, _ := res.RowsAffected(); n == 0 {
				return sql.ErrNoRows
			}
			if _, err := tx.ExecContext(ctx, "DELETE FROM removed_skill_directories WHERE path=? OR instr(path,?)=1", path, prefix); err != nil {
				return err
			}
		}
		if removal.exclude {
			if _, err := tx.ExecContext(ctx, "INSERT OR IGNORE INTO removed_skill_directories(path) VALUES(?)", path); err != nil {
				return err
			}
		}
		recursive := removal.unsubscribeID != "" || removal.deleteFiles
		if _, err := tx.ExecContext(ctx, "DELETE FROM skill_directories WHERE path=? OR (? AND instr(path,?)=1)", path, recursive, prefix); err != nil {
			return err
		}
		agents, err := store.List[model.Agent](ctx, tx, "SELECT data FROM agents WHERE json_array_length(data,'$.profile.skills')>0")
		if err != nil {
			return err
		}
		for _, agent := range agents {
			before := len(agent.Profile.Skills)
			agent.Profile.Skills = slices.DeleteFunc(agent.Profile.Skills, func(ref string) bool {
				return ref == path || (recursive && strings.HasPrefix(ref, prefix))
			})
			if before != len(agent.Profile.Skills) {
				agent.UpdatedAt = now()
				if _, err := tx.ExecContext(ctx, "UPDATE agents SET data=? WHERE id=?", store.JSON(agent), agent.ID); err != nil {
					return err
				}
			}
		}
		if err := store.Event(tx, model.Event{Type: "skills"}); err != nil || !removal.deleteFiles {
			return err
		}
		if current, err := workspace.Canonical(path); err != nil || current != path {
			if errors.Is(err, os.ErrNotExist) && removal.unsubscribeID != "" {
				return nil
			}
			return conflict("The directory has changed. Reload before deleting its files.")
		}
		temp := ".removed-" + ID()
		if _, err := workspace.ChangeEntry(root, original, "move", temp); err != nil {
			return err
		}
		staged = temp
		return nil
	})
	if err != nil {
		if staged != "" {
			_, restoreErr := workspace.ChangeEntry(root, staged, "move", original)
			err = errors.Join(err, restoreErr)
		}
		return model.SkillRemovalResult{}, err
	}
	result := model.SkillRemovalResult{Deleted: true}
	if staged != "" {
		if _, err := workspace.ChangeEntry(root, staged, "delete", ""); err != nil && !errors.Is(err, os.ErrNotExist) {
			result.RemainingDirectory = filepath.Join(root, staged)
		}
	}
	return result, nil
}
