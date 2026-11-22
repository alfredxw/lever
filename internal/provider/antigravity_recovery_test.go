package provider

import (
	"errors"
	"testing"

	acp "github.com/coder/acp-go-sdk"
)

func TestAntigravityAuthContinuationChecksNativeCheckpoint(t *testing.T) {
	fixture := newAntigravityChildFixture(t)
	const native = "test-session"
	const failure = "UNAUTHENTICATED (code 401): fixture"
	fixture.step(0, 14, nil, nil)
	watch := watchAntigravityOutcomeDB(t.Context(), fixture.store)
	bind := func() antigravityContinuationSink {
		t.Helper()
		var checkpoint *antigravityAuthCheckpoint
		if err := watch(acp.StopReasonEndTurn); !errors.As(err, &checkpoint) {
			t.Fatalf("missing terminal auth checkpoint: %v", err)
		}
		checkpoint.native = native
		return antigravityContinuationSink{newRecordingSink(), t.Context(), checkpoint}
	}
	fixture.step(1, 17, nil, []byte(failure))
	if err := bind().Bind(native); err == nil {
		t.Fatal("old user input authorized continuation of a different prompt")
	}
	watch = watchAntigravityOutcomeDB(t.Context(), fixture.store)
	fixture.step(2, 14, nil, nil)
	fixture.step(3, 17, nil, []byte(failure))
	if err := watch(acp.StopReasonCancelled); err != nil {
		t.Fatal("401 overrode a native cancellation", err)
	}
	continuation := bind()
	if err := continuation.Bind("other-session"); err == nil {
		t.Fatal("accepted the wrong native session")
	}
	if err := continuation.Bind(native); err != nil {
		t.Fatal("same checkpoint was not accepted", err)
	}
	fixture.step(4, 14, nil, nil)
	if err := continuation.Bind(native); err == nil {
		t.Fatal("continued after the native conversation had moved on")
	}
}
