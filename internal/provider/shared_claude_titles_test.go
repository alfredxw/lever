package provider

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"lever/internal/model"
)

func TestSharedClaudeFollowsNativeTitles(t *testing.T) {
	config := model.Provider{Type: "claude", ConfigDir: t.TempDir()}
	t.Setenv("HOME", t.TempDir())
	t.Setenv("LOCALAPPDATA", t.TempDir())
	dir := filepath.Join(config.ConfigDir, "projects", "sample")
	if err := os.MkdirAll(dir, 0700); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, "78b8440e-9c0c-4558-8909-2728d46764a8.jsonl")
	const user = `{"type":"user","uuid":"opening","cwd":"/sample","entrypoint":"cli","message":{"content":"Opening question"}}`
	const reply = `{"type":"assistant","uuid":"answer","message":{"content":[{"type":"text","text":"Latest answer"}]}}`
	write := func(flags int, records ...string) {
		t.Helper()
		f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|flags, 0600)
		if err != nil {
			t.Fatal(err)
		}
		_, err = f.WriteString(strings.Join(records, "\n") + "\n")
		if closeErr := f.Close(); closeErr != nil || err != nil {
			t.Fatalf("write transcript: %v, close: %v", err, closeErr)
		}
	}
	check := func(want string) {
		t.Helper()
		rows, err := ListShared(t.Context(), config, nil)
		if err != nil || len(rows) != 1 || rows[0].Title != want || rows[0].Preview != "Latest answer" {
			t.Fatalf("expected title %q and latest reply, got %+v, %v", want, rows, err)
		}
	}
	write(os.O_TRUNC, user, reply)
	check("Opening question")
	write(os.O_APPEND, `{"type":"ai-title","aiTitle":"First summary"}`)
	check("First summary")
	// On first discovering a long transcript, a manual rename can predate
	// both the latest summary and the window used for message previews.
	write(os.O_TRUNC, user, `{"type":"custom-title","customTitle":"My name"}`,
		`{"type":"tool","content":"`+strings.Repeat("x", 2<<20)+`"}`, reply,
		`{"type":"ai-title","aiTitle":"New summary"}`)
	check("My name")
	write(os.O_APPEND, `{"type":"ai-title","aiTitle":"Newest summary"}`)
	check("My name")
	write(os.O_APPEND, `{"type":"custom-title","customTitle":""}`)
	check("Newest summary")
	write(os.O_TRUNC, user, reply)
	check("Opening question")
}
