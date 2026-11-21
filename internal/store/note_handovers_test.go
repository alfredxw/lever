package store

import (
	"database/sql"
	"path/filepath"
	"testing"
)

func TestOpenMigratesNoteHandovers(t *testing.T) {
	dir := t.TempDir()
	db, err := sql.Open("sqlite", filepath.Join(dir, "lever.db"))
	if err != nil {
		t.Fatal(err)
	}
	_, err = db.Exec(`
CREATE TABLE agents(id TEXT PRIMARY KEY, data TEXT NOT NULL);
CREATE TABLE chats(id TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES agents(id), data TEXT NOT NULL);
CREATE TABLE note_handovers(note_id TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE, chat_id TEXT REFERENCES chats(id) ON DELETE SET NULL);
INSERT INTO agents VALUES('reviewer','{}');
INSERT INTO chats VALUES('reviews','reviewer','{}');
INSERT INTO note_handovers VALUES('old-note','reviewer','reviews');`)
	db.Close()
	if err != nil {
		t.Fatal(err)
	}
	s, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	var agent, chat string
	var oneClick bool
	err = s.DB.QueryRow("SELECT agent_id,chat_id,one_click FROM note_handovers WHERE note_id='old-note'").Scan(&agent, &chat, &oneClick)
	if err != nil || agent != "reviewer" || chat != "reviews" || oneClick {
		t.Fatalf("migrated handover: agent=%q chat=%q oneClick=%t err=%v", agent, chat, oneClick, err)
	}
	if _, err := s.DB.Exec("INSERT INTO note_handovers(note_id,one_click) VALUES('new-note',1)"); err != nil {
		t.Fatalf("enable one-click handover without a default Agent: %v", err)
	}
}
