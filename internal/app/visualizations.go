package app

import (
	"bytes"
	"context"
	"net/url"
	"os"
	"path/filepath"
	"strings"

	"github.com/yuin/goldmark"
	"github.com/yuin/goldmark/extension"
	goldmarkhtml "github.com/yuin/goldmark/renderer/html"
	"golang.org/x/net/html"

	"lever/internal/model"
	"lever/internal/provider"
	"lever/internal/store"
	"lever/internal/workspace"
)

// Preview paths come from Markdown. Resolve them against the conversation's
// working directory, then hand a root-relative path to the confined file reader.
func previewPath(path, cwd string, roots []string) (string, string, error) {
	if path == "" || len(path) > 4096 {
		return "", "", os.ErrNotExist
	}
	if !filepath.IsAbs(path) {
		if !filepath.IsAbs(cwd) || filepath.VolumeName(path) != "" {
			return "", "", os.ErrNotExist
		}
		path = filepath.Join(cwd, path)
	}
	// macOS, for example, may spell the same directory as /var or /private/var.
	dir, err := filepath.EvalSymlinks(filepath.Dir(path))
	if err != nil {
		return "", "", os.ErrNotExist
	}
	path = filepath.Join(dir, filepath.Base(path))
	for _, root := range roots {
		if !filepath.IsAbs(root) {
			continue
		}
		root, err := workspace.Canonical(root)
		if err != nil {
			continue
		}
		relative, err := filepath.Rel(root, path)
		if err == nil && relative != "." && filepath.IsLocal(relative) {
			return root, filepath.ToSlash(relative), nil
		}
	}
	return "", "", os.ErrNotExist
}

func codexPreviewRoots(home string, image bool) []string {
	if !filepath.IsAbs(home) {
		return nil
	}
	roots := []string{filepath.Join(home, "visualizations")}
	if image {
		roots = append(roots, filepath.Join(home, "generated_images"))
	}
	return roots
}

// Render raw HTML for link extraction only. The renderer's output is never served.
var previewMarkdown = goldmark.New(goldmark.WithExtensions(extension.GFM), goldmark.WithRendererOptions(goldmarkhtml.WithUnsafe()))

func hasPreviewImageLink(markdown, path, origin string) bool {
	var rendered bytes.Buffer
	if err := previewMarkdown.Convert([]byte(markdown), &rendered); err != nil {
		return false
	}
	tokens := html.NewTokenizer(&rendered)
	for kind := tokens.Next(); kind != html.ErrorToken; kind = tokens.Next() {
		if kind != html.StartTagToken && kind != html.SelfClosingTagToken {
			continue
		}
		token := tokens.Token()
		var key string
		switch token.Data {
		case "a":
			key = "href"
		case "img":
			key = "src"
		case "source":
			key = "srcset"
		default:
			continue
		}
		for _, attr := range token.Attr {
			if attr.Key == key && previewLinkPath(attr.Val, origin) == path {
				return true
			}
		}
	}
	return false
}

func previewLinkPath(href, origin string) string {
	href = strings.ReplaceAll(strings.TrimSpace(href), "\\", "/")
	if filepath.VolumeName(href) != "" && !strings.HasPrefix(href, "/") {
		href = "/" + href // Keep a Windows drive letter in the path, not the scheme.
	}
	link, err := url.Parse(href)
	if err != nil {
		return ""
	}
	switch link.Scheme {
	case "", "sandbox":
		if link.Host != "" {
			return ""
		}
	case "file":
		if link.Host != "" && !strings.EqualFold(link.Host, "localhost") {
			return ""
		}
	case "http", "https":
		if link.Scheme+"://"+link.Host != origin {
			return ""
		}
	default:
		return ""
	}
	path := strings.ReplaceAll(link.Path, "\\", "/")
	if drivePath := strings.TrimPrefix(path, "/"); filepath.VolumeName(drivePath) != "" {
		return drivePath
	}
	return path
}

// WorkspacePreviewPath resolves a Markdown link only within the supplied roots.
func WorkspacePreviewPath(path string, scope model.Scope) (string, string, error) {
	roots := make([]string, 0, len(scope.Roots))
	for _, root := range scope.Roots {
		roots = append(roots, root.Path)
	}
	return previewPath(path, workspace.CWD(scope), roots)
}

func (a *App) RunPreviewPath(ctx context.Context, runID, path string, image bool) (string, string, error) {
	var agentID, sessionID string
	err := a.Store.DB.QueryRowContext(ctx, "SELECT agent_id, session_id FROM runs WHERE id=?", runID).Scan(&agentID, &sessionID)
	if err != nil {
		return "", "", err
	}
	scope, release, err := a.UseScope(ctx, agentID, sessionID, "", false)
	if err != nil {
		return "", "", err
	}
	defer release()
	if root, relative, err := WorkspacePreviewPath(path, scope); err == nil {
		return root, relative, nil
	}
	if !filepath.IsAbs(path) && !strings.HasPrefix(path, "~/") && !strings.HasPrefix(path, `~\`) {
		return "", "", os.ErrNotExist
	}
	config, err := store.Get[model.Provider](ctx, a.Store.DB, `SELECT providers.data FROM providers
		JOIN runs ON providers.id=json_extract(runs.data,'$.selection.provider') WHERE runs.id=?`, runID)
	if err == nil {
		switch config.Type {
		case "codex":
			if root, relative, err := previewPath(path, "", codexPreviewRoots(provider.SharedStore(config), image)); err == nil {
				return root, relative, nil
			}
		case "antigravity":
			var native string
			err := a.Store.DB.QueryRowContext(ctx, `SELECT json_extract(data,'$.nativeId') FROM sessions
				WHERE id=? AND json_extract(data,'$.selection.provider')=?`, sessionID, config.ID).Scan(&native)
			if err == nil {
				dir := provider.AntigravityArtifactDir(provider.WithStateDir(ctx, a.Store.Dir), config, native)
				if root, relative, err := previewPath(path, "", []string{dir}); err == nil {
					return root, relative, nil
				}
			}
		}
	}
	if !image {
		return "", "", os.ErrNotExist
	}
	canonical, err := a.ResolveHostFile(path)
	if err != nil {
		return "", "", err
	}
	// A host image outside the workspace is available only when the assistant linked it in this run.
	items, err := store.Get[[]model.Item](ctx, a.Store.DB, `SELECT json_extract(data,'$.items') FROM runs WHERE id=?`, runID)
	if err != nil {
		return "", "", err
	}
	for _, item := range items {
		if item.Kind == "text" && hasPreviewImageLink(item.Text, path, a.URL) {
			return filepath.Dir(canonical), filepath.Base(canonical), nil
		}
	}
	return "", "", os.ErrNotExist
}

// VisualizationArtifactPath also supports older markers without a conversation.
func (a *App) VisualizationArtifactPath(ctx context.Context, path string) (string, string, error) {
	configs, err := a.sharedProviders(ctx)
	if err != nil {
		return "", "", err
	}
	var roots []string
	if home, err := os.UserHomeDir(); err == nil {
		roots = append(roots, codexPreviewRoots(filepath.Join(home, ".codex"), false)...)
	}
	roots = append(roots, codexPreviewRoots(os.Getenv("CODEX_HOME"), false)...)
	for _, config := range configs {
		if config.Type == "codex" {
			roots = append(roots, codexPreviewRoots(config.ConfigDir, false)...)
		}
	}
	return previewPath(path, "", roots)
}

func (a *App) SharedPreviewPath(ctx context.Context, providerID, id, path string, image bool) (string, string, error) {
	config, managed, err := a.sharedProvider(ctx, providerID)
	if err != nil {
		return "", "", err
	}
	cwd, err := provider.SharedWorkingDirectory(ctx, config, id, managed)
	if err != nil {
		return "", "", err
	}
	roots := []string{cwd}
	switch config.Type {
	case "codex":
		roots = append(roots, codexPreviewRoots(provider.SharedStore(config), image)...)
	case "antigravity":
		if dir := provider.AntigravityArtifactDir(provider.WithStateDir(ctx, a.Store.Dir), config, id); dir != "" {
			roots = append(roots, dir)
		}
	}
	if root, relative, err := previewPath(path, cwd, roots); err == nil {
		return root, relative, nil
	}
	if !image {
		return "", "", os.ErrNotExist
	}
	canonical, err := a.ResolveHostFile(path)
	if err != nil {
		return "", "", err
	}
	history, err := provider.ReadShared(ctx, config, id, sharedHistoryLimit, managed)
	if err != nil {
		return "", "", err
	}
	for _, message := range history.Messages {
		if message.Role == "assistant" && message.Kind != "reasoning" && message.Kind != "tool" &&
			hasPreviewImageLink(message.Text, path, a.URL) {
			return filepath.Dir(canonical), filepath.Base(canonical), nil
		}
	}
	return "", "", os.ErrNotExist
}
