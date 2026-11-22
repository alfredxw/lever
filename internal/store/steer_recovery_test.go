package store

import (
	"database/sql"
	"testing"

	"lever/internal/model"
)

func TestRecoverSteersKeepsOnlyLiveTargets(t *testing.T) {
	s := activityStore(t)
	ctx := t.Context()
	if err := s.Write(ctx, func(tx *sql.Tx) error {
		for _, owner := range []string{"lost", "live"} {
			session := "main"
			if owner == "live" {
				session = "topic"
			}
			for _, status := range []string{"running", "queued", "steering"} {
				run := model.Run{ID: owner, AgentID: "agent", ChatID: "chat", SessionID: session, Operation: "main", Status: status, SteerPending: status == "running"}
				if status != "running" {
					run.ID, run.Delivery, run.SteerRunID = owner+status, "steer", owner
				}
				if err := InsertRun(tx, &run, run.ID, run.ID); err != nil {
					return err
				}
			}
		}
		_, err := tx.Exec(`INSERT INTO runtime_hosts(run_id,input) VALUES('live','{}')`)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Recover(ctx); err != nil {
		t.Fatal(err)
	}
	read := func(id string) model.Run {
		t.Helper()
		run, err := Get[model.Run](ctx, s.DB, "SELECT data FROM runs WHERE id=?", id)
		if err != nil {
			t.Fatal(err)
		}
		return run
	}
	if run := read("lostqueued"); run.Status != "queued" || run.SteerRunID != "" || run.Delivery != "queue" {
		t.Fatal(run)
	}
	if run := read("loststeering"); run.Status != "steered" || run.Error == "" {
		t.Fatal(run)
	}
	if run := read("lost"); run.Status != "unknown" || run.SteerPending || run.CanSteer {
		t.Fatal(run)
	}
	if run := read("livequeued"); run.Status != "queued" || run.SteerRunID != "live" || run.Delivery != "steer" {
		t.Fatal(run)
	}
	if run := read("livesteering"); run.Status != "steering" || run.Error != "" {
		t.Fatal(run)
	}
}
