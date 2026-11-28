package localstats

import (
	"bytes"
	"database/sql"
	"encoding/gob"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	_ "modernc.org/sqlite"
)

const cacheSchemaVersion = 2

type cachedRun struct {
	Status    string
	CreatedAt time.Time
	Additions int
	Deletions int
}

type cachedAgySummary struct {
	Fingerprint string
	Summaries   map[string]agySummaryMeta
}

type diskCache struct {
	mu     sync.Mutex
	db     *sql.DB
	closed bool
}

func openDiskCache(stateDir string) (*diskCache, error) {
	stateDir = strings.TrimSpace(stateDir)
	if stateDir == "" {
		return nil, nil
	}
	if err := os.MkdirAll(stateDir, 0o700); err != nil {
		return nil, err
	}
	abs, err := filepath.Abs(filepath.Join(stateDir, "local_stats_cache.db"))
	if err != nil {
		return nil, err
	}
	slash := filepath.ToSlash(abs)
	if !strings.HasPrefix(slash, "/") {
		slash = "/" + slash
	}
	uri := url.URL{
		Scheme:   "file",
		Path:     slash,
		RawQuery: "_pragma=journal_mode(WAL)&_pragma=synchronous(NORMAL)&_pragma=busy_timeout(2000)",
	}
	db, err := sql.Open("sqlite", uri.String())
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	_, err = db.Exec(`
		CREATE TABLE IF NOT EXISTS file_cache (
			path TEXT PRIMARY KEY,
			schema_ver INTEGER NOT NULL,
			fingerprint TEXT NOT NULL,
			payload BLOB NOT NULL
		);
		CREATE TABLE IF NOT EXISTS run_cache (
			id TEXT PRIMARY KEY,
			status TEXT NOT NULL,
			created_at INTEGER NOT NULL,
			additions INTEGER NOT NULL,
			deletions INTEGER NOT NULL
		);
		CREATE TABLE IF NOT EXISTS agy_summary_cache (
			path TEXT PRIMARY KEY,
			fingerprint TEXT NOT NULL,
			payload BLOB NOT NULL
		);
	`)
	if err != nil {
		_ = db.Close()
		return nil, err
	}
	return &diskCache{db: db}, nil
}

func (c *diskCache) close() {
	if c == nil {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed {
		return
	}
	c.closed = true
	if c.db != nil {
		_ = c.db.Close()
		c.db = nil
	}
}

func (c *diskCache) loadAll() (map[string]cachedFile, map[string]cachedRun, map[string]cachedAgySummary) {
	files := make(map[string]cachedFile)
	runs := make(map[string]cachedRun)
	summaries := make(map[string]cachedAgySummary)
	if c == nil {
		return files, runs, summaries
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed || c.db == nil {
		return files, runs, summaries
	}

	if rows, err := c.db.Query("SELECT path, fingerprint, payload FROM file_cache WHERE schema_ver = ?", cacheSchemaVersion); err == nil {
		for rows.Next() {
			var path, fp string
			var blob []byte
			if rows.Scan(&path, &fp, &blob) != nil {
				continue
			}
			var pf parsedFile
			if gob.NewDecoder(bytes.NewReader(blob)).Decode(&pf) == nil {
				files[path] = cachedFile{fingerprint: fp, parsed: pf}
			}
		}
		rows.Close()
	}

	if rows, err := c.db.Query("SELECT id, status, created_at, additions, deletions FROM run_cache"); err == nil {
		for rows.Next() {
			var id, status string
			var createdUnixNano int64
			var add, del int
			if rows.Scan(&id, &status, &createdUnixNano, &add, &del) != nil {
				continue
			}
			var ts time.Time
			if createdUnixNano != 0 {
				ts = time.Unix(0, createdUnixNano).UTC()
			}
			runs[id] = cachedRun{
				Status:    status,
				CreatedAt: ts,
				Additions: add,
				Deletions: del,
			}
		}
		rows.Close()
	}

	if rows, err := c.db.Query("SELECT path, fingerprint, payload FROM agy_summary_cache"); err == nil {
		for rows.Next() {
			var path, fp string
			var blob []byte
			if rows.Scan(&path, &fp, &blob) != nil {
				continue
			}
			var m map[string]agySummaryMeta
			if gob.NewDecoder(bytes.NewReader(blob)).Decode(&m) == nil {
				summaries[path] = cachedAgySummary{Fingerprint: fp, Summaries: m}
			}
		}
		rows.Close()
	}

	return files, runs, summaries
}

func (c *diskCache) saveBatch(
	files map[string]cachedFile,
	runs map[string]cachedRun,
	summaries map[string]cachedAgySummary,
	pruneFiles []string,
	pruneRuns []string,
) {
	if c == nil {
		return
	}
	if len(files) == 0 && len(runs) == 0 && len(summaries) == 0 && len(pruneFiles) == 0 && len(pruneRuns) == 0 {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed || c.db == nil {
		return
	}

	tx, err := c.db.Begin()
	if err != nil {
		return
	}

	var buf bytes.Buffer
	if len(files) > 0 {
		if stmt, err := tx.Prepare(`INSERT INTO file_cache(path, schema_ver, fingerprint, payload) VALUES(?, ?, ?, ?)
			ON CONFLICT(path) DO UPDATE SET schema_ver=excluded.schema_ver, fingerprint=excluded.fingerprint, payload=excluded.payload`); err == nil {
			for path, cf := range files {
				buf.Reset()
				if gob.NewEncoder(&buf).Encode(cf.parsed) != nil {
					continue
				}
				_, _ = stmt.Exec(path, cacheSchemaVersion, cf.fingerprint, buf.Bytes())
			}
			_ = stmt.Close()
		}
	}

	if len(runs) > 0 {
		if stmt, err := tx.Prepare(`INSERT INTO run_cache(id, status, created_at, additions, deletions) VALUES(?, ?, ?, ?, ?)
			ON CONFLICT(id) DO UPDATE SET status=excluded.status, created_at=excluded.created_at, additions=excluded.additions, deletions=excluded.deletions`); err == nil {
			for id, r := range runs {
				var ns int64
				if !r.CreatedAt.IsZero() {
					ns = r.CreatedAt.UTC().UnixNano()
				}
				_, _ = stmt.Exec(id, r.Status, ns, r.Additions, r.Deletions)
			}
			_ = stmt.Close()
		}
	}

	if len(summaries) > 0 {
		if stmt, err := tx.Prepare(`INSERT INTO agy_summary_cache(path, fingerprint, payload) VALUES(?, ?, ?)
			ON CONFLICT(path) DO UPDATE SET fingerprint=excluded.fingerprint, payload=excluded.payload`); err == nil {
			for path, sm := range summaries {
				buf.Reset()
				if gob.NewEncoder(&buf).Encode(sm.Summaries) != nil {
					continue
				}
				_, _ = stmt.Exec(path, sm.Fingerprint, buf.Bytes())
			}
			_ = stmt.Close()
		}
	}

	if len(pruneFiles) > 0 {
		if stmt, err := tx.Prepare("DELETE FROM file_cache WHERE path = ?"); err == nil {
			for _, p := range pruneFiles {
				_, _ = stmt.Exec(p)
			}
			_ = stmt.Close()
		}
	}

	if len(pruneRuns) > 0 {
		if stmt, err := tx.Prepare("DELETE FROM run_cache WHERE id = ?"); err == nil {
			for _, id := range pruneRuns {
				_, _ = stmt.Exec(id)
			}
			_ = stmt.Close()
		}
	}

	// Clean up rows from older schema versions if any.
	_, _ = tx.Exec("DELETE FROM file_cache WHERE schema_ver != ?", cacheSchemaVersion)

	if err := tx.Commit(); err != nil {
		_ = tx.Rollback()
	}
}
