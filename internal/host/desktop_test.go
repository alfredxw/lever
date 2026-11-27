package host

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestServeDesktopDetachesStdout(t *testing.T) {
	dir := t.TempDir()
	logPath := filepath.Join(dir, "backend.log")
	logFile, err := os.OpenFile(logPath, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600)
	if err != nil {
		t.Fatal(err)
	}
	defer logFile.Close()

	stdoutRead, stdoutWrite, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	defer stdoutRead.Close()
	defer stdoutWrite.Close()

	stdinRead, stdinWrite, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	defer stdinRead.Close()
	defer stdinWrite.Close()

	cmd := exec.Command(os.Args[0], "-test.run=^TestServeDesktopStdoutHelper$")
	cmd.Env = append(os.Environ(), "LEVER_TEST_SERVE_DESKTOP_DIR="+dir)
	cmd.Stdin = stdinRead
	cmd.Stdout = stdoutWrite
	cmd.Stderr = logFile
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	_ = stdoutWrite.Close()
	_ = stdinRead.Close()

	done := make(chan struct{})
	var waitErr error
	go func() {
		waitErr = cmd.Wait()
		close(done)
	}()
	t.Cleanup(func() {
		_ = stdinWrite.Close()
		select {
		case <-done:
		case <-time.After(3 * time.Second):
			_ = cmd.Process.Kill()
			<-done
		}
	})

	var startup desktopStartup
	if err := json.NewDecoder(stdoutRead).Decode(&startup); err != nil || startup.Error != "" {
		t.Fatalf("decode desktop startup: err=%v startup=%+v", err, startup)
	}
	// Match launchDesktopServer closing the startup pipe reader right after startup.
	if err := stdoutRead.Close(); err != nil {
		t.Fatal(err)
	}

	desktop, err := ConnectDesktop(dir, "127.0.0.1:0", "", false)
	if err != nil {
		t.Fatalf("connect desktop: %v", err)
	}
	defer desktop.Close()

	// Trigger stdout writes in the backend after the startup pipe reader is closed.
	if err := stdinWrite.Close(); err != nil {
		t.Fatal(err)
	}

	deadline := time.Now().Add(5 * time.Second)
	for {
		select {
		case <-done:
			t.Fatalf("desktop backend exited after stdout write: %v", waitErr)
		default:
		}
		raw, _ := os.ReadFile(logPath)
		if strings.Contains(string(raw), "tenant brand: feishu") && strings.Contains(string(raw), "raw stdout write") {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("stdout writes did not land in backend.log; contents=%q", string(raw))
		}
		time.Sleep(20 * time.Millisecond)
	}

	res, err := http.Get(desktop.URL + "/api/overview")
	if err != nil {
		t.Fatalf("backend unreachable after stdout write: %v", err)
	}
	_ = res.Body.Close()

	desktop.Close()
	select {
	case <-done:
		if waitErr != nil {
			t.Fatalf("desktop backend exited with error: %v", waitErr)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("idle desktop backend did not exit")
	}
}

func TestServeDesktopStdoutHelper(t *testing.T) {
	dir := os.Getenv("LEVER_TEST_SERVE_DESKTOP_DIR")
	if dir == "" {
		return
	}
	go func() {
		_, _ = io.ReadAll(os.Stdin)
		fmt.Println("tenant brand: feishu")
		writeRawStdout("raw stdout write\n")
	}()
	if err := ServeDesktop(context.Background(), dir, "127.0.0.1:0", "", os.Stdout); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	os.Exit(0)
}

func TestDetachReadyWriterIsolatesHandshake(t *testing.T) {
	logPath := filepath.Join(t.TempDir(), "backend.log")
	logFile, err := os.OpenFile(logPath, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600)
	if err != nil {
		t.Fatal(err)
	}
	defer logFile.Close()

	stdoutRead, stdoutWrite, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	defer stdoutRead.Close()
	defer stdoutWrite.Close()

	stdinRead, stdinWrite, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	defer stdinRead.Close()
	defer stdinWrite.Close()

	cmd := exec.Command(os.Args[0], "-test.run=^TestDetachReadyWriterHelper$")
	cmd.Env = append(os.Environ(), "LEVER_TEST_DETACH_READY=1")
	cmd.Stdin = stdinRead
	cmd.Stdout = stdoutWrite
	cmd.Stderr = logFile
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	_ = stdoutWrite.Close()
	_ = stdinRead.Close()

	var startup desktopStartup
	if err := json.NewDecoder(stdoutRead).Decode(&startup); err != nil || startup.Error != "" {
		t.Fatalf("decode desktop startup: err=%v startup=%+v", err, startup)
	}
	if err := stdoutRead.Close(); err != nil {
		t.Fatal(err)
	}
	if err := stdinWrite.Close(); err != nil {
		t.Fatal(err)
	}
	if err := cmd.Wait(); err != nil {
		t.Fatalf("helper exited with error after stdout pipe closed: %v", err)
	}
	raw, err := os.ReadFile(logPath)
	if err != nil {
		t.Fatal(err)
	}
	logText := string(raw)
	for _, want := range []string{
		"[Info] [event-dispatch is ready]",
		"raw before ready",
		"tenant brand: feishu",
		"raw after close",
	} {
		if !strings.Contains(logText, want) {
			t.Fatalf("backend.log missing %q; contents=%q", want, logText)
		}
	}
}

func TestDetachReadyWriterHelper(t *testing.T) {
	if os.Getenv("LEVER_TEST_DETACH_READY") == "" {
		return
	}
	ready, closeReady := detachReadyWriter(os.Stdout)
	defer closeReady()
	fmt.Println("[Info] [event-dispatch is ready]")
	writeRawStdout("raw before ready\n")
	if err := json.NewEncoder(ready).Encode(desktopStartup{}); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	closeReady()
	_, _ = io.ReadAll(os.Stdin)
	fmt.Println("tenant brand: feishu")
	writeRawStdout("raw after close\n")
	os.Exit(0)
}

func TestConnectDesktopHandsOffVersionMismatch(t *testing.T) {
	dir := t.TempDir()
	const address = "127.0.0.1:0"

	prevVersion := DesktopVersion
	prevLauncher := launchDesktopBackend
	t.Cleanup(func() {
		DesktopVersion = prevVersion
		launchDesktopBackend = prevLauncher
	})

	startInProcess := func(ctx context.Context, version string) (<-chan error, func()) {
		DesktopVersion = version
		ready, report := io.Pipe()
		done := make(chan error, 1)
		go func() {
			defer report.Close()
			done <- ServeDesktop(ctx, dir, address, "", report)
		}()
		var startup desktopStartup
		if err := json.NewDecoder(ready).Decode(&startup); err != nil || startup.Error != "" {
			t.Fatalf("start backend %s: err=%v startup=%+v", version, err, startup)
		}
		_ = ready.Close()
		return done, func() {
			select {
			case err := <-done:
				if err != nil {
					t.Errorf("backend %s exited with error: %v", version, err)
				}
			case <-time.After(5 * time.Second):
				t.Errorf("backend %s did not exit", version)
			}
		}
	}

	oldDone, waitOld := startInProcess(t.Context(), "0.1.0")
	var newWait func()
	launched := false
	launchDesktopBackend = func(ctx context.Context, _, _, _ string, _ *http.Client) error {
		launched = true
		_, newWait = startInProcess(t.Context(), "0.2.0")
		return nil
	}

	DesktopVersion = "0.2.0"
	desktop, err := ConnectDesktop(dir, address, "", false)
	if err != nil {
		t.Fatalf("ConnectDesktop handoff failed: %v", err)
	}
	if !launched {
		t.Fatal("expected ConnectDesktop to launch a fresh backend for version mismatch")
	}
	if desktop.Version != "0.2.0" {
		t.Fatalf("attached version = %q, want 0.2.0", desktop.Version)
	}
	select {
	case err := <-oldDone:
		if err != nil {
			t.Fatalf("old backend exited with error: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("old backend did not exit during handoff")
	}
	// Close is idempotent.
	desktop.Close()
	desktop.Close()
	if newWait != nil {
		newWait()
	}
	_ = waitOld
}

func TestConnectDesktopPreservesResidentBackendOnVersionMismatch(t *testing.T) {
	dir := t.TempDir()
	prevVersion := DesktopVersion
	prevLauncher := launchDesktopBackend
	t.Cleanup(func() {
		DesktopVersion = prevVersion
		launchDesktopBackend = prevLauncher
	})

	DesktopVersion = "0.1.0"
	server, err := Start(dir, "127.0.0.1:0", "")
	if err != nil {
		t.Fatalf("start resident server: %v", err)
	}
	t.Cleanup(func() { _ = Stop(server) })

	launchDesktopBackend = func(context.Context, string, string, string, *http.Client) error {
		t.Fatal("ConnectDesktop must not replace a resident CLI backend")
		return nil
	}

	DesktopVersion = "0.2.0"
	desktop, err := ConnectDesktop(dir, "127.0.0.1:0", "", false)
	if err != nil {
		t.Fatalf("attach resident backend: %v", err)
	}
	defer desktop.Close()
	if !desktop.resident {
		t.Fatal("expected resident flag on desktop pairing")
	}
}
