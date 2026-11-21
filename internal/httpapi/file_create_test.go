package httpapi_test

import (
	"lever/internal/model"
	"testing"
)

func TestFileCreateHTTP(t *testing.T) {
	f := newFixture(t)
	agent := f.agent("codex")
	url := "/agents/" + agent.ID + "/files?root=root&path="
	var entry model.FileEntry
	f.request("POST", url+"notes", map[string]any{"rootPath": agent.Profile.Roots[0].Path, "directory": true}, 200, &entry)
	if !entry.Directory || entry.Name != "notes" {
		t.Fatalf("unexpected folder: %+v", entry)
	}
	f.request("POST", url+"notes/empty.md", map[string]any{"rootPath": agent.Profile.Roots[0].Path}, 200, &entry)
	var content model.FileContent
	f.request("GET", "/agents/"+agent.ID+"/file?root=root&path=notes/empty.md", nil, 200, &content)
	if content.Content != "" || content.Version == "" {
		t.Fatalf("unexpected content: %+v", content)
	}
	f.request("POST", url+"notes/empty.md", map[string]any{"rootPath": agent.Profile.Roots[0].Path}, 409, nil)
	f.request("POST", url+"new", map[string]any{"rootPath": "stale-scope"}, 409, nil)
	f.request("POST", url+"../outside", map[string]any{"rootPath": agent.Profile.Roots[0].Path}, 400, nil)
}
