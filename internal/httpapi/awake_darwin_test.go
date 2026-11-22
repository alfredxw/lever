package httpapi_test

import (
	"os"
	"os/exec"
	"strconv"
	"strings"
	"testing"
	"time"

	"lever/internal/model"
)

// Each provider takes over from a still-running predecessor. Check only the
// system sleep assertions owned by (or made on behalf of) this test process.
func TestOverlappingProviderRunsPreventIdleSleep(t *testing.T) {
	f := newFixture(t)
	pid := strconv.Itoa(os.Getpid())
	waitForHold := func(provider string, want bool) {
		t.Helper()
		deadline := time.Now().Add(3 * time.Second)
		for time.Now().Before(deadline) {
			out, err := exec.Command("/usr/bin/pmset", "-g", "assertions").Output()
			if err != nil {
				t.Fatal(err)
			}
			held := false
			for _, entry := range strings.Split(string(out), "\n   pid ") {
				if strings.Contains(entry, "PreventUserIdleSystemSleep named:") &&
					(strings.HasPrefix(entry, pid+"(") || strings.Contains(entry, "Created for PID: "+pid+".")) {
					held = true
				}
			}
			if held == want {
				return
			}
			time.Sleep(25 * time.Millisecond)
		}
		t.Fatalf("%s: expected idle sleep assertion held=%t for PID %s", provider, want, pid)
	}

	stop := func(id string) {
		t.Helper()
		f.request("POST", "/runs/"+id+"/stop", struct{}{}, 200, nil)
		f.wait(id, "interrupted")
	}
	scope := model.Scope{Roots: []model.Root{{ID: "root", Path: f.root}}, PrimaryRootID: "root"}
	var previous string
	for _, tc := range []struct{ provider, permission, prompt string }{
		{"codex", "ask", "[approval]"},
		{"claude", "ask", "[claude-approval]"},
		{"pi", "", "[pi-question]"},
		{"antigravity", "request-review", "[approval]"},
		{"dsh", "", "[approval]"},
		{f.acpProvider("awake").ID, "review-mode", "[approval]"},
	} {
		var agent model.Agent
		profile := model.Profile{Scope: scope, Provider: tc.provider, Permission: tc.permission}
		f.request("POST", "/agents", model.Agent{Name: tc.provider, Profile: profile}, 200, &agent)
		run := f.send(f.chat(agent).ID, "main", "", tc.prompt)
		f.wait(run.ID, "waiting_user")
		if previous != "" {
			stop(previous)
		}
		waitForHold(tc.provider, true)
		previous = run.ID
	}
	stop(previous)
	waitForHold("all runs stopped", false)
}
