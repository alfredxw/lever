package provider

import (
	"context"
	_ "embed"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"

	"lever/internal/model"
)

//go:embed models.json
var modelsJSON []byte

type catalogModel struct {
	model.ModelInfo
	MinVersion string `json:"minVersion"`
}

var bundledModels = func() map[string][]catalogModel {
	var models map[string][]catalogModel
	if err := json.Unmarshal(modelsJSON, &models); err != nil {
		panic(err)
	}
	return models
}()

var versionPattern = regexp.MustCompile(`\b[0-9]+\.[0-9]+\.[0-9]+\b`)

func runtimeVersion(output string) string { return versionPattern.FindString(output) }

func versionAtLeast(version, minimum string) bool {
	if minimum == "" {
		return true
	}
	if version == "" {
		return false
	}
	parts := func(v string) [3]int {
		var out [3]int
		for i, part := range strings.SplitN(v, ".", 3) {
			out[i], _ = strconv.Atoi(part)
		}
		return out
	}
	v, m := parts(version), parts(minimum)
	return slices.Compare(v[:], m[:]) >= 0
}

func mergeCatalog(catalog *model.Catalog, builtins []catalogModel) {
	native := catalog.Models
	catalog.Models = []model.ModelInfo{}
	seen := map[string]bool{}
	add := func(entry model.ModelInfo) {
		if entry.ID == "" || seen[entry.ID] {
			return
		}
		seen[entry.ID] = true
		if entry.Name == "" {
			entry.Name = entry.ID
		}
		if entry.Efforts == nil {
			entry.Efforts = []string{}
		}
		catalog.Models = append(catalog.Models, entry)
	}
	for _, entry := range native {
		if entry.Default || catalog.Provider == "codex" {
			add(entry)
		}
	}
	for _, builtin := range builtins {
		if i := slices.IndexFunc(native, func(m model.ModelInfo) bool { return m.ID == builtin.ID }); i >= 0 {
			add(native[i])
			continue
		}
		entry := builtin.ModelInfo
		if !versionAtLeast(catalog.Version, builtin.MinVersion) {
			entry.RequiresVersion = builtin.MinVersion
		} else if catalog.Provider == "codex" {
			// Codex's account catalog remains authoritative for selectable models.
			continue
		}
		entry.Fast = entry.Fast && catalog.FastUnavailable == "" && entry.RequiresVersion == ""
		add(entry)
	}
	for _, entry := range native {
		add(entry)
	}
}

func listCodexModels(request func(object) (object, error)) ([]model.ModelInfo, error) {
	models := []model.ModelInfo{}
	params := object{}
	seen := map[string]bool{}
	for {
		r, err := request(params)
		if err != nil {
			return nil, err
		}
		for _, v := range arr(r["data"]) {
			m := obj(v)
			entry := model.ModelInfo{ID: str(m["model"]), Name: str(m["displayName"]), DefaultEffort: str(m["defaultReasoningEffort"]), Efforts: []string{}}
			if entry.ID == "" {
				continue
			}
			entry.Default, _ = m["isDefault"].(bool)
			for _, e := range arr(m["supportedReasoningEfforts"]) {
				entry.Efforts = append(entry.Efforts, str(obj(e)["reasoningEffort"]))
			}
			for _, tier := range arr(m["serviceTiers"]) {
				if str(obj(tier)["id"]) == "fast" || str(obj(tier)["id"]) == "priority" {
					entry.Fast = true
				}
			}
			for _, tier := range arr(m["additionalSpeedTiers"]) {
				if str(tier) == "fast" {
					entry.Fast = true
				}
			}
			models = append(models, entry)
		}
		cursor := str(r["nextCursor"])
		if cursor == "" {
			return models, nil
		}
		if seen[cursor] {
			return nil, errors.New("runtime repeated a model catalog cursor")
		}
		seen[cursor] = true
		params["cursor"] = cursor
	}
}

// App-server refreshes a cache shared with other Codex clients after startup.
// Wait briefly for that refresh so another client's stale list is not cached.
func waitForCodexCatalog(ctx context.Context, home, version string, started time.Time) bool {
	deadline := time.NewTimer(3 * time.Second)
	defer deadline.Stop()
	tick := time.NewTicker(100 * time.Millisecond)
	defer tick.Stop()
	for {
		data, err := os.ReadFile(filepath.Join(home, "models_cache.json"))
		var stamp struct {
			FetchedAt     time.Time `json:"fetched_at"`
			ClientVersion string    `json:"client_version"`
		}
		if err == nil && json.Unmarshal(data, &stamp) == nil && !stamp.FetchedAt.Before(started) &&
			(version == "" || stamp.ClientVersion == "" || stamp.ClientVersion == version) {
			return true
		}
		select {
		case <-ctx.Done():
			return false
		case <-deadline.C:
			return false
		case <-tick.C:
		}
	}
}
