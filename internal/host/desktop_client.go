package host

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/gofrs/flock"
	"lever/internal/device"
	"lever/internal/localipc"
)

type Desktop struct {
	URL     string
	PairURL string
	client  *http.Client
	lease   io.Closer
}

var errDesktopStopping = errors.New("Lever is shutting down")

// ConnectDesktop normally reattaches to the running backend. An explicit
// restart requires a successful startup from this executable before attaching.
func ConnectDesktop(dir, address, devOrigin string, fresh bool) (*Desktop, error) {
	dir, err := filepath.Abs(dir)
	if err != nil {
		return nil, err
	}
	if err := os.MkdirAll(dir, 0700); err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), desktopStartupTimeout)
	defer cancel()
	startupLock := flock.New(filepath.Join(dir, "desktop-start.lock"))
	locked, err := startupLock.TryLockContext(ctx, 100*time.Millisecond)
	if err != nil {
		return nil, err
	}
	if !locked {
		return nil, errors.New("another desktop is starting the Lever backend")
	}
	defer startupLock.Unlock()

	client := &http.Client{
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
		Transport: &http.Transport{
			ResponseHeaderTimeout: 3 * time.Second,
			DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
				ctx, cancel := context.WithTimeout(ctx, 3*time.Second)
				defer cancel()
				return localipc.Dial(ctx, dir)
			},
		},
	}
	query := url.Values{"address": {address}, "devOrigin": {devOrigin}}
	for !fresh {
		desktop, err := attachDesktop(client, query)
		if err == nil {
			return desktop, nil
		}
		if !errors.Is(err, errDesktopStopping) && !errors.Is(err, io.EOF) && !errors.Is(err, syscall.ECONNRESET) {
			if !errors.Is(err, os.ErrNotExist) && !errors.Is(err, syscall.ECONNREFUSED) {
				return nil, err
			}
			break
		}
		if err := waitForDesktopStartup(ctx); err != nil {
			return nil, err
		}
	}
	var previous *http.Client
	if fresh {
		previous = client
	}
	if err := launchDesktopServer(ctx, dir, address, devOrigin, previous); err != nil {
		return nil, err
	}
	return attachDesktop(client, query)
}

// Older backends release their lock after the last idle window closes.
func releaseDesktopBackend(ctx context.Context, client *http.Client) error {
	for {
		req, err := http.NewRequestWithContext(ctx, http.MethodPost, "http://lever/desktop/restart", nil)
		if err != nil {
			return err
		}
		res, err := client.Do(req)
		if err != nil {
			if errors.Is(err, os.ErrNotExist) || errors.Is(err, syscall.ECONNREFUSED) || errors.Is(err, syscall.ECONNRESET) || errors.Is(err, io.EOF) {
				return nil
			}
			return err
		}
		res.Body.Close()
		switch res.StatusCode {
		case http.StatusNoContent, http.StatusServiceUnavailable, http.StatusNotFound:
			return nil
		case http.StatusConflict:
			if err = waitForDesktopStartup(ctx); err != nil {
				return err
			}
		default:
			return fmt.Errorf("release desktop backend: %s", res.Status)
		}
	}
}

func attachDesktop(client *http.Client, query url.Values) (*Desktop, error) {
	res, err := client.Post("http://lever/desktop/attach?"+query.Encode(), "", nil)
	if err != nil {
		return nil, err
	}
	if res.StatusCode != http.StatusOK {
		defer res.Body.Close()
		if res.StatusCode == http.StatusServiceUnavailable {
			return nil, errDesktopStopping
		}
		if res.StatusCode == http.StatusNotFound {
			return nil, errors.New("the data directory is already in use by another Lever backend")
		}
		return nil, desktopResponseError(res)
	}
	var pairing desktopPairing
	if err := json.NewDecoder(res.Body).Decode(&pairing); err != nil {
		_ = res.Body.Close()
		return nil, err
	}
	return &Desktop{URL: pairing.URL, PairURL: pairing.PairURL, client: client, lease: res.Body}, nil
}

func (d *Desktop) Close() {
	_ = d.lease.Close()
	d.client.CloseIdleConnections()
}

func desktopResponseError(res *http.Response) error {
	detail, _ := io.ReadAll(io.LimitReader(res.Body, 4096))
	return fmt.Errorf("Lever backend: %s: %s", res.Status, strings.TrimSpace(string(detail)))
}

func launchDesktopServer(ctx context.Context, dir, address, devOrigin string, previous *http.Client) error {
	executable, err := os.Executable()
	if err != nil {
		return err
	}
	logPath := filepath.Join(dir, "backend.log")
	logFile, err := os.OpenFile(logPath, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600)
	if err != nil {
		return err
	}
	defer logFile.Close()
	read, write, err := os.Pipe()
	if err != nil {
		return err
	}
	defer read.Close()
	defer write.Close()
	cmd := exec.Command(executable, "--"+DesktopServerFlag, "--data-dir", dir, "--listen", address, "--dev-origin", devOrigin)
	cmd.Stdout, cmd.Stderr = write, logFile
	device.Detach(cmd)
	if previous != nil {
		if err := releaseDesktopBackend(ctx, previous); err != nil {
			return err
		}
	}
	if err := cmd.Start(); err != nil {
		return err
	}
	_ = write.Close()
	go func() { _ = cmd.Wait() }()

	ready := make(chan error, 1)
	go func() {
		var result desktopStartup
		err := json.NewDecoder(read).Decode(&result)
		if err == nil && result.Error != "" {
			err = errors.New(result.Error)
		}
		ready <- err
	}()
	select {
	case err := <-ready:
		if err != nil {
			return fmt.Errorf("start Lever backend (see %s): %w", logPath, err)
		}
		return nil
	case <-ctx.Done():
		return fmt.Errorf("waiting for Lever backend (see %s): %w", logPath, ctx.Err())
	}
}
