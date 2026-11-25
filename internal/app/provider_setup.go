package app

import (
	"context"
	"errors"
	"os"
	"time"

	"lever/internal/model"
	"lever/internal/provider"
	"lever/internal/store"
	"lever/internal/terminal"
)

type providerSetup struct {
	state  model.ProviderSetup
	cancel context.CancelFunc
	action string
}

func (a *App) StartProviderLogin(ctx context.Context, key terminal.Key) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.closed {
		return conflict("Application is closing")
	}
	config, err := configuredProvider(ctx, a.Store.DB, key.Provider)
	if err != nil {
		return err
	}
	cmd, err := provider.LoginCommand(provider.WithStateDir(ctx, a.Store.Dir), config)
	if err != nil {
		return invalid(err.Error())
	}
	agy := config.Type == "antigravity"
	if agy && a.agyLogin != (terminal.Key{}) {
		if a.agyLogin == key {
			return nil
		}
		return conflict("A local agy sign-in is already in progress")
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return err
	}
	started, err := a.Terminals.StartProcess(key, cmd, home, func() {
		success := cmd.ProcessState != nil && cmd.ProcessState.Success()
		if !agy && !success {
			return
		}
		a.mu.Lock()
		defer a.mu.Unlock()
		if agy {
			a.agyLogin = terminal.Key{}
		}
		if success && !a.closed {
			a.invalidateProviderCatalogsLocked(config.ID, true)
		}
	})
	if started && agy {
		a.agyLogin = key
	}
	return err
}

func (a *App) ProviderSetup(ctx context.Context, id string) (model.ProviderSetup, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	config, err := store.Get[model.Provider](ctx, a.Store.DB, "SELECT data FROM providers WHERE id=?", id)
	if err != nil {
		return model.ProviderSetup{}, err
	}
	if config.Type != "antigravity" {
		return model.ProviderSetup{}, invalid("This runtime has no managed setup")
	}
	if setup := a.setups[id]; setup != nil {
		return setup.state, nil
	}
	return model.ProviderSetup{Phase: "idle"}, nil
}

func (a *App) SetupProvider(ctx context.Context, id, action string) (model.ProviderSetup, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.closed {
		return model.ProviderSetup{}, conflict("Application is closing")
	}
	if action == "cancel" {
		if setup := a.setups[id]; setup != nil && setup.cancel != nil {
			setup.cancel()
			setup.state = model.ProviderSetup{Phase: "cancelling"}
			return setup.state, nil
		}
		return model.ProviderSetup{Phase: "idle"}, nil
	}
	config, err := configuredProvider(ctx, a.Store.DB, id)
	if err != nil {
		return model.ProviderSetup{}, err
	}
	if config.Type != "antigravity" || (action != "install" && action != "signin") {
		return model.ProviderSetup{}, invalid("Unsupported runtime setup action")
	}
	if action == "install" && config.Command != "" {
		return model.ProviderSetup{}, invalid("A custom executable must be installed by its owner")
	}
	for otherID, setup := range a.setups {
		if setup.cancel != nil && (otherID == id || (action == "install" && setup.action == "install")) {
			return model.ProviderSetup{}, conflict("Runtime setup is already in progress")
		}
	}
	phase, timeout := "signing_in", 5*time.Minute
	if action == "install" {
		phase, timeout = "installing", 10*time.Minute
	}
	work, cancel := context.WithTimeout(a.ctx, timeout)
	setup := &providerSetup{state: model.ProviderSetup{Phase: phase}, cancel: cancel, action: action}
	if a.setups == nil {
		a.setups = map[string]*providerSetup{}
	}
	a.setups[id] = setup
	a.wg.Add(1)
	go func() {
		defer a.wg.Done()
		defer cancel()
		var err error
		if action == "install" {
			err = provider.InstallAntigravity(work)
		} else {
			err = provider.SignInAntigravity(work, config, func(link string) {
				a.mu.Lock()
				defer a.mu.Unlock()
				if work.Err() == nil {
					setup.state.URL = link
				}
			})
		}
		a.mu.Lock()
		defer a.mu.Unlock()
		setup.cancel = nil
		setup.state = model.ProviderSetup{Phase: "authenticated"}
		if action == "install" {
			setup.state.Phase = "installed"
		}
		if errors.Is(work.Err(), context.Canceled) {
			setup.state.Phase = "cancelled"
		} else if work.Err() != nil {
			setup.state = model.ProviderSetup{Phase: "failed", Error: "Antigravity setup timed out. Try again."}
		} else if err != nil {
			setup.state = model.ProviderSetup{Phase: "failed", Error: err.Error()}
		} else {
			a.invalidateProviderCatalogsLocked(id, action == "signin")
		}
	}()
	return setup.state, nil
}

func (a *App) cancelProviderSetupLocked(id string) {
	if setup := a.setups[id]; setup != nil && setup.cancel != nil {
		setup.cancel()
		setup.state = model.ProviderSetup{Phase: "cancelling"}
	}
}
