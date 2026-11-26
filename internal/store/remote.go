package store

import (
	"crypto/ed25519"
	"crypto/rand"
	"database/sql"
	"errors"
	"fmt"

	p "lever/internal/remoteproto"
)

// A membership owns one durable change stream. A row survives pruning as a
// versioned tombstone until ACK. Full rebuilds also work after either DB rolls back.
const remoteSchema = `
CREATE TABLE IF NOT EXISTS remote_identity(singleton INTEGER PRIMARY KEY CHECK(singleton=1),id TEXT NOT NULL,key BLOB NOT NULL);
CREATE TABLE IF NOT EXISTS remote_memberships(hub TEXT NOT NULL,space TEXT NOT NULL,origin TEXT NOT NULL,credential TEXT NOT NULL,epoch TEXT NOT NULL,version INTEGER NOT NULL DEFAULT 0,acked INTEGER NOT NULL DEFAULT 0,lan INTEGER NOT NULL DEFAULT 0,policy INTEGER NOT NULL DEFAULT 0,expose_all INTEGER NOT NULL DEFAULT 0,allow_delegation INTEGER NOT NULL DEFAULT 1,PRIMARY KEY(hub,space));
CREATE TABLE IF NOT EXISTS hub_exposed_agents(hub TEXT NOT NULL,space TEXT NOT NULL,agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,PRIMARY KEY(hub,space,agent_id),FOREIGN KEY(hub,space) REFERENCES remote_memberships ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS remote_trusted_controllers(hub TEXT NOT NULL,space TEXT NOT NULL,controller TEXT NOT NULL,pub BLOB NOT NULL,name TEXT NOT NULL,PRIMARY KEY(hub,space,controller),FOREIGN KEY(hub,space) REFERENCES remote_memberships ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS remote_control_permissions(hub TEXT NOT NULL,space TEXT NOT NULL,controller TEXT NOT NULL,agent_id TEXT NOT NULL,action TEXT NOT NULL,PRIMARY KEY(hub,space,controller,agent_id,action),FOREIGN KEY(hub,space,controller) REFERENCES remote_trusted_controllers ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS shared_sync_log(hub TEXT NOT NULL,space TEXT NOT NULL,kind TEXT NOT NULL,object_id TEXT NOT NULL,version INTEGER NOT NULL,chat_id TEXT NOT NULL DEFAULT '',PRIMARY KEY(hub,space,kind,object_id),FOREIGN KEY(hub,space) REFERENCES remote_memberships ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS remote_commands(hub TEXT NOT NULL,space TEXT NOT NULL,id TEXT NOT NULL,digest TEXT NOT NULL,receipt TEXT NOT NULL,PRIMARY KEY(hub,space,id));
CREATE TABLE IF NOT EXISTS remote_private_chats(hub TEXT NOT NULL,space TEXT NOT NULL,controller TEXT NOT NULL,chat TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,PRIMARY KEY(hub,space,controller,chat),FOREIGN KEY(hub,space) REFERENCES remote_memberships ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS lan_proposals(hub TEXT NOT NULL,space TEXT NOT NULL,id TEXT NOT NULL,command TEXT NOT NULL,receipt TEXT NOT NULL,expires INTEGER NOT NULL,policy INTEGER NOT NULL,published INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(hub,space,id),FOREIGN KEY(hub,space) REFERENCES remote_memberships ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS remote_lan_nonces(nonce TEXT PRIMARY KEY,expires INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS remote_replay_bounds(hub TEXT NOT NULL,space TEXT NOT NULL,floor INTEGER NOT NULL,PRIMARY KEY(hub,space),FOREIGN KEY(hub,space) REFERENCES remote_memberships ON DELETE CASCADE);
INSERT OR IGNORE INTO remote_replay_bounds SELECT hub,space,acked FROM remote_memberships;
CREATE TABLE IF NOT EXISTS remote_note_tasks(note_id TEXT NOT NULL,hub TEXT NOT NULL,space TEXT NOT NULL,task_id TEXT NOT NULL,PRIMARY KEY(note_id,hub,space));
`

func (s *Store) initRemote() error {
	tx, err := s.DB.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err = tx.Exec(remoteSchema); err != nil {
		return err
	}
	var hasParent bool
	if err = tx.QueryRow("SELECT EXISTS(SELECT 1 FROM pragma_table_info('shared_sync_log') WHERE name='chat_id')").Scan(&hasParent); err != nil {
		return err
	}
	if !hasParent {
		// Old tombstones have no parent. Give existing LAN readers one clean snapshot
		// while retaining the old log and acknowledgements for the Hub uploader.
		if _, err = tx.Exec(`ALTER TABLE shared_sync_log ADD COLUMN chat_id TEXT NOT NULL DEFAULT '';
			INSERT OR REPLACE INTO remote_replay_bounds SELECT hub,space,version FROM remote_memberships`); err != nil {
			return err
		}
	}
	var hasExposeAll bool
	if err = tx.QueryRow("SELECT EXISTS(SELECT 1 FROM pragma_table_info('remote_memberships') WHERE name='expose_all')").Scan(&hasExposeAll); err != nil {
		return err
	}
	if !hasExposeAll {
		if _, err = tx.Exec("ALTER TABLE remote_memberships ADD COLUMN expose_all INTEGER NOT NULL DEFAULT 0"); err != nil {
			return err
		}
	}
	var hasAllowDelegation bool
	if err = tx.QueryRow("SELECT EXISTS(SELECT 1 FROM pragma_table_info('remote_memberships') WHERE name='allow_delegation')").Scan(&hasAllowDelegation); err != nil {
		return err
	}
	if !hasAllowDelegation {
		if _, err = tx.Exec("ALTER TABLE remote_memberships ADD COLUMN allow_delegation INTEGER NOT NULL DEFAULT 1"); err != nil {
			return err
		}
	}
	var legacyPermFK bool
	if err = tx.QueryRow("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='remote_control_permissions' AND instr(sql,'hub_exposed_agents')>0)").Scan(&legacyPermFK); err != nil {
		return err
	}
	if legacyPermFK {
		if _, err = tx.Exec(`
CREATE TABLE remote_control_permissions_new(hub TEXT NOT NULL,space TEXT NOT NULL,controller TEXT NOT NULL,agent_id TEXT NOT NULL,action TEXT NOT NULL,PRIMARY KEY(hub,space,controller,agent_id,action),FOREIGN KEY(hub,space,controller) REFERENCES remote_trusted_controllers ON DELETE CASCADE);
INSERT INTO remote_control_permissions_new SELECT hub,space,controller,agent_id,action FROM remote_control_permissions;
DROP TABLE remote_control_permissions;
ALTER TABLE remote_control_permissions_new RENAME TO remote_control_permissions;`); err != nil {
			return err
		}
	}
	var hasExposeAllTrigger bool
	if err = tx.QueryRow("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='trigger' AND name='share_agents_INSERT' AND instr(sql,'expose_all')>0)").Scan(&hasExposeAllTrigger); err != nil {
		return err
	}
	var id string
	err = tx.QueryRow("SELECT id FROM remote_identity").Scan(&id)
	if errors.Is(err, sql.ErrNoRows) {
		_, key, err := ed25519.GenerateKey(rand.Reader)
		if err != nil {
			return err
		}
		id = p.NewID()
		if _, err = tx.Exec("INSERT INTO remote_identity VALUES(1,?,?)", id, []byte(key)); err != nil {
			return err
		}
	} else if err != nil {
		return err
	}
	s.DeviceID = id
	// The scope lookup is also used by AFTER DELETE. Foreign-key dependencies
	// keep a parent Chat present while its child rows are being removed.
	for _, spec := range []struct{ table, kind, id, scope string }{
		{"chats", "chat", "id", `hub=json_extract(%[1]s.data,'$.sharedScope.hubId') AND space=json_extract(%[1]s.data,'$.sharedScope.spaceId')`},
		{"sessions", "session", "id", chatScope},
		{"runs", "run", "id", chatScope},
		{"requests", "request", "id", chatScope},
		{"agents", "agent", "id", `expose_all=1 OR (hub,space) IN (SELECT hub,space FROM hub_exposed_agents WHERE agent_id=%[1]s.id)`},
		{"working_copies", "agent", "agent_id", `expose_all=1 OR (hub,space) IN (SELECT hub,space FROM hub_exposed_agents WHERE agent_id=%[1]s.agent_id)`},
		{"hub_exposed_agents", "agent", "agent_id", `hub=%[1]s.hub AND space=%[1]s.space`},
	} {
		for _, op := range []string{"INSERT", "UPDATE", "DELETE"} {
			ref := "NEW"
			if op == "DELETE" {
				ref = "OLD"
			}
			where := fmt.Sprintf(spec.scope, ref)
			parent := "''"
			switch spec.kind {
			case "chat":
				parent = ref + ".id"
			case "session", "run", "request":
				parent = ref + ".chat_id"
			}
			if !hasParent || (!hasExposeAllTrigger && (spec.table == "agents" || spec.table == "working_copies")) {
				if _, err = tx.Exec("DROP TRIGGER IF EXISTS share_" + spec.table + "_" + op); err != nil {
					return err
				}
			}
			trigger := fmt.Sprintf(`CREATE TRIGGER IF NOT EXISTS share_%s_%s AFTER %s ON %s BEGIN
UPDATE remote_memberships SET version=version+1 WHERE %s;
INSERT INTO shared_sync_log(hub,space,kind,object_id,version,chat_id) SELECT hub,space,'%s',%s.%s,version,%s FROM remote_memberships WHERE %s
ON CONFLICT(hub,space,kind,object_id) DO UPDATE SET version=excluded.version,chat_id=excluded.chat_id; END`, spec.table, op, op, spec.table, where, spec.kind, ref, spec.id, parent, where)
			if _, err = tx.Exec(trigger); err != nil {
				return err
			}
		}
	}
	// Keep session summary projections (activeStatus, pendingCount, replyCount) fresh
	// on the home index whenever a run or request transitions status, without firing on streaming chunks.
	for _, spec := range []struct{ table, sessionExpr string }{
		{"runs", "%[1]s.session_id"},
		{"requests", "coalesce(json_extract(%[1]s.data,'$.sessionId'),'')"},
	} {
		for _, op := range []string{"INSERT", "UPDATE", "DELETE"} {
			ref := "NEW"
			when := ""
			if op == "DELETE" {
				ref = "OLD"
			} else if op == "UPDATE" {
				when = " WHEN NEW.status<>OLD.status"
			}
			sessionExpr := fmt.Sprintf(spec.sessionExpr, ref)
			where := fmt.Sprintf(chatScope, ref)
			trigger := fmt.Sprintf(`CREATE TRIGGER IF NOT EXISTS share_%s_session_%s AFTER %s ON %s%s BEGIN
UPDATE remote_memberships SET version=version+1 WHERE %s AND %s<>'';
INSERT INTO shared_sync_log(hub,space,kind,object_id,version,chat_id) SELECT hub,space,'session',%s,version,%s.chat_id FROM remote_memberships WHERE %s AND %s<>''
ON CONFLICT(hub,space,kind,object_id) DO UPDATE SET version=excluded.version,chat_id=excluded.chat_id; END`,
				spec.table, op, op, spec.table, when, where, sessionExpr, sessionExpr, ref, where, sessionExpr)
			if _, err = tx.Exec(trigger); err != nil {
				return err
			}
		}
	}
	return tx.Commit()
}

const chatScope = `(hub,space) IN (SELECT json_extract(data,'$.sharedScope.hubId'),json_extract(data,'$.sharedScope.spaceId') FROM chats WHERE id=%[1]s.chat_id)`
