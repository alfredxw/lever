package runhost

import (
	"database/sql"
	"encoding/json"
	"errors"
	"reflect"
	"strings"
	"testing"

	"lever/internal/model"
	"lever/internal/provider"
)

func TestSteerStateUsesCompatibleRuntimeSnapshot(t *testing.T) {
	db, err := sql.Open("sqlite", ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if _, err := db.Exec("CREATE TABLE runtime_events(run_id, kind, data)"); err != nil {
		t.Fatal(err)
	}
	runtime := model.SessionRuntime{Context: &model.ContextUsage{Used: 73, Window: 100}}
	w := worker{db: db, id: "turn", runtime: runtime}
	for _, state := range []provider.SteerState{provider.SteerReady, provider.SteerUnavailable} {
		if err := w.SetSteerState(state); err != nil {
			t.Fatal(err)
		}
		var kind, data string
		if err := db.QueryRow("SELECT kind, data FROM runtime_events WHERE run_id=? ORDER BY rowid DESC LIMIT 1", w.id).Scan(&kind, &data); err != nil {
			t.Fatal(err)
		}
		// An older backend recognizes the event and decodes just the session.
		var legacy model.SessionRuntime
		if kind != "runtime" || json.Unmarshal([]byte(data), &legacy) != nil || !reflect.DeepEqual(legacy, runtime) {
			t.Fatalf("incompatible runtime snapshot: %s %s", kind, data)
		}
		var update RuntimeUpdate
		if err := json.Unmarshal([]byte(data), &update); err != nil || update.SteerState != state {
			t.Fatalf("missing steering state %q in %s: %v", state, data, err)
		}
	}
}

func TestOutcomeErrDoesNotDuplicateSentinel(t *testing.T) {
	original := errors.Join(provider.ErrUnconfirmed, errors.New("Antigravity disconnected while waiting for background work"))
	got := Result(original).Err()
	if !errors.Is(got, provider.ErrUnconfirmed) {
		t.Fatalf("expected ErrUnconfirmed, got %v", got)
	}
	if count := strings.Count(got.Error(), provider.ErrUnconfirmed.Error()); count != 1 {
		t.Fatalf("sentinel repeated %d times in %q", count, got.Error())
	}
	bare := Result(provider.ErrUnconfirmed).Err()
	if bare != provider.ErrUnconfirmed {
		t.Fatalf("expected bare ErrUnconfirmed, got %v", bare)
	}
}
