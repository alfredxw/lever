// Package host is shared bootstrap for the web server and desktop shell.
package host

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"time"

	"lever/internal/app"
	"lever/internal/httpapi"
	"lever/web"
)

func DefaultDir() string {
	if dir := os.Getenv("LEVER_DATA_DIR"); dir != "" {
		return dir
	}
	dir, err := os.UserConfigDir()
	if err != nil {
		panic(err)
	}
	return filepath.Join(dir, "Lever")
}
func Start(dir, address, devOrigin string) (*httpapi.Server, error) {
	ctx, cancel := context.WithCancel(context.Background())
	control := &desktopControl{ctx: ctx, stop: cancel, address: address, resident: true}
	s, err := start(dir, address, devOrigin, control)
	if err != nil {
		cancel()
		return nil, err
	}
	s.OnStop = cancel
	return s, nil
}

func start(dir, address, devOrigin string, control *desktopControl) (*httpapi.Server, error) {
	a, err := app.OpenServer(dir)
	if err != nil {
		return nil, err
	}
	a.Version = DesktopVersion
	if _, err := a.ConnectLocalProviders(context.Background()); err != nil {
		slog.Warn("connect local runtimes", "error", err)
	}
	if err := a.InitStarterAgent(); err != nil {
		slog.Warn("create starter Agent", "error", err)
	}
	s, err := httpapi.New(a, address, devOrigin, web.Assets())
	if err != nil {
		a.Close()
		return nil, err
	}
	var desktop http.Handler
	if control != nil {
		control.server = s
		desktop = http.HandlerFunc(control.attach)
	}
	if err := s.StartLocalCLI(desktop); err != nil {
		if control != nil {
			return nil, errors.Join(err, Stop(s))
		}
		slog.Warn("start local CLI", "error", err)
	}
	go func() {
		if err := s.Serve(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			slog.Error("serve Lever HTTP", "error", err)
		}
	}()
	return s, nil
}
func Stop(s *httpapi.Server) error {
	// Detach running providers and drain local handlers before releasing the store.
	if s.OnStop != nil {
		s.OnStop()
	}
	s.App.Shutdown()
	cliCtx, stopCLI := context.WithTimeout(context.Background(), 2*time.Second)
	cliErr := s.CloseLocalCLI(cliCtx)
	stopCLI()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	err := s.Close(ctx)
	if err != nil {
		_ = s.HTTP.Close()
	}
	return errors.Join(cliErr, err, s.App.Store.Close())
}
