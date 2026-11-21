package plugin

import (
	"encoding/pem"
	"net/http/cgi"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// Exercise the HTTPS transport against a real smart-HTTP Git server, including
// a repository-root package and a pinned commit with no branch lookup.
func TestHTTPSPackageAtCommit(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("git-http-backend CGI fixture")
	}
	git := func(dir string, args ...string) string {
		t.Helper()
		cmd := exec.Command("git", append([]string{"-C", dir, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "-c", "commit.gpgsign=false"}, args...)...)
		out, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("%s: %v", out, err)
		}
		return strings.TrimSpace(string(out))
	}
	work, root := t.TempDir(), t.TempDir()
	git(work, "init", "-qb", "main")
	manifest := `{"manifestVersion":1,"id":"example.web","name":"Web","version":"1","contributes":{"providers":[{"id":"cli","name":"CLI","driver":"acp","command":"external-cli"}]}}`
	if err := os.WriteFile(filepath.Join(work, ManifestFile), []byte(manifest), 0600); err != nil {
		t.Fatal(err)
	}
	git(work, "add", ManifestFile)
	git(work, "commit", "-qm", "package")
	commit := git(work, "rev-parse", "HEAD")
	git(root, "clone", "-q", "--bare", work, "plugin.git")
	httpBackend := filepath.Join(git(work, "--exec-path"), "git-http-backend")
	server := httptest.NewTLSServer(&cgi.Handler{Path: httpBackend, Dir: root, Env: []string{"GIT_PROJECT_ROOT=" + root, "GIT_HTTP_EXPORT_ALL=1"}})
	defer server.Close()
	ca := filepath.Join(t.TempDir(), "test-ca.pem")
	if err := os.WriteFile(ca, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: server.Certificate().Raw}), 0600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("GIT_SSL_CAINFO", ca)
	t.Setenv("NO_PROXY", "127.0.0.1")
	source, err := GitSource(server.URL+"/plugin.git", commit, ".")
	if err != nil {
		t.Fatal(err)
	}
	source, resolved, err := ResolveGit(t.Context(), source)
	if err != nil || source.Kind != "commit" || resolved != commit {
		t.Fatal(source, resolved, err)
	}
	dir := t.TempDir()
	tree, err := GitTree(t.Context(), source, resolved, dir)
	if err != nil || tree != git(work, "rev-parse", "HEAD^{tree}") {
		t.Fatal(tree, err)
	}
	m, _, err := ReadPackage(dir)
	if err != nil || m.ID != "example.web" {
		t.Fatal(m, err)
	}
}

func TestGitSourceBoundaries(t *testing.T) {
	for _, tc := range []struct{ url, ref, path string }{
		{"/local/repository", "", ""}, {"http://example.test/team/repo", "", ""}, {"https://user:password@example.test/repo", "", ""},
		{"https://example.test/team/repo", "", "../sibling"}, {"https://example.test/team/repo", "main~2", ""}, {"git@example.test:team/repo", "", "x/.git"},
	} {
		if _, err := GitSource(tc.url, tc.ref, tc.path); err == nil {
			t.Fatalf("accepted invalid source %+v", tc)
		}
	}
	source, err := GitSource("git@example.test:team/repo.git", "release/v2", "plugins/notes")
	if err != nil || source.Path != "plugins/notes" || source.Ref != "release/v2" {
		t.Fatal(source, err)
	}
}
