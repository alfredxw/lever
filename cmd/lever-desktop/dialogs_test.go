package main

import (
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestHTMLFileURL(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "报告 #100%.HTM")
	if err := os.WriteFile(path, []byte("<p>report</p>"), 0600); err != nil {
		t.Fatal(err)
	}
	link, err := htmlFileURL(path, "#part%202")
	if err != nil {
		t.Fatal(err)
	}
	parsed, err := url.Parse(link)
	if err != nil || parsed.Scheme != "file" || parsed.Host != "" || parsed.RawQuery != "" ||
		parsed.Path != "/"+strings.TrimPrefix(filepath.ToSlash(path), "/") || parsed.Fragment != "part 2" {
		t.Fatalf("unexpected original file URL: %q (%v)", link, err)
	}
	directory := filepath.Join(dir, "folder.html")
	if err := os.Mkdir(directory, 0700); err != nil {
		t.Fatal(err)
	}
	for _, invalid := range []string{"relative.html", "https://example.test/report.html", "/view/runs/id/preview?kind=html&path=page.html", filepath.Join(dir, "missing.html"), directory, filepath.Join(dir, "script.js")} {
		if _, err := htmlFileURL(invalid, ""); err == nil {
			t.Errorf("accepted non-file target %q", invalid)
		}
	}
	if _, err := htmlFileURL(path, "https://example.test/"); err == nil {
		t.Error("accepted a second URL instead of a fragment")
	}
}
