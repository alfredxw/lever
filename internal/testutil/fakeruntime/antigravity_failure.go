package main

import (
	"database/sql"
	"errors"
	"os"
	"path/filepath"
	"strings"

	_ "modernc.org/sqlite"
)

func fixtureAntigravityFailure(native string, history []string) error {
	scenario := fixtureCommands(history[0])
	if strings.HasPrefix(scenario, "[agy-token-text]") || (len(history) > 1 && !strings.HasPrefix(scenario, "[agy-token-persistent]")) {
		return nil
	}
	profile := os.Getenv("ANTIGRAVITY_CLI_CONFIG_DIR")
	if !filepath.IsAbs(profile) {
		return errors.New("failure fixture requires an isolated CLI directory")
	}
	dir := filepath.Join(profile, "conversations")
	if err := os.MkdirAll(dir, 0700); err != nil {
		return err
	}
	db, err := sql.Open("sqlite", filepath.Join(dir, native+".db"))
	if err != nil {
		return err
	}
	defer db.Close()
	if _, err := db.Exec(`CREATE TABLE IF NOT EXISTS steps (idx INTEGER PRIMARY KEY, step_type INTEGER, status INTEGER, step_payload BLOB)`); err != nil {
		return err
	}
	status := "UNAUTHENTICATED (code 401): private-fixture-detail"
	if strings.HasPrefix(scenario, "[agy-token-forbidden]") {
		status = "PERMISSION_DENIED (code 403): private-fixture-detail"
	}
	_, err = db.Exec(`INSERT INTO steps(step_type, status, step_payload) VALUES (14, 3, NULL), (17, 3, ?)`, []byte(status))
	return err
}
