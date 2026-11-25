package provider

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"testing"
	"time"

	acp "github.com/coder/acp-go-sdk"
	"lever/internal/model"
)

func TestACPSetupTimeoutFormatsReadableMessage(t *testing.T) {
	for _, tt := range []struct {
		name     string
		provider model.Provider
		native   string
		timeout  time.Duration
		want     string
	}{
		{
			name:     "antigravity resume",
			provider: model.Provider{ID: "antigravity", Type: "antigravity", Name: "Antigravity"},
			native:   "session-1",
			timeout:  90 * time.Second,
			want:     "Antigravity timed out after 90s while resuming the session; no message was sent. Check your network or proxy connection and try again.",
		},
		{
			name:     "antigravity new session",
			provider: model.Provider{ID: "antigravity", Type: "antigravity"},
			timeout:  90 * time.Second,
			want:     "Antigravity timed out after 90s while starting the session; no message was sent. Check your network or proxy connection and try again.",
		},
		{
			name:     "custom acp provider",
			provider: model.Provider{ID: "dsh", Type: "acp", Name: "DSH"},
			timeout:  45 * time.Second,
			want:     "DSH timed out after 45s while starting the session; no message was sent. Check your network or proxy connection and try again.",
		},
	} {
		t.Run(tt.name, func(t *testing.T) {
			client, peer := net.Pipe()
			t.Cleanup(func() { _ = peer.Close(); _ = client.Close() })
			runtime, _ := newTestACPRuntime("", tt.provider.Type == "antigravity")
			runtime.provider = tt.provider
			runtime.initial.AgentCapabilities.SessionCapabilities.Resume = &acp.SessionResumeCapabilities{}
			runtime.conn = acp.NewConnection(runtime.handle, client, client)

			// Drain the outgoing request and withhold any response so the real
			// acp-go-sdk client-side deadline triggers -32603.
			received := make(chan string, 1)
			go func() {
				var frame struct {
					Method string `json:"method"`
				}
				if err := json.NewDecoder(peer).Decode(&frame); err == nil {
					received <- frame.Method
				}
			}()

			setup, stop := context.WithTimeout(t.Context(), 25*time.Millisecond)
			defer stop()
			_, rawErr := runtime.sessionState(setup, t.TempDir(), tt.native, nil, nil)
			if rawErr == nil {
				t.Fatal("expected deadline error from hanging ACP peer")
			}
			select {
			case method := <-received:
				wantMethod := "session/new"
				if tt.native != "" {
					wantMethod = "session/resume"
				}
				if method != wantMethod {
					t.Fatalf("unexpected ACP method: got %q, want %q", method, wantMethod)
				}
			case <-time.After(time.Second):
				t.Fatal("peer never received ACP setup request")
			}

			got := runtime.setupFailure(t.Context(), setup, tt.timeout, sessionSetupAction(tt.native != ""), rawErr)
			if got == nil || got.Error() != tt.want {
				t.Fatalf("got %q, want %q", got, tt.want)
			}
			if !errors.Is(got, context.DeadlineExceeded) {
				t.Fatalf("formatted timeout lost context.DeadlineExceeded: %v", got)
			}
		})
	}
}

func TestACPSetupFailurePreservesNonTimeoutErrors(t *testing.T) {
	provider := model.Provider{ID: "antigravity", Type: "antigravity", Name: "Antigravity"}
	deadlineReq := acp.NewInternalError(map[string]any{"error": context.DeadlineExceeded.Error()})

	t.Run("server deadline before local timeout omits duration", func(t *testing.T) {
		runtime, _ := newTestACPRuntime("", true)
		runtime.provider = provider
		setup, stop := context.WithTimeout(t.Context(), time.Minute)
		defer stop()
		got := runtime.setupFailure(t.Context(), setup, 90*time.Second, sessionSetupAction(true), deadlineReq)
		want := "Antigravity timed out while resuming the session; no message was sent. Check your network or proxy connection and try again."
		if got == nil || got.Error() != want {
			t.Fatalf("got %q, want %q", got, want)
		}
	})

	t.Run("auth output error wins over timeout", func(t *testing.T) {
		runtime, _ := newTestACPRuntime("", true)
		runtime.provider = provider
		runtime.output = &antigravityOutput{err: ErrAntigravityCLIAuthRequired}
		setup, stop := context.WithDeadline(t.Context(), time.Now().Add(-time.Second))
		defer stop()
		got := runtime.setupFailure(t.Context(), setup, 90*time.Second, sessionSetupAction(false), deadlineReq)
		if !errors.Is(got, ErrAntigravityCLIAuthRequired) {
			t.Fatalf("got %v, want %v", got, ErrAntigravityCLIAuthRequired)
		}
	})

	t.Run("parent cancellation is not reported as timeout", func(t *testing.T) {
		runtime, _ := newTestACPRuntime("", true)
		runtime.provider = provider
		parent, cancel := context.WithCancel(t.Context())
		cancel()
		got := runtime.setupFailure(parent, parent, 90*time.Second, sessionSetupAction(false), deadlineReq)
		if got != deadlineReq {
			t.Fatalf("got %v, want original error %v", got, deadlineReq)
		}
	})

	t.Run("other internal errors are not misclassified", func(t *testing.T) {
		runtime, _ := newTestACPRuntime("", true)
		runtime.provider = provider
		other := acp.NewInternalError(map[string]any{"error": "peer disconnected before response"})
		setup, stop := context.WithDeadline(t.Context(), time.Now().Add(-time.Second))
		defer stop()
		got := runtime.setupFailure(t.Context(), setup, 90*time.Second, sessionSetupAction(false), other)
		if got != other {
			t.Fatalf("got %v, want original error %v", got, other)
		}
	})
}

func TestACPPromptDeadlineFormatsWithoutClaimingUnsent(t *testing.T) {
	peer := startAntigravityPrompt(t)
	peer.runtime.provider = model.Provider{ID: "antigravity", Type: "antigravity", Name: "Antigravity"}
	peer.send(object{
		"id":    peer.request,
		"error": object{"code": -32603, "message": "Internal error", "data": object{"error": context.DeadlineExceeded.Error()}},
	})
	err := <-peer.result
	want := "Antigravity timed out while waiting for a response. Check your network or proxy connection and try again."
	if err == nil || err.Error() != want {
		t.Fatalf("got %q, want %q", err, want)
	}
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("prompt timeout lost context.DeadlineExceeded: %v", err)
	}
}

func TestSetupTimeoutErrorAcrossProvidersAndDiscovery(t *testing.T) {
	expired, stop := context.WithDeadline(t.Context(), time.Now().Add(-time.Second))
	defer stop()

	piErr := setupTimeoutError(t.Context(), expired, model.Provider{ID: "pi", Type: "pi", Name: "Pi"}, piSetupTimeout, sessionSetupAction(false), context.DeadlineExceeded)
	wantPi := "Pi timed out after 30s while starting the session; no message was sent. Check your network or proxy connection and try again."
	if piErr == nil || piErr.Error() != wantPi {
		t.Fatalf("got %q, want %q", piErr, wantPi)
	}

	rawACP := acp.NewInternalError(map[string]any{"error": context.DeadlineExceeded.Error()})
	normalized := normalizeACPDeadline(expired, model.Provider{ID: "antigravity", Type: "antigravity", Name: "Antigravity"}, "loading models", rawACP)
	discoverErr := setupTimeoutError(t.Context(), expired, model.Provider{ID: "antigravity", Type: "antigravity", Name: "Antigravity"}, 90*time.Second, "loading models", normalized)
	wantDiscover := "Antigravity timed out after 90s while loading models. Check your network or proxy connection and try again."
	if discoverErr == nil || discoverErr.Error() != wantDiscover {
		t.Fatalf("got %q, want %q", discoverErr, wantDiscover)
	}

	codexDiscover := setupTimeoutError(t.Context(), expired, model.Provider{ID: "codex", Type: "codex"}, 15*time.Second, "loading models", context.DeadlineExceeded)
	wantCodex := "Codex timed out after 15s while loading models. Check your network or proxy connection and try again."
	if codexDiscover == nil || codexDiscover.Error() != wantCodex {
		t.Fatalf("got %q, want %q", codexDiscover, wantCodex)
	}
}
