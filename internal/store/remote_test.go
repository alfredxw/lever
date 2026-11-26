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
	if err := s.DB.QueryRow("SELECT instr(sql,'chat_id')>0 AND instr(sql,'expose_all')>0 FROM sqlite_master WHERE type='trigger' AND name='share_agents_INSERT'").Scan(&replaced); err != nil || !replaced {
		t.Fatal("legacy trigger was not upgraded", err)
	}
	var hasExposeAll bool
	if err := s.DB.QueryRow("SELECT EXISTS(SELECT 1 FROM pragma_table_info('remote_memberships') WHERE name='expose_all')").Scan(&hasExposeAll); err != nil || !hasExposeAll {
		t.Fatal("expose_all column was not added", err)
	}
}

func TestMigrateRemotePermissionsWildcard(t *testing.T) {
	dir := t.TempDir()
	db, err := sql.Open("sqlite", filepath.Join(dir, "lever.db"))
	if err != nil {
		t.Fatal(err)
	}
	_, err = db.Exec(`
PRAGMA foreign_keys = ON;
CREATE TABLE agents(id TEXT PRIMARY KEY,data TEXT NOT NULL);
CREATE TABLE remote_memberships(hub TEXT NOT NULL,space TEXT NOT NULL,origin TEXT NOT NULL,credential TEXT NOT NULL,epoch TEXT NOT NULL,version INTEGER NOT NULL DEFAULT 0,acked INTEGER NOT NULL DEFAULT 0,lan INTEGER NOT NULL DEFAULT 0,policy INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(hub,space));
CREATE TABLE hub_exposed_agents(hub TEXT NOT NULL,space TEXT NOT NULL,agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,PRIMARY KEY(hub,space,agent_id),FOREIGN KEY(hub,space) REFERENCES remote_memberships ON DELETE CASCADE);
CREATE TABLE remote_trusted_controllers(hub TEXT NOT NULL,space TEXT NOT NULL,controller TEXT NOT NULL,pub BLOB NOT NULL,name TEXT NOT NULL,PRIMARY KEY(hub,space,controller),FOREIGN KEY(hub,space) REFERENCES remote_memberships ON DELETE CASCADE);
CREATE TABLE remote_control_permissions(hub TEXT NOT NULL,space TEXT NOT NULL,controller TEXT NOT NULL,agent_id TEXT NOT NULL,action TEXT NOT NULL,PRIMARY KEY(hub,space,controller,agent_id,action),FOREIGN KEY(hub,space,controller) REFERENCES remote_trusted_controllers ON DELETE CASCADE,FOREIGN KEY(hub,space,agent_id) REFERENCES hub_exposed_agents ON DELETE CASCADE);
INSERT INTO agents VALUES('a1','{"id":"a1","name":"A1"}');
INSERT INTO remote_memberships(hub,space,origin,credential,epoch) VALUES('h','s','http://x','{}','e1');
INSERT INTO hub_exposed_agents VALUES('h','s','a1');
INSERT INTO remote_trusted_controllers VALUES('h','s','c1',X'01','Phone');
INSERT INTO remote_control_permissions VALUES('h','s','c1','a1','send');`)
	db.Close()
	if err != nil {
		t.Fatal(err)
	}
	s, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	// Existing permission survived migration and wildcard '*' can now be inserted without hub_exposed_agents row.
	if _, err := s.DB.Exec("INSERT INTO remote_control_permissions VALUES('h','s','c1','*','answer')"); err != nil {
		t.Fatalf("wildcard permission insert failed: %v", err)
	}
	var count int
	if err := s.DB.QueryRow("SELECT count(*) FROM remote_control_permissions WHERE controller='c1'").Scan(&count); err != nil || count != 2 {
		t.Fatalf("expected 2 permissions, got %d (%v)", count, err)
	}
	// Deleting trusted controller still cascades and deletes all permissions.
	if _, err := s.DB.Exec("DELETE FROM remote_trusted_controllers WHERE controller='c1'"); err != nil {
		t.Fatal(err)
	}
	if err := s.DB.QueryRow("SELECT count(*) FROM remote_control_permissions WHERE controller='c1'").Scan(&count); err != nil || count != 0 {
		t.Fatalf("expected cascade delete to 0, got %d (%v)", count, err)
	}
}
