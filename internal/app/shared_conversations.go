package app

import (
	"context"
	"errors"
	"net/http"
	"os"
	"slices"
	"strings"
	"time"

	"lever/internal/model"
	"lever/internal/provider"
	"lever/internal/store"
)

const sharedHistoryLimit = 1200

func sharedRuntimeKey(config model.Provider) [2]string {
	return [2]string{config.Type, provider.SharedStore(config)}
}

func (a *App) sharedProviders(ctx context.Context) ([]model.Provider, error) {
	return store.List[model.Provider](ctx, a.Store.DB, `SELECT data FROM providers
		WHERE json_extract(data,'$.type') IN ('codex','claude') ORDER BY rowid`)
}

// Lever-owned sessions have a separate execution lifecycle. The shared view
// opens native-owned conversations and never sends to a Lever-owned session.
func (a *App) managedNativeIDs(ctx context.Context, configs []model.Provider) (map[[2]string]map[string]bool, error) {
	sources := make(map[string][2]string, len(configs))
	for _, config := range configs {
		sources[config.ID] = sharedRuntimeKey(config)
	}
	rows, err := a.Store.DB.QueryContext(ctx, `SELECT json_extract(data,'$.selection.provider'),
		json_extract(data,'$.nativeId') FROM sessions WHERE json_extract(data,'$.nativeId') <> ''`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	managed := map[[2]string]map[string]bool{}
	for rows.Next() {
		var id, providerID string
		if err := rows.Scan(&providerID, &id); err != nil {
			return nil, err
		}
		if runtime, ok := sources[providerID]; ok {
			if managed[runtime] == nil {
				managed[runtime] = map[string]bool{}
			}
			managed[runtime][id] = true
		}
	}
	return managed, rows.Err()
}

func (a *App) SharedConversations(ctx context.Context) (model.SharedConversations, error) {
	list := model.SharedConversations{Conversations: []model.SharedConversation{}, Unavailable: []string{}}
	configs, err := a.sharedProviders(ctx)
	if err != nil {
		return list, err
	}
	managed, err := a.managedNativeIDs(ctx, configs)
	if err != nil {
		return list, err
	}
	seen := map[[2]string]bool{}
	for _, config := range configs {
		config, available, err := runtimeProvider(ctx, a.Store.DB, config)
		if err != nil {
			return list, err
		}
		key := sharedRuntimeKey(config)
		if !available || key[1] == "" || seen[key] {
			continue
		}
		seen[key] = true
		items, err := provider.ListShared(ctx, config, managed[key])
		if err != nil {
			list.Unavailable = append(list.Unavailable, config.Name)
			continue
		}
		list.Conversations = append(list.Conversations, items...)
	}
	slices.SortFunc(list.Conversations, func(a, b model.SharedConversation) int {
		return strings.Compare(b.UpdatedAt, a.UpdatedAt)
	})
	return list, ctx.Err()
}

func (a *App) sharedProvider(ctx context.Context, providerID string) (model.Provider, map[string]bool, error) {
	config, err := configuredProvider(ctx, a.Store.DB, providerID)
	if err != nil {
		return config, nil, err
	}
	key := sharedRuntimeKey(config)
	if key[1] == "" {
		return config, nil, os.ErrNotExist
	}
	configs, err := a.sharedProviders(ctx)
	if err != nil {
		return config, nil, err
	}
	managed, err := a.managedNativeIDs(ctx, configs)
	return config, managed[key], err
}

func (a *App) SharedHistory(ctx context.Context, providerID, id string, limit int) (model.SharedHistory, error) {
	config, managed, err := a.sharedProvider(ctx, providerID)
	if err != nil {
		return model.SharedHistory{}, err
	}
	return provider.ReadShared(ctx, config, id, min(max(limit, 100), sharedHistoryLimit), managed)
}

func (a *App) SharedImage(ctx context.Context, providerID, id, imageID string) ([]byte, string, error) {
	config, managed, err := a.sharedProvider(ctx, providerID)
	if err != nil {
		return nil, "", err
	}
	return provider.ReadSharedImage(ctx, config, id, imageID, managed)
}

func (a *App) SharedDetail(ctx context.Context, providerID, id, messageID string) (string, error) {
	config, managed, err := a.sharedProvider(ctx, providerID)
	if err != nil {
		return "", err
	}
	return provider.ReadSharedDetail(ctx, config, id, messageID, managed)
}

func (a *App) SendSharedMessage(ctx context.Context, providerID, id, text string) error {
	text = strings.TrimSpace(text)
	if text == "" || len(text) > 128<<10 {
		return invalid("Enter a message of up to 128 KiB")
	}
	config, managed, err := a.sharedProvider(ctx, providerID)
	if err != nil {
		return err
	}
	runtime := sharedRuntimeKey(config)
	key := [3]string{runtime[0], runtime[1], id}
	if _, sending := a.sharedSending.LoadOrStore(key, true); sending {
		return conflict(provider.ErrSharedBusy.Error())
	}
	defer a.sharedSending.Delete(key)
	if err := ctx.Err(); err != nil {
		return err
	}
	// Finish settling an accepted send even if the user reloads the tab.
	ctx, cancel := context.WithTimeout(a.ctx, 50*time.Second)
	defer cancel()
	err = provider.SendShared(ctx, config, id, ID(), text, managed)
	switch {
	case errors.Is(err, provider.ErrSharedBusy):
		return conflict(err.Error())
	case errors.Is(err, provider.ErrSharedUnavailable):
		return &Error{http.StatusServiceUnavailable, err.Error()}
	case errors.Is(err, provider.ErrSharedUnconfirmed):
		return &Error{http.StatusBadGateway, err.Error()}
	default:
		return err
	}
}
