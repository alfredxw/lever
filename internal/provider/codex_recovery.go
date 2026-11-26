package provider

import (
	"context"
	"errors"
	"time"
)

var errCodexThreadBusy = errors.New("Another Codex process has this conversation open for writing.")

func latestCodexTurn(call func(string, object) (object, error), threadID, itemsView string) (object, error) {
	history, err := call("thread/turns/list", object{
		"threadId": threadID, "limit": 1, "sortDirection": "desc", "itemsView": itemsView,
	})
	if err != nil {
		return nil, err
	}
	turns := arr(history["data"])
	if len(turns) != 1 {
		return nil, errors.New("Codex could not find the latest turn in its saved thread")
	}
	return obj(turns[0]), nil
}

func codexRecoveryTurn(ctx context.Context, call func(string, object) (object, error), in Input) (object, error) {
	for {
		turn, err := latestCodexTurn(call, in.Session.NativeID, "full")
		if err != nil {
			return nil, err
		}
		if !matchesCodexRecoveryTurn(turn, in) {
			return nil, errors.New("Codex could not match the previous execution to the latest turn in its saved thread")
		}
		// An unloaded app-server can describe an in-progress turn as interrupted.
		// Require the persisted terminal timestamp before using that result.
		completedAt, _ := turn["completedAt"].(float64)
		if completedAt > 0 {
			switch turn["status"] {
			case "completed", "failed", "interrupted":
				return turn, nil
			}
		}
		select {
		case <-ctx.Done():
			return nil, errors.New("Codex has not confirmed that the previous turn ended")
		case <-time.After(250 * time.Millisecond):
		}
	}
}

func resumeInterruptedCodexThread(ctx context.Context, call func(string, object) (object, error), params object, threadID, turnID string, allowFailed bool) (object, error) {
	wrap := func(err error) error {
		if allowFailed {
			return err
		}
		return errors.Join(ErrUnconfirmed, err)
	}
	params["excludeTurns"] = true
	var result object
	var err error
	for delay := 250 * time.Millisecond; ; delay = min(2*delay, 4*time.Second) {
		result, err = openCodexThread(call, params, threadID)
		if !errors.Is(err, errCodexThreadBusy) {
			break
		}
		select {
		case <-ctx.Done():
			return nil, wrap(errCodexThreadBusy)
		case <-time.After(delay):
		}
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return nil, wrap(err)
	}
	if err != nil {
		return nil, err
	}
	// Another writer may have advanced the thread since the read-only check.
	// Verify the turn again under our write lock before sending a continuation.
	turn, err := latestCodexTurn(call, threadID, "notLoaded")
	if err != nil {
		return nil, wrap(err)
	}
	if !confirmedCodexResumable(turn, turnID, allowFailed) {
		return nil, wrap(errors.New("The interrupted turn is no longer the latest confirmed turn in this Codex conversation."))
	}
	return result, nil
}

func confirmedCodexInterruption(turn object, turnID string) bool {
	return confirmedCodexResumable(turn, turnID, false)
}

func confirmedCodexResumable(turn object, turnID string, allowFailed bool) bool {
	completedAt, _ := turn["completedAt"].(float64)
	if turn["id"] != turnID || completedAt <= 0 {
		return false
	}
	return turn["status"] == "interrupted" || (allowFailed && turn["status"] == "failed")
}

func matchesCodexRecoveryTurn(turn object, in Input) bool {
	id := str(turn["id"])
	if id == "" {
		return false
	}
	if in.Recovery.NativeTurnID != nil {
		return id == *in.Recovery.NativeTurnID
	}
	return hasCodexUserMessage(turn, in.RunID)
}

func hasCodexUserMessage(turn object, clientID string) bool {
	for _, value := range arr(turn["items"]) {
		item := obj(value)
		if item["type"] == "userMessage" && item["clientId"] == clientID {
			return true
		}
	}
	return false
}
