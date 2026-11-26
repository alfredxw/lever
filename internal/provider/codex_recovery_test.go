package provider

import (
	"context"
	"errors"
	"testing"
	"testing/synctest"
	"time"
)

func TestCodexRecoveryRequiresPersistedEnd(t *testing.T) {
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	id := "accepted-turn"
	call := func(string, object) (object, error) {
		cancel()
		return object{"data": []any{object{"id": id, "status": "interrupted", "completedAt": nil}}}, nil
	}
	if turn, err := codexRecoveryTurn(ctx, call, Input{Recovery: &Recovery{NativeTurnID: &id, Continue: true}}); err == nil {
		t.Fatalf("accepted an interrupted status with no recorded end: %+v", turn)
	}
}

func TestCodexRecoveryLeavesPersistentWriterUnconfirmed(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		ctx, cancel := context.WithTimeout(t.Context(), 90*time.Second)
		defer cancel()
		attempts := 0
		_, err := resumeInterruptedCodexThread(ctx, func(method string, p object) (object, error) {
			if method != "thread/resume" || p["threadId"] != "saved-thread" {
				t.Fatalf("unexpected %s while the writer is busy: %v", method, p)
			}
			attempts++
			return nil, &codexRequestError{payload: object{
				"code": float64(-32600), "message": "thread saved-thread already has an active writer",
			}}
		}, object{}, "saved-thread", "previous-turn", false)
		if attempts < 2 || ctx.Err() != context.DeadlineExceeded || !errors.Is(err, ErrUnconfirmed) || !errors.Is(err, errCodexThreadBusy) {
			t.Fatalf("got %d attempts, context %v, error %v", attempts, ctx.Err(), err)
		}
	})
}

func TestCodexRecoveryAllowsFailedTurnContinuation(t *testing.T) {
	turn := object{"id": "failed-turn", "status": "failed", "completedAt": float64(123)}
	if confirmedCodexInterruption(turn, "failed-turn") {
		t.Fatal("strict pause interruption unexpectedly accepted failed turn")
	}
	if !confirmedCodexResumable(turn, "failed-turn", true) {
		t.Fatal("failed turn continuation rejected confirmed failed turn")
	}
}
