// Package runhost keeps a native provider and its stdio in a per-turn process.
// SQLite is its durable mailbox. Only the backend projects events into Lever runs.
package runhost

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/gofrs/flock"
	"github.com/google/uuid"
	"lever/internal/device"
	"lever/internal/model"
	"lever/internal/provider"
	"lever/internal/store"
	"lever/internal/workspace"
)

const Flag = "--provider-worker"
const Poll = 100 * time.Millisecond

// Input includes the before-checkpoints needed to capture turn-scoped diffs
// even if the backend is offline when the provider finishes.
type Input struct {
	provider.Input
	Changes []model.RunChanges
}

type Outcome struct {
	Message               string
	Unconfirmed, Rejected bool
}

func Result(err error) Outcome {
	if err == nil {
		return Outcome{}
	}
	return Outcome{err.Error(), errors.Is(err, provider.ErrUnconfirmed), errors.Is(err, provider.ErrSteerRejected)}
}
func (o Outcome) Err() error {
	if o.Message == "" {
		return nil
	}
	if o.Unconfirmed {
		return wrapOutcomeError(provider.ErrUnconfirmed, o.Message)
	}
	if o.Rejected {
		return wrapOutcomeError(provider.ErrSteerRejected, o.Message)
	}
	return errors.New(o.Message)
}

func wrapOutcomeError(sentinel error, message string) error {
	prefix := sentinel.Error()
	switch {
	case message == "" || message == prefix:
		return sentinel
	case strings.HasPrefix(message, prefix+"\n"):
		return errors.Join(sentinel, errors.New(strings.TrimPrefix(message, prefix+"\n")))
	case strings.HasPrefix(message, prefix+": "):
		return fmt.Errorf("%w: %s", sentinel, strings.TrimPrefix(message, prefix+": "))
	default:
		return fmt.Errorf("%w: %s", sentinel, message)
	}
}

func LockPath(dir, id string) string { return filepath.Join(dir, "runtime-hosts", id+".lock") }

// Ensure may race another launcher. Only the lock holder can claim 'ready'.
// Losing a worker after that claim can never cause the input to be resubmitted.
func Ensure(ctx context.Context, db *sql.DB, dir, id, phase string) error {
	if err := os.MkdirAll(filepath.Join(dir, "runtime-hosts"), 0700); err != nil {
		return err
	}
	lock := flock.New(LockPath(dir, id))
	ok, err := lock.TryLock()
	if err != nil || !ok {
		return err
	}
	defer lock.Unlock()
	if phase == "running" {
		_, err = db.ExecContext(ctx, "UPDATE runtime_hosts SET phase='unknown', error=?, finished_at=? WHERE run_id=? AND phase='running'", provider.ErrUnconfirmed.Error(), time.Now().UTC().Format(time.RFC3339Nano), id)
		return err
	}
	if phase != "ready" {
		return nil
	}
	exe, err := os.Executable()
	if err == nil {
		cmd := exec.Command(exe, Flag, dir, id)
		device.Detach(cmd)
		if err = cmd.Start(); err == nil {
			go func() { _ = cmd.Wait() }()
			return nil
		}
	}
	_, saveErr := db.ExecContext(ctx, "UPDATE runtime_hosts SET phase='failed', error=?, finished_at=? WHERE run_id=? AND phase='ready'", err.Error(), time.Now().UTC().Format(time.RFC3339Nano), id)
	return saveErr
}

func Main() bool {
	if len(os.Args) < 2 || os.Args[1] != Flag {
		return false
	}
	if len(os.Args) != 4 {
		fmt.Fprintln(os.Stderr, "expected data directory and run ID")
		os.Exit(2)
	}
	if err := Serve(os.Args[2], os.Args[3]); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	return true
}

func Serve(dir, id string) error {
	if _, err := uuid.Parse(id); err != nil {
		return err
	}
	lock := flock.New(LockPath(dir, id))
	// A launching backend briefly holds this lock; a duplicate worker exits once
	// it sees the committed claim or completion.
	ctx, cancelLock := context.WithTimeout(context.Background(), 2*time.Second)
	locked, err := lock.TryLockContext(ctx, 20*time.Millisecond)
	cancelLock()
	if err != nil || !locked {
		return err
	}
	defer lock.Unlock()
	db, err := store.OpenConnection(dir)
	if err != nil {
		return err
	}
	defer db.Close()
	var raw string
	err = db.QueryRow("UPDATE runtime_hosts SET phase='running' WHERE run_id=? AND phase='ready' RETURNING input", id).Scan(&raw)
	if errors.Is(err, sql.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	var in Input
	err = json.Unmarshal([]byte(raw), &in)
	if err == nil {
		err = drive(db, dir, in.Input)
	}
	finished := time.Now().UTC().Format(time.RFC3339Nano)
	phase, detail := "completed", ""
	if err != nil {
		detail = err.Error()
		switch {
		case errors.Is(err, context.Canceled):
			phase = "interrupted"
		case errors.Is(err, provider.ErrPaused):
			phase, detail = "paused", ""
		case errors.Is(err, provider.ErrUnconfirmed):
			phase = "unknown"
		default:
			phase = "failed"
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	workspace.FinishRunChanges(ctx, id, in.Changes)
	tx, err := db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if len(in.Changes) > 0 {
		if _, err = tx.Exec("INSERT INTO runtime_events(run_id,kind,data) VALUES(?,'changes',?)", id, store.JSON(in.Changes)); err != nil {
			return err
		}
	}
	if _, err = tx.Exec("UPDATE runtime_hosts SET phase=?,error=?,finished_at=? WHERE run_id=?", phase, detail, finished, id); err != nil {
		return err
	}
	return tx.Commit()
}

type worker struct {
	db         *sql.DB
	id         string
	ctx        context.Context
	cancel     context.CancelCauseFunc
	steers     chan struct{}
	mu         sync.Mutex
	runtime    model.SessionRuntime
	items      []model.Item
	positions  map[string]int
	permission func(context.Context, string) error
}

func drive(db *sql.DB, dir string, in provider.Input) error {
	signalCtx, stopSignals := signal.NotifyContext(provider.WithStateDir(context.Background(), dir), os.Interrupt, syscall.SIGTERM)
	defer stopSignals()
	ctx, cancel := context.WithCancelCause(signalCtx)
	defer cancel(nil)
	w := &worker{db: db, id: in.RunID, ctx: ctx, cancel: cancel, steers: make(chan struct{}, 1), positions: make(map[string]int)}
	if in.Session.Runtime != nil {
		w.runtime = *in.Session.Runtime
	}
	in.Steers = w.steers
	relay, err := mcpRelay(dir, in.MCPToken)
	if err != nil {
		return err
	}
	defer relay.Close()
	in.MCPURL = "http://" + relay.Addr + "/mcp"
	// Check a stop recorded before the new process was scheduled.
	if err = w.controls(); err != nil {
		return err
	}
	if ctx.Err() != nil {
		return ctx.Err()
	}
	done := make(chan error, 1)
	go func() {
		ticker := time.NewTicker(Poll)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				done <- nil
				return
			case <-ticker.C:
				if err := w.flush(); err != nil {
					cancel(nil)
					done <- err
					return
				}
				if err := w.controls(); err != nil {
					cancel(nil)
					done <- err
					return
				}
			}
		}
	}()
	err = provider.Run(ctx, in, w)
	stopped := ctx.Err() != nil && !errors.Is(context.Cause(ctx), provider.ErrPauseRequested)
	cancel(nil)
	pollErr := <-done
	if flushErr := w.flush(); flushErr != nil {
		return errors.Join(provider.ErrUnconfirmed, flushErr)
	}
	if pollErr != nil {
		return errors.Join(provider.ErrUnconfirmed, pollErr)
	}
	if stopped {
		return context.Canceled
	}
	return err
}

func (w *worker) flush() error {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.flushLocked()
}
func (w *worker) flushLocked() error {
	if len(w.items) == 0 {
		return nil
	}
	tx, err := w.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	for _, item := range w.items {
		if _, err = tx.Exec(`INSERT INTO runtime_events(run_id,kind,item_id,data) VALUES(?,'item',?,?)
   ON CONFLICT(run_id,item_id) DO UPDATE SET data=excluded.data`, w.id, item.ID, store.JSON(item)); err != nil {
			return err
		}
	}
	if err = tx.Commit(); err == nil {
		clear(w.positions)
		w.items = nil
	}
	return err
}
func (w *worker) emit(kind string, value any) error {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.emitLocked(kind, value)
}
func (w *worker) emitLocked(kind string, value any) error {
	if err := w.flushLocked(); err != nil {
		return err
	}
	_, err := w.db.Exec("INSERT INTO runtime_events(run_id,kind,data) VALUES(?,?,?)", w.id, kind, store.JSON(value))
	return err
}
func (w *worker) Bind(id string) error        { return w.emit("bind", id) }
func (w *worker) BindTurn(id string) error    { return w.emit("turn", id) }
func (w *worker) TurnDiff(patch string) error { return w.emit("patch", patch) }
func (w *worker) Item(item model.Item) error {
	w.mu.Lock()
	defer w.mu.Unlock()
	if i, ok := w.positions[item.ID]; ok {
		w.items[i] = item
	} else {
		w.positions[item.ID] = len(w.items)
		w.items = append(w.items, item)
	}
	return nil
}
func (w *worker) UpdateRuntime(update func(*model.SessionRuntime)) error {
	w.mu.Lock()
	defer w.mu.Unlock()
	update(&w.runtime)
	return w.emitLocked("runtime", w.runtime)
}
func (w *worker) Ask(ctx context.Context, r model.Request) (model.Answer, error) {
	r.ID = uuid.NewString()
	if err := w.emit("ask", r); err != nil {
		return model.Answer{}, err
	}
	defer w.emit("closeRequest", r.ID)
	ticker := time.NewTicker(Poll)
	defer ticker.Stop()
	for {
		answer, err := store.Get[model.Answer](ctx, w.db, "SELECT json_extract(data,'$.answer') FROM requests WHERE id=? AND status='answered'", r.ID)
		if !errors.Is(err, sql.ErrNoRows) {
			return answer, err
		}
		select {
		case <-ctx.Done():
			return model.Answer{}, ctx.Err()
		case <-w.ctx.Done():
			return model.Answer{}, w.ctx.Err()
		case <-ticker.C:
		}
	}
}
func (w *worker) EnablePermissionChanges(set func(context.Context, string) error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.permission = set
	if err := w.emitLocked("mutable", true); err != nil {
		w.cancel(nil)
	}
}
func (w *worker) controls() error {
	var stop, pause, steers bool
	if err := w.db.QueryRow(`SELECT h.stop, COALESCE(r.data->>'pauseRequested',0),
  EXISTS(SELECT 1 FROM runtime_commands WHERE run_id=h.run_id AND kind='steer' AND taken=0)
  FROM runtime_hosts h JOIN runs r ON r.id=h.run_id WHERE h.run_id=?`, w.id).Scan(&stop, &pause, &steers); err != nil {
		return err
	}
	if stop {
		if pause {
			w.cancel(provider.ErrPauseRequested)
		} else {
			w.cancel(nil)
		}
		return nil
	}
	if steers {
		select {
		case w.steers <- struct{}{}:
		default:
		}
	}
	w.mu.Lock()
	set := w.permission
	w.mu.Unlock()
	if set == nil {
		return nil
	}
	var id, permission string
	err := w.db.QueryRow("UPDATE runtime_commands SET taken=1 WHERE seq=(SELECT min(seq) FROM runtime_commands WHERE run_id=? AND kind='permission' AND taken=0) RETURNING id,data", w.id).Scan(&id, &permission)
	if errors.Is(err, sql.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(w.ctx, 10*time.Second)
	err = set(ctx, permission)
	cancel()
	_, dbErr := w.db.Exec("UPDATE runtime_commands SET result=? WHERE id=?", store.JSON(Result(err)), id)
	if errors.Is(err, provider.ErrUnconfirmed) {
		w.cancel(nil)
	}
	return dbErr
}
// Keep the runtime snapshot readable by older backends that may reattach to
// this worker. Steering is a turn-local hint added to the mailbox payload.
type RuntimeUpdate struct {
	model.SessionRuntime
	SteerState provider.SteerState `json:"steerState,omitempty"`
}

func (w *worker) SetSteerState(state provider.SteerState) error {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.emitLocked("runtime", RuntimeUpdate{SessionRuntime: w.runtime, SteerState: state})
}

func (w *worker) NextSteer() (*provider.Input, error) {
	var raw string
	err := w.db.QueryRow("UPDATE runtime_commands SET taken=1 WHERE seq=(SELECT min(seq) FROM runtime_commands WHERE run_id=? AND kind='steer' AND taken=0) RETURNING data", w.id).Scan(&raw)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var in provider.Input
	err = json.Unmarshal([]byte(raw), &in)
	return &in, err
}

type SteerResult struct {
	ID      string
	Outcome Outcome
}

func (w *worker) Steered(id string, err error) error {
	return w.emit("steered", SteerResult{id, Result(err)})
}
