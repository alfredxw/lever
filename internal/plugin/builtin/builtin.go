// Package builtin registers the plugins shipped with Lever.
package builtin

import (
	"embed"
	"encoding/json"
	"fmt"

	"lever/internal/model"
	"lever/internal/plugin"
	"lever/internal/plugin/builtin/github"
	"lever/internal/plugin/builtin/imap-mail"
	"lever/internal/plugin/builtin/lark-todos"
)

//go:embed */lever-plugin.json
var manifests embed.FS

func Plugins() ([]model.Plugin, error) {
	// Keep the order in which the plugins are offered in a new installation.
	dirs := []string{"acp", "antigravity", "claude", "codex", "dsh", "pi", "github", "lark-bot", "larkx", "lark-todos", "imap-mail"}
	result := make([]model.Plugin, 0, len(dirs))
	for _, dir := range dirs {
		data, err := manifests.ReadFile(dir + "/" + plugin.ManifestFile)
		if err != nil {
			return nil, err
		}
		var manifest model.PluginManifest
		if err := json.Unmarshal(data, &manifest); err != nil {
			return nil, fmt.Errorf("read built-in plugin %s: %w", dir, err)
		}
		result = append(result, model.Plugin{ID: manifest.ID, Manifest: manifest, Builtin: true, Installed: true, Enabled: true})
	}
	return result, nil
}

func EventSourceAdapters() map[[2]string]plugin.EventSourceAdapter {
	return map[[2]string]plugin.EventSourceAdapter{
		{imapmail.PluginID, imapmail.ContributionID}: imapmail.Source{},
	}
}

func TaskSourceAdapters() map[[2]string]plugin.TaskSourceAdapter {
	return map[[2]string]plugin.TaskSourceAdapter{
		{github.PluginID, github.ContributionID}:       github.NewTaskSource(),
		{larktodos.PluginID, larktodos.ContributionID}: larktodos.NewTaskSource(),
	}
}
