package store

import (
	"database/sql"
	"fmt"
)

// Only structural changes and status transitions advance the hot window.
// Token deltas update runs.data and never schedule a Hub write.
func initPeerCheckpoints(tx *sql.Tx) error {
	if _, err := tx.Exec(`CREATE TABLE IF NOT EXISTS peer_clock(singleton INTEGER PRIMARY KEY, revision INTEGER NOT NULL, visibility INTEGER NOT NULL);
		INSERT OR IGNORE INTO peer_clock VALUES(1,1,1);
		CREATE TABLE IF NOT EXISTS peer_chat_revisions(chat_id TEXT PRIMARY KEY REFERENCES chats ON DELETE CASCADE,revision INTEGER NOT NULL)`); err != nil {
		return err
	}
	for _, v := range []struct {
		name, table, event, when, chat string
		privacy                        bool
	}{
		{"new_agent", "agents", "INSERT", "", "", false}, {"agent", "agents", "UPDATE", "", "", true}, {"drop_agent", "agents", "DELETE", "", "", true},
		{"new_chat", "chats", "INSERT", "", "NEW.id", false}, {"drop_chat", "chats", "DELETE", "", "", true},
		{"chat", "chats", "UPDATE OF data", " WHEN json_extract(NEW.data,'$.title') IS NOT json_extract(OLD.data,'$.title')", "NEW.id", false},
		{"visibility", "chats", "UPDATE OF data", " WHEN json_extract(NEW.data,'$.localOnly') IS NOT json_extract(OLD.data,'$.localOnly') OR json_extract(NEW.data,'$.sharedScope') IS NOT json_extract(OLD.data,'$.sharedScope')", "NEW.id", true},
		{"expose", "hub_exposed_agents", "INSERT", "", "", true}, {"hide", "hub_exposed_agents", "DELETE", "", "", true},
		{"strategy", "remote_memberships", "UPDATE OF expose_all", " WHEN NEW.expose_all<>OLD.expose_all", "", true},
		{"access", "remote_access", "UPDATE", "", "", true},
		{"run", "runs", "INSERT", "", "NEW.chat_id", false}, {"run_state", "runs", "UPDATE OF status", " WHEN NEW.status<>OLD.status", "NEW.chat_id", false},
		{"request", "requests", "INSERT", "", "NEW.chat_id", false}, {"answer", "requests", "UPDATE OF status", " WHEN NEW.status<>OLD.status", "NEW.chat_id", false},
		{"activity", "sessions", "UPDATE OF activity", " WHEN OLD.activity IS NOT NEW.activity", "NEW.chat_id", false},
	} {
		body := "UPDATE peer_clock SET revision=revision+1"
		if v.privacy {
			body += ",visibility=visibility+1"
		}
		body += " WHERE singleton=1;"
		if v.chat != "" {
			body += fmt.Sprintf("INSERT INTO peer_chat_revisions SELECT %s,revision FROM peer_clock WHERE singleton=1 ON CONFLICT(chat_id) DO UPDATE SET revision=excluded.revision;", v.chat)
		}
		query := fmt.Sprintf("CREATE TRIGGER IF NOT EXISTS peer_index_%s AFTER %s ON %s%s BEGIN %s END", v.name, v.event, v.table, v.when, body)
		if _, err := tx.Exec(query); err != nil {
			return err
		}
	}
	return nil
}
