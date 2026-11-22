package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"math"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"github.com/gofrs/flock"
	"lever/internal/model"
	_ "modernc.org/sqlite"
)

type Store struct {
	DB       *sql.DB
	Dir      string
	lock     *flock.Flock
	mu       sync.Mutex
	watchers map[chan struct{}]struct{}
}

const taskSourceSyncKindColumn = "sync_kind TEXT NOT NULL DEFAULT 'both' CHECK(sync_kind IN ('issue','pr','both'))"

// StarterAgentPending is recorded before the agents table is first created.
const StarterAgentPending = "starter_agent_pending"

var ErrInUse = errors.New("data directory is already in use")

// OpenConnection opens the WAL database without taking the backend's instance
// lock or running migrations. A provider worker only accesses its own mailbox.
func OpenConnection(dir string) (*sql.DB, error) {
	path, err := filepath.Abs(filepath.Join(dir, "lever.db"))
	if err != nil {
		return nil, err
	}
	path = filepath.ToSlash(path)
	if !strings.HasPrefix(path, "/") {
		path = "/" + path
	}
	uri := url.URL{Scheme: "file", Path: path, RawQuery: "_txlock=immediate&_pragma=busy_timeout(5000)&_pragma=foreign_keys(1)"}
	db, err := sql.Open("sqlite", uri.String())
	if err == nil {
		db.SetMaxOpenConns(1)
	}
	return db, err
}

func Open(dir string) (*Store, error) {
	if err := os.MkdirAll(dir, 0700); err != nil {
		return nil, err
	}
	lock := flock.New(filepath.Join(dir, "lever.lock"))
	locked, err := lock.TryLock()
	if err != nil {
		return nil, err
	}
	if !locked {
		return nil, ErrInUse
	}
	db, err := OpenConnection(dir)
	if err != nil {
		_ = lock.Unlock()
		return nil, err
	}
	s := &Store{DB: db, Dir: dir, lock: lock, watchers: make(map[chan struct{}]struct{})}
	_, err = db.Exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
INSERT OR IGNORE INTO settings(key,value) SELECT '` + StarterAgentPending + `','1'
WHERE NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='agents');
CREATE TABLE IF NOT EXISTS agents(id TEXT PRIMARY KEY, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS skill_directories(path TEXT PRIMARY KEY);
CREATE TABLE IF NOT EXISTS working_copies(id TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES agents(id), data TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS agent_working_copies ON working_copies(agent_id);
CREATE TABLE IF NOT EXISTS worktrees(
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES agents(id),
  source TEXT NOT NULL, path TEXT NOT NULL, data TEXT NOT NULL,
  UNIQUE(agent_id,source,path)
);
CREATE TABLE IF NOT EXISTS providers(id TEXT PRIMARY KEY, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS provider_catalogs(
  provider_id TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  config_dir TEXT NOT NULL, cwd TEXT NOT NULL, data TEXT NOT NULL,
  PRIMARY KEY(provider_id,config_dir,cwd)
);
CREATE TABLE IF NOT EXISTS plugins(id TEXT PRIMARY KEY, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS chats(id TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES agents(id), data TEXT NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS chat_task ON chats(json_extract(data,'$.taskId')) WHERE json_type(data,'$.taskId') = 'text';
CREATE UNIQUE INDEX IF NOT EXISTS note_chat ON chats(agent_id,json_extract(data,'$.noteId')) WHERE json_type(data,'$.noteId')='text';
CREATE TABLE IF NOT EXISTS note_handovers(
  note_id TEXT PRIMARY KEY, agent_id TEXT REFERENCES agents(id) ON DELETE CASCADE, chat_id TEXT REFERENCES chats(id) ON DELETE SET NULL
);
CREATE TABLE IF NOT EXISTS task_views(id TEXT PRIMARY KEY, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS work_items(
  id TEXT PRIMARY KEY, data TEXT NOT NULL,
  request_scope TEXT NOT NULL, request_key TEXT, input_hash TEXT NOT NULL,
  UNIQUE(request_scope, request_key)
);
CREATE TABLE IF NOT EXISTS task_sources(
  id TEXT PRIMARY KEY, plugin_id TEXT NOT NULL REFERENCES plugins(id), contribution_id TEXT NOT NULL,
  target_id TEXT NOT NULL, name TEXT NOT NULL, ` + taskSourceSyncKindColumn + `,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','paused','removed')),
  cursor TEXT NOT NULL DEFAULT '', last_synced_at INTEGER NOT NULL DEFAULT 0,
  next_sync_at INTEGER NOT NULL DEFAULT 0, error TEXT NOT NULL DEFAULT '',
  UNIQUE(plugin_id, contribution_id, target_id)
);
CREATE TABLE IF NOT EXISTS external_tasks(
  id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES task_sources(id), external_id TEXT NOT NULL,
  data TEXT NOT NULL, done INTEGER NOT NULL DEFAULT 0, UNIQUE(source_id, external_id)
);
CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY, chat_id TEXT NOT NULL REFERENCES chats(id), kind TEXT NOT NULL CHECK(kind IN ('main','topic')), data TEXT NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS one_main ON sessions(chat_id) WHERE kind='main';
CREATE INDEX IF NOT EXISTS chat_topics ON sessions(chat_id) WHERE kind='topic';
CREATE UNIQUE INDEX IF NOT EXISTS topic_task ON sessions(json_extract(data,'$.taskId'))
WHERE kind='topic' AND json_type(data,'$.taskId')='text';
CREATE UNIQUE INDEX IF NOT EXISTS one_topic_per_source ON sessions(json_extract(data,'$.sourceRunId'))
WHERE kind='topic' AND json_extract(data,'$.sourceRunId') IS NOT NULL;
CREATE TABLE IF NOT EXISTS runs(sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, session_id TEXT NOT NULL REFERENCES sessions(id), chat_id TEXT NOT NULL REFERENCES chats(id), agent_id TEXT NOT NULL REFERENCES agents(id), command_id TEXT NOT NULL UNIQUE, input_hash TEXT NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS runtime_hosts(
 run_id TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE, input TEXT NOT NULL,
 phase TEXT NOT NULL DEFAULT 'ready', stop INTEGER NOT NULL DEFAULT 0, error TEXT NOT NULL DEFAULT '', finished_at TEXT NOT NULL DEFAULT '',
 history_bytes INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS runtime_events(
 seq INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL REFERENCES runtime_hosts(run_id) ON DELETE CASCADE,
 kind TEXT NOT NULL, data TEXT NOT NULL, item_id TEXT, UNIQUE(run_id,item_id)
);
CREATE INDEX IF NOT EXISTS runtime_event_order ON runtime_events(run_id,seq);
CREATE TABLE IF NOT EXISTS runtime_commands(
 seq INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL REFERENCES runtime_hosts(run_id) ON DELETE CASCADE,
 id TEXT NOT NULL UNIQUE, kind TEXT NOT NULL, data TEXT NOT NULL, taken INTEGER NOT NULL DEFAULT 0,
 result TEXT
);
CREATE INDEX IF NOT EXISTS runtime_command_order ON runtime_commands(run_id,kind,seq);
CREATE TABLE IF NOT EXISTS run_turn_diffs(run_id TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE, patch TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS session_runs ON runs(session_id, sequence);
CREATE INDEX IF NOT EXISTS chat_runs ON runs(chat_id, sequence);
CREATE TABLE IF NOT EXISTS task_triage(
  task_id TEXT PRIMARY KEY, accepted INTEGER NOT NULL DEFAULT 0, closed INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS task_deadlines(
  task_id TEXT PRIMARY KEY,
  due_at INTEGER NOT NULL DEFAULT 0,
  due_date TEXT NOT NULL DEFAULT '',
  remind_offsets_json TEXT,
  fired_due_at INTEGER NOT NULL DEFAULT 0,
  fired_offsets_json TEXT NOT NULL DEFAULT '[]',
  snoozed_until INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS task_deadlines_due ON task_deadlines(due_at);
CREATE TABLE IF NOT EXISTS task_queue(
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL, agent_id TEXT NOT NULL REFERENCES agents(id),
  input_hash TEXT NOT NULL, position INTEGER NOT NULL, data TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('queued','withdrawn','started')),
  error TEXT NOT NULL DEFAULT '', started_at INTEGER NOT NULL DEFAULT 0,
  run_id TEXT REFERENCES runs(id) ON DELETE SET NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS one_queued_task ON task_queue(task_id) WHERE state='queued';
CREATE INDEX IF NOT EXISTS task_queue_order ON task_queue(agent_id,position) WHERE state='queued';
CREATE INDEX IF NOT EXISTS task_queue_starts ON task_queue(agent_id,started_at) WHERE state='started';
CREATE INDEX IF NOT EXISTS task_queue_run ON task_queue(run_id) WHERE run_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS comparisons(id TEXT PRIMARY KEY, chat_id TEXT NOT NULL REFERENCES chats(id), position INTEGER NOT NULL, command_id TEXT NOT NULL UNIQUE, input_hash TEXT NOT NULL, data TEXT NOT NULL, UNIQUE(chat_id,position));
CREATE TABLE IF NOT EXISTS run_dependencies(
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  after_run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  PRIMARY KEY(run_id, after_run_id)
);
CREATE INDEX IF NOT EXISTS run_dependencies_after ON run_dependencies(after_run_id);
CREATE INDEX IF NOT EXISTS active_runs ON runs(sequence)
  WHERE status IN ('starting','running','waiting_user','cancelling','unknown','queued');
CREATE UNIQUE INDEX IF NOT EXISTS paused_runs ON runs(session_id) WHERE status='paused';
CREATE TABLE IF NOT EXISTS automations(
  id TEXT PRIMARY KEY, data TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('active','paused','archived')),
  next_at INTEGER, event_token TEXT NOT NULL DEFAULT '', error TEXT NOT NULL DEFAULT '',
  bound_chat_id TEXT REFERENCES chats(id),
  bound_chats TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS automation_due ON automations(next_at) WHERE state='active';
CREATE TABLE IF NOT EXISTS automation_runs(
  id TEXT PRIMARY KEY, automation_id TEXT NOT NULL REFERENCES automations(id), name TEXT NOT NULL,
  trigger TEXT NOT NULL CHECK(trigger IN ('schedule','event','manual')),
  planned_at INTEGER, created_at TEXT NOT NULL, event_count INTEGER NOT NULL DEFAULT 0,
  run_id TEXT UNIQUE REFERENCES runs(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT '', error TEXT NOT NULL DEFAULT '', done INTEGER NOT NULL DEFAULT 0,
  work_item INTEGER NOT NULL DEFAULT 1,
  target_id TEXT NOT NULL DEFAULT '',
  agent_id TEXT NOT NULL DEFAULT '',
  event_payload TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS automation_history ON automation_runs(automation_id);
CREATE TABLE IF NOT EXISTS automation_events(
  id INTEGER PRIMARY KEY, automation_id TEXT NOT NULL REFERENCES automations(id),
  event_key TEXT, payload TEXT, UNIQUE(automation_id, event_key)
);
CREATE INDEX IF NOT EXISTS automation_pending_events ON automation_events(automation_id, id)
  WHERE payload IS NOT NULL;
CREATE TABLE IF NOT EXISTS automation_event_sources(
  automation_id TEXT PRIMARY KEY REFERENCES automations(id),
  secret_id TEXT NOT NULL DEFAULT '', secret_fields TEXT NOT NULL DEFAULT '[]',
  cursor TEXT NOT NULL DEFAULT '', poll_at INTEGER NOT NULL DEFAULT 0,
  error TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS channel_connections(
  kind TEXT PRIMARY KEY, data TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS channel_deliveries(
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  binding_id TEXT NOT NULL, message_id TEXT NOT NULL,
  part TEXT NOT NULL CHECK(part IN ('answer','request')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','sending','sent','failed','unknown','cancelled')),
  PRIMARY KEY(run_id, part)
);
CREATE INDEX IF NOT EXISTS pending_channel_deliveries ON channel_deliveries(binding_id, part) WHERE status='pending';
CREATE TABLE IF NOT EXISTS personal_channel_turns(
  run_id TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE, binding TEXT NOT NULL, chat TEXT NOT NULL,
  conversation TEXT NOT NULL, thread TEXT NOT NULL, command TEXT NOT NULL, signature TEXT NOT NULL,
  answer_id TEXT NOT NULL DEFAULT '', context_ready INTEGER NOT NULL,
  reaction TEXT NOT NULL DEFAULT '', reaction_status TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS personal_channel_conversation ON personal_channel_turns(binding,chat,conversation);
CREATE INDEX IF NOT EXISTS personal_channel_answer ON personal_channel_turns(binding,chat,answer_id) WHERE answer_id<>'';
CREATE TABLE IF NOT EXISTS attachments(id TEXT PRIMARY KEY, chat_id TEXT NOT NULL REFERENCES chats(id), data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS draft_attachments(id TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES agents(id), data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS run_attachments(run_id TEXT NOT NULL REFERENCES runs(id), attachment_id TEXT NOT NULL REFERENCES attachments(id), PRIMARY KEY(run_id, attachment_id));
CREATE TABLE IF NOT EXISTS requests(id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), chat_id TEXT NOT NULL REFERENCES chats(id), status TEXT NOT NULL, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS delegations(id TEXT PRIMARY KEY, parent_run_id TEXT NOT NULL REFERENCES runs(id), request_key TEXT NOT NULL, input_hash TEXT NOT NULL, data TEXT NOT NULL, UNIQUE(parent_run_id, request_key));
CREATE TABLE IF NOT EXISTS events(sequence INTEGER PRIMARY KEY AUTOINCREMENT, data TEXT NOT NULL);
UPDATE agents SET data = CASE
  WHEN json_extract(data, '$.avatar') = '' THEN json_remove(data, '$.avatar')
  ELSE json_set(data, '$.avatar', json_object('kind', 'emoji', 'value', json_extract(data, '$.avatar')))
END WHERE json_type(data, '$.avatar') = 'text';
UPDATE sessions SET data = json_remove(json_set(data,
  '$.roots', json_extract(data, '$.profile.roots'),
  '$.primaryRootId', json_extract(data, '$.profile.primaryRootId'),
  '$.selection', CASE WHEN COALESCE(json_extract(data, '$.selection.provider'), '') = ''
    THEN json_object(
      'provider', json_extract(data, '$.profile.provider'),
      'model', json_extract(data, '$.profile.model'),
      'permission', json_extract(data, '$.profile.permission'),
      'effort', '', 'fast', json('false'))
    ELSE json_set(json_extract(data, '$.selection'), '$.permission', COALESCE(
      NULLIF(json_extract(data, '$.selection.permission'), ''),
      CASE WHEN json_extract(data, '$.selection.provider') = json_extract(data, '$.profile.provider')
        THEN json_extract(data, '$.profile.permission') ELSE 'ask' END))
    END), '$.profile', '$.revision')
WHERE json_type(data, '$.profile') = 'object';
UPDATE agents SET data = json_remove(data, '$.revision') WHERE json_type(data, '$.revision') IS NOT NULL;
`)
	if err == nil {
		err = addStoreColumns(db)
	}
	if err == nil {
		var requiresAgent bool
		err = db.QueryRow(`SELECT "notnull" FROM pragma_table_info('note_handovers') WHERE name='agent_id'`).Scan(&requiresAgent)
		if err == nil && requiresAgent {
			_, err = db.Exec("ALTER TABLE note_handovers ALTER COLUMN agent_id DROP NOT NULL")
		}
	}
	if err == nil {
		var hasSyncKind bool
		err = db.QueryRow("SELECT EXISTS(SELECT 1 FROM pragma_table_info('task_sources') WHERE name='sync_kind')").Scan(&hasSyncKind)
		if err == nil && !hasSyncKind {
			_, err = db.Exec("ALTER TABLE task_sources ADD COLUMN " + taskSourceSyncKindColumn)
		}
	}
	if err == nil {
		// The active transcript orders by position. Superseded runs remain
		// addressable by ID and commandId but no longer occupy a position.
		var hasPosition bool
		err = db.QueryRow("SELECT EXISTS(SELECT 1 FROM pragma_table_xinfo('runs') WHERE name='position')").Scan(&hasPosition)
		if err == nil && !hasPosition {
			_, err = db.Exec(`ALTER TABLE runs ADD COLUMN position INTEGER GENERATED ALWAYS AS (
  CASE WHEN json_extract(data,'$.superseded') THEN NULL
  ELSE COALESCE(NULLIF(json_extract(data,'$.sequence'),0),sequence) END
) VIRTUAL`)
		}
	}
	if err == nil {
		_, err = db.Exec(`DROP INDEX IF EXISTS automation_slot;
CREATE UNIQUE INDEX IF NOT EXISTS automation_slot_target ON automation_runs(automation_id, target_id, planned_at)
  WHERE trigger='schedule';
CREATE INDEX IF NOT EXISTS session_run_positions ON runs(session_id, position);
CREATE UNIQUE INDEX IF NOT EXISTS chat_run_positions ON runs(chat_id, position);
CREATE INDEX IF NOT EXISTS chat_title_runs ON chats(title_run_id) WHERE title_run_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS comparison_runs ON runs(session_id, sequence) WHERE json_type(data,'$.comparisonId') = 'text';`)
	}
	if err == nil {
		err = s.backfillActivity()
	}
	if err != nil {
		_ = s.Close()
		return nil, err
	}
	return s, nil
}

func addStoreColumns(db *sql.DB) error {
	for _, column := range []struct{ table, name, definition string }{
		{"note_handovers", "one_click", "INTEGER NOT NULL DEFAULT 0"},
		{"automations", "bound_chat_id", "TEXT REFERENCES chats(id)"},
		{"automations", "bound_chats", "TEXT NOT NULL DEFAULT '{}'"},
		{"automation_runs", "work_item", "INTEGER NOT NULL DEFAULT 1"},
		{"automation_runs", "target_id", "TEXT NOT NULL DEFAULT ''"},
		{"automation_runs", "agent_id", "TEXT NOT NULL DEFAULT ''"},
		{"automation_runs", "event_payload", "TEXT NOT NULL DEFAULT ''"},
		{"task_triage", "disposition", "TEXT NOT NULL DEFAULT '' CHECK (disposition IN ('','todo','deleted'))"},
		{"chats", "title_run_id", "TEXT"},
		{"sessions", "title_run_id", "TEXT"},
		{"task_sources", "lark_section_ids", "TEXT NOT NULL DEFAULT '[]'"},
		{"task_sources", "lark_excluded_task_ids", "TEXT NOT NULL DEFAULT '[]'"},
		{"task_sources", "lark_filters", "TEXT NOT NULL DEFAULT 'null'"},
		{"external_tasks", "in_scope", "INTEGER NOT NULL DEFAULT 1"},
		{"personal_channel_turns", "reaction", "TEXT NOT NULL DEFAULT ''"},
		{"personal_channel_turns", "reaction_status", "TEXT NOT NULL DEFAULT ''"},
	} {
		var exists bool
		if err := db.QueryRow("SELECT EXISTS(SELECT 1 FROM pragma_table_info(?) WHERE name=?)", column.table, column.name).Scan(&exists); err != nil {
			return err
		}
		if !exists {
			if _, err := db.Exec("ALTER TABLE " + column.table + " ADD COLUMN " + column.name + " " + column.definition); err != nil {
				return err
			}
		}
	}
	return nil
}

func (s *Store) Close() error { return errors.Join(s.DB.Close(), s.lock.Unlock()) }

func JSON(v any) string {
	b, err := json.Marshal(v)
	if err != nil {
		panic(err)
	}
	return string(b)
}

type Queryer interface {
	QueryRowContext(context.Context, string, ...any) *sql.Row
	QueryContext(context.Context, string, ...any) (*sql.Rows, error)
}

func Get[T any](ctx context.Context, q Queryer, query string, args ...any) (T, error) {
	var value T
	var raw string
	if err := q.QueryRowContext(ctx, query, args...).Scan(&raw); err != nil {
		return value, err
	}
	if err := json.Unmarshal([]byte(raw), &value); err != nil {
		return value, err
	}
	return value, nil
}

func List[T any](ctx context.Context, q Queryer, query string, args ...any) ([]T, error) {
	rows, err := q.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	values := []T{}
	for rows.Next() {
		var raw string
		var value T
		if err := rows.Scan(&raw); err != nil {
			return nil, err
		}
		if err := json.Unmarshal([]byte(raw), &value); err != nil {
			return nil, err
		}
		values = append(values, value)
	}
	return values, rows.Err()
}

func (s *Store) Write(ctx context.Context, fn func(*sql.Tx) error) error {
	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err := fn(tx); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	s.mu.Lock()
	for ch := range s.watchers {
		select {
		case ch <- struct{}{}:
		default:
		}
	}
	s.mu.Unlock()
	return nil
}

func Event(tx *sql.Tx, event model.Event) error {
	// Keep replay cursors and references, not thousands of copies of growing
	// transcripts. Events are invalidations; replay hydrates current projections.
	if event.Run != nil {
		event.RunID = event.Run.ID
		event.Run = nil
	}
	if event.Request != nil {
		event.RequestID = event.Request.ID
		event.Request = nil
	}
	_, err := tx.Exec("INSERT INTO events(data) VALUES (?)", JSON(event))
	if err != nil {
		return err
	}
	_, err = tx.Exec("DELETE FROM events WHERE sequence < (SELECT MAX(sequence)-2000 FROM events)")
	return err
}

func SaveRun(tx *sql.Tx, run model.Run) error {
	previous, err := Get[model.Run](context.Background(), tx, "SELECT data FROM runs WHERE id=?", run.ID)
	if err != nil {
		return err
	}
	run.Channel, run.WaitingOn, run.ScopePaths = nil, nil, nil
	if _, err := tx.Exec("UPDATE runs SET status=?,data=? WHERE id=?", run.Status, JSON(run), run.ID); err != nil {
		return err
	}
	if err := Event(tx, model.Event{Type: "run", ChatID: run.ChatID, Run: &run}); err != nil {
		return err
	}
	if previous.Sequence == 0 || previous.Status != run.Status {
		if err := notifyDelegation(tx, run.ID); err != nil {
			return err
		}
		if err := notifyDependentRuns(tx, run.ID); err != nil {
			return err
		}
	}
	return updateActivity(tx, previous, run)
}

func notifyDependentRuns(tx *sql.Tx, afterRunID string) error {
	rows, err := tx.Query(`SELECT r.id, r.chat_id FROM run_dependencies d
JOIN runs r ON r.id=d.run_id
WHERE d.after_run_id=? AND r.status='queued'`, afterRunID)
	if err != nil {
		return err
	}
	type dep struct{ id, chatID string }
	var deps []dep
	for rows.Next() {
		var item dep
		if err := rows.Scan(&item.id, &item.chatID); err != nil {
			rows.Close()
			return err
		}
		deps = append(deps, item)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return err
	}
	if err := rows.Close(); err != nil {
		return err
	}
	for _, item := range deps {
		if err := Event(tx, model.Event{Type: "run", ChatID: item.chatID, RunID: item.id}); err != nil {
			return err
		}
	}
	return nil
}

func InsertRun(tx *sql.Tx, run *model.Run, commandID, hash string) error {
	initial := *run
	initial.Sequence = 0
	r, err := tx.Exec("INSERT INTO runs(id,session_id,chat_id,agent_id,command_id,input_hash,status,data) VALUES(?,?,?,?,?,?,?,?)", run.ID, run.SessionID, run.ChatID, run.AgentID, commandID, hash, run.Status, JSON(initial))
	if err != nil {
		return err
	}
	if run.Sequence == 0 {
		run.Sequence, err = r.LastInsertId()
		if err != nil {
			return err
		}
	}
	return SaveRun(tx, *run)
}

// SupersedeRuns removes turns from the active conversation while preserving their outcomes.
func SupersedeRuns(tx *sql.Tx, from model.Run, session *model.Session) error {
	if _, err := tx.Exec(`UPDATE runs SET data=json_set(data,'$.superseded',json('true'))
WHERE session_id=? AND position>=? AND status IN ('completed','failed','interrupted','paused')`, from.SessionID, from.Sequence); err != nil {
		return err
	}
	// Replacing the message that named a Topic also replaces its generated name.
	cleared, err := tx.Exec(`UPDATE sessions SET title_run_id=NULL,data=json_remove(data,'$.title')
WHERE id=? AND title_run_id=?`, session.ID, from.ID)
	if err != nil {
		return err
	}
	if n, err := cleared.RowsAffected(); err != nil {
		return err
	} else if n > 0 {
		session.Title = ""
	}
	if _, err := tx.Exec(`UPDATE sessions SET activity=json_set(activity,'$.title',COALESCE(json_extract(data,'$.title'),'')) WHERE id=? AND NOT EXISTS (
  SELECT 1 FROM runs WHERE session_id=? AND position<? AND status IN ('completed','failed','interrupted','paused')
)`, from.SessionID, from.SessionID, from.Sequence); err != nil {
		return err
	}
	return Event(tx, model.Event{Type: "run", ChatID: from.ChatID, RunID: from.ID})
}

func SaveRequest(tx *sql.Tx, request model.Request) error {
	_, err := tx.Exec("INSERT INTO requests(id,run_id,chat_id,status,data) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,data=excluded.data", request.ID, request.RunID, request.ChatID, request.Status, JSON(request))
	if err != nil {
		return err
	}
	if err := Event(tx, model.Event{Type: "request", ChatID: request.ChatID, Request: &request}); err != nil {
		return err
	}
	return requestActivity(tx, request)
}

func (s *Store) Subscribe() (<-chan struct{}, func()) {
	ch := make(chan struct{}, 1)
	s.mu.Lock()
	s.watchers[ch] = struct{}{}
	s.mu.Unlock()
	return ch, func() { s.mu.Lock(); delete(s.watchers, ch); s.mu.Unlock() }
}

func (s *Store) Events(ctx context.Context, after int64) ([]model.Event, error) {
	rows, err := s.DB.QueryContext(ctx, "SELECT sequence,data FROM events WHERE sequence>? ORDER BY sequence LIMIT 100", after)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []model.Event{}
	for rows.Next() {
		var e model.Event
		var raw string
		if err := rows.Scan(&e.Sequence, &raw); err != nil {
			return nil, err
		}
		seq := e.Sequence
		if err := json.Unmarshal([]byte(raw), &e); err != nil {
			return nil, err
		}
		e.Sequence = seq
		result = append(result, e)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if err := rows.Close(); err != nil {
		return nil, err
	}
	runs := map[string]*model.Run{}
	requests := map[string]*model.Request{}
	conversations := map[string]*model.Conversation{}
	for i := range result {
		e := &result[i]
		var sessionID string
		if e.RunID != "" {
			if runs[e.RunID] == nil {
				v, err := Get[model.Run](ctx, s.DB, `SELECT `+RunWithOverviewFields+` FROM runs r
LEFT JOIN channel_deliveries d ON d.run_id=r.id AND d.part='answer' WHERE r.id=?`, e.RunID)
				if err != nil {
					return nil, err
				}
				runs[e.RunID] = &v
			}
			e.Run = runs[e.RunID]
			sessionID = e.Run.SessionID
		}
		if e.RequestID != "" {
			if requests[e.RequestID] == nil {
				v, err := Get[model.Request](ctx, s.DB, "SELECT data FROM requests WHERE id=?", e.RequestID)
				if err != nil {
					return nil, err
				}
				requests[e.RequestID] = &v
			}
			e.Request = requests[e.RequestID]
			sessionID = e.Request.SessionID
		}
		if sessionID != "" {
			if conversations[sessionID] == nil {
				v, err := Get[model.Conversation](ctx, s.DB, ConversationQuery+" WHERE s.id=?", sessionID)
				if err != nil {
					return nil, err
				}
				conversations[sessionID] = &v
			}
			e.Conversation = conversations[sessionID]
		}
	}
	return result, nil
}

type RestartRun struct {
	ID       string `json:"id"`
	Continue bool   `json:"continue"`
}

const restartUnconfirmed = "The backend stopped before the runtime confirmed a result. Verify that the previous execution has stopped before continuing."

func (s *Store) Recover(ctx context.Context) ([]RestartRun, error) {
	var restarts []RestartRun
	err := s.Write(ctx, func(tx *sql.Tx) error {
		// Read stop and approval evidence before expiring requests or pausing queues.
		var err error
		restarts, err = List[RestartRun](ctx, tx, `SELECT json_object('id',r.id,'continue',json(CASE
			WHEN (json_extract(r.data,'$.resumeAfterShutdown')=1 OR (
				r.status IN ('starting','running') AND (json_extract(r.data,'$.nativeTurnId') IS NOT NULL OR
				json_extract(s.data,'$.queuePaused') IS NOT 1)))
			AND COALESCE(json_extract(r.data,'$.pauseRequested'),0)=0
			AND NOT EXISTS (SELECT 1 FROM requests WHERE run_id=r.id AND status='pending')
			THEN 'true' ELSE 'false' END))
			FROM runs r JOIN sessions s ON s.id=r.session_id
			JOIN providers p ON p.id=json_extract(r.data,'$.selection.provider')
			WHERE r.id NOT IN (SELECT run_id FROM runtime_hosts) AND json_extract(p.data,'$.type')='codex' AND COALESCE(json_extract(s.data,'$.nativeId'),'')<>''
			AND (r.status IN ('starting','running','waiting_user','cancelling') OR
				(r.status IN ('interrupted','unknown') AND json_extract(r.data,'$.resumeAfterShutdown')=1) OR
				(r.status='unknown' AND json_extract(r.data,'$.error')=?))
			AND NOT EXISTS (SELECT 1 FROM runs next WHERE next.session_id=r.session_id AND next.sequence>r.sequence
				AND next.status NOT IN ('queued','steering','steered','cancelled'))`, restartUnconfirmed)
		if err != nil {
			return err
		}
		if _, err := tx.Exec("UPDATE channel_deliveries SET status='unknown' WHERE status='sending'"); err != nil {
			return err
		}
		if _, err := tx.Exec("UPDATE personal_channel_turns SET context_ready=1 WHERE context_ready=0"); err != nil {
			return err
		}
		if _, err := tx.Exec("UPDATE personal_channel_turns SET reaction_status='unknown' WHERE reaction_status='pending'"); err != nil {
			return err
		}
		// A live worker retains its session queue. Other unfinished queues need an
		// explicit resume, except a queued run waiting only on live upstream hosts.
		if _, err := tx.Exec(`UPDATE sessions SET data=json_set(data,'$.queuePaused',json('true'))
WHERE id IN (SELECT session_id FROM runs WHERE status IN ('queued','steering','starting','running','waiting_user','cancelling'))
AND id NOT IN (SELECT r.session_id FROM runs r JOIN runtime_hosts h ON r.id=h.run_id)
AND NOT (
  NOT EXISTS (SELECT 1 FROM runs r WHERE r.session_id=sessions.id AND r.status IN ('steering','starting','running','waiting_user','cancelling'))
  AND EXISTS (
    SELECT 1 FROM runs q
    WHERE q.id=(SELECT id FROM runs WHERE session_id=sessions.id AND status='queued' ORDER BY sequence LIMIT 1)
    AND EXISTS (SELECT 1 FROM run_dependencies rd WHERE rd.run_id=q.id)
    AND EXISTS (SELECT 1 FROM run_dependencies rd JOIN runs dep ON dep.id=rd.after_run_id WHERE rd.run_id=q.id AND (dep.id IN (SELECT run_id FROM runtime_hosts) OR dep.status='queued'))
    AND NOT EXISTS (SELECT 1 FROM run_dependencies rd JOIN runs dep ON dep.id=rd.after_run_id WHERE rd.run_id=q.id AND dep.status NOT IN ('completed','queued') AND dep.id NOT IN (SELECT run_id FROM runtime_hosts))
  )
)`); err != nil {
			return err
		}
		steers, err := List[model.Run](ctx, tx, `SELECT data FROM runs WHERE (status='steering' OR (status='queued' AND json_extract(data,'$.steerRunId') IS NOT NULL))
			AND coalesce(json_extract(data,'$.steerRunId'),'') NOT IN (SELECT run_id FROM runtime_hosts)`)
		if err != nil {
			return err
		}
		for _, run := range steers {
			if run.Status == "queued" {
				run.SteerRunID, run.Delivery = "", "queue"
			} else {
				run.Status = "steered"
				run.Error = "Delivery was not confirmed before the backend stopped; this input will not be replayed."
			}
			if err := SaveRun(tx, run); err != nil {
				return err
			}
		}
		runs, err := List[model.Run](ctx, tx, "SELECT data FROM runs WHERE status IN ('starting','running','waiting_user','cancelling') AND id NOT IN (SELECT run_id FROM runtime_hosts)")
		if err != nil {
			return err
		}
		for _, run := range runs {
			run.Status = "unknown"
			run.CanSteer, run.SteerPending = false, false
			for i := range run.Items {
				if (run.Items[i].Kind == "user" || run.Items[i].Kind == "subagent") && run.Items[i].Status == "running" {
					run.Items[i].Status = "unknown"
				}
			}
			run.Error = restartUnconfirmed
			if err := SaveRun(tx, run); err != nil {
				return err
			}
		}
		requests, err := List[model.Request](ctx, tx, "SELECT data FROM requests WHERE status='pending' AND run_id NOT IN (SELECT run_id FROM runtime_hosts)")
		if err != nil {
			return err
		}
		for _, r := range requests {
			r.Status = "expired"
			if err := SaveRequest(tx, r); err != nil {
				return err
			}
		}
		return nil
	})
	return restarts, err
}

func (s *Store) SessionView(ctx context.Context, id string) (model.SessionView, error) {
	var v model.SessionView
	tx, err := s.DB.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return v, err
	}
	defer tx.Rollback()
	v.Session, err = Get[model.Session](ctx, tx, "SELECT data FROM sessions WHERE id=?", id)
	if err != nil {
		return v, err
	}
	if v.Session.SourceRunID != "" {
		v.Source, err = ReadTopicSource(ctx, tx, v.Session)
		if err != nil {
			return v, err
		}
	}
	// Match the topic root in View, including a queued first message. A topic
	// with all its queued messages removed still has a usable reply composer.
	root, err := Get[model.Run](ctx, tx, `SELECT `+RunWithWaitingOn+` FROM runs r
LEFT JOIN channel_deliveries d ON d.run_id=r.id AND d.part='answer'
WHERE r.session_id=? AND r.position IS NOT NULL AND r.status NOT IN ('steering','steered','cancelled') ORDER BY r.position LIMIT 1`, id)
	if err == nil {
		v.Root = &root
	} else if !errors.Is(err, sql.ErrNoRows) {
		return v, err
	}
	return v, tx.Commit()
}

func (s *Store) SessionRuns(ctx context.Context, id string, before int64) (model.SessionRuns, error) {
	return s.SessionRunPage(ctx, id, before, 40)
}

func (s *Store) SessionRunPage(ctx context.Context, id string, before int64, limit int) (model.SessionRuns, error) {
	if limit < 1 || limit > 40 {
		limit = 40
	}
	var v model.SessionRuns
	tx, err := s.DB.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return v, err
	}
	defer tx.Rollback()
	if before == 0 {
		before = 1 << 62
	}
	v.Runs, err = List[model.Run](ctx, tx, `SELECT `+RunWithWaitingOn+` FROM runs r
LEFT JOIN channel_deliveries d ON d.run_id=r.id AND d.part='answer'
WHERE r.session_id=? AND r.position<? AND r.status NOT IN ('queued','steering','steered','cancelled') ORDER BY r.position DESC LIMIT ?`, id, before, limit)
	if err != nil {
		return v, err
	}
	if err := tx.QueryRowContext(ctx, "SELECT COALESCE(MAX(sequence),0) FROM events").Scan(&v.Cursor); err != nil {
		return v, err
	}
	return v, tx.Commit()
}

func (s *Store) ChatTopics(ctx context.Context, chatID string, limit int) ([]model.TopicSummary, error) {
	page, err := s.readChatTopics(ctx, chatID, 0, limit)
	return page.Topics, err
}

func (s *Store) ChatTopicsPage(ctx context.Context, chatID string, before int64, limit int) (model.ChatTopicsPage, error) {
	if limit < 1 || limit > 40 {
		limit = 40
	}
	return s.readChatTopics(ctx, chatID, before, limit)
}

func (s *Store) readChatTopics(ctx context.Context, chatID string, before int64, limit int) (model.ChatTopicsPage, error) {
	page := model.ChatTopicsPage{Topics: []model.TopicSummary{}}
	if before == 0 {
		before = math.MaxInt64
	}
	fetch := limit
	if limit > 0 {
		fetch++ // Look ahead one row to distinguish a full last page from a continuation.
	}
	rows, err := s.DB.QueryContext(ctx, `
SELECT s.rowid, s.id, COALESCE(root.id,''), substr(COALESCE(
  NULLIF(json_extract(s.data,'$.title'),''),
  NULLIF(trim(json_extract(root.data,'$.input')),''),
  NULLIF(trim(json_extract(root.data,'$.quote.text')),''),
  json_extract(root.data,'$.attachments[0].name'),
  json_extract(root.data,'$.references[0].name'),''
),1,120), COALESCE((
  SELECT status FROM runs WHERE session_id=s.id AND position IS NOT NULL AND status NOT IN ('steering','steered','cancelled')
  ORDER BY position DESC LIMIT 1
),''), COALESCE(json_extract(s.data,'$.createdAt'),'')
FROM sessions s LEFT JOIN runs root ON root.id=(
  SELECT id FROM runs WHERE session_id=s.id AND position IS NOT NULL AND status NOT IN ('steering','steered','cancelled') ORDER BY position LIMIT 1
)
WHERE s.chat_id=? AND s.kind='topic' AND s.rowid<?
ORDER BY s.rowid DESC LIMIT ?`, chatID, before, fetch)
	if err != nil {
		return page, err
	}
	defer rows.Close()
	var position int64
	for rows.Next() {
		if limit > 0 && len(page.Topics) == limit {
			page.NextBefore = position
			break
		}
		var topic model.TopicSummary
		if err := rows.Scan(&position, &topic.ID, &topic.RootRunID, &topic.Title, &topic.Status, &topic.CreatedAt); err != nil {
			return page, err
		}
		page.Topics = append(page.Topics, topic)
	}
	return page, rows.Err()
}

func (s *Store) View(ctx context.Context, chatID string, before int64) (model.ChatView, error) {
	return s.ChatPage(ctx, chatID, before, 40)
}

const RunWithChannelReceipt = `CASE WHEN d.run_id IS NULL THEN r.data ELSE json_set(r.data,'$.channel',json_object('status',d.status)) END`

const runWaitingOnExpr = `(SELECT json_group_array(json(dep_json)) FROM (
  SELECT json_object(
    'runId', dep.id,
    'sessionId', dep.session_id,
    'chatId', dep.chat_id,
    'agentId', dep.agent_id,
    'topic', json(CASE WHEN ds.kind='topic' THEN 'true' ELSE 'false' END),
    'title', substr(COALESCE(
      CASE WHEN ds.kind='topic' THEN NULLIF(json_extract(ds.data,'$.title'),'') ELSE NULLIF(json_extract(dc.data,'$.title'),'') END,
      NULLIF(trim(json_extract(dep.data,'$.input')),''),
      NULLIF(trim(json_extract(dep.data,'$.quote.text')),''),
      json_extract(dep.data,'$.attachments[0].name'),
      json_extract(dep.data,'$.references[0].name'),
      ''
    ), 1, 120),
    'status', dep.status
  ) AS dep_json
  FROM run_dependencies rd
  JOIN runs dep ON dep.id = rd.after_run_id
  JOIN sessions ds ON ds.id = dep.session_id
  JOIN chats dc ON dc.id = dep.chat_id
  WHERE rd.run_id = r.id
  ORDER BY rd.rowid
))`

const RunWithWaitingOn = `CASE WHEN EXISTS(SELECT 1 FROM run_dependencies rd WHERE rd.run_id=r.id) THEN json_set(` + RunWithChannelReceipt + `,'$.waitingOn',json(` + runWaitingOnExpr + `)) ELSE ` + RunWithChannelReceipt + ` END`

const RunWithOverviewFields = `CASE WHEN r.status IN ('starting','running','waiting_user','cancelling','unknown','queued','paused') THEN json_set(` + RunWithWaitingOn + `,'$.scopePaths',json(COALESCE((SELECT json_group_array(root.value->>'path') FROM sessions rs, json_each(rs.data,'$.roots') root WHERE rs.id=r.session_id),'[]'))) ELSE ` + RunWithWaitingOn + ` END`

func (s *Store) ChatPage(ctx context.Context, chatID string, before int64, limit int) (model.ChatView, error) {
	if limit < 1 || limit > 40 {
		limit = 40
	}
	v := model.ChatView{Sessions: []model.Session{}, Entries: []model.TimelineEntry{}, Runs: []model.Run{}, Requests: []model.Request{}}
	tx, err := s.DB.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return v, err
	}
	defer tx.Rollback()
	v.Chat, err = Get[model.Chat](ctx, tx, "SELECT "+ChatDisplayData+" FROM chats WHERE id=?", chatID)
	if err != nil {
		return v, err
	}
	if before == 0 {
		before = 1 << 62
	}
	// A comparison takes one position in its source Chat. Its local Topic is
	// represented by that entry. Other Agents retain their normal Topic entries.
	// A Topic created from a turn is represented by the action on that turn.
	rows, err := tx.QueryContext(ctx, `SELECT r.position, s.kind, `+RunWithWaitingOn+`, COALESCE(topic.id,'') FROM runs r JOIN sessions s ON r.session_id=s.id
LEFT JOIN channel_deliveries d ON d.run_id=r.id AND d.part='answer'
LEFT JOIN sessions topic ON s.kind='main' AND topic.chat_id=r.chat_id AND topic.kind='topic' AND json_extract(topic.data,'$.sourceRunId')=r.id
WHERE r.chat_id=? AND r.position<? AND r.status NOT IN ('steering','steered','cancelled')
AND COALESCE(json_extract(s.data,'$.comparison.chatId'),'')!=r.chat_id
AND ((s.kind='main' AND r.status!='queued') OR (s.kind='topic' AND json_extract(s.data,'$.sourceRunId') IS NULL AND r.position=(
  SELECT MIN(position) FROM runs WHERE session_id=s.id AND status NOT IN ('steering','steered','cancelled')
)))
UNION ALL SELECT position,'comparison',data,'' FROM comparisons WHERE chat_id=? AND position<?
ORDER BY 1 DESC LIMIT ?`, chatID, before, chatID, before, limit+1)
	if err != nil {
		return v, err
	}
	defer rows.Close()
	type entry struct {
		position                  int64
		kind, data, sourceTopicID string
	}
	entries := make([]entry, 0, limit+1)
	for rows.Next() {
		var e entry
		if err := rows.Scan(&e.position, &e.kind, &e.data, &e.sourceTopicID); err != nil {
			return v, err
		}
		entries = append(entries, e)
	}
	if err := rows.Err(); err != nil {
		return v, err
	}
	if err := rows.Close(); err != nil {
		return v, err
	}
	v.HasMore = len(entries) > limit
	if v.HasMore {
		entries = entries[:limit]
	}
	sessions := map[string]model.Session{}
	main, err := Get[model.Session](ctx, tx, "SELECT data FROM sessions WHERE chat_id=? AND kind='main'", chatID)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return v, err
	}
	for i := len(entries) - 1; i >= 0; i-- {
		entry := entries[i]
		if entry.kind == "comparison" {
			var comparison model.Comparison
			if err := json.Unmarshal([]byte(entry.data), &comparison); err != nil {
				return v, err
			}
			v.Entries = append(v.Entries, model.TimelineEntry{Kind: entry.kind, Sequence: entry.position, ComparisonID: comparison.ID})
			v.Comparisons = append(v.Comparisons, comparison)
			continue
		}
		var run model.Run
		if err := json.Unmarshal([]byte(entry.data), &run); err != nil {
			return v, err
		}
		session, ok := sessions[run.SessionID]
		if !ok {
			if run.SessionID == main.ID {
				session = main
			} else {
				session, err = Get[model.Session](ctx, tx, "SELECT data FROM sessions WHERE id=?", run.SessionID)
				if err != nil {
					return v, err
				}
			}
			v.Sessions = append(v.Sessions, session)
			sessions[run.SessionID] = session
		}
		count := 0
		if session.Kind == "topic" {
			if err := tx.QueryRowContext(ctx, "SELECT COUNT(*)-1 FROM runs WHERE session_id=? AND position IS NOT NULL AND status NOT IN ('queued','steering','steered','cancelled')", session.ID).Scan(&count); err != nil {
				return v, err
			}
			count = max(0, count)
		}
		v.Entries = append(v.Entries, model.TimelineEntry{SessionID: session.ID, RunID: run.ID, Kind: session.Kind, Sequence: run.Sequence, ReplyCount: count, SourceTopicID: entry.sourceTopicID})
		v.Runs = append(v.Runs, run)
	}
	if _, seen := sessions[main.ID]; main.ID != "" && !seen {
		v.Sessions = append(v.Sessions, main)
	}
	v.Requests, err = List[model.Request](ctx, tx, "SELECT data FROM requests WHERE chat_id=? AND status='pending'", chatID)
	if err != nil {
		return v, err
	}
	if err := tx.QueryRowContext(ctx, "SELECT COALESCE(MAX(sequence),0) FROM events").Scan(&v.Cursor); err != nil {
		return v, err
	}
	return v, tx.Commit()
}
