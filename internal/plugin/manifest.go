// Package plugin defines the package boundary. Contribution contracts grow here
// as the host implements them; unknown fields are rejected instead of ignored.
package plugin

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"

	"lever/internal/model"
	"lever/internal/provider"
	"lever/internal/workspace"
)

const ManifestFile = "lever-plugin.json"
const PersonalChannelDriver = "personal-stdio-v1"
const EventSourcePollDriver = "poll-stdio-v1"

var identifier = regexp.MustCompile(`^[a-z0-9][a-z0-9._-]{0,127}$`)

func Read(directory string) (model.PluginManifest, string, error) {
	return readDirectory(directory, false)
}

// ReadPackage keeps logical entry points in a managed manifest. A preview's
// temporary location must never become part of a provider's session identity.
func ReadPackage(directory string) (model.PluginManifest, string, error) {
	return readDirectory(directory, true)
}

func readDirectory(directory string, managed bool) (model.PluginManifest, string, error) {
	var manifest model.PluginManifest
	directory, err := workspace.Canonical(directory)
	if err != nil {
		return manifest, "", err
	}
	file, err := os.Open(filepath.Join(directory, ManifestFile))
	if err != nil {
		return manifest, "", err
	}
	defer file.Close()
	stat, err := file.Stat()
	if err != nil {
		return manifest, "", err
	}
	if stat.Size() > 256<<10 {
		return manifest, "", errors.New("Plugin manifest exceeds 256 KiB")
	}
	decoder := json.NewDecoder(io.LimitReader(file, 256<<10))
	decoder.DisallowUnknownFields()
	if err = decoder.Decode(&manifest); err != nil {
		return manifest, "", err
	}
	if err = decoder.Decode(new(any)); !errors.Is(err, io.EOF) {
		return manifest, "", errors.New("A plugin must contain exactly one manifest object")
	}
	if err = Validate(manifest); err != nil {
		return manifest, "", err
	}
	for _, channel := range manifest.Contributes.Channels {
		if _, err := PackageExecutable(directory, channel.Command); err != nil {
			return manifest, "", err
		}
	}
	for _, source := range manifest.Contributes.EventSources {
		if _, err := PackageExecutable(directory, source.Command); err != nil {
			return manifest, "", err
		}
	}
	for i := range manifest.Contributes.Providers {
		item := &manifest.Contributes.Providers[i]
		if RelativeCommand(item.Command) {
			if managed {
				if _, err := PackageExecutable(directory, item.Command); err != nil {
					return manifest, "", err
				}
				continue
			}
			if !filepath.IsLocal(item.Command) {
				return manifest, "", errors.New("Provider executable must stay inside the plugin directory")
			}
			path, err := filepath.EvalSymlinks(filepath.Join(directory, item.Command))
			if err != nil {
				return manifest, "", err
			}
			if !workspace.Contains(directory, path) {
				return manifest, "", errors.New("Provider executable points outside the plugin directory")
			}
			item.Command = path
		}
	}
	return manifest, directory, nil
}

func RelativeCommand(command string) bool {
	return !filepath.IsAbs(command) && strings.ContainsAny(command, `/\`)
}

func PackageExecutable(directory, command string) (string, error) {
	if directory == "" || !filepath.IsLocal(command) {
		return "", errors.New("Select an executable inside the plugin package")
	}
	path, err := filepath.EvalSymlinks(filepath.Join(directory, command))
	if err != nil {
		return "", err
	}
	info, err := os.Stat(path)
	if err != nil || !info.Mode().IsRegular() || !workspace.Contains(directory, path) {
		return "", errors.New("The executable must be a file inside the plugin package")
	}
	if runtime.GOOS != "windows" && info.Mode().Perm()&0111 == 0 {
		return "", errors.New("The plugin entry point is not executable")
	}
	return path, nil
}

func Validate(manifest model.PluginManifest) error {
	if manifest.ManifestVersion != 1 {
		return errors.New("Unsupported plugin manifest version")
	}
	if !identifier.MatchString(manifest.ID) || strings.HasPrefix(manifest.ID, "lever.") {
		return errors.New("Use a unique plugin ID outside the reserved lever. namespace")
	}
	if strings.TrimSpace(manifest.Name) == "" || len(manifest.Name) > 100 || manifest.Version == "" || len(manifest.Version) > 100 {
		return errors.New("Plugin name and version are required (up to 100 characters)")
	}
	if len(manifest.Description) > 1000 {
		return errors.New("Plugin description can be up to 1000 characters")
	}
	if len(manifest.Contributes.TaskSources) != 0 {
		return errors.New("Task sources currently require a built-in adapter")
	}
	if channels := manifest.Contributes.Channels; len(channels) != 0 {
		if len(channels) != 1 || len(manifest.Contributes.Providers) != 0 || len(manifest.Contributes.EventSources) != 0 ||
			channels[0].Driver != PersonalChannelDriver ||
			!identifier.MatchString(channels[0].ID) || strings.TrimSpace(channels[0].Name) == "" || len(channels[0].Name) > 100 ||
			!filepath.IsLocal(channels[0].Command) {
			return errors.New("Declare one personal-stdio-v1 channel with a package-relative command")
		}
		return nil
	}
	providers := manifest.Contributes.Providers
	eventSources := manifest.Contributes.EventSources
	if (len(providers) == 0 && len(eventSources) == 0) || len(providers) > 32 || len(eventSources) > 32 {
		return errors.New("Declare 1–32 providers or event sources, or one local personal channel")
	}
	seenProviders := map[string]bool{}
	for _, item := range providers {
		if !identifier.MatchString(item.ID) || seenProviders[item.ID] || strings.TrimSpace(item.Name) == "" || len(item.Name) > 100 {
			return errors.New("Provider contributions require unique IDs and names")
		}
		seenProviders[item.ID] = true
		known := false
		for _, kind := range provider.Types() {
			known = known || kind.ID == item.Driver
		}
		if !known {
			return fmt.Errorf("Unsupported provider driver: %s", item.Driver)
		}
		if item.Driver == "acp" && strings.TrimSpace(item.Command) == "" {
			return errors.New("ACP provider contributions require an executable")
		}
	}
	seenSources := map[string]bool{}
	for _, item := range eventSources {
		if !identifier.MatchString(item.ID) || seenSources[item.ID] || strings.TrimSpace(item.Name) == "" || len(item.Name) > 100 {
			return errors.New("Event source contributions require unique IDs and names")
		}
		seenSources[item.ID] = true
		if item.Driver != EventSourcePollDriver {
			return fmt.Errorf("Unsupported event source driver: %s", item.Driver)
		}
		if strings.TrimSpace(item.Command) == "" || !filepath.IsLocal(item.Command) {
			return errors.New("Event source contributions require a package-relative command")
		}
		if len(item.Fields) > 32 {
			return errors.New("Event sources can declare up to 32 fields")
		}
		seenFields := map[string]bool{}
		for _, field := range item.Fields {
			if !identifier.MatchString(field.ID) || seenFields[field.ID] || strings.TrimSpace(field.Label) == "" || len(field.Label) > 100 {
				return errors.New("Event source fields require unique IDs and labels")
			}
			seenFields[field.ID] = true
			if field.Kind != "text" && field.Kind != "secret" {
				return fmt.Errorf("Unsupported event source field kind: %s", field.Kind)
			}
			if field.Kind == "secret" && field.Default != "" {
				return errors.New("Secret event source fields cannot define a default value")
			}
			if len(field.Default) > 512 || strings.ContainsAny(field.Default, "\x00\r\n") {
				return fmt.Errorf("Invalid default value for event source field %s", field.ID)
			}
			if len(field.Placeholder) > 200 || strings.ContainsAny(field.Placeholder, "\x00\r\n") {
				return fmt.Errorf("Invalid placeholder for event source field %s", field.ID)
			}
		}
	}
	return nil
}
