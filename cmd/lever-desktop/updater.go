package main

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/egoist/mygo"
	"lever/internal/store"
)

// ErrDesktopRestartBusy is returned by RestartToUpdate when a run has not yet
// been handed off to an independent provider worker.
var ErrDesktopRestartBusy = errors.New("desktop_restart_busy")

const (
	updateStateFile     = "updater.json"
	updateFirstCheck    = 10 * time.Second
	updateCheckInterval = 24 * time.Hour
	updateRetryInterval = time.Hour
	progressEmitStep    = 100 * time.Millisecond
)

var (
	updateStateChanged   = mygo.NewEvent[UpdateState]("lever:update-state")
	openUpdatesRequested = mygo.NewEvent[struct{}]("lever:open-updates")
)

// UpdatePreferences configures how Lever Desktop checks for and installs updates.
type UpdatePreferences struct {
	AutomaticChecks    bool `json:"automaticChecks"`
	AutomaticDownloads bool `json:"automaticDownloads"`
	Prereleases        bool `json:"prereleases"`
}

// UpdateState is the snapshot pushed to the desktop workbench UI.
type UpdateState struct {
	Supported          bool   `json:"supported"`
	DisabledReason     string `json:"disabledReason,omitempty"`
	CurrentVersion     string `json:"currentVersion"`
	Status             string `json:"status"`
	Version            string `json:"version,omitempty"`
	Notes              string `json:"notes,omitempty"`
	PublishedAt        string `json:"publishedAt,omitempty"`
	Downloaded         int64  `json:"downloaded,omitempty"`
	Total              int64  `json:"total,omitempty"`
	Error              string `json:"error,omitempty"`
	LastCheckedAt      string `json:"lastCheckedAt,omitempty"`
	AutomaticChecks    bool   `json:"automaticChecks"`
	AutomaticDownloads bool   `json:"automaticDownloads"`
	Prereleases        bool   `json:"prereleases"`
	SkippedVersion     string `json:"skippedVersion,omitempty"`
}

type persistedUpdateState struct {
	AutomaticChecks    *bool     `json:"automaticChecks,omitempty"`
	AutomaticDownloads bool      `json:"automaticDownloads,omitempty"`
	Prereleases        bool      `json:"prereleases,omitempty"`
	SkippedVersion     string    `json:"skippedVersion,omitempty"`
	LastCheckedAt      time.Time `json:"lastCheckedAt,omitzero"`
}

type availableUpdate struct {
	version     string
	notes       string
	publishedAt time.Time
	install     func(ctx context.Context, progress func(downloaded, total int64)) error
}

// Updates manages signed desktop application updates via mygo.Updater.
type Updates struct {
	mu      sync.Mutex
	dataDir string

	started       bool
	loaded        bool
	launchChecked bool
	openPending   bool

	prefs          UpdatePreferences
	skippedVersion string
	lastCheckedAt  time.Time
	lastFailedAt   time.Time

	status     string
	pending    *availableUpdate
	installed  *availableUpdate
	downloaded int64
	total      int64
	errText    string

	checkInFlight bool
	checkIsUser   bool
	opID          uint64
	cancelActive  context.CancelFunc
	timer         *time.Timer

	// Dependency hooks for deterministic unit testing.
	enabledFn        func() bool
	isDevFn          func() bool
	isPackagedFn     func() bool
	versionFn        func() string
	setPrereleasesFn func(bool)
	checkFn          func(context.Context) (*availableUpdate, error)
	busyFn           func(string) (bool, error)
	relaunchFn       func()
	emitStateFn      func(UpdateState)
	emitOpenFn       func()
	nowFn            func() time.Time
	firstCheckWait   time.Duration
	checkInterval    time.Duration
	retryInterval    time.Duration
}

func newUpdates(dataDir string, browser *Browser) *Updates {
	u := &Updates{
		dataDir: dataDir,
		prefs: UpdatePreferences{
			AutomaticChecks:    true,
			AutomaticDownloads: false,
			Prereleases:        false,
		},
		status:           "idle",
		enabledFn:        mygo.Updater.Enabled,
		isDevFn:          mygo.IsDev,
		isPackagedFn:     mygo.App.IsPackaged,
		versionFn:        mygo.App.Version,
		setPrereleasesFn: mygo.Updater.SetPrereleases,
		checkFn: func(ctx context.Context) (*availableUpdate, error) {
			up, err := mygo.Updater.Check(ctx)
			if err != nil || up == nil {
				return nil, err
			}
			return &availableUpdate{
				version:     up.Version,
				notes:       up.Notes,
				publishedAt: up.Date,
				install:     up.Install,
			}, nil
		},
		busyFn: store.DesktopRestartBusy,
		relaunchFn: func() {
			mygo.App.Relaunch()
		},
		emitStateFn: func(state UpdateState) {
			if browser == nil {
				return
			}
			mygo.RunOnMain(func() {
				if shell := browser.shell; shell != nil && !shell.IsDestroyed() {
					_ = updateStateChanged.EmitPage(shell.Page(), state)
				}
			})
		},
		emitOpenFn: func() {
			if browser == nil {
				return
			}
			mygo.RunOnMain(func() {
				if windows := mygo.Windows(); len(windows) > 0 {
					w := windows[0]
					if w.IsMinimized() {
						w.Restore()
					}
					w.Focus()
				}
				mygo.App.Focus()
				if shell := browser.shell; shell != nil && !shell.IsDestroyed() {
					_ = openUpdatesRequested.EmitPage(shell.Page(), struct{}{})
				}
			})
		},
		nowFn:          time.Now,
		firstCheckWait: updateFirstCheck,
		checkInterval:  updateCheckInterval,
		retryInterval:  updateRetryInterval,
	}
	return u
}

// start loads persisted preferences and schedules automatic background checks.
// Call once after the desktop app is ready.
func (u *Updates) start() {
	u.mu.Lock()
	if u.started {
		u.mu.Unlock()
		return
	}
	u.loadLocked()
	prereleases := u.prefs.Prereleases
	u.started = true
	u.mu.Unlock()

	if u.setPrereleasesFn != nil {
		u.setPrereleasesFn(prereleases)
	}
	mygo.Power.OnResume(func() {
		u.mu.Lock()
		u.scheduleLocked()
		u.mu.Unlock()
	})

	u.mu.Lock()
	u.scheduleLocked()
	u.mu.Unlock()
}

// stop cancels any active timer or in-flight request.
func (u *Updates) stop() {
	u.mu.Lock()
	if u.timer != nil {
		u.timer.Stop()
		u.timer = nil
	}
	cancel := u.cancelActive
	u.cancelActive = nil
	u.started = false
	u.mu.Unlock()
	if cancel != nil {
		cancel()
	}
}

// State returns the current update state snapshot.
func (u *Updates) State() UpdateState {
	u.mu.Lock()
	defer u.mu.Unlock()
	u.loadLocked()
	return u.snapshotLocked()
}

// TakeOpenRequest consumes a pending menu-triggered request to open the updates panel.
func (u *Updates) TakeOpenRequest() bool {
	u.mu.Lock()
	defer u.mu.Unlock()
	pending := u.openPending
	u.openPending = false
	return pending
}

// requestCheckFromMenu opens the Updates view in the workbench and runs a manual check.
func (u *Updates) requestCheckFromMenu() {
	u.mu.Lock()
	u.openPending = true
	emitOpen := u.emitOpenFn
	u.mu.Unlock()
	if emitOpen != nil {
		emitOpen()
	}
	u.Check()
}

// Check starts a user-initiated check for updates and returns the immediate state.
func (u *Updates) Check() UpdateState {
	return u.startCheck(true)
}

// Download downloads and stages the available update.
func (u *Updates) Download() error {
	u.mu.Lock()
	u.loadLocked()
	if u.status == "downloading" || u.status == "installing" {
		u.mu.Unlock()
		return nil
	}
	if u.status == "ready" && u.installed != nil {
		u.mu.Unlock()
		return nil
	}
	target := u.pending
	if target == nil {
		u.mu.Unlock()
		return errors.New("no update available to download")
	}
	ctx, cancel := context.WithCancel(context.Background())
	u.opID++
	opID := u.opID
	u.cancelActive = cancel
	u.status = "downloading"
	u.downloaded = 0
	u.total = 0
	u.errText = ""
	state := u.snapshotLocked()
	u.mu.Unlock()

	u.emit(state)
	go u.runDownload(ctx, cancel, opID, target, true)
	return nil
}

// CancelDownload cancels an active download or check.
func (u *Updates) CancelDownload() UpdateState {
	u.mu.Lock()
	cancel := u.cancelActive
	u.cancelActive = nil
	u.opID++
	if u.status == "downloading" {
		if u.pending != nil {
			u.status = "available"
		} else {
			u.status = "idle"
		}
		u.downloaded = 0
		u.total = 0
		u.errText = ""
	} else if u.status == "checking" || u.checkInFlight {
		if u.status == "checking" {
			u.status = "idle"
		}
		u.checkInFlight = false
		u.checkIsUser = false
	}
	state := u.snapshotLocked()
	u.scheduleLocked()
	u.mu.Unlock()

	if cancel != nil {
		cancel()
	}
	u.emit(state)
	return state
}

// SkipVersion marks version as skipped so background checks will not prompt for it again.
func (u *Updates) SkipVersion(version string) UpdateState {
	version = strings.TrimSpace(version)
	u.mu.Lock()
	u.loadLocked()
	if version != "" {
		u.skippedVersion = version
		if u.pending != nil && u.pending.version == version && u.status == "available" {
			u.pending = nil
			u.status = "idle"
			u.errText = ""
		}
		u.saveLocked()
	}
	state := u.snapshotLocked()
	u.scheduleLocked()
	u.mu.Unlock()

	u.emit(state)
	return state
}

// SetPreferences updates persisted update preferences and reschedules background checks.
func (u *Updates) SetPreferences(prefs UpdatePreferences) (UpdateState, error) {
	u.mu.Lock()
	u.loadLocked()
	channelChanged := u.prefs.Prereleases != prefs.Prereleases
	u.prefs = prefs
	if channelChanged && u.status != "ready" && u.status != "downloading" && u.status != "installing" {
		u.pending = nil
		u.errText = ""
		if u.status == "available" || u.status == "up-to-date" || u.status == "error" {
			u.status = "idle"
		}
	}
	err := u.saveLocked()
	u.scheduleLocked()
	state := u.snapshotLocked()
	setPrereleases := u.setPrereleasesFn
	u.mu.Unlock()

	if setPrereleases != nil {
		setPrereleases(prefs.Prereleases)
	}
	u.emit(state)
	return state, err
}

// RestartToUpdate verifies the backend can safely hand off and relaunches Lever into the staged update.
func (u *Updates) RestartToUpdate() error {
	u.mu.Lock()
	ready := u.status == "ready" && u.installed != nil
	dataDir := u.dataDir
	busyFn := u.busyFn
	relaunchFn := u.relaunchFn
	u.mu.Unlock()

	if !ready {
		return errors.New("no update is ready to install")
	}
	if busyFn != nil && dataDir != "" {
		busy, err := busyFn(dataDir)
		if err != nil {
			slog.Warn("check desktop restart readiness", "error", err)
		} else if busy {
			return ErrDesktopRestartBusy
		}
	}
	if relaunchFn != nil {
		relaunchFn()
	}
	return nil
}

func (u *Updates) startCheck(user bool) UpdateState {
	u.mu.Lock()
	u.loadLocked()
	supported, _ := u.supportLocked()
	if !supported {
		if user {
			u.status = "idle"
			u.errText = ""
		}
		state := u.snapshotLocked()
		u.mu.Unlock()
		if user {
			u.emit(state)
		}
		return state
	}
	if u.status == "downloading" || u.status == "installing" || (u.status == "ready" && u.installed != nil) {
		state := u.snapshotLocked()
		u.mu.Unlock()
		return state
	}
	if u.checkInFlight {
		if user && !u.checkIsUser {
			u.checkIsUser = true
			u.status = "checking"
			u.errText = ""
			state := u.snapshotLocked()
			u.mu.Unlock()
			u.emit(state)
			return state
		}
		state := u.snapshotLocked()
		u.mu.Unlock()
		return state
	}
	if u.timer != nil {
		u.timer.Stop()
		u.timer = nil
	}
	ctx, cancel := context.WithCancel(context.Background())
	u.opID++
	opID := u.opID
	u.cancelActive = cancel
	u.checkInFlight = true
	u.checkIsUser = user
	u.launchChecked = true
	if user {
		u.status = "checking"
		u.errText = ""
	}
	state := u.snapshotLocked()
	u.mu.Unlock()

	if user {
		u.emit(state)
	}
	go u.runCheck(ctx, cancel, opID)
	return state
}

func (u *Updates) runCheck(ctx context.Context, cancel context.CancelFunc, opID uint64) {
	defer cancel()
	up, err := u.checkFn(ctx)

	u.mu.Lock()
	if ctx.Err() != nil || u.opID != opID {
		u.mu.Unlock()
		return
	}
	user := u.checkIsUser
	u.checkInFlight = false
	u.checkIsUser = false
	u.cancelActive = nil

	if err != nil {
		u.lastFailedAt = u.nowFn()
		slog.Warn("check for desktop updates", "error", err)
		if user {
			u.status = "error"
			u.errText = err.Error()
		}
		u.scheduleLocked()
		state := u.snapshotLocked()
		u.mu.Unlock()
		if user {
			u.emit(state)
		}
		return
	}

	u.lastFailedAt = time.Time{}
	u.lastCheckedAt = u.nowFn().UTC()
	u.saveLocked()

	if up == nil {
		u.pending = nil
		u.errText = ""
		if user {
			u.status = "up-to-date"
		} else if u.status == "available" {
			u.status = "idle"
		}
		u.scheduleLocked()
		state := u.snapshotLocked()
		u.mu.Unlock()
		u.emit(state)
		return
	}

	if !user && u.skippedVersion == up.version {
		u.pending = nil
		u.scheduleLocked()
		state := u.snapshotLocked()
		u.mu.Unlock()
		u.emit(state)
		return
	}

	u.pending = up
	u.errText = ""

	if !user && u.prefs.AutomaticDownloads {
		dlCtx, dlCancel := context.WithCancel(context.Background())
		u.opID++
		dlOpID := u.opID
		u.cancelActive = dlCancel
		u.status = "downloading"
		u.downloaded = 0
		u.total = 0
		state := u.snapshotLocked()
		u.mu.Unlock()
		u.emit(state)
		go u.runDownload(dlCtx, dlCancel, dlOpID, up, false)
		return
	}

	u.status = "available"
	u.scheduleLocked()
	state := u.snapshotLocked()
	u.mu.Unlock()
	u.emit(state)
}

func (u *Updates) runDownload(ctx context.Context, cancel context.CancelFunc, opID uint64, target *availableUpdate, user bool) {
	defer cancel()
	var lastEmit time.Time
	err := target.install(ctx, func(downloaded, total int64) {
		now := u.nowFn()
		u.mu.Lock()
		if ctx.Err() != nil || u.opID != opID {
			u.mu.Unlock()
			return
		}
		u.downloaded = downloaded
		u.total = total
		nextStatus := "downloading"
		if total > 0 && downloaded >= total {
			nextStatus = "installing"
		}
		changedStatus := u.status != nextStatus
		u.status = nextStatus
		shouldEmit := changedStatus || lastEmit.IsZero() || now.Sub(lastEmit) >= progressEmitStep
		var state UpdateState
		if shouldEmit {
			lastEmit = now
			state = u.snapshotLocked()
		}
		u.mu.Unlock()
		if shouldEmit {
			u.emit(state)
		}
	})

	u.mu.Lock()
	if ctx.Err() != nil || u.opID != opID {
		u.mu.Unlock()
		return
	}
	u.cancelActive = nil
	if err != nil {
		slog.Warn("install desktop update", "version", target.version, "error", err)
		u.downloaded = 0
		u.total = 0
		if user {
			u.status = "error"
			u.errText = err.Error()
		} else {
			// Background auto-download failed: surface the update as available so the user can retry manually.
			u.status = "available"
			u.errText = ""
		}
		u.scheduleLocked()
		state := u.snapshotLocked()
		u.mu.Unlock()
		u.emit(state)
		return
	}

	u.installed = target
	u.pending = target
	u.status = "ready"
	u.errText = ""
	if u.total > 0 {
		u.downloaded = u.total
	}
	state := u.snapshotLocked()
	u.mu.Unlock()
	u.emit(state)
}

func (u *Updates) scheduleLocked() {
	if u.timer != nil {
		u.timer.Stop()
		u.timer = nil
	}
	supported, _ := u.supportLocked()
	if !u.started || !supported || !u.prefs.AutomaticChecks || u.checkInFlight ||
		u.status == "downloading" || u.status == "installing" || u.installed != nil {
		return
	}
	wait := u.firstCheckWait
	if u.launchChecked {
		now := u.nowFn()
		last := u.lastCheckedAt
		if last.After(now) {
			last = now
		}
		due := last.Add(u.checkInterval)
		if !u.lastFailedAt.IsZero() {
			retry := u.lastFailedAt.Add(min(u.checkInterval, u.retryInterval))
			if retry.After(due) {
				due = retry
			}
		}
		wait = max(due.Sub(now), u.firstCheckWait)
	}
	u.timer = time.AfterFunc(wait, func() {
		u.startCheck(false)
	})
}

func (u *Updates) supportLocked() (bool, string) {
	if u.enabledFn != nil && u.enabledFn() {
		return true, ""
	}
	if (u.isDevFn != nil && u.isDevFn()) || (u.isPackagedFn != nil && !u.isPackagedFn()) {
		return false, "dev"
	}
	return false, "unwritable"
}

func (u *Updates) snapshotLocked() UpdateState {
	supported, reason := u.supportLocked()
	current := ""
	if u.versionFn != nil {
		current = u.versionFn()
	}
	if current == "" {
		current = "dev"
	}
	state := UpdateState{
		Supported:          supported,
		DisabledReason:     reason,
		CurrentVersion:     current,
		Status:             u.status,
		Downloaded:         u.downloaded,
		Total:              u.total,
		Error:              u.errText,
		AutomaticChecks:    u.prefs.AutomaticChecks,
		AutomaticDownloads: u.prefs.AutomaticDownloads,
		Prereleases:        u.prefs.Prereleases,
		SkippedVersion:     u.skippedVersion,
	}
	if !u.lastCheckedAt.IsZero() {
		state.LastCheckedAt = u.lastCheckedAt.UTC().Format(time.RFC3339)
	}
	target := u.installed
	if target == nil {
		target = u.pending
	}
	if target != nil {
		state.Version = target.version
		state.Notes = target.notes
		if !target.publishedAt.IsZero() {
			state.PublishedAt = target.publishedAt.UTC().Format(time.RFC3339)
		}
	}
	return state
}

func (u *Updates) emit(state UpdateState) {
	if u.emitStateFn != nil {
		u.emitStateFn(state)
	}
}

func (u *Updates) statePath() string {
	if u.dataDir == "" {
		return ""
	}
	return filepath.Join(u.dataDir, updateStateFile)
}

func (u *Updates) loadLocked() {
	if u.loaded {
		return
	}
	u.loaded = true
	path := u.statePath()
	if path == "" {
		return
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return
	}
	var saved persistedUpdateState
	if err := json.Unmarshal(raw, &saved); err != nil {
		return
	}
	if saved.AutomaticChecks != nil {
		u.prefs.AutomaticChecks = *saved.AutomaticChecks
	}
	u.prefs.AutomaticDownloads = saved.AutomaticDownloads
	u.prefs.Prereleases = saved.Prereleases
	u.skippedVersion = saved.SkippedVersion
	u.lastCheckedAt = saved.LastCheckedAt
}

func (u *Updates) saveLocked() error {
	path := u.statePath()
	if path == "" {
		return nil
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	autoChecks := u.prefs.AutomaticChecks
	saved := persistedUpdateState{
		AutomaticChecks:    &autoChecks,
		AutomaticDownloads: u.prefs.AutomaticDownloads,
		Prereleases:        u.prefs.Prereleases,
		SkippedVersion:     u.skippedVersion,
		LastCheckedAt:      u.lastCheckedAt,
	}
	data, err := json.MarshalIndent(saved, "", "  ")
	if err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, append(data, '\n'), 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}
