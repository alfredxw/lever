package provider

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	acp "github.com/coder/acp-go-sdk"
	"lever/internal/model"
)

func TestAntigravityUsesOnlyAdvertisedSkillReferences(t *testing.T) {
	dir := t.TempDir()
	file := filepath.Join(dir, "notes.md")
	if err := os.WriteFile(file, []byte("notes"), 0600); err != nil {
		t.Fatal(err)
	}
	review := model.Reference{Kind: "skill", Name: "review", Provider: "agy", Path: filepath.Join(dir, "review", model.SkillEntry)}
	verify := model.Reference{Kind: "skill", Name: "verify", Provider: "codex", Path: filepath.Join(dir, "verify", model.SkillEntry)}
	input := Input{
		Provider: model.Provider{ID: "agy", Type: "antigravity"}, Text: "Review this", Profile: model.Profile{Instructions: "Agent context"}, HistoryContext: "Prior turn",
		Attachments: []Attachment{{Attachment: model.Attachment{Name: "notes.md", MediaType: "text/markdown"}, Path: file}},
		References:  []model.Reference{review, verify, review, {Kind: "file", Name: "notes.md", Path: file}},
		Skills:      SkillPlan{AntigravitySkills: map[string]string{review.Path: "review-selected", verify.Path: "verify-selected"}},
	}
	for _, test := range []struct {
		name                       string
		multiRoot                  bool
		commands                   []model.NativeCommand
		wantPrefix                 string
		reviewNative, verifyNative bool
	}{
		{"both advertised", true, []model.NativeCommand{{Name: "review-selected"}, {Name: "verify-selected"}}, "/review-selected /verify-selected Agent instructions:", true, true},
		{"one advertised", true, []model.NativeCommand{{Name: "review"}, {Name: "verify-selected"}}, "/verify-selected Agent instructions:", false, true},
		{"no announcement", true, nil, "Agent instructions:", false, false},
		{"no directory support", false, []model.NativeCommand{{Name: "review-selected"}}, "Agent instructions:", false, false},
	} {
		t.Run(test.name, func(t *testing.T) {
			blocks, err := acpPrompt(input, model.ProviderCapabilities{MultiRoot: test.multiRoot, Files: true}, test.commands)
			if err != nil || len(blocks) != 2 || blocks[1].Resource == nil {
				t.Fatalf("missing attachment: %v, %v", blocks, err)
			}
			text := blocks[0].Text.Text
			if !strings.HasPrefix(text, test.wantPrefix) || strings.Contains(text, review.Path) == test.reviewNative || strings.Contains(text, verify.Path) == test.verifyNative {
				t.Fatalf("unexpected native commands or fallback paths: %s", text)
			}
			for _, want := range []string{"Agent context", "Prior turn", "Review this", "[Attached file", "[Referenced file"} {
				if !strings.Contains(text, want) {
					t.Fatalf("lost %q from the prompt: %s", want, text)
				}
			}
		})
	}
}

func TestAntigravityDetectsUserCLIAndHonorsExplicitPaths(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	t.Setenv("LEVER_ANTIGRAVITY_PATH", "")
	name := "agy"
	if runtime.GOOS == "windows" {
		name += ".exe"
	}
	userBin := filepath.Join(home, ".local", "bin")
	pathBin := t.TempDir()
	for _, dir := range []string{userBin, pathBin} {
		if err := os.MkdirAll(dir, 0700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dir, name), []byte("fixture"), 0700); err != nil {
			t.Fatal(err)
		}
	}
	t.Setenv("PATH", pathBin)
	config := model.Provider{ID: "antigravity", Type: "antigravity", Command: "agy"}
	if path, err := Executable(context.Background(), config); err != nil || path != filepath.Join(userBin, name) {
		t.Fatal("user installation was not detected before PATH", path, err)
	}
	t.Setenv("LEVER_ANTIGRAVITY_PATH", filepath.Join(pathBin, name))
	if path, err := Executable(context.Background(), config); err != nil || path != filepath.Join(pathBin, name) {
		t.Fatal("explicit installation was ignored", path, err)
	}
	config.Command = filepath.Join(userBin, name)
	if path, err := Executable(context.Background(), config); err != nil || path != config.Command {
		t.Fatal("a configured executable was replaced", path, err)
	}
}

func TestAntigravityFiltersSignInOutput(t *testing.T) {
	valid := "https://accounts.google.com/o/oauth2/v2/auth?response_type=code&state=nonce&redirect_uri=http%3A%2F%2F127.0.0.1%3A43210%2F"
	for _, raw := range []string{valid, strings.Replace(valid, "https:", "http:", 1), strings.Replace(valid, "accounts.google.com", "evil.example", 1), strings.Replace(valid, "127.0.0.1", "localhost", 1), valid + "&state=second", strings.Replace(valid, "43210", "80", 1)} {
		err := antigravityAuthorizationURL(raw)
		if (err == nil) != (raw == valid) {
			t.Fatalf("URL validation: %s: %v", raw, err)
		}
	}
	links := []string{}
	o := &antigravityOutput{cancel: func() {}, onURL: func(link string) { links = append(links, link) }}
	reader := o.stdout(strings.NewReader(antigravityAuthPrefix + valid + "\n{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{}}\n"))
	data, err := io.ReadAll(reader)
	if err != nil || strings.Contains(string(data), "accounts.google.com") || len(links) != 1 {
		t.Fatal(string(data), links, err)
	}
	for _, part := range []string{antigravityBrowserMarker[:12], antigravityBrowserMarker[12:] + fmt.Sprintf("%q", valid) + "\n"} {
		_, _ = o.Write([]byte(part))
	}
	if len(links) != 2 {
		t.Fatal("fragmented browser callback lost", links)
	}
	blocked := &antigravityOutput{cancel: func() {}}
	_, err = io.ReadAll(blocked.stdout(strings.NewReader(antigravityAuthPrefix + valid + "\n")))
	if err == nil || blocked.failure(nil) != errAntigravitySignIn {
		t.Fatal("background discovery did not require explicit sign-in", err)
	}
}

func TestAntigravityInstallVerifiesAndPublishesBothFiles(t *testing.T) {
	var archive bytes.Buffer
	w := zip.NewWriter(&archive)
	name, harness := antigravityNames()
	for _, name := range []string{name, harness} {
		header := &zip.FileHeader{Name: name, Method: zip.Deflate}
		header.SetMode(0700)
		file, err := w.CreateHeader(header)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := file.Write([]byte("binary")); err != nil {
			t.Fatal(err)
		}
	}
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write(archive.Bytes()) }))
	defer server.Close()
	release := antigravityRelease{URL: server.URL, SHA256: fmt.Sprintf("%x", sha256.Sum256(archive.Bytes())), ArchiveBytes: int64(archive.Len()), ExecutableBytes: 6, HarnessBytes: 6}
	ctx := WithStateDir(context.Background(), t.TempDir())
	if err := installAntigravity(ctx, release); err != nil {
		t.Fatal(err)
	}
	dir, _ := antigravityInstallDir(ctx)
	if !antigravityInstalled(dir, release) {
		t.Fatal("incomplete runtime published")
	}
	if err := os.Remove(filepath.Join(dir, harness)); err != nil {
		t.Fatal(err)
	}
	bad := release
	bad.SHA256 = strings.Repeat("0", 64)
	if err := installAntigravity(ctx, bad); err == nil {
		t.Fatal("unverified archive published")
	}
	if data, err := os.ReadFile(filepath.Join(dir, name)); err != nil || string(data) != "binary" {
		t.Fatal("failed installation changed existing files", err)
	}
	if err := installAntigravity(ctx, release); err != nil || !antigravityInstalled(dir, release) {
		t.Fatal("incomplete installation was not repaired", err)
	}
	stages, _ := filepath.Glob(filepath.Join(filepath.Dir(dir), ".install-*"))
	if len(stages) > 0 {
		t.Fatal("installation left temporary files", stages)
	}
	bad.ExecutableBytes++
	input := filepath.Join(t.TempDir(), "runtime.zip")
	if err := os.WriteFile(input, archive.Bytes(), 0600); err != nil {
		t.Fatal(err)
	}
	if err := extractAntigravity(ctx, input, t.TempDir(), bad); err == nil {
		t.Fatal("invalid executable size accepted")
	}
}

func TestAntigravityOutcomeIgnoresOldErrorsAndFailsNewErrors(t *testing.T) {
	dir := t.TempDir()
	config := model.Provider{ID: "account", Type: "antigravity"}
	path := filepath.Join(antigravityProfileDir(dir, config.ID), "antigravity-acp", "conversations", "native.db")
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		t.Fatal(err)
	}
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if _, err := db.Exec("CREATE TABLE steps(idx INTEGER,step_type INTEGER); INSERT INTO steps VALUES(0,17)"); err != nil {
		t.Fatal(err)
	}
	ctx := WithStateDir(context.Background(), dir)
	watch := watchAntigravityOutcome(ctx, config, "native")
	if _, err := db.Exec("INSERT INTO steps VALUES(1,2)"); err != nil {
		t.Fatal(err)
	}
	if err := watch(acp.StopReasonEndTurn); err != nil {
		t.Fatal("old provider error poisoned a successful turn", err)
	}
	watch = watchAntigravityOutcome(ctx, config, "native")
	if _, err := db.Exec("INSERT INTO steps VALUES(2,17)"); err != nil {
		t.Fatal(err)
	}
	if err := watch(acp.StopReasonEndTurn); err == nil {
		t.Fatal("upstream failure marked completed")
	}
	if err := watchAntigravityOutcome(ctx, config, "../foreign")(acp.StopReasonRefusal); err == nil {
		t.Fatal("refusal marked completed")
	}
}

func TestAntigravityErrorStepPreservesOnlyStatus(t *testing.T) {
	for _, tt := range []struct{ name, payload, want string }{
		{"credentials", "\x00UNAUTHENTICATED (code 401): Request had invalid authentication credentials.\nHeaders: private", "Antigravity returned UNAUTHENTICATED (HTTP 401)."},
		{"wire length", "\x12\x41UNAVAILABLE (code 503): temporarily unavailable", "Antigravity returned UNAVAILABLE (HTTP 503)."},
		{"legacy", "Error 503, Message: internal detail, Status: UNAVAILABLE\nprivate stack", "Antigravity returned UNAVAILABLE (HTTP 503)."},
		{"unknown", "unknown private failure", errAntigravityProvider.Error()},
		{"outside prefix", strings.Repeat(" ", 16384) + "UNAUTHENTICATED (code 401): private", errAntigravityProvider.Error()},
	} {
		t.Run(tt.name, func(t *testing.T) {
			f := newAntigravityChildFixture(t)
			watch := watchAntigravityOutcomeDB(t.Context(), f.store)
			probe := f.store.watchSubagents("test-session")
			f.declare(1, "launch", "child", "SUBAGENT_STATE_ALIVE")
			f.step(2, 17, nil, []byte(tt.payload))
			_, backgroundErr := probe(t.Context(), map[string]int{"launch": 1}, "")
			for _, err := range []error{watch(acp.StopReasonEndTurn), backgroundErr} {
				if err == nil || err.Error() != tt.want {
					t.Errorf("got %v, want %s", err, tt.want)
				}
			}
			if tt.name == "credentials" {
				if err := watch(acp.StopReasonRefusal); err == nil || err.Error() != tt.want {
					t.Errorf("typed stop reason hid the upstream status: %v", err)
				}
			}
		})
	}
}
