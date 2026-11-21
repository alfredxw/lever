package provider

import (
	"context"
	"database/sql"
	"errors"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"time"

	acp "github.com/coder/acp-go-sdk"
	"lever/internal/model"
	_ "modernc.org/sqlite"
)

var antigravitySessionID = regexp.MustCompile(`^[\w-]+$`)

// The official agent can report an upstream error as text followed by end_turn.
// Check new native trajectory steps to distinguish that from success.
// Read only this session's own regular database, and never echo its raw payload.
func watchAntigravityOutcome(ctx context.Context, config model.Provider, native string) func(acp.StopReason) error {
	check := func(reason acp.StopReason) error {
		if reason == acp.StopReasonRefusal {
			return errors.New("Antigravity refused the turn or exhausted the account quota")
		}
		return nil
	}
	if !antigravitySessionID.MatchString(native) {
		return check
	}
	dir, err := antigravityDir(ctx)
	if err != nil {
		return check
	}
	profile := antigravityProfileDir(dir, config.ID)
	dataDir := filepath.Join(profile, "antigravity-acp")
	if executable, err := Executable(ctx, config); err == nil && IsAntigravityCLI(config, executable) {
		profile = os.Getenv("ANTIGRAVITY_CLI_CONFIG_DIR")
		if profile == "" {
			home, err := os.UserHomeDir()
			if err != nil {
				return check
			}
			profile = filepath.Join(home, ".gemini", "antigravity-cli")
		}
		if !filepath.IsAbs(profile) {
			return check
		}
		dataDir = profile
	}
	path := filepath.Join(dataDir, "conversations", native+".db")
	regular := func() os.FileInfo {
		for _, parent := range []string{profile, dataDir, filepath.Dir(path)} {
			info, err := os.Lstat(parent)
			if err != nil || !info.IsDir() {
				return nil
			}
		}
		info, err := os.Lstat(path)
		if err != nil || !info.Mode().IsRegular() {
			return nil
		}
		return info
	}
	read := func(query string, args ...any) (int, error) {
		uriPath := filepath.ToSlash(path)
		if volume := filepath.VolumeName(path); len(volume) == 2 && volume[1] == ':' {
			uriPath = "/" + uriPath
		}
		connection := (&url.URL{Scheme: "file", Path: uriPath}).String() + "?mode=ro"
		db, err := sql.Open("sqlite", connection)
		if err != nil {
			return 0, err
		}
		defer db.Close()
		readCtx, cancel := context.WithTimeout(ctx, time.Second)
		defer cancel()
		var value int
		err = db.QueryRowContext(readCtx, query, args...).Scan(&value)
		return value, err
	}
	before, index := regular(), -1
	if before != nil {
		if value, err := read("SELECT COALESCE(MAX(idx), -1) FROM steps"); err == nil {
			index = value
		} else {
			return check
		}
	} else if _, err := os.Lstat(path); !errors.Is(err, os.ErrNotExist) {
		return check
	}
	return func(reason acp.StopReason) error {
		if err := check(reason); err != nil {
			return err
		}
		after := regular()
		if after == nil || (before != nil && !os.SameFile(before, after)) {
			return nil
		}
		step, err := read("SELECT step_type FROM steps WHERE idx > ? ORDER BY idx DESC LIMIT 1", index)
		if err == nil && step == 17 {
			return errors.New("Antigravity stopped this turn because of a provider error. See its response for details.")
		}
		return nil
	}
}
