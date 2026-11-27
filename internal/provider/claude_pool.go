package provider

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"path/filepath"
	"slices"
	"sync"
	"sync/atomic"
	"time"

	"github.com/google/uuid"
	"lever/internal/device"
	"lever/internal/model"
)

var (
	claudeIdleTimeout = 30 * time.Minute
	claudeMaxIdle     = 8
)

type claudePoolKey struct {
	stateDir  string
	sessionID string
}

type claudePool struct {
	mu      sync.Mutex
	entries map[claudePoolKey]*claudeResident
}

var defaultClaudePool = &claudePool{entries: map[claudePoolKey]*claudeResident{}}

// CloseClaudeSessions closes all idle resident Claude processes owned by stateDir.
func CloseClaudeSessions(stateDir string) {
	defaultClaudePool.closeStateDir(stateDir)
}

// HasResidentClaude reports whether an idle resident Claude process is currently
// parked for (stateDir, sessionID).
func HasResidentClaude(stateDir, sessionID string) bool {
	return defaultClaudePool.has(stateDir, sessionID)
}

func (p *claudePool) take(stateDir, sessionID string) *claudeResident {
	if sessionID == "" {
		return nil
	}
	key := claudePoolKey{stateDir: stateDir, sessionID: sessionID}
	p.mu.Lock()
	r := p.entries[key]
	delete(p.entries, key)
	p.mu.Unlock()
	return r
}

func (p *claudePool) park(stateDir, sessionID string, r *claudeResident) {
	if sessionID == "" || r == nil || !r.alive() {
		if r != nil {
			r.close()
		}
		return
	}
	key := claudePoolKey{stateDir: stateDir, sessionID: sessionID}
	var evicted []*claudeResident
	p.mu.Lock()
	if prev := p.entries[key]; prev != nil && prev != r {
		delete(p.entries, key)
		evicted = append(evicted, prev)
	}
	for claudeMaxIdle > 0 && len(p.entries) >= claudeMaxIdle {
		var oldestKey claudePoolKey
		var oldest *claudeResident
		for k, candidate := range p.entries {
			if oldest == nil || candidate.parkedAt.Before(oldest.parkedAt) {
				oldestKey, oldest = k, candidate
			}
		}
		if oldest == nil {
			break
		}
		delete(p.entries, oldestKey)
		evicted = append(evicted, oldest)
	}
	r.parkedAt = time.Now()
	r.startIdleLocked(p, key, claudeIdleTimeout)
	p.entries[key] = r
	p.mu.Unlock()
	for _, old := range evicted {
		old.close()
	}
}

func (p *claudePool) removeIf(key claudePoolKey, r *claudeResident) {
	p.mu.Lock()
	if p.entries[key] == r {
		delete(p.entries, key)
	}
	p.mu.Unlock()
}

func (p *claudePool) has(stateDir, sessionID string) bool {
	if sessionID == "" {
		return false
	}
	p.mu.Lock()
	r := p.entries[claudePoolKey{stateDir: stateDir, sessionID: sessionID}]
	p.mu.Unlock()
	return r != nil && r.alive()
}

func (p *claudePool) closeStateDir(stateDir string) {
	var victims []*claudeResident
	p.mu.Lock()
	for key, r := range p.entries {
		if key.stateDir == stateDir {
			delete(p.entries, key)
			victims = append(victims, r)
		}
	}
	p.mu.Unlock()
	for _, r := range victims {
		r.close()
	}
}

type claudeResident struct {
	p           *device.Process
	nativeID    string
	fingerprint    string
	permission     string
	commands       []model.Reference
	contextWindows map[string]int64
	mcpRelay       *claudeMCPRelay
	reqSeq      atomic.Uint64
	parkedAt    time.Time

	idleStop     chan struct{}
	idleDone     chan struct{}
	idleStopOnce sync.Once
	idleClean    bool
	closeOnce    sync.Once
}

func (r *claudeResident) nextRequestID(kind string) string {
	return fmt.Sprintf("lever-%s-%d", kind, r.reqSeq.Add(1))
}

func (r *claudeResident) alive() bool {
	if r == nil || r.p == nil {
		return false
	}
	select {
	case <-r.p.Done:
		return false
	default:
		return true
	}
}

func (r *claudeResident) startIdleLocked(pool *claudePool, key claudePoolKey, timeout time.Duration) {
	r.idleStop = make(chan struct{})
	r.idleDone = make(chan struct{})
	r.idleStopOnce = sync.Once{}
	r.idleClean = false
	stop, done := r.idleStop, r.idleDone
	go func() {
		defer close(done)
		timer := time.NewTimer(timeout)
		defer timer.Stop()
		for {
			select {
			case <-stop:
				r.idleClean = r.alive()
				return
			case <-r.p.Done:
				pool.removeIf(key, r)
				r.closeProcess()
				return
			case <-timer.C:
				pool.removeIf(key, r)
				r.closeProcess()
				return
			case frame, ok := <-r.p.Frames:
				if !ok || !claudeIdleFrameBenign(frame) {
					pool.removeIf(key, r)
					r.closeProcess()
					return
				}
			}
		}
	}()
}

// stopIdle detaches the resident process from idle monitoring and reports
// whether it is still alive and clean for reuse.
func (r *claudeResident) stopIdle() bool {
	if r == nil {
		return false
	}
	if r.idleDone == nil {
		return r.alive()
	}
	r.idleStopOnce.Do(func() { close(r.idleStop) })
	<-r.idleDone
	clean := r.idleClean && r.alive()
	r.idleStop, r.idleDone, r.idleClean = nil, nil, false
	return clean
}

func (r *claudeResident) close() {
	if r == nil {
		return
	}
	r.stopIdle()
	r.closeProcess()
}

func (r *claudeResident) closeProcess() {
	r.closeOnce.Do(func() {
		if r.p != nil {
			r.p.Close()
		}
		if r.mcpRelay != nil {
			r.mcpRelay.close()
		}
	})
}

func claudeIdleFrameBenign(raw []byte) bool {
	f, err := decode(raw)
	if err != nil {
		return false
	}
	switch str(f["type"]) {
	case "keep_alive", "rate_limit_event":
		return true
	case "system":
		sub := str(f["subtype"])
		return sub == "informational" || sub == "status"
	default:
		return false
	}
}

// claudeMCPRelay gives a long-lived Claude process a single stable loopback
// MCP endpoint while swapping the per-turn upstream URL and bearer token.
type claudeMCPRelay struct {
	addr       string
	secret     string
	configPath string
	server     *http.Server

	mu     sync.RWMutex
	target *url.URL
	token  string
}

func newClaudeMCPRelay(assets, upstreamURL, upstreamToken string) (*claudeMCPRelay, error) {
	parsed, err := url.Parse(upstreamURL)
	if err != nil {
		return nil, err
	}
	if assets != "" {
		if err := os.MkdirAll(assets, 0700); err != nil {
			return nil, err
		}
	}
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, err
	}
	relay := &claudeMCPRelay{
		addr:   l.Addr().String(),
		secret: uuid.NewString() + uuid.NewString(),
		target: parsed,
		token:  upstreamToken,
	}
	transport := &http.Transport{DisableKeepAlives: true}
	proxy := &httputil.ReverseProxy{
		Transport: transport,
		Rewrite: func(r *httputil.ProxyRequest) {
			relay.mu.RLock()
			target, token := relay.target, relay.token
			relay.mu.RUnlock()
			if target == nil {
				return
			}
			r.Out.URL.Scheme = target.Scheme
			r.Out.URL.Host = target.Host
			r.Out.URL.Path = target.Path
			r.Out.URL.RawPath = target.RawPath
			r.Out.URL.RawQuery = target.RawQuery
			r.Out.Host = target.Host
			r.Out.Header.Set("Authorization", "Bearer "+token)
		},
	}
	relay.server = &http.Server{
		Addr:              relay.addr,
		ReadHeaderTimeout: 5 * time.Second,
		Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.Host != relay.addr || r.URL.Path != "/mcp" || r.Header.Get("Origin") != "" ||
				subtle.ConstantTimeCompare([]byte(r.Header.Get("Authorization")), []byte("Bearer "+relay.secret)) != 1 {
				http.Error(w, "Invalid execution capability", http.StatusForbidden)
				return
			}
			relay.mu.RLock()
			active := relay.target != nil
			relay.mu.RUnlock()
			if !active {
				http.Error(w, "No active execution", http.StatusUnauthorized)
				return
			}
			proxy.ServeHTTP(w, r)
		}),
	}
	config := object{"mcpServers": object{"lever": object{
		"type":    "http",
		"url":     "http://" + relay.addr + "/mcp",
		"headers": object{"Authorization": "Bearer " + relay.secret},
	}}}
	relay.configPath = filepath.Join(assets, "mcp-relay-"+uuid.NewString()+".json")
	if err := os.WriteFile(relay.configPath, []byte(pretty(config)), 0600); err != nil {
		_ = l.Close()
		return nil, err
	}
	go func() { _ = relay.server.Serve(l) }()
	return relay, nil
}

func (r *claudeMCPRelay) set(upstreamURL, upstreamToken string) error {
	parsed, err := url.Parse(upstreamURL)
	if err != nil {
		return err
	}
	r.mu.Lock()
	r.target, r.token = parsed, upstreamToken
	r.mu.Unlock()
	return nil
}

func (r *claudeMCPRelay) clear() {
	r.mu.Lock()
	r.target, r.token = nil, ""
	r.mu.Unlock()
}

func (r *claudeMCPRelay) close() {
	r.clear()
	if r.server != nil {
		_ = r.server.Close()
	}
	if r.configPath != "" {
		_ = os.Remove(r.configPath)
	}
}

func claudeLaunchFingerprint(in Input, executablePath, cwd, entrypoint string, addDirs []string, supportsResumeDialog bool) string {
	disabled := slices.Clone(in.Skills.Disabled)
	slices.Sort(disabled)
	var bundledDigest []string
	for _, src := range in.Skills.Bundled {
		entry := src
		if info, err := os.Stat(filepath.Join(in.Skills.Assets, "skills", filepath.Base(src), model.SkillEntry)); err == nil {
			entry = fmt.Sprintf("%s:%d:%d", src, info.Size(), info.ModTime().UnixNano())
		}
		bundledDigest = append(bundledDigest, entry)
	}
	payload := struct {
		Executable           string
		ProviderID           string
		ProviderArgs         []string
		ConfigDir            string
		ManagedProfile       bool
		AutoCompactWindow    int
		IdleCompaction       string
		Entrypoint           string
		CWD                  string
		Model                string
		Effort               string
		Fast                 bool
		Instructions          string
		Delegations           []model.DelegationRule
		DelegationEnabled     bool
		DelegationPolicy      model.DelegationPolicy
		AllowRemoteDelegation bool
		SkillsAssets          string
		SkillsBundled        []string
		SkillsDisabled       []string
		SkillsClaudeDirs     []string
		AddDirs              []string
		HasMCP               bool
		SupportsResumeDialog bool
	}{
		Executable:           executablePath,
		ProviderID:           in.Provider.ID,
		ProviderArgs:         in.Provider.Args,
		ConfigDir:            ConfigurationDirectory(in.Provider),
		ManagedProfile:       in.Provider.ManagedProfile,
		AutoCompactWindow:    in.Provider.AutoCompactWindow,
		IdleCompaction:       in.Provider.IdleCompaction,
		Entrypoint:           entrypoint,
		CWD:                  cwd,
		Model:                in.Selection.Model,
		Effort:               in.Selection.Effort,
		Fast:                 in.Selection.Fast,
		Instructions:          in.Profile.Instructions,
		Delegations:           in.Profile.Delegations,
		DelegationEnabled:     in.DelegationEnabled,
		DelegationPolicy:      in.Profile.DelegationPolicy,
		AllowRemoteDelegation: in.Profile.AllowsRemoteDelegation(),
		SkillsAssets:          in.Skills.Assets,
		SkillsBundled:        bundledDigest,
		SkillsDisabled:       disabled,
		SkillsClaudeDirs:     in.Skills.ClaudeDirectories,
		AddDirs:              addDirs,
		HasMCP:               in.MCPURL != "",
		SupportsResumeDialog: supportsResumeDialog,
	}
	raw, _ := json.Marshal(payload)
	sum := sha256.Sum256(raw)
	return hex.EncodeToString(sum[:])
}

// watchClaudeTurn attaches a turn-scoped cancellation watcher to a live Claude
// process so cancelling one turn interrupts it without poisoning later turns on
// a reused process.
func watchClaudeTurn(ctx context.Context, p *device.Process, interruptReqID string) (stop func(), triggered *atomic.Bool) {
	watchStop := make(chan struct{})
	watchDone := make(chan struct{})
	triggered = &atomic.Bool{}
	var once sync.Once
	go func() {
		defer close(watchDone)
		select {
		case <-watchStop:
			return
		case <-p.Done:
			return
		case <-ctx.Done():
			select {
			case <-watchStop:
				return
			default:
			}
			triggered.Store(true)
			go func() {
				_ = p.Send(object{"type": "control_request", "request_id": interruptReqID, "request": object{"subtype": "interrupt"}})
			}()
		}
		select {
		case <-watchStop:
		case <-p.Done:
		case <-time.After(4 * time.Second):
			p.Terminate()
		}
	}()
	return func() {
		once.Do(func() { close(watchStop) })
		<-watchDone
	}, triggered
}

func setClaudePermissionMode(ctx context.Context, r *claudeResident, mode string) error {
	reqID := r.nextRequestID("permission")
	if err := r.p.Send(object{"type": "control_request", "request_id": reqID, "request": object{"subtype": "set_permission_mode", "mode": mode}}); err != nil {
		return err
	}
	waitCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	for {
		select {
		case <-waitCtx.Done():
			return waitCtx.Err()
		case b, ok := <-r.p.Frames:
			if !ok {
				return errors.Join(errors.New("Claude exited while updating permission mode"), r.p.Error())
			}
			f, err := decode(b)
			if err != nil {
				return err
			}
			if str(f["type"]) == "control_response" {
				resp := obj(f["response"])
				if str(resp["request_id"]) == reqID {
					if str(resp["subtype"]) != "success" {
						return fail(resp)
					}
					r.permission = mode
					return nil
				}
			}
			if !claudeIdleFrameBenign(b) {
				return errors.New("unexpected Claude frame while updating permission mode")
			}
		}
	}
}
