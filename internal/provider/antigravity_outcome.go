package provider

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	acp "github.com/coder/acp-go-sdk"
	"lever/internal/model"
	_ "modernc.org/sqlite"
)

var antigravitySessionID = regexp.MustCompile(`^[\w-]+$`)
var errAntigravityProvider = errors.New("Antigravity stopped this turn because of a provider error. See its response for details.")
var errAntigravityUnauthenticated = errors.New("Antigravity returned UNAUTHENTICATED (HTTP 401).")

// Error steps can also contain HTTP headers, response bodies and stack traces.
// Extract only the HTTP code and Google RPC status from the two native formats.
const antigravityErrorPayload = "substr(step_payload, 1, 16384)"

// A protobuf length byte directly before the status may itself be printable.
const googleRPCErrorStatus = `(CANCELLED|UNKNOWN|INVALID_ARGUMENT|DEADLINE_EXCEEDED|NOT_FOUND|ALREADY_EXISTS|PERMISSION_DENIED|RESOURCE_EXHAUSTED|FAILED_PRECONDITION|ABORTED|OUT_OF_RANGE|UNIMPLEMENTED|INTERNAL|UNAVAILABLE|DATA_LOSS|UNAUTHENTICATED)`

var antigravityStatusError = regexp.MustCompile(googleRPCErrorStatus + ` \(code ([45][0-9]{2})\):`)
var antigravityAPIError = regexp.MustCompile(`Error ([45][0-9]{2}), Message: [^\x00]*?, Status: ` + googleRPCErrorStatus + `\b`)

func antigravityStepError(payload []byte, fallback error) error {
	var status, code []byte
	if m := antigravityStatusError.FindSubmatch(payload); m != nil {
		status, code = m[1], m[2]
	} else if m := antigravityAPIError.FindSubmatch(payload); m != nil {
		status, code = m[2], m[1]
	} else {
		return fallback
	}
	if string(status) == "UNAUTHENTICATED" && string(code) == "401" {
		return errAntigravityUnauthenticated
	}
	return fmt.Errorf("Antigravity returned %s (HTTP %s).", status, code)
}

type antigravitySessionDB struct {
	profile, dataDir, path string
}

func openAntigravitySessionDB(ctx context.Context, config model.Provider, native string) *antigravitySessionDB {
	if !antigravitySessionID.MatchString(native) {
		return nil
	}
	var profile, dataDir string
	executable, err := Executable(ctx, config)
	if err != nil {
		executable = config.Command
	}
	if IsAntigravityCLI(config, executable) {
		profile = os.Getenv("ANTIGRAVITY_CLI_CONFIG_DIR")
		if profile == "" {
			gemini := os.Getenv("GEMINI_HOME")
			if gemini == "" {
				home, err := os.UserHomeDir()
				if err != nil {
					return nil
				}
				gemini = filepath.Join(home, ".gemini")
			}
			if !filepath.IsAbs(gemini) {
				return nil
			}
			profile = filepath.Join(gemini, "antigravity-cli")
		}
		if !filepath.IsAbs(profile) {
			return nil
		}
		dataDir = profile
	} else {
		dir, err := antigravityDir(ctx)
		if err != nil {
			return nil
		}
		profile = antigravityProfileDir(dir, config.ID)
		dataDir = filepath.Join(profile, "antigravity-acp")
	}
	return &antigravitySessionDB{
		profile: profile,
		dataDir: dataDir,
		path:    filepath.Join(dataDir, "conversations", native+".db"),
	}
}

// AntigravityArtifactDir returns the native artifact directory (brain/<native>)
// for an Antigravity session, or "" if it cannot be resolved.
func AntigravityArtifactDir(ctx context.Context, config model.Provider, native string) string {
	db := openAntigravitySessionDB(ctx, config, native)
	if db == nil {
		return ""
	}
	profile, err := os.OpenRoot(db.profile)
	if err != nil {
		return ""
	}
	defer profile.Close()
	relative, err := filepath.Rel(db.profile, db.dataDir)
	if err != nil {
		return ""
	}
	directory, err := openManagedSubdir(profile, relative, "brain", native)
	if err != nil {
		return ""
	}
	defer directory.Close()
	return directory.Name()
}

func (s *antigravitySessionDB) regular() os.FileInfo {
	if s == nil {
		return nil
	}
	for _, parent := range []string{s.profile, s.dataDir, filepath.Dir(s.path)} {
		info, err := os.Lstat(parent)
		if err != nil || !info.IsDir() {
			return nil
		}
	}
	info, err := os.Lstat(s.path)
	if err != nil || !info.Mode().IsRegular() {
		return nil
	}
	return info
}

func (s *antigravitySessionDB) open() (*sql.DB, error) {
	uri := url.URL{Scheme: "file", Path: filepath.ToSlash(s.path)}
	if !strings.HasPrefix(uri.Path, "/") {
		uri.Path = "/" + uri.Path
	}
	query := url.Values{"mode": {"ro"}, "_pragma": {"busy_timeout(500)"}}
	// SQLite needs the WAL index in read-only mode. A closed session can remove
	// it; an absent or empty WAL has no commit that could be lost.
	if _, err := os.Stat(s.path + "-shm"); errors.Is(err, os.ErrNotExist) {
		if wal, walErr := os.Stat(s.path + "-wal"); errors.Is(walErr, os.ErrNotExist) || walErr == nil && wal.Size() <= 32 {
			query.Set("immutable", "1")
		}
	}
	uri.RawQuery = query.Encode()
	return sql.Open("sqlite", uri.String())
}

func (s *antigravitySessionDB) watchBackground() func(context.Context) antigravityProbeState {
	if s == nil {
		return nil
	}
	before := s.regular()
	if before == nil {
		if _, err := os.Lstat(s.path); !errors.Is(err, os.ErrNotExist) {
			return nil
		}
	}
	return func(ctx context.Context) antigravityProbeState {
		after := s.regular()
		if after == nil || (before != nil && !os.SameFile(before, after)) {
			return antigravityProbeIdle
		}
		db, err := s.open()
		if err != nil {
			return antigravityProbeIdle
		}
		defer db.Close()
		readCtx, cancel := context.WithTimeout(ctx, time.Second)
		defer cancel()
		var stepType, status int
		if err := db.QueryRowContext(readCtx, "SELECT step_type, status FROM steps ORDER BY idx DESC LIMIT 1").Scan(&stepType, &status); err != nil {
			return antigravityProbeIdle
		}
		return classifyAntigravityStep(stepType, status)
	}
}

func classifyAntigravityStep(stepType, status int) antigravityProbeState {
	switch stepType {
	case 14, 101: // USER_INPUT or SYSTEM_MESSAGE (background command/subagent/timer wakeup)
		return antigravityProbePending
	case 132: // Tool step awaiting a planner response (unless canceled)
		if status == 6 {
			return antigravityProbeIdle
		}
		return antigravityProbePending
	}
	if status == 2 || status == 8 { // RUNNING or GENERATING
		return antigravityProbeGenerating
	}
	return antigravityProbeIdle
}

// The official agent can report an upstream error as text followed by end_turn.
// Check new native trajectory steps to distinguish that from success.
// Read only this session's own regular database, and never echo its raw payload.
func watchAntigravityOutcome(ctx context.Context, config model.Provider, native string) func(acp.StopReason) error {
	return watchAntigravityOutcomeDB(ctx, openAntigravitySessionDB(ctx, config, native))
}

func watchAntigravityOutcomeDB(ctx context.Context, sessionDB *antigravitySessionDB) func(acp.StopReason) error {
	check := func(reason acp.StopReason) error {
		if reason == acp.StopReasonRefusal {
			return errors.New("Antigravity refused the turn or exhausted the account quota")
		}
		return nil
	}
	if sessionDB == nil {
		return check
	}
	read := func(query string, arg int, dest ...any) error {
		db, err := sessionDB.open()
		if err != nil {
			return err
		}
		defer db.Close()
		readCtx, cancel := context.WithTimeout(ctx, time.Second)
		defer cancel()
		return db.QueryRowContext(readCtx, query, arg).Scan(dest...)
	}
	before, index := sessionDB.regular(), -1
	if before != nil {
		if err := read("SELECT COALESCE(MAX(idx), ?) FROM steps", -1, &index); err != nil {
			return check
		}
	} else if _, err := os.Lstat(sessionDB.path); !errors.Is(err, os.ErrNotExist) {
		return check
	}
	return func(reason acp.StopReason) error {
		fallback := check(reason)
		if reason == acp.StopReasonCancelled {
			return fallback
		}
		after := sessionDB.regular()
		if after == nil || (before != nil && !os.SameFile(before, after)) {
			return fallback
		}
		const latest = " FROM steps WHERE idx > ? ORDER BY idx DESC LIMIT 1"
		var step, last int
		var payload []byte
		err := read("SELECT idx, step_type, CASE WHEN step_type = 17 THEN "+antigravityErrorPayload+" END"+latest, index, &last, &step, &payload)
		if err != nil && !errors.Is(err, sql.ErrNoRows) {
			// Older trajectories may record the error type without a payload column.
			err = read("SELECT step_type"+latest, index, &step)
		}
		if err == nil && step == 17 {
			if fallback == nil {
				fallback = errAntigravityProvider
			}
			failure := antigravityStepError(payload, fallback)
			if failure == errAntigravityUnauthenticated && (reason == acp.StopReasonEndTurn || reason == acp.StopReasonRefusal) {
				return &antigravityAuthCheckpoint{store: sessionDB, file: after, before: index, last: last}
			}
			return failure
		}
		return fallback
	}
}
