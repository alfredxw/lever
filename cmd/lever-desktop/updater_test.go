package main

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"
)

func newTestUpdates(t *testing.T) (*Updates, chan UpdateState) {
	t.Helper()
	events := make(chan UpdateState, 32)
	u := newUpdates(t.TempDir(), nil)
	u.enabledFn = func() bool { return true }
	u.isDevFn = func() bool { return false }
	u.isPackagedFn = func() bool { return true }
	u.versionFn = func() string { return "0.2.0" }
	u.setPrereleasesFn = func(bool) {}
	u.busyFn = func(string) (bool, error) { return false, nil }
	u.relaunchFn = func() {}
	u.emitStateFn = func(s UpdateState) {
		select {
		case events <- s:
		default:
		}
	}
	u.emitOpenFn = func() {}
	u.nowFn = func() time.Time { return time.Date(2026, 11, 27, 12, 0, 0, 0, time.UTC) }
	u.firstCheckWait = time.Hour
	t.Cleanup(u.stop)
	return u, events
}

func waitForStatus(t *testing.T, ch <-chan UpdateState, want string) UpdateState {
	t.Helper()
	deadline := time.After(3 * time.Second)
	for {
		select {
		case state := <-ch:
			if state.Status == want {
				return state
			}
		case <-deadline:
			t.Fatalf("timed out waiting for status %q", want)
		}
	}
}

func TestUpdatesDisabledReasons(t *testing.T) {
	u, _ := newTestUpdates(t)
	u.enabledFn = func() bool { return false }
	u.isDevFn = func() bool { return true }
	u.versionFn = func() string { return "" }
	s := u.State()
	if s.Supported || s.DisabledReason != "dev" || s.CurrentVersion != "dev" {
		t.Fatalf("unexpected dev state: %+v", s)
	}

	u.isDevFn = func() bool { return false }
	u.isPackagedFn = func() bool { return true }
	u.versionFn = func() string { return "0.2.0" }
	s = u.State()
	if s.Supported || s.DisabledReason != "unwritable" || s.CurrentVersion != "0.2.0" {
		t.Fatalf("unexpected unwritable state: %+v", s)
	}
}

func TestUpdatesPreferencesPersistenceAndPrereleases(t *testing.T) {
	dir := t.TempDir()
	var prereleaseCalls []bool

	u1 := newUpdates(dir, nil)
	u1.enabledFn = func() bool { return true }
	u1.isDevFn = func() bool { return false }
	u1.isPackagedFn = func() bool { return true }
	u1.versionFn = func() string { return "0.2.0" }
	u1.setPrereleasesFn = func(v bool) { prereleaseCalls = append(prereleaseCalls, v) }
	u1.emitStateFn = func(UpdateState) {}
	t.Cleanup(u1.stop)

	next, err := u1.SetPreferences(UpdatePreferences{
		AutomaticChecks:    false,
		AutomaticDownloads: true,
		Prereleases:        true,
	})
	if err != nil {
		t.Fatalf("SetPreferences: %v", err)
	}
	if next.AutomaticChecks || !next.AutomaticDownloads || !next.Prereleases {
		t.Fatalf("unexpected saved prefs: %+v", next)
	}
	if len(prereleaseCalls) != 1 || !prereleaseCalls[0] {
		t.Fatalf("expected SetPrereleases(true), got %v", prereleaseCalls)
	}

	u2 := newUpdates(dir, nil)
	u2.enabledFn = func() bool { return true }
	u2.isDevFn = func() bool { return false }
	u2.isPackagedFn = func() bool { return true }
	u2.versionFn = func() string { return "0.2.0" }
	u2.setPrereleasesFn = func(v bool) { prereleaseCalls = append(prereleaseCalls, v) }
	u2.emitStateFn = func(UpdateState) {}
	t.Cleanup(u2.stop)

	loaded := u2.State()
	if loaded.AutomaticChecks || !loaded.AutomaticDownloads || !loaded.Prereleases {
		t.Fatalf("reloaded prefs mismatch: %+v", loaded)
	}
}

func TestUpdatesManualCheckDownloadAndRestart(t *testing.T) {
	u, events := newTestUpdates(t)
	published := time.Date(2026, 11, 26, 10, 0, 0, 0, time.UTC)
	u.checkFn = func(context.Context) (*availableUpdate, error) {
		return &availableUpdate{
			version:     "0.3.0",
			notes:       "### 新增\n- 自动更新",
			publishedAt: published,
			install: func(_ context.Context, progress func(downloaded, total int64)) error {
				progress(50, 100)
				progress(100, 100)
				return nil
			},
		}, nil
	}

	initial := u.Check()
	if initial.Status != "checking" {
		t.Fatalf("immediate status = %q, want checking", initial.Status)
	}
	avail := waitForStatus(t, events, "available")
	if avail.Version != "0.3.0" || avail.Notes == "" || avail.PublishedAt == "" {
		t.Fatalf("unexpected available state: %+v", avail)
	}

	if err := u.Download(); err != nil {
		t.Fatalf("Download: %v", err)
	}
	ready := waitForStatus(t, events, "ready")
	if ready.Version != "0.3.0" || ready.Downloaded != 100 || ready.Total != 100 {
		t.Fatalf("unexpected ready state: %+v", ready)
	}

	// Busy backend blocks restart without relaunching.
	relaunched := false
	u.relaunchFn = func() { relaunched = true }
	u.busyFn = func(string) (bool, error) { return true, nil }
	if err := u.RestartToUpdate(); !errors.Is(err, ErrDesktopRestartBusy) {
		t.Fatalf("RestartToUpdate busy err = %v, want ErrDesktopRestartBusy", err)
	}
	if relaunched {
		t.Fatal("must not relaunch while backend is busy")
	}

	// Idle/hosted backend permits relaunch.
	u.busyFn = func(string) (bool, error) { return false, nil }
	if err := u.RestartToUpdate(); err != nil {
		t.Fatalf("RestartToUpdate idle err: %v", err)
	}
	if !relaunched {
		t.Fatal("expected relaunchFn to be invoked")
	}
}

func TestUpdatesSkipAndBackgroundAutoDownload(t *testing.T) {
	u, events := newTestUpdates(t)
	release := &availableUpdate{
		version: "0.3.0",
		notes:   "release notes",
		install: func(_ context.Context, progress func(downloaded, total int64)) error {
			progress(10, 10)
			return nil
		},
	}
	u.checkFn = func(context.Context) (*availableUpdate, error) {
		return release, nil
	}

	u.Check()
	waitForStatus(t, events, "available")

	skipped := u.SkipVersion("0.3.0")
	if skipped.Status != "idle" || skipped.SkippedVersion != "0.3.0" {
		t.Fatalf("unexpected skipped state: %+v", skipped)
	}

	// Background check ignores the skipped version.
	u.startCheck(false)
	idle := waitForStatus(t, events, "idle")
	if idle.Version != "" {
		t.Fatalf("background check resurfaced skipped version: %+v", idle)
	}

	// Manual check still offers the skipped version.
	u.Check()
	avail := waitForStatus(t, events, "available")
	if avail.Version != "0.3.0" {
		t.Fatalf("manual check did not show skipped version: %+v", avail)
	}

	// Background check with AutomaticDownloads stages a newer version automatically.
	release = &availableUpdate{
		version: "0.4.0",
		notes:   "auto download",
		install: func(_ context.Context, progress func(downloaded, total int64)) error {
			progress(20, 20)
			return nil
		},
	}
	if _, err := u.SetPreferences(UpdatePreferences{
		AutomaticChecks:    true,
		AutomaticDownloads: true,
	}); err != nil {
		t.Fatalf("SetPreferences: %v", err)
	}
	u.startCheck(false)
	ready := waitForStatus(t, events, "ready")
	if ready.Version != "0.4.0" {
		t.Fatalf("expected auto-downloaded version 0.4.0, got %+v", ready)
	}
}

func TestUpdatesCancelDownloadRestoresAvailable(t *testing.T) {
	u, events := newTestUpdates(t)
	started := make(chan struct{})
	u.checkFn = func(context.Context) (*availableUpdate, error) {
		return &availableUpdate{
			version: "0.3.0",
			install: func(ctx context.Context, _ func(downloaded, total int64)) error {
				close(started)
				<-ctx.Done()
				return ctx.Err()
			},
		}, nil
	}

	u.Check()
	waitForStatus(t, events, "available")
	if err := u.Download(); err != nil {
		t.Fatalf("Download: %v", err)
	}
	<-started
	canceled := u.CancelDownload()
	if canceled.Status != "available" || canceled.Version != "0.3.0" {
		t.Fatalf("unexpected canceled state: %+v", canceled)
	}
}

func TestUpdatesRequestCheckFromMenu(t *testing.T) {
	u, events := newTestUpdates(t)
	var mu sync.Mutex
	opened := 0
	u.emitOpenFn = func() {
		mu.Lock()
		opened++
		mu.Unlock()
	}
	u.checkFn = func(context.Context) (*availableUpdate, error) {
		return nil, nil
	}

	u.requestCheckFromMenu()
	waitForStatus(t, events, "up-to-date")

	mu.Lock()
	gotOpened := opened
	mu.Unlock()
	if gotOpened != 1 {
		t.Fatalf("emitOpenFn called %d times, want 1", gotOpened)
	}
	if !u.TakeOpenRequest() {
		t.Fatal("expected TakeOpenRequest() to return true once")
	}
	if u.TakeOpenRequest() {
		t.Fatal("expected second TakeOpenRequest() to return false")
	}
}
