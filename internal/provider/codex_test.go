package provider

import (
	"errors"
	"maps"
	"testing"
)

func TestOpenCodexThread(t *testing.T) {
	const threadID = "saved-thread"
	archived := &codexRequestError{payload: object{
		"code":    -32600,
		"message": "session saved-thread is archived. Run `codex unarchive saved-thread` to unarchive it first.",
	}}
	missing := &codexRequestError{payload: object{"code": -32600, "message": "thread not found"}}
	otherArchived := &codexRequestError{payload: object{"code": -32600, "message": "session other-thread is archived"}}
	otherWriter := &codexRequestError{payload: object{"code": float64(-32600), "message": "thread other-thread already has an active writer"}}
	otherCode := &codexRequestError{payload: object{"code": float64(-32603), "message": "thread saved-thread already has an active writer"}}
	transport := errors.Join(ErrUnconfirmed, errors.New("session saved-thread is archived"))

	type response struct {
		method string
		err    error
	}
	resume := response{"thread/resume", nil}
	resumeArchived := response{"thread/resume", archived}
	unarchive := response{"thread/unarchive", nil}
	for _, tc := range []struct {
		name     string
		threadID string
		want     []response
	}{
		{"starts new thread", "", []response{{"thread/start", nil}}},
		{"resumes active thread", threadID, []response{resume}},
		{"restores archived thread", threadID, []response{resumeArchived, unarchive, resume}},
		{"preserves missing thread error", threadID, []response{{"thread/resume", missing}}},
		{"preserves other thread error", threadID, []response{{"thread/resume", otherArchived}}},
		{"preserves other thread writer error", threadID, []response{{"thread/resume", otherWriter}}},
		{"preserves other writer error code", threadID, []response{{"thread/resume", otherCode}}},
		{"preserves transport error", threadID, []response{{"thread/resume", transport}}},
		{"preserves unarchive error", threadID, []response{resumeArchived, {"thread/unarchive", missing}}},
		{"only retries once", threadID, []response{resumeArchived, unarchive, resumeArchived}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			params := object{"cwd": t.TempDir(), "model": "gpt-test", "approvalPolicy": "never"}
			wantParams := maps.Clone(params)
			if tc.threadID != "" {
				wantParams["threadId"] = tc.threadID
			}
			calls := 0
			result, err := openCodexThread(func(method string, got object) (object, error) {
				if calls >= len(tc.want) {
					t.Fatalf("unexpected call to %s", method)
				}
				expected := tc.want[calls]
				calls++
				if method != expected.method {
					t.Fatalf("call %d: got %s, want %s", calls, method, expected.method)
				}
				want := wantParams
				if method == "thread/unarchive" {
					want = object{"threadId": tc.threadID}
				}
				if !maps.Equal(got, want) {
					t.Fatalf("%s params: got %v, want %v", method, got, want)
				}
				if expected.err != nil {
					return nil, expected.err
				}
				return object{"thread": object{"id": threadID}}, nil
			}, params, tc.threadID)
			if wantErr := tc.want[len(tc.want)-1].err; calls != len(tc.want) || err != wantErr {
				t.Fatalf("got %d calls with error %v, want %d with error %v", calls, err, len(tc.want), wantErr)
			}
			if err == nil && str(obj(result["thread"])["id"]) != threadID {
				t.Fatalf("unexpected thread result: %v", result)
			}
		})
	}
}
