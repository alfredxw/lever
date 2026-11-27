package provider

import (
	"encoding/json"
	"testing"
	"time"

	acp "github.com/coder/acp-go-sdk"
	"lever/internal/model"
)

func TestSetContextUsageAllowsUnknownWindow(t *testing.T) {
	sink := newRecordingSink()
	if err := setContextUsage(sink, float64(0), nil); err != nil {
		t.Fatal(err)
	}
	if sink.contextUsage() != nil {
		t.Fatalf("expected empty zero-used/zero-window update to be ignored, got %+v", sink.contextUsage())
	}
	if err := setContextUsage(sink, float64(4200), nil); err != nil {
		t.Fatal(err)
	}
	got := sink.contextUsage()
	if got == nil || got.Used != 4200 || got.Window != 0 {
		t.Fatalf("expected used-only context usage, got %+v", got)
	}
	if err := setContextUsage(sink, float64(0), float64(200000)); err != nil {
		t.Fatal(err)
	}
	got = sink.contextUsage()
	if got == nil || got.Used != 0 || got.Window != 200000 {
		t.Fatalf("expected zero-used with known window, got %+v", got)
	}
}

func TestCodexContextUsedFallback(t *testing.T) {
	if got := codexContextUsed(object{"totalTokens": float64(1234), "inputTokens": float64(900), "outputTokens": float64(100)}); got != float64(1234) {
		t.Fatalf("expected totalTokens to win, got %v", got)
	}
	if got := codexContextUsed(object{"inputTokens": float64(900), "outputTokens": float64(100)}); got != int64(1000) {
		t.Fatalf("expected input+output fallback, got %v", got)
	}
	if got := codexContextUsed(object{}); got != nil {
		t.Fatalf("expected nil for empty usage, got %v", got)
	}
}

func TestClaudeContextHelpers(t *testing.T) {
	// Advisor iterations must measure the last main-model message pass instead of cumulative totals.
	usage := object{
		"input_tokens":                float64(99999),
		"cache_read_input_tokens":     float64(88888),
		"cache_creation_input_tokens": float64(77777),
		"output_tokens":               float64(666),
		"iterations": []any{
			object{"type": "message", "input_tokens": float64(100), "cache_read_input_tokens": float64(1000), "output_tokens": float64(50)},
			object{"type": "advisor", "input_tokens": float64(5000), "output_tokens": float64(200)},
			object{"type": "message", "input_tokens": float64(20), "cache_read_input_tokens": float64(2000), "cache_creation_input_tokens": float64(300), "output_tokens": float64(80)},
		},
	}
	input, total := claudeUsageCounts(usage)
	if input != 2320 || total != 2400 {
		t.Fatalf("expected last message iteration counts (2320, 2400), got (%d, %d)", input, total)
	}

	merged := mergeClaudeStreamUsage(
		object{"input_tokens": float64(10), "cache_read_input_tokens": float64(500), "output_tokens": float64(5)},
		object{"output_tokens": float64(45), "cache_read_input_tokens": nil},
	)
	if in, tot := claudeUsageCounts(merged); in != 510 || tot != 555 {
		t.Fatalf("merged stream usage mismatch: (%d, %d)", in, tot)
	}

	cache := map[string]int64{}
	modelUsage := object{
		"claude-opus-4-6[1m]": object{
			"contextWindow":  float64(1_000_000),
			"canonicalModel": "claude-opus-4-6",
		},
	}
	claudeRememberContextWindows(modelUsage, cache)
	if w := claudeResolveContextWindow(modelUsage, "claude-opus-4-6", cache); w != 1_000_000 {
		t.Fatalf("expected 1M window via canonical/suffix match, got %d", w)
	}
	if w := claudeResolveContextWindow(nil, "claude-opus-4-6[1m]", cache); w != 1_000_000 {
		t.Fatalf("expected cached window lookup, got %d", w)
	}

	sink := newRecordingSink()
	in := Input{
		RunID:    "run-1",
		Provider: model.Provider{AutoCompactWindow: 150_000},
	}
	if err := setClaudeContext(sink, in, time.Now(), 45_000, 200_000, object{"cache_read_input_tokens": float64(40_000)}); err != nil {
		t.Fatal(err)
	}
	got := sink.contextUsage()
	if got == nil || got.Used != 45_000 || got.Window != 200_000 || got.AutoCompactThreshold != 117_000 || got.PromptCacheExpiresAt == 0 {
		t.Fatalf("unexpected Claude context usage: %+v", got)
	}

	// AutoCompactWindow >= model window does not apply.
	if threshold := claudeAutoCompactThreshold(200_000, 200_000); threshold != 0 {
		t.Fatalf("expected 0 threshold when autoCompactWindow == window, got %d", threshold)
	}
}

func TestPiTranscriptLiveAndCompactionContextUsage(t *testing.T) {
	sink := newRecordingSink()
	tr := piTranscript{sink: sink, items: map[string]model.Item{}, contextWindow: 128_000}

	if err := tr.update(object{
		"type":  "message_update",
		"usage": object{"totalTokens": float64(12_000)},
		"assistantMessageEvent": object{"type": "text_delta", "contentIndex": float64(0), "delta": "hi"},
	}); err != nil {
		t.Fatal(err)
	}
	if got := sink.contextUsage(); got == nil || got.Used != 12_000 || got.Window != 128_000 {
		t.Fatalf("expected live Pi usage (12000/128000), got %+v", got)
	}

	if err := tr.update(object{
		"type": "message_end",
		"message": object{
			"role":    "assistant",
			"usage":   object{"input": float64(10_000), "cacheRead": float64(4_000), "output": float64(500)},
			"content": []any{object{"type": "text", "text": "hi"}},
		},
	}); err != nil {
		t.Fatal(err)
	}
	if got := sink.contextUsage(); got == nil || got.Used != 14_500 || got.Window != 128_000 {
		t.Fatalf("expected message_end Pi usage (14500/128000), got %+v", got)
	}

	if err := tr.update(object{
		"type":   "compaction_end",
		"result": object{"estimatedTokensAfter": float64(3_200), "tokensBefore": float64(14_500)},
	}); err != nil {
		t.Fatal(err)
	}
	if got := sink.contextUsage(); got == nil || got.Used != 3_200 || got.Window != 128_000 || !tr.compacted || tr.compactionAfterTokens != 3_200 {
		t.Fatalf("expected post-compaction Pi usage (3200/128000), got %+v", got)
	}
}

func TestACPContextUsageReplayLateAndMeta(t *testing.T) {
	rt, sink := newTestACPRuntime("/workspace", false)
	rt.session = "sess-1"
	rt.contextUsage = map[acp.SessionId]model.ContextUsage{}

	sendUpdate := func(payload object) {
		t.Helper()
		raw, err := json.Marshal(payload)
		if err != nil {
			t.Fatal(err)
		}
		if _, rpcErr := rt.handle(t.Context(), "session/update", raw); rpcErr != nil {
			t.Fatalf("session/update failed: %v", rpcErr)
		}
	}

	// 1. Replay before prompt activates (Grok-style _meta.totalTokens) buffers until activation.
	sendUpdate(object{
		"sessionId": "sess-1",
		"_meta":     object{"totalTokens": 9_500},
		"update":    object{"sessionUpdate": "agent_message_chunk", "content": object{"type": "text", "text": "replayed"}},
	})
	if sink.contextUsage() != nil {
		t.Fatalf("expected pre-prompt replay usage to stay buffered before model window resolution, got %+v", sink.contextUsage())
	}

	// Resolve model window from acpState and activate.
	state := acpState{
		Models: &struct {
			CurrentModelID  string `json:"currentModelId"`
			AvailableModels []struct {
				ModelID string         `json:"modelId"`
				Name    string         `json:"name"`
				Meta    map[string]any `json:"_meta,omitempty"`
			} `json:"availableModels"`
		}{
			CurrentModelID: "grok-code",
			AvailableModels: []struct {
				ModelID string         `json:"modelId"`
				Name    string         `json:"name"`
				Meta    map[string]any `json:"_meta,omitempty"`
			}{
				{ModelID: "grok-code", Name: "Grok Code", Meta: map[string]any{"totalContextTokens": float64(256_000)}},
			},
		},
	}
	rt.mu.Lock()
	rt.modelContextWindow = state.activeModelContextWindow()
	rt.active = true
	rt.prompted = true
	usage := rt.contextUsage[rt.session]
	if usage.Window <= 0 && rt.modelContextWindow > 0 {
		usage.Window = rt.modelContextWindow
		rt.contextUsage[rt.session] = usage
	}
	if err := rt.publishContextUsageLocked(usage); err != nil {
		rt.mu.Unlock()
		t.Fatal(err)
	}
	rt.mu.Unlock()

	if got := sink.contextUsage(); got == nil || got.Used != 9_500 || got.Window != 256_000 {
		t.Fatalf("expected buffered Grok usage upgraded with model window, got %+v", got)
	}

	// 2. Late usage_update arriving after prompt ends (active=false, prompted=true), with size=0 falling back to model window.
	rt.mu.Lock()
	rt.active = false
	rt.mu.Unlock()
	sendUpdate(object{
		"sessionId": "sess-1",
		"update":    object{"sessionUpdate": "usage_update", "used": 18_400, "size": 0},
	})
	if got := sink.contextUsage(); got == nil || got.Used != 18_400 || got.Window != 256_000 {
		t.Fatalf("expected late post-prompt usage_update to persist with model window, got %+v", got)
	}

	// 3. Standard usage_update with explicit size overrides model window.
	sendUpdate(object{
		"sessionId": "sess-1",
		"update":    object{"sessionUpdate": "usage_update", "used": 22_000, "size": 1_048_576},
	})
	if got := sink.contextUsage(); got == nil || got.Used != 22_000 || got.Window != 1_048_576 {
		t.Fatalf("expected explicit usage_update size, got %+v", got)
	}
}
