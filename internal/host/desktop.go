package host

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"sync"
	"time"

	"lever/internal/httpapi"
	"lever/internal/store"
)

const (
	DesktopServerFlag     = "serve-desktop"
	desktopStartupTimeout = 45 * time.Second
)

type desktopStartup struct {
	Error string `json:"error,omitempty"`
}

type desktopPairing struct {
	URL     string `json:"url"`
	PairURL string `json:"pairUrl"`
}

// ServeDesktop runs the local backend independently of the desktop process.
// ready reports startup to the launcher. Pairing stays on the private IPC server.
func ServeDesktop(ctx context.Context, dir, address, devOrigin string, ready io.Writer) error {
	ready, closeReady := detachReadyWriter(ready)
	defer closeReady()
	ctx, stop := context.WithCancel(ctx)
	defer stop()
	control := &desktopControl{ctx: ctx, stop: stop, address: address, attachBy: time.Now().Add(desktopStartupTimeout)}
	startup, cancelStartup := context.WithTimeout(ctx, desktopStartupTimeout)
	defer cancelStartup()
	var server *httpapi.Server
	var err error
	for {
		server, err = start(dir, address, devOrigin, control)
		if !errors.Is(err, store.ErrInUse) || waitForDesktopStartup(startup) != nil {
			break
		}
	}
	result := desktopStartup{}
	if err != nil {
		result.Error = err.Error()
	}
	_ = json.NewEncoder(ready).Encode(result)
	closeReady()
	if err != nil {
		return err
	}

	ticker := time.NewTicker(500 * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return Stop(server)
		case <-ticker.C:
			control.stopIfIdle()
		}
	}
}

type desktopControl struct {
	resident bool
	ctx      context.Context
	stop     context.CancelFunc
	address  string
	server   *httpapi.Server

	mu       sync.Mutex
	clients  int
	attachBy time.Time
}

func (c *desktopControl) attach(w http.ResponseWriter, r *http.Request) {
	c.mu.Lock()
	if c.ctx.Err() != nil {
		c.mu.Unlock()
		http.Error(w, "Lever is shutting down", http.StatusServiceUnavailable)
		return
	}
	if r.URL.Path == "/desktop/restart" {
		defer c.mu.Unlock()
		if c.resident || c.clients != 0 || !c.server.App.BeginDesktopRestart() {
			http.Error(w, "Desktop is still attached or a run is preparing", http.StatusConflict)
			return
		}
		w.WriteHeader(http.StatusNoContent)
		c.stop()
		return
	}
	query := r.URL.Query()
	if address := query.Get("address"); !c.resident && address != c.address && "http://"+address != c.server.URL {
		c.mu.Unlock()
		http.Error(w, "Lever is already listening at "+c.server.URL+" for this data directory", http.StatusConflict)
		return
	}
	if err := c.server.SetDevOrigin(query.Get("devOrigin")); err != nil {
		c.mu.Unlock()
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	c.clients++
	c.attachBy = time.Time{}
	c.mu.Unlock()
	defer func() {
		c.mu.Lock()
		defer c.mu.Unlock()
		c.clients--
		c.stopIfIdleLocked()
	}()

	// Keep the request open so a quit or crash releases the desktop attachment.
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(desktopPairing{URL: c.server.URL, PairURL: c.server.PairURL()}); err != nil {
		return
	}
	if err := http.NewResponseController(w).Flush(); err != nil {
		return
	}
	select {
	case <-r.Context().Done():
	case <-c.ctx.Done():
	}
}

func (c *desktopControl) stopIfIdle() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.stopIfIdleLocked()
}

func (c *desktopControl) stopIfIdleLocked() {
	if !c.resident && c.clients == 0 && !time.Now().Before(c.attachBy) && (c.server.Remote == nil || !c.server.Remote.Paired()) && c.server.App.BeginIdleShutdown() {
		c.stop()
	}
}

func waitForDesktopStartup(ctx context.Context) error {
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-time.After(100 * time.Millisecond):
		return nil
	}
}
