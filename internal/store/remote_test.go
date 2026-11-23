package store

import (
	"database/sql"
	"path/filepath"
	"testing"
)

func TestMigrateRemoteReplayParents(t *testing.T) {
	dir := t.TempDir()
	db, err := sql.Open("sqlite", filepath.Join(dir, "lever.db"))
	if err != nil {
		t.Fatal(err)
	}
	_, err = db.Exec(`
CREATE TABLE agents(id TEXT PRIMARY KEY,data TEXT NOT NULL);
CREATE TRIGGER share_agents_INSERT AFTER INSERT ON agents BEGIN SELECT 1; END;
CREATE TABLE remote_memberships(hub TEXT,space TEXT,origin TEXT,credential TEXT,epoch TEXT,version INTEGER,acked INTEGER,lan INTEGER,policy INTEGER,PRIMARY KEY(hub,space));
CREATE TABLE shared_sync_log(hub TEXT,space TEXT,kind TEXT,object_id TEXT,version INTEGER,PRIMARY KEY(hub,space,kind,object_id));
INSERT INTO remote_memberships VALUES('h','s','','{}','epoch',12,7,0,0);
INSERT INTO shared_sync_log VALUES('h','s','session','old-topic',12);`)
	db.Close()
	if err != nil {
		t.Fatal(err)
	}
	s, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	var floor, ack, version int
	if err := s.DB.QueryRow(`SELECT b.floor,m.acked,l.version FROM remote_memberships m JOIN remote_replay_bounds b USING(hub,space) JOIN shared_sync_log l USING(hub,space) WHERE l.object_id='old-topic'`).Scan(&floor, &ack, &version); err != nil || floor != 12 || ack != 7 || version != 12 {
		t.Fatal("migration lost the Hub upload or retained an ambiguous LAN cursor", floor, ack, version, err)
	}
	var replaced bool
	if err := s.DB.QueryRow("SELECT instr(sql,'chat_id')>0 FROM sqlite_master WHERE type='trigger' AND name='share_agents_INSERT'").Scan(&replaced); err != nil || !replaced {
		t.Fatal("legacy trigger was not upgraded", err)
	}
}
