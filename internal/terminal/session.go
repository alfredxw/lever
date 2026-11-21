// Package terminal owns interactive shells independently of their viewers.
package terminal

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"strings"
	"sync"
	"time"

	"github.com/charmbracelet/x/xpty"

	"lever/internal/device"
)

const reconnectGrace = 30 * time.Second

var ErrBusy = errors.New("terminal already has a connected viewer")

// Key separates workspace, setup, and provider terminals.
type Key struct {
	Agent, Conversation, Worktree, Provider, ID string
}

// Manager's zero value is ready to use.
type Manager struct {
	mu       sync.Mutex
	sessions map[Key]*Session
	closed   bool
	ended    map[Key]time.Time
}

// Attach reuses an existing PTY, or starts one when explicitly requested.
// lease transfers ownership of the Scope lease only on a successful start.
func (m *Manager) Attach(key Key, cwd string, cols, rows int, start bool, lease func()) (*Session, *Viewer, bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed {
		return nil, nil, false, errors.New("terminal service is shutting down")
	}
	if s := m.sessions[key]; s != nil {
		select {
		case <-s.Closing:
			return nil, nil, false, ErrBusy
		default:
		}
		if key.Worktree == "" && s.cmd.Dir != cwd {
			return nil, nil, false, errors.New("terminal working directory has changed")
		}
		s.mu.Lock()
		defer s.mu.Unlock()
		if s.viewer != nil {
			return nil, nil, false, ErrBusy
		}
		if s.expiry != nil {
			s.expiry.Stop()
			s.expiry = nil
			s.detached = nil
		}
		return s, s.attachLocked(), false, nil
	}
	if !start || time.Now().Before(m.ended[key]) {
		return nil, nil, false, nil
	}
	s, err := m.startLocked(key, shellCommand(), cwd, cols, rows, lease)
	if err != nil {
		return nil, nil, false, err
	}
	s.mu.Lock()
	viewer := s.attachLocked()
	s.mu.Unlock()
	go s.readOutput()
	go s.writeInput()
	return s, viewer, true, nil
}

// Knows reports both live sessions and recent attempts that were closed.
func (m *Manager) Knows(key Key) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.sessions[key] != nil || time.Now().Before(m.ended[key])
}

func (m *Manager) StartCommand(key Key, command, cwd string, lease func()) (bool, error) {
	return m.StartProcess(key, setupCommand(command), cwd, lease)
}

func (m *Manager) StartProcess(key Key, cmd *exec.Cmd, cwd string, lease func()) (bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed {
		return false, errors.New("terminal service is shutting down")
	}
	if m.sessions[key] != nil || time.Now().Before(m.ended[key]) {
		return false, nil
	}
	s, err := m.startLocked(key, cmd, cwd, 80, 16, lease)
	if err != nil {
		return false, err
	}
	s.expiry = time.AfterFunc(reconnectGrace, func() { m.terminate(key, s, nil) })
	go s.readOutput()
	go s.writeInput()
	return true, nil
}

func (m *Manager) startLocked(key Key, cmd *exec.Cmd, cwd string, cols, rows int, lease func()) (*Session, error) {
	if len(m.sessions) >= 32 {
		return nil, errors.New("close an existing terminal before opening another")
	}
	s, err := newSession(cmd, cwd, cols, rows, lease)
	if err != nil {
		return nil, err
	}
	if m.sessions == nil {
		m.sessions = make(map[Key]*Session)
	}
	m.sessions[key] = s
	return s, nil
}

func (m *Manager) Detach(key Key, s *Session, viewer *Viewer) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.sessions[key] != s {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.viewer != viewer {
		return
	}
	s.viewer = nil
	s.signalLocked()
	select {
	case <-s.Closing:
		return
	default:
	}
	// Run under the manager lock in terminate, which also orders reattach.
	s.expiry = time.AfterFunc(reconnectGrace, func() { m.terminate(key, s, viewer) })
	s.detached = viewer
}

func (m *Manager) Terminate(key Key) { m.terminate(key, nil, nil) }

func (m *Manager) terminate(key Key, expected *Session, viewer *Viewer) {
	m.mu.Lock()
	s := m.sessions[key]
	if expected != nil && (s != expected || s.expiry == nil || s.detached != viewer) {
		m.mu.Unlock()
		return
	}
	// A close may beat the first WebSocket to the manager.
	if m.ended == nil {
		m.ended = make(map[Key]time.Time)
	}
	now := time.Now()
	for k, until := range m.ended {
		if !now.Before(until) {
			delete(m.ended, k)
		}
	}
	m.ended[key] = now.Add(reconnectGrace)
	if s == nil {
		m.mu.Unlock()
		return
	}
	// Keep the entry reserved while stopping it. Shutdown can still wait
	// for its cleanup, and a concurrent attach sees Closing.
	s.beginClose()
	m.mu.Unlock()
	s.close()
	m.mu.Lock()
	if m.sessions[key] == s {
		delete(m.sessions, key)
	}
	m.mu.Unlock()
}

func (m *Manager) Close() {
	m.mu.Lock()
	m.closed = true
	sessions := make([]*Session, 0, len(m.sessions))
	for _, s := range m.sessions {
		s.beginClose()
		sessions = append(sessions, s)
	}
	m.mu.Unlock()
	var waiting sync.WaitGroup
	for _, s := range sessions {
		waiting.Go(s.close)
	}
	waiting.Wait()
	m.mu.Lock()
	clear(m.sessions)
	m.mu.Unlock()
}

type Session struct {
	xpty.Pty
	done    chan struct{}
	settled chan struct{}
	Closing chan struct{}
	cmd     *exec.Cmd
	stop    func()
	release func()
	closing sync.Once
	once    sync.Once
	ptyOnce sync.Once

	mu       sync.Mutex
	viewer   *Viewer
	detached *Viewer // guarded by Manager.mu
	input    chan terminalInput
	expiry   *time.Timer // guarded by Manager.mu
	size     Size
	history  outputHistory
	changed  chan struct{}
	exited   bool
}

func newSession(cmd *exec.Cmd, cwd string, cols, rows int, lease func()) (*Session, error) {
	cmd.Dir = cwd
	cmd.Env = environment(cmd.Env)
	prepareCommand(cmd)
	p, err := xpty.NewPty(cols, rows)
	if err != nil {
		return nil, err
	}
	if err = p.Start(cmd); err != nil {
		_ = p.Close()
		return nil, err
	}
	done := make(chan struct{})
	stop, err := ownPTY(p, cmd, done)
	if err != nil {
		_ = cmd.Process.Kill()
		_ = xpty.WaitProcess(context.Background(), cmd)
		_ = p.Close()
		return nil, err
	}
	s := &Session{
		Pty: p, cmd: cmd, stop: stop, done: done, settled: make(chan struct{}), release: lease,
		Closing: make(chan struct{}), changed: make(chan struct{}), input: make(chan terminalInput, 16),
		history: outputHistory{size: Size{cols, rows}},
		size:    Size{cols, rows},
	}
	go func() {
		_ = xpty.WaitProcess(context.Background(), cmd)
		close(s.done)
		finishPTY(s)
		if s.release != nil {
			s.release()
		}
		close(s.settled)
	}()
	return s, nil
}

func (s *Session) ExitCode() int {
	<-s.settled
	if s.cmd.ProcessState == nil {
		return -1
	}
	return s.cmd.ProcessState.ExitCode()
}

func (s *Session) Directory() string { return s.cmd.Dir }

func (s *Session) closePTY() { s.ptyOnce.Do(func() { closePTY(s.Pty) }) }

func (s *Session) beginClose() {
	if s.expiry != nil {
		s.expiry.Stop()
	}
	s.closing.Do(func() { close(s.Closing) })
}

func (s *Session) close() {
	s.once.Do(func() {
		s.stop()
		s.closePTY()
		<-s.settled
	})
}

func ValidSize(cols, rows int) bool { return cols >= 2 && cols <= 500 && rows >= 1 && rows <= 300 }

func environment(base []string) []string {
	if base == nil {
		base = device.Environment()
	}
	var env []string
	for _, entry := range base {
		key, _, _ := strings.Cut(entry, "=")
		switch strings.ToUpper(key) {
		case "TERM", "COLORTERM", "TERM_PROGRAM", "NO_COLOR", "FORCE_COLOR", "CLICOLOR", "CLICOLOR_FORCE":
			continue
		}
		env = append(env, entry)
	}
	if os.Getenv("LANG") == "" {
		env = append(env, "LANG=en_US.UTF-8")
	}
	return append(env, "TERM=xterm-256color", "COLORTERM=truecolor", "TERM_PROGRAM=Lever")
}
