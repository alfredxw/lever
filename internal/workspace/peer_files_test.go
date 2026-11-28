package workspace

import (
	"context"
	"os"
	"path/filepath"
	"slices"
	"testing"

	"lever/internal/model"
)

func TestPeerFileBoundaries(t *testing.T) {
	root, err := Canonical(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	data := filepath.Join(root, "LeverData")
	for _, dir := range []string{data, filepath.Join(root, ".ssh"), filepath.Join(root, "home")} {
		if err := os.Mkdir(dir, 0700); err != nil {
			t.Fatal(err)
		}
	}
	for _, name := range []string{"LeverData/state", ".ssh/config", "home/example.PEM", "home/.zshrc", "visible.txt"} {
		if err := os.WriteFile(filepath.Join(root, name), []byte("contents"), 0600); err != nil {
			t.Fatal(err)
		}
	}
	if err = os.Link(filepath.Join(root, ".ssh/config"), filepath.Join(root, "linked.txt")); err != nil {
		t.Fatal(err)
	}
	if err = os.Symlink(filepath.Join(root, ".ssh"), filepath.Join(root, "alias")); err != nil {
		t.Skipf("creating a symlink: %v", err)
	}
	for _, name := range []string{"LeverData/state", ".ssh/config", "home/example.PEM", "linked.txt", "alias/config", "../secret"} {
		if _, err := PeerFile(root, name, data, nil); err == nil {
			t.Errorf("unexpected read permission for %s", name)
		}
	}
	content, err := PeerFile(root, "home/.zshrc", data, nil)
	if err == nil {
		if _, err = PeerFile(root, "home/.zshrc", data, &model.FileWrite{Content: "update", Version: content.Version, RootPath: root}); err == nil {
			t.Fatal("startup file writable")
		}
	}
	matches, err := PeerSearchFiles(t.Context(), model.Scope{Roots: []model.Root{{ID: "root", Path: root}}}, "linked", false, data)
	if err != nil || len(matches.Matches) != 0 {
		t.Fatal("file search disclosed a protected entry", matches, err)
	}
	list, err := PeerList(context.Background(), root, ".", data)
	if err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"LeverData", ".ssh", "linked.txt", "alias"} {
		if slices.ContainsFunc(list, func(e model.FileEntry) bool { return e.Name == name }) {
			t.Errorf("listed restricted file %s", name)
		}
	}
}
