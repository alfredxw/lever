package httpapi_test

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"testing"
	"time"

	"lever/internal/host"
	"lever/internal/httpapi"
	"lever/internal/model"
)

func TestDesktopReattachPreservesExecution(t *testing.T) {
	const address = "127.0.0.1:0"
	dir := t.TempDir()
	firstVite := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		fmt.Fprint(w, "first frontend")
	}))
	defer firstVite.Close()
	secondVite := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		fmt.Fprint(w, "second frontend")
	}))
	defer secondVite.Close()

	ready, report := io.Pipe()
	defer ready.Close()
	done := make(chan struct{})
	var backendErr error
	go func() {
		defer close(done)
		defer report.Close()
		backendErr = host.ServeDesktop(t.Context(), dir, address, firstVite.URL, report)
	}()
	t.Cleanup(func() { <-done })
	var startup struct{ Error string }
	if err := json.NewDecoder(ready).Decode(&startup); err != nil || startup.Error != "" {
		t.Fatalf("start desktop backend: %v %s", err, startup.Error)
	}
	first, err := host.ConnectDesktop(dir, address, firstVite.URL, false)
	if err != nil {
		t.Fatal(err)
	}
	defer first.Close()
	pair, err := url.Parse(first.PairURL)
	if err != nil {
		t.Fatal(err)
	}
	token, err := url.ParseQuery(pair.Fragment)
	if err != nil {
		t.Fatal(err)
	}
	f := &fixture{t: t, s: &httpapi.Server{URL: first.URL, Token: token.Get("token")}, root: t.TempDir()}
	f.request("POST", "/provider-candidates/lever.codex/codex", nil, 200, nil)
	chat := f.chat(f.agent("codex"))
	run := f.send(chat.ID, "main", "", "[approval]")
	var overview model.Overview
	deadline := time.Now().Add(10 * time.Second)
	for len(overview.Requests) == 0 && time.Now().Before(deadline) {
		f.request("GET", "/overview", nil, 200, &overview)
		time.Sleep(20 * time.Millisecond)
	}
	if len(overview.Requests) != 1 || overview.Requests[0].RunID != run.ID {
		t.Fatalf("pending approval before quit: %+v", overview.Requests)
	}
	requestID := overview.Requests[0].ID
	first.Close()
	select {
	case <-done:
		t.Fatalf("backend exited with pending work: %v", backendErr)
	case <-time.After(750 * time.Millisecond):
	}

	second, err := host.ConnectDesktop(dir, address, secondVite.URL, false)
	if err != nil {
		t.Fatal(err)
	}
	defer second.Close()
	if second.PairURL != first.PairURL {
		t.Fatal("reopen started a different backend")
	}
	// A failed fresh launch must be reported even with a healthy backend that
	// a normal window could attach to.
	logPath := filepath.Join(dir, "backend.log")
	if err := os.Mkdir(logPath, 0700); err != nil {
		t.Fatal(err)
	}
	restarted, err := host.ConnectDesktop(dir, address, secondVite.URL, true)
	if err == nil {
		restarted.Close()
		t.Fatal("explicit restart attached to the running backend")
	}
	var pathErr *os.PathError
	if !errors.As(err, &pathErr) || pathErr.Path != logPath {
		t.Fatalf("fresh launch error = %v, want backend log open failure", err)
	}
	response, err := http.Get(second.URL)
	if err != nil {
		t.Fatal(err)
	}
	content, err := io.ReadAll(response.Body)
	response.Body.Close()
	if err != nil || response.StatusCode != http.StatusOK || string(content) != "second frontend" {
		t.Fatalf("reopen used stale Vite origin: %d %q %v", response.StatusCode, content, err)
	}
	f.request("GET", "/overview", nil, 200, &overview)
	if len(overview.Requests) != 1 || overview.Requests[0].ID != requestID || len(overview.Runs) != 1 || overview.Runs[0].ID != run.ID || overview.Runs[0].Status != "waiting_user" {
		t.Fatal("reopen lost the Run or its pending approval")
	}
	f.request("POST", "/requests/"+requestID+"/answer", model.Answer{Allow: true}, 200, nil)
	var history model.SessionRuns
	deadline = time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		f.request("GET", "/sessions/"+run.SessionID+"/runs", nil, 200, &history)
		if len(history.Runs) == 1 && history.Runs[0].ID == run.ID && history.Runs[0].Status == "completed" {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if len(history.Runs) != 1 || history.Runs[0].ID != run.ID || history.Runs[0].Status != "completed" {
		t.Fatal("the original Run did not complete after approval")
	}
	second.Close()
	select {
	case <-done:
		if backendErr != nil {
			t.Fatal(backendErr)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("idle backend stayed open after the desktop closed")
	}
}
