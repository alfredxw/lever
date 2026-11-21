package store

import (
	"database/sql"
	"path/filepath"
	"testing"
)

func TestRecoverPersonalReactionReceipts(t *testing.T) {
	dir := t.TempDir()
	db, err := sql.Open("sqlite", filepath.Join(dir, "lever.db"))
	if err != nil {
		t.Fatal(err)
	}
	_, err = db.Exec(`CREATE TABLE personal_channel_turns (
run_id TEXT PRIMARY KEY, binding TEXT, chat TEXT, conversation TEXT, thread TEXT,
command TEXT, signature TEXT, answer_id TEXT DEFAULT '', context_ready INTEGER);
INSERT INTO personal_channel_turns(run_id, context_ready) VALUES('legacy',1),('accepted',0),('confirmed',1);`)
	db.Close()
	if err != nil {
		t.Fatal(err)
	}
	s, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	_, err = s.DB.Exec(`UPDATE personal_channel_turns SET reaction='DONE',
reaction_status=CASE run_id WHEN 'accepted' THEN 'pending' ELSE 'ok' END WHERE run_id<>'legacy'`)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.Recover(t.Context()); err != nil {
		t.Fatal(err)
	}
	for run, want := range map[string]string{"legacy": "", "accepted": "unknown", "confirmed": "ok"} {
		var status string
		var ready bool
		err := s.DB.QueryRow("SELECT reaction_status,context_ready FROM personal_channel_turns WHERE run_id=?", run).Scan(&status, &ready)
		if err != nil || status != want || !ready {
			t.Fatalf("%s: status=%q context ready=%v err=%v", run, status, ready, err)
		}
	}
}
