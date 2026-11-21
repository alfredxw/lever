package httpapi_test

import (
	"os"
	"path/filepath"
	"testing"

	"lever/internal/model"
)

func TestFileSearchHTTP(t *testing.T) {
	f := newFixture(t)
	agent := f.agent("codex")
	if err := os.WriteFile(filepath.Join(f.root, "search.txt"), []byte("first\nScope needle\n"), 0600); err != nil {
		t.Fatal(err)
	}
	var result model.FileSearch
	url := "/agents/" + agent.ID + "/files/search"
	f.request("GET", url+"?mode=content&query=needle", nil, 200, &result)
	if len(result.Matches) != 1 || result.Matches[0].RootID != "root" || result.Matches[0].Line != 2 {
		t.Fatalf("unexpected search: %+v", result)
	}
	f.request("GET", url+"?mode=path&query=search.txt", nil, 200, &result)
	if len(result.Matches) != 1 || result.Matches[0].Line != 0 {
		t.Fatalf("unexpected filename search: %+v", result)
	}
	f.request("GET", url+"?root=root&mode=path&query=search.txt", nil, 200, &result)
	if len(result.Matches) != 1 || result.Matches[0].RootID != "root" {
		t.Fatalf("scoped search: %+v", result)
	}
	f.request("GET", url+"?root=missing&mode=path&query=search.txt", nil, 400, nil)
	f.request("GET", url+"?mode=invalid&query=needle", nil, 400, nil)
}
