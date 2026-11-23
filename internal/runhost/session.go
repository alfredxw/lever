package runhost

import (
	"context"
	"database/sql"
	"errors"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/gofrs/flock"
	"github.com/google/uuid"
	"lever/internal/device"
	"lever/internal/provider"
	"lever/internal/store"
)

const SessionFlag = "--provider-session-worker"

func SessionLockPath(dir, sessionID string) string {
	return filepath.Join(dir, "runtime-hosts", "session-"+sessionID+".lock")
}

func backendLockPath(dir string) string {
	return filepath.Join(dir, "runtime-hosts", "backend.lock")
}

func idleEpochPath(dir string) string {
	return filepath.Join(dir, "runtime-hosts", "idle-epoch")
}

// BackendLease holds the backend liveness lock used by idle session workers to
// detect graceful shutdown or unexpected backend death without interfering with
// active detached turns.
type BackendLease struct {
	lock *flock.Flock
}

func (l *BackendLease) Release() {
	if l != nil && l.lock != nil {
		_ = l.lock.Unlock()
	}
}

func AcquireBackendLock(dir string) (*BackendLease, error) {
	if err := os.MkdirAll(filepath.Join(dir, "runtime-hosts"), 0700); err != nil {
		return nil, err
	}
	lock := flock.New(backendLockPath(dir))
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	ok, err := lock.TryLockContext(ctx, 10*time.Millisecond)
	if err != nil {
		return nil, err
	}
	if !ok {
		return nil, errors.New("backend runtime host lock is busy")
	}
	return &BackendLease{lock: lock}, nil
}

func backendAlive(dir string) bool {
	path := backendLockPath(dir)
	if _, err := os.Stat(path); err != nil {
		return false
	}
	lock := flock.New(path)
	ok, err := lock.TryLock()
	if err != nil {
		return false
	}
	if ok {
		_ = lock.Unlock()
		return false
	}
	return true
}

func readIdleEpoch(dir string) string {
	b, err := os.ReadFile(idleEpochPath(dir))
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(b))
}

// StopIdleSessions signals idle session workers to close any warm provider
// processes and exit. Active turns continue undisturbed.
func StopIdleSessions(dir string) {
	hostsDir := filepath.Join(dir, "runtime-hosts")
	if _, err := os.Stat(hostsDir); err != nil {
		return
	}
	_ = os.WriteFile(idleEpochPath(dir), []byte(uuid.NewString()), 0600)
}

// WaitIdleSessions waits briefly for idle session workers (those without an
// active runtime_hosts row) to release their session locks after shutdown.
func WaitIdleSessions(dir string, db *sql.DB, timeout time.Duration) {
	hostsDir := filepath.Join(dir, "runtime-hosts")
	entries, err := os.ReadDir(hostsDir)
	if err != nil {
		return
	}
	active := map[string]bool{}
	if db != nil {
		if rows, err := db.Query("SELECT DISTINCT r.session_id FROM runtime_hosts h JOIN runs r ON r.id=h.run_id"); err == nil {
			for rows.Next() {
				var sid string
				if rows.Scan(&sid) == nil {
					active[sid] = true
				}
			}
			_ = rows.Close()
		}
	}
	var pending []string
	for _, entry := range entries {
		name := entry.Name()
		if sid, ok := strings.CutPrefix(name, "session-"); ok {
			if sid, ok = strings.CutSuffix(sid, ".lock"); ok && !active[sid] {
				pending = append(pending, filepath.Join(hostsDir, name))
			}
		}
	}
	if len(pending) == 0 {
		return
	}
	deadline := time.Now().Add(timeout)
	for len(pending) > 0 {
		remaining := pending[:0]
		for _, path := range pending {
			if _, err := os.Stat(path); err != nil {
				continue
			}
			lock := flock.New(path)
			ok, err := lock.TryLock()
			if err != nil {
				continue
			}
			if ok {
				_ = lock.Unlock()
				continue
			}
			remaining = append(remaining, path)
		}
		pending = remaining
		if len(pending) == 0 || time.Now().After(deadline) {
			return
		}
		time.Sleep(25 * time.Millisecond)
	}
}

// EnsureSession ensures a session-scoped resident worker owns turns for
// sessionID, keeping compatible native processes (e.g. Claude Code) warm across
// consecutive turns.
func EnsureSession(ctx context.Context, db *sql.DB, dir, runID, sessionID, phase string) error {
	if err := os.MkdirAll(filepath.Join(dir, "runtime-hosts"), 0700); err != nil {
		return err
	}
	// Preserve compatibility with an already-running legacy per-run worker.
	if _, err := os.Stat(LockPath(dir, runID)); err == nil {
		legacy := flock.New(LockPath(dir, runID))
		ok, err := legacy.TryLock()
		if err != nil || !ok {
			return err
		}
		_ = legacy.Unlock()
	}
	lock := flock.New(SessionLockPath(dir, sessionID))
	ok, err := lock.TryLock()
	if err != nil || !ok {
		return err
	}
	defer lock.Unlock()
	if phase == "running" {
		_, err = db.ExecContext(ctx, "UPDATE runtime_hosts SET phase='unknown', error=?, finished_at=? WHERE run_id=? AND phase='running'", provider.ErrUnconfirmed.Error(), time.Now().UTC().Format(time.RFC3339Nano), runID)
		return err
	}
	if phase != "ready" {
		return nil
	}
	exe, err := os.Executable()
	if err == nil {
		cmd := exec.Command(exe, SessionFlag, dir, sessionID)
		device.Detach(cmd)
		if err = cmd.Start(); err == nil {
			go func() { _ = cmd.Wait() }()
			return nil
		}
	}
	_, saveErr := db.ExecContext(ctx, "UPDATE runtime_hosts SET phase='failed', error=?, finished_at=? WHERE run_id=? AND phase='ready'", err.Error(), time.Now().UTC().Format(time.RFC3339Nano), runID)
	return saveErr
}

// ServeSession runs a session-scoped provider worker that serves consecutive
// turns for sessionID while a warm resident Claude process remains parked.
func ServeSession(dir, sessionID string) error {
	if _, err := uuid.Parse(sessionID); err != nil {
		return err
	}
	lock := flock.New(SessionLockPath(dir, sessionID))
	ctx, cancelLock := context.WithTimeout(context.Background(), 2*time.Second)
	locked, err := lock.TryLockContext(ctx, 20*time.Millisecond)
	cancelLock()
	if err != nil || !locked {
		return err
	}
	defer lock.Unlock()
	defer provider.CloseClaudeSessions(dir)

	db, err := store.OpenConnection(dir)
	if err != nil {
		return err
	}
	defer db.Close()

	sigCtx, stopSignals := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stopSignals()

	watchBackend := backendAlive(dir)
	epoch := readIdleEpoch(dir)
	ranAny := false

	for {
		var runID, providerType string
		err := db.QueryRow(`SELECT h.run_id, COALESCE(json_extract(h.input,'$.Provider.type'),'')
			FROM runtime_hosts h JOIN runs r ON r.id=h.run_id
			WHERE r.session_id=? AND h.phase='ready' ORDER BY r.sequence ASC LIMIT 1`, sessionID).Scan(&runID, &providerType)
		if err == nil {
			if providerType != "claude" {
				// The session moved to another provider; let its per-run worker own it.
				return nil
			}
			ranAny = true
			epoch = readIdleEpoch(dir)
			if err := serveRun(db, dir, runID); err != nil {
				return err
			}
			continue
		}
		if !errors.Is(err, sql.ErrNoRows) {
			return err
		}
		if !ranAny || !provider.HasResidentClaude(dir, sessionID) {
			return nil
		}
		if sigCtx.Err() != nil || readIdleEpoch(dir) != epoch || (watchBackend && !backendAlive(dir)) {
			return nil
		}
		select {
		case <-sigCtx.Done():
			return nil
		case <-time.After(Poll):
		}
		if !provider.HasResidentClaude(dir, sessionID) || readIdleEpoch(dir) != epoch || (watchBackend && !backendAlive(dir)) {
			return nil
		}
	}
}
