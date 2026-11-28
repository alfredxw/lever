package hub_test

import (
	"os/exec"
	"strings"
	"testing"
)

// A transitive dependency would pull local execution into every Hub deployment.
func TestHubHasNoExecutorDependencies(t *testing.T) {
	output, err := exec.CommandContext(t.Context(), "go", "list", "-deps", "lever/internal/hub").CombinedOutput()
	if err != nil {
		t.Fatalf("go list: %v: %s", err, output)
	}
	for _, pkg := range strings.Fields(string(output)) {
		switch pkg {
		case "lever/internal/app", "lever/internal/provider", "lever/internal/workspace":
			t.Errorf("Hub depends on %s", pkg)
		}
	}
}
