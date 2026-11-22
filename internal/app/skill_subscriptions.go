package app

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"lever/internal/model"
	"lever/internal/plugin"
	"lever/internal/store"
	"lever/internal/workspace"
)

type skillSubscriptionRecord struct {
	model.SkillSubscription
	// SyncedHashes maps canonical relative skill path (e.g. "lark-doc" or ".")
	// to the SHA-256 digest of all regular files written during the last sync.
	SyncedHashes map[string]string `json:"syncedHashes,omitempty"`
	// SkippedCommits records remote commits explicitly skipped by user ("keep").
	SkippedCommits map[string]string `json:"skippedCommits,omitempty"`
}

func (a *App) skillSubscriptionsRoot() (string, error) {
	data, err := workspace.Canonical(a.Store.Dir)
	if err != nil {
		return "", err
	}
	return filepath.Join(data, "skill-subscriptions"), nil
}

func (a *App) skillSubscriptionDir(id string) (string, error) {
	root, err := a.skillSubscriptionsRoot()
	if err != nil {
		return "", err
	}
	if !filepath.IsLocal(id) || strings.ContainsAny(id, `/\`) {
		return "", invalid("Invalid subscription ID")
	}
	return filepath.Join(root, id), nil
}

func (a *App) skillSubscriptionRecords(ctx context.Context) ([]skillSubscriptionRecord, error) {
	return store.List[skillSubscriptionRecord](ctx, a.Store.DB, "SELECT data FROM skill_subscriptions ORDER BY rowid")
}

func (a *App) skillSubscriptionRecordByID(ctx context.Context, q store.Queryer, id string) (skillSubscriptionRecord, error) {
	return store.Get[skillSubscriptionRecord](ctx, q, "SELECT data FROM skill_subscriptions WHERE id=?", id)
}

// discoverSkillsInTree finds all subdirectories (or root) containing a regular SKILL.md file.
// Returns relative slash-separated paths ("." if the root itself is a single skill).
func discoverSkillsInTree(root string) ([]string, error) {
	var found []string
	err := filepath.WalkDir(root, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if path != root && strings.HasPrefix(entry.Name(), ".") {
			if entry.IsDir() {
				return fs.SkipDir
			}
			return nil
		}
		if !entry.IsDir() {
			return nil
		}
		info, err := os.Lstat(filepath.Join(path, model.SkillEntry))
		if err == nil && info.Mode().IsRegular() {
			rel, err := filepath.Rel(root, path)
			if err != nil {
				return err
			}
			found = append(found, filepath.ToSlash(rel))
			return fs.SkipDir
		}
		return nil
	})
	sort.Strings(found)
	return found, err
}

// skillDirHash computes a deterministic SHA-256 fingerprint over all regular files
// inside a skill directory so local edits in Files can be reliably detected.
func skillDirHash(dir string) (string, error) {
	var rels []string
	err := filepath.WalkDir(dir, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if path != dir && strings.HasPrefix(entry.Name(), ".") {
			if entry.IsDir() {
				return fs.SkipDir
			}
			return nil
		}
		if entry.Type().IsRegular() {
			rel, err := filepath.Rel(dir, path)
			if err != nil {
				return err
			}
			rels = append(rels, filepath.ToSlash(rel))
		}
		return nil
	})
	if err != nil {
		return "", err
	}
	sort.Strings(rels)
	h := sha256.New()
	for _, rel := range rels {
		_, _ = io.WriteString(h, rel)
		_, _ = h.Write([]byte{0})
		data, err := os.ReadFile(filepath.Join(dir, filepath.FromSlash(rel)))
		if err != nil {
			return "", err
		}
		_, _ = h.Write(data)
		_, _ = h.Write([]byte{0})
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

func copyRegularTree(src, dst string) error {
	return filepath.WalkDir(src, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if path != src && strings.HasPrefix(entry.Name(), ".") {
			if entry.IsDir() {
				return fs.SkipDir
			}
			return nil
		}
		rel, err := filepath.Rel(src, path)
		if err != nil {
			return err
		}
		target := filepath.Join(dst, rel)
		if entry.IsDir() {
			return os.MkdirAll(target, 0700)
		}
		if !entry.Type().IsRegular() {
			return nil
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		mode := fs.FileMode(0600)
		if info.Mode()&0111 != 0 {
			mode = 0700
		}
		if err := os.MkdirAll(filepath.Dir(target), 0700); err != nil {
			return err
		}
		in, err := os.Open(path)
		if err != nil {
			return err
		}
		defer in.Close()
		out, err := os.OpenFile(target, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, mode)
		if err != nil {
			return err
		}
		_, copyErr := io.Copy(out, in)
		return errors.Join(copyErr, out.Close())
	})
}

func defaultSubscriptionName(source model.PluginGitSource) string {
	base := strings.TrimSuffix(source.URL, "/")
	base = strings.TrimSuffix(base, ".git")
	if i := strings.LastIndexAny(base, "/:"); i >= 0 && i+1 < len(base) {
		base = base[i+1:]
	}
	if source.Path != "" {
		return base + "/" + source.Path
	}
	if base == "" {
		return "Skill subscription"
	}
	return base
}

func (a *App) hydrateSkillSubscription(rec skillSubscriptionRecord) model.SkillSubscription {
	dto := rec.SkillSubscription
	dir, err := a.skillSubscriptionDir(rec.ID)
	if err != nil {
		return dto
	}
	rels, err := discoverSkillsInTree(dir)
	if err != nil {
		return dto
	}
	dto.SkillCount = len(rels)
	modified := 0
	for _, rel := range rels {
		skillDir := filepath.Join(dir, filepath.FromSlash(rel))
		if expected, ok := rec.SyncedHashes[rel]; ok && expected != "" {
			if cur, err := skillDirHash(skillDir); err == nil && cur != expected {
				modified++
			}
		}
	}
	dto.ModifiedCount = modified
	return dto
}

func (a *App) SkillSubscriptions(ctx context.Context) ([]model.SkillSubscription, error) {
	records, err := a.skillSubscriptionRecords(ctx)
	if err != nil {
		return nil, err
	}
	out := make([]model.SkillSubscription, 0, len(records))
	for _, rec := range records {
		out = append(out, a.hydrateSkillSubscription(rec))
	}
	return out, nil
}

func (a *App) CreateSkillSubscription(ctx context.Context, input model.SkillSubscriptionInput) (model.SkillSubscription, error) {
	source, err := plugin.GitSource(input.URL, input.Ref, input.Path)
	if err != nil {
		return model.SkillSubscription{}, invalid(err.Error())
	}
	policy, err := normalizeItemUpdatePolicy(input.UpdatePolicy)
	if err != nil {
		return model.SkillSubscription{}, err
	}
	source, commit, err := plugin.ResolveGit(ctx, source)
	if err != nil {
		return model.SkillSubscription{}, err
	}
	stage, err := os.MkdirTemp("", "lever-skill-sub-")
	if err != nil {
		return model.SkillSubscription{}, err
	}
	defer os.RemoveAll(stage)

	tree, err := plugin.GitTree(ctx, source, commit, stage)
	if err != nil {
		return model.SkillSubscription{}, err
	}
	rels, err := discoverSkillsInTree(stage)
	if err != nil {
		return model.SkillSubscription{}, err
	}
	if len(rels) == 0 {
		return model.SkillSubscription{}, invalid("No SKILL.md directories were found in this Git repository path")
	}
	subID := ID()
	destRoot, err := a.skillSubscriptionDir(subID)
	if err != nil {
		return model.SkillSubscription{}, err
	}
	if err := os.MkdirAll(destRoot, 0700); err != nil {
		return model.SkillSubscription{}, err
	}
	hashes := make(map[string]string, len(rels))
	for _, rel := range rels {
		srcDir := filepath.Join(stage, filepath.FromSlash(rel))
		dstDir := destRoot
		if rel != "." {
			dstDir = filepath.Join(destRoot, filepath.FromSlash(rel))
		}
		if err := copyRegularTree(srcDir, dstDir); err != nil {
			_ = os.RemoveAll(destRoot)
			return model.SkillSubscription{}, err
		}
		sum, err := skillDirHash(dstDir)
		if err != nil {
			_ = os.RemoveAll(destRoot)
			return model.SkillSubscription{}, err
		}
		hashes[rel] = sum
	}
	name := strings.TrimSpace(input.Name)
	if name == "" {
		name = defaultSubscriptionName(source)
	}
	if len(name) > 100 {
		name = name[:100]
	}
	ts := now()
	rec := skillSubscriptionRecord{
		SkillSubscription: model.SkillSubscription{
			ID:            subID,
			Name:          name,
			Source:        source,
			Commit:        commit,
			Tree:          tree,
			UpdatePolicy:  policy,
			LastCheckedAt: ts,
			LastSyncedAt:  ts,
			SkillCount:    len(rels),
		},
		SyncedHashes:   hashes,
		SkippedCommits: map[string]string{},
	}
	err = a.Store.Write(ctx, func(tx *sql.Tx) error {
		if _, err := tx.ExecContext(ctx, "INSERT INTO skill_subscriptions(id,data) VALUES(?,?)", rec.ID, store.JSON(rec)); err != nil {
			return err
		}
		return store.Event(tx, model.Event{Type: "skills"})
	})
	if err != nil {
		_ = os.RemoveAll(destRoot)
		return model.SkillSubscription{}, err
	}
	return a.hydrateSkillSubscription(rec), nil
}

func (a *App) UpdateSkillSubscription(ctx context.Context, id string, name, policy *string) (model.SkillSubscription, error) {
	var normalizedPolicy string
	if policy != nil {
		var err error
		normalizedPolicy, err = normalizeItemUpdatePolicy(*policy)
		if err != nil {
			return model.SkillSubscription{}, err
		}
	}
	var updated skillSubscriptionRecord
	err := a.Store.Write(ctx, func(tx *sql.Tx) error {
		rec, err := a.skillSubscriptionRecordByID(ctx, tx, id)
		if err != nil {
			return err
		}
		if name != nil {
			trimmed := strings.TrimSpace(*name)
			if trimmed == "" || len(trimmed) > 100 {
				return invalid("Subscription name must be 1 to 100 characters")
			}
			rec.Name = trimmed
		}
		if policy != nil {
			rec.UpdatePolicy = normalizedPolicy
		}
		updated = rec
		if _, err := tx.ExecContext(ctx, "UPDATE skill_subscriptions SET data=? WHERE id=?", store.JSON(rec), rec.ID); err != nil {
			return err
		}
		return store.Event(tx, model.Event{Type: "skills"})
	})
	if err != nil {
		return model.SkillSubscription{}, err
	}
	return a.hydrateSkillSubscription(updated), nil
}

func (a *App) DeleteSkillSubscription(ctx context.Context, id string) error {
	dir, err := a.skillSubscriptionDir(id)
	if err != nil {
		return err
	}
	err = a.Store.Write(ctx, func(tx *sql.Tx) error {
		res, err := tx.ExecContext(ctx, "DELETE FROM skill_subscriptions WHERE id=?", id)
		if err != nil {
			return err
		}
		if n, _ := res.RowsAffected(); n == 0 {
			return sql.ErrNoRows
		}
		return store.Event(tx, model.Event{Type: "skills"})
	})
	if err != nil {
		return err
	}
	return os.RemoveAll(dir)
}

func (a *App) CheckSkillSubscription(ctx context.Context, id string) (model.SkillSubscription, error) {
	rec, err := a.skillSubscriptionRecordByID(ctx, a.Store.DB, id)
	if err != nil {
		return model.SkillSubscription{}, err
	}
	ts := now()
	rec.LastCheckedAt = ts
	rec.Error = ""
	if rec.Source.Kind == "branch" {
		_, commit, resolveErr := plugin.ResolveGit(ctx, rec.Source)
		if resolveErr != nil {
			rec.Error = resolveErr.Error()
		} else if commit != rec.Commit {
			tree, treeErr := plugin.GitTree(ctx, rec.Source, commit, "")
			if treeErr != nil {
				rec.Error = treeErr.Error()
			} else if tree != rec.Tree {
				rec.Available = true
				rec.AvailableCommit = commit
			} else {
				rec.Available = false
				rec.AvailableCommit = ""
			}
		} else {
			rec.Available = false
			rec.AvailableCommit = ""
		}
	}
	err = a.Store.Write(ctx, func(tx *sql.Tx) error {
		if _, err := tx.ExecContext(ctx, "UPDATE skill_subscriptions SET data=? WHERE id=?", store.JSON(rec), rec.ID); err != nil {
			return err
		}
		return store.Event(tx, model.Event{Type: "skills"})
	})
	if err != nil {
		return model.SkillSubscription{}, err
	}
	return a.hydrateSkillSubscription(rec), nil
}

func (a *App) SyncSkillSubscription(ctx context.Context, id string) (model.SkillSubscriptionSyncResult, error) {
	rec, err := a.skillSubscriptionRecordByID(ctx, a.Store.DB, id)
	if err != nil {
		return model.SkillSubscriptionSyncResult{}, err
	}
	targetCommit := rec.AvailableCommit
	if targetCommit == "" {
		if rec.Source.Kind == "branch" {
			_, targetCommit, err = plugin.ResolveGit(ctx, rec.Source)
			if err != nil {
				return model.SkillSubscriptionSyncResult{}, err
			}
		} else {
			targetCommit = rec.Commit
		}
	}
	stage, err := os.MkdirTemp("", "lever-skill-sync-")
	if err != nil {
		return model.SkillSubscriptionSyncResult{}, err
	}
	defer os.RemoveAll(stage)

	tree, err := plugin.GitTree(ctx, rec.Source, targetCommit, stage)
	if err != nil {
		return model.SkillSubscriptionSyncResult{}, err
	}
	remoteRels, err := discoverSkillsInTree(stage)
	if err != nil {
		return model.SkillSubscriptionSyncResult{}, err
	}
	if len(remoteRels) == 0 {
		return model.SkillSubscriptionSyncResult{}, invalid("No SKILL.md directories found in target revision")
	}
	destRoot, err := a.skillSubscriptionDir(rec.ID)
	if err != nil {
		return model.SkillSubscriptionSyncResult{}, err
	}
	if err := os.MkdirAll(destRoot, 0700); err != nil {
		return model.SkillSubscriptionSyncResult{}, err
	}
	if rec.SyncedHashes == nil {
		rec.SyncedHashes = map[string]string{}
	}
	if rec.SkippedCommits == nil {
		rec.SkippedCommits = map[string]string{}
	}

	var result model.SkillSubscriptionSyncResult
	remoteSet := map[string]bool{}
	for _, rel := range remoteRels {
		remoteSet[rel] = true
		srcDir := filepath.Join(stage, filepath.FromSlash(rel))
		dstDir := destRoot
		if rel != "." {
			dstDir = filepath.Join(destRoot, filepath.FromSlash(rel))
		}
		remoteHash, err := skillDirHash(srcDir)
		if err != nil {
			return model.SkillSubscriptionSyncResult{}, err
		}
		prevHash, existed := rec.SyncedHashes[rel]
		if !existed {
			if err := os.RemoveAll(dstDir); err != nil {
				return model.SkillSubscriptionSyncResult{}, err
			}
			if err := copyRegularTree(srcDir, dstDir); err != nil {
				return model.SkillSubscriptionSyncResult{}, err
			}
			rec.SyncedHashes[rel] = remoteHash
			delete(rec.SkippedCommits, rel)
			result.Added++
			continue
		}
		curHash, curErr := skillDirHash(dstDir)
		// Protect locally modified skills from being overwritten silently!
		if curErr == nil && prevHash != "" && curHash != prevHash {
			if curHash != remoteHash {
				result.SkippedModified++
				continue
			}
			rec.SyncedHashes[rel] = remoteHash
			continue
		}
		if curErr == nil && curHash == remoteHash {
			rec.SyncedHashes[rel] = remoteHash
			delete(rec.SkippedCommits, rel)
			continue
		}
		if err := os.RemoveAll(dstDir); err != nil {
			return model.SkillSubscriptionSyncResult{}, err
		}
		if err := copyRegularTree(srcDir, dstDir); err != nil {
			return model.SkillSubscriptionSyncResult{}, err
		}
		rec.SyncedHashes[rel] = remoteHash
		delete(rec.SkippedCommits, rel)
		result.Updated++
	}

	// Clean up removed unmodified skills
	for rel, prevHash := range rec.SyncedHashes {
		if remoteSet[rel] || rel == "." {
			continue
		}
		dstDir := filepath.Join(destRoot, filepath.FromSlash(rel))
		if curHash, err := skillDirHash(dstDir); err == nil && prevHash != "" && curHash != prevHash {
			result.SkippedModified++
			continue
		}
		_ = os.RemoveAll(dstDir)
		delete(rec.SyncedHashes, rel)
		delete(rec.SkippedCommits, rel)
		result.Removed++
	}

	ts := now()
	rec.LastCheckedAt = ts
	rec.LastSyncedAt = ts
	rec.Error = ""
	if result.SkippedModified == 0 {
		rec.Commit = targetCommit
		rec.Tree = tree
		rec.Available = false
		rec.AvailableCommit = ""
	} else {
		rec.Available = true
		rec.AvailableCommit = targetCommit
	}
	err = a.Store.Write(ctx, func(tx *sql.Tx) error {
		if _, err := tx.ExecContext(ctx, "UPDATE skill_subscriptions SET data=? WHERE id=?", store.JSON(rec), rec.ID); err != nil {
			return err
		}
		return store.Event(tx, model.Event{Type: "skills"})
	})
	if err != nil {
		return model.SkillSubscriptionSyncResult{}, err
	}
	result.Subscription = a.hydrateSkillSubscription(rec)
	return result, nil
}

// ResolveSkillUpdate handles conflict resolution for a locally-modified subscribed skill:
//   - "keep": keep local files and dismiss update notice for this remote commit
//   - "overwrite": replace local files with upstream commit
//   - "fork": copy local modified skill to managed ~/.lever/skills/<name>-local and update subscribed skill
func (a *App) ResolveSkillUpdate(ctx context.Context, skillID, strategy string) (model.Skill, error) {
	switch strategy {
	case "keep", "overwrite", "fork":
	default:
		return model.Skill{}, invalid("Strategy must be keep, overwrite, or fork")
	}
	sub, rel, skillPath, err := a.findSubscribedSkill(ctx, skillID)
	if err != nil {
		return model.Skill{}, err
	}
	targetCommit := sub.AvailableCommit
	if targetCommit == "" {
		targetCommit = sub.Commit
	}
	if strategy == "keep" {
		if sub.SkippedCommits == nil {
			sub.SkippedCommits = map[string]string{}
		}
		sub.SkippedCommits[rel] = targetCommit
		err = a.Store.Write(ctx, func(tx *sql.Tx) error {
			if _, err := tx.ExecContext(ctx, "UPDATE skill_subscriptions SET data=? WHERE id=?", store.JSON(sub), sub.ID); err != nil {
				return err
			}
			return store.Event(tx, model.Event{Type: "skills"})
		})
		if err != nil {
			return model.Skill{}, err
		}
		return describeSkill(skillAt(skillPath, false)), nil
	}

	var forkedSkill *model.Skill
	if strategy == "fork" {
		managedRoot, err := a.skillsDir()
		if err != nil {
			return model.Skill{}, err
		}
		if err := os.MkdirAll(managedRoot, 0700); err != nil {
			return model.Skill{}, err
		}
		baseName := sanitizeSkillSlug(filepath.Base(skillPath)) + "-local"
		forkName := uniqueManagedSkillName(managedRoot, baseName)
		forkDir := filepath.Join(managedRoot, forkName)
		if err := copyRegularTree(skillPath, forkDir); err != nil {
			return model.Skill{}, err
		}
		sk := describeSkill(skillAt(forkDir, true))
		forkedSkill = &sk
	}

	stage, err := os.MkdirTemp("", "lever-skill-resolve-")
	if err != nil {
		return model.Skill{}, err
	}
	defer os.RemoveAll(stage)

	_, err = plugin.GitTree(ctx, sub.Source, targetCommit, stage)
	if err != nil {
		return model.Skill{}, err
	}
	srcDir := filepath.Join(stage, filepath.FromSlash(rel))
	if _, err := os.Lstat(filepath.Join(srcDir, model.SkillEntry)); err != nil {
		return model.Skill{}, invalid("Skill no longer exists in target revision")
	}
	if err := os.RemoveAll(skillPath); err != nil {
		return model.Skill{}, err
	}
	if err := copyRegularTree(srcDir, skillPath); err != nil {
		return model.Skill{}, err
	}
	remoteHash, err := skillDirHash(skillPath)
	if err != nil {
		return model.Skill{}, err
	}
	if sub.SyncedHashes == nil {
		sub.SyncedHashes = map[string]string{}
	}
	sub.SyncedHashes[rel] = remoteHash
	delete(sub.SkippedCommits, rel)
	// If no other skills remain locally modified, mark subscription caught up
	if a.hydrateSkillSubscription(sub).ModifiedCount == 0 && sub.AvailableCommit == targetCommit {
		sub.Commit = targetCommit
		sub.Available = false
		sub.AvailableCommit = ""
	}
	err = a.Store.Write(ctx, func(tx *sql.Tx) error {
		if _, err := tx.ExecContext(ctx, "UPDATE skill_subscriptions SET data=? WHERE id=?", store.JSON(sub), sub.ID); err != nil {
			return err
		}
		return store.Event(tx, model.Event{Type: "skills"})
	})
	if err != nil {
		return model.Skill{}, err
	}
	if forkedSkill != nil {
		return *forkedSkill, nil
	}
	return describeSkill(skillAt(skillPath, false)), nil
}

func sanitizeSkillSlug(raw string) string {
	var b strings.Builder
	prevDash := false
	for _, r := range strings.ToLower(raw) {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') {
			b.WriteRune(r)
			prevDash = false
		} else if !prevDash && b.Len() > 0 {
			b.WriteByte('-')
			prevDash = true
		}
	}
	out := strings.Trim(b.String(), "-")
	if out == "" {
		return "skill"
	}
	if len(out) > 48 {
		out = strings.TrimRight(out[:48], "-")
	}
	return out
}

func uniqueManagedSkillName(root, base string) string {
	if _, err := os.Lstat(filepath.Join(root, base)); errors.Is(err, os.ErrNotExist) {
		return base
	}
	for i := 2; i < 1000; i++ {
		candidate := fmt.Sprintf("%s-%d", base, i)
		if _, err := os.Lstat(filepath.Join(root, candidate)); errors.Is(err, os.ErrNotExist) {
			return candidate
		}
	}
	return base + "-" + ID()[:6]
}

func (a *App) findSubscribedSkill(ctx context.Context, skillID string) (skillSubscriptionRecord, string, string, error) {
	records, err := a.skillSubscriptionRecords(ctx)
	if err != nil {
		return skillSubscriptionRecord{}, "", "", err
	}
	for _, rec := range records {
		root, err := a.skillSubscriptionDir(rec.ID)
		if err != nil {
			continue
		}
		rels, err := discoverSkillsInTree(root)
		if err != nil {
			continue
		}
		for _, rel := range rels {
			p := root
			if rel != "." {
				p = filepath.Join(root, filepath.FromSlash(rel))
			}
			canon, err := workspace.Canonical(p)
			if err != nil {
				continue
			}
			if hash(canon) == skillID {
				return rec, rel, canon, nil
			}
		}
	}
	return skillSubscriptionRecord{}, "", "", errSkillUnavailable
}

func (a *App) subscribedSkillDirectories(ctx context.Context) ([]skillDirectory, map[string]subscribedSkillMeta, error) {
	records, err := a.skillSubscriptionRecords(ctx)
	if err != nil {
		return nil, nil, err
	}
	var dirs []skillDirectory
	meta := map[string]subscribedSkillMeta{}
	for _, rec := range records {
		root, err := a.skillSubscriptionDir(rec.ID)
		if err != nil {
			continue
		}
		canonRoot, err := workspace.Canonical(root)
		if err != nil {
			continue
		}
		dirs = append(dirs, skillDirectory{path: canonRoot, subscription: true})
		rels, err := discoverSkillsInTree(canonRoot)
		if err != nil {
			continue
		}
		for _, rel := range rels {
			p := canonRoot
			if rel != "." {
				p = filepath.Join(canonRoot, filepath.FromSlash(rel))
			}
			canonSkill, err := workspace.Canonical(p)
			if err != nil {
				continue
			}
			modified := false
			if expected, ok := rec.SyncedHashes[rel]; ok && expected != "" {
				if cur, err := skillDirHash(canonSkill); err == nil && cur != expected {
					modified = true
				}
			}
			updateAvail := rec.Available && rec.AvailableCommit != "" && rec.SkippedCommits[rel] != rec.AvailableCommit
			meta[canonSkill] = subscribedSkillMeta{
				subID:           rec.ID,
				subName:         rec.Name,
				localModified:   modified,
				updateAvailable: updateAvail,
			}
		}
	}
	return dirs, meta, nil
}

type subscribedSkillMeta struct {
	subID           string
	subName         string
	localModified   bool
	updateAvailable bool
}

// Helper for counting regular files inside a skill package directory.
func countSkillFiles(dir string) int {
	count := 0
	_ = filepath.WalkDir(dir, func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if path != dir && strings.HasPrefix(entry.Name(), ".") {
			if entry.IsDir() {
				return fs.SkipDir
			}
			return nil
		}
		if entry.Type().IsRegular() {
			count++
			if count >= 99 {
				return fs.SkipAll
			}
		}
		return nil
	})
	return count
}
