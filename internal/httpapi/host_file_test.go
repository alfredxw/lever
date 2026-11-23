package httpapi_test

import (
	"bytes"
	"encoding/json"
	"image"
	"image/png"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"lever/internal/model"
)

func TestHostFilePreview(t *testing.T) {
	f := newFixture(t)
	hostDir := t.TempDir()

	var pngData bytes.Buffer
	if err := png.Encode(&pngData, image.NewRGBA(image.Rect(0, 0, 2, 2))); err != nil {
		t.Fatal(err)
	}
	mdPath := filepath.Join(hostDir, "design.md")
	imgPath := filepath.Join(hostDir, "diagram.png")
	htmlPath := filepath.Join(hostDir, "demo.html")
	binPath := filepath.Join(hostDir, "blob.bin")
	for p, data := range map[string][]byte{
		mdPath:   []byte("# Design\n\n![Diagram](" + filepath.ToSlash(imgPath) + ")\n"),
		imgPath:  pngData.Bytes(),
		htmlPath: []byte(`<!doctype html><img src="diagram.png"><script>parent.x=1</script>`),
		binPath:  []byte{0x00, 0x01, 0x02, 0x03},
	} {
		if err := os.WriteFile(p, data, 0600); err != nil {
			t.Fatal(err)
		}
	}

	doGet := func(rawURL string, auth bool, dest string) (*http.Response, []byte) {
		t.Helper()
		req, err := http.NewRequest(http.MethodGet, rawURL, nil)
		if err != nil {
			t.Fatal(err)
		}
		if auth {
			req.Header.Set("Authorization", "Bearer "+f.s.Token)
		}
		if dest != "" {
			req.Header.Set("Sec-Fetch-Dest", dest)
		}
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		body, err := io.ReadAll(res.Body)
		res.Body.Close()
		if err != nil {
			t.Fatal(err)
		}
		return res, body
	}

	t.Run("reads text file outside workspace", func(t *testing.T) {
		res, body := doGet(f.s.URL+"/api/host-file?path="+url.QueryEscape(mdPath), true, "")
		if res.StatusCode != http.StatusOK {
			t.Fatalf("status = %d, body = %s", res.StatusCode, body)
		}
		var file model.FileContent
		if err := json.Unmarshal(body, &file); err != nil {
			t.Fatal(err)
		}
		wantCanonical, err := filepath.EvalSymlinks(mdPath)
		if err != nil {
			t.Fatal(err)
		}
		if file.Path != filepath.ToSlash(wantCanonical) || !strings.Contains(file.Content, "# Design") {
			t.Fatalf("unexpected file content: %+v", file)
		}
	})

	t.Run("expands home-relative paths", func(t *testing.T) {
		home := t.TempDir()
		t.Setenv("HOME", home)
		t.Setenv("USERPROFILE", home)
		planDir := filepath.Join(home, ".claude", "plans")
		if err := os.MkdirAll(planDir, 0700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(planDir, "plan.md"), []byte("hello plan"), 0600); err != nil {
			t.Fatal(err)
		}
		res, body := doGet(f.s.URL+"/api/host-file?path="+url.QueryEscape("~/.claude/plans/plan.md"), true, "")
		if res.StatusCode != http.StatusOK || !strings.Contains(string(body), "hello plan") {
			t.Fatalf("home-relative read failed: %d %s", res.StatusCode, body)
		}
	})

	t.Run("serves image asset with sandbox headers", func(t *testing.T) {
		res, body := doGet(f.s.URL+"/api/host-file?asset=true&path="+url.QueryEscape(imgPath), true, "")
		if res.StatusCode != http.StatusOK || !bytes.Equal(body, pngData.Bytes()) ||
			res.Header.Get("Content-Type") != "image/png" ||
			res.Header.Get("X-Content-Type-Options") != "nosniff" ||
			!strings.Contains(res.Header.Get("Content-Security-Policy"), "sandbox;") {
			t.Fatalf("unexpected image response: %d %v", res.StatusCode, res.Header)
		}
		bad, _ := doGet(f.s.URL+"/api/host-file?asset=true&path="+url.QueryEscape(mdPath), true, "")
		if bad.StatusCode != http.StatusBadRequest {
			t.Fatalf("non-image asset status = %d, want 400", bad.StatusCode)
		}
	})

	t.Run("serves sandboxed HTML preview with sibling image", func(t *testing.T) {
		res, body := doGet(f.s.URL+"/api/host-file?preview=html&path="+url.QueryEscape(htmlPath), true, "iframe")
		policy := res.Header.Get("Content-Security-Policy")
		if res.StatusCode != http.StatusOK ||
			!strings.Contains(string(body), "data:image/png;base64,") ||
			!strings.Contains(policy, "sandbox allow-scripts;") {
			t.Fatalf("unexpected HTML preview: %d %v %s", res.StatusCode, res.Header, body)
		}
		docRes, _ := doGet(f.s.URL+"/api/host-file?preview=html&path="+url.QueryEscape(htmlPath), true, "document")
		if strings.Contains(docRes.Header.Get("Content-Security-Policy"), "allow-scripts") {
			t.Fatalf("document HTML preview should not allow scripts: %v", docRes.Header)
		}
	})

	t.Run("download and binary text preview", func(t *testing.T) {
		res, body := doGet(f.s.URL+"/api/host-file?download=true&path="+url.QueryEscape(binPath), true, "")
		if res.StatusCode != http.StatusOK || !strings.HasPrefix(res.Header.Get("Content-Disposition"), "attachment;") || len(body) != 4 {
			t.Fatalf("download failed: %d %v", res.StatusCode, res.Header)
		}
		binRes, _ := doGet(f.s.URL+"/api/host-file?path="+url.QueryEscape(binPath), true, "")
		if binRes.StatusCode != http.StatusUnsupportedMediaType {
			t.Fatalf("binary read status = %d, want 415", binRes.StatusCode)
		}
	})

	t.Run("enforces authentication and read-only methods", func(t *testing.T) {
		res, _ := doGet(f.s.URL+"/api/host-file?path="+url.QueryEscape(mdPath), false, "")
		if res.StatusCode != http.StatusUnauthorized {
			t.Fatalf("unauthenticated status = %d, want 401", res.StatusCode)
		}
		for _, method := range []string{http.MethodPut, http.MethodPost, http.MethodDelete} {
			req, err := http.NewRequest(method, f.s.URL+"/api/host-file?path="+url.QueryEscape(mdPath), strings.NewReader(`{"content":"x"}`))
			if err != nil {
				t.Fatal(err)
			}
			req.Header.Set("Authorization", "Bearer "+f.s.Token)
			writeRes, err := http.DefaultClient.Do(req)
			if err != nil {
				t.Fatal(err)
			}
			writeRes.Body.Close()
			if writeRes.StatusCode != http.StatusMethodNotAllowed {
				t.Fatalf("%s /api/host-file status = %d, want 405", method, writeRes.StatusCode)
			}
		}
	})

	t.Run("blocks Lever internal state and secrets while allowing managed artifacts", func(t *testing.T) {
		writeFile := func(rel string, data []byte) string {
			t.Helper()
			full := filepath.Join(f.a.Store.Dir, filepath.FromSlash(rel))
			if err := os.MkdirAll(filepath.Dir(full), 0700); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(full, data, 0600); err != nil {
				t.Fatal(err)
			}
			return full
		}
		blocked := []string{
			filepath.Join(f.a.Store.Dir, "lever.db"),
			writeFile("channel-secrets/feishu-1", []byte("top-secret")),
			writeFile("automation-secrets/auto-1", []byte("auto-secret")),
			writeFile("providers/antigravity/abc/api-key", []byte("ai-key")),
			writeFile("providers/antigravity/abc/antigravity-acp/settings.json", []byte(`{"auth":{}}`)),
			writeFile("providers/codex/c1/auth.json", []byte(`{"token":"x"}`)),
			writeFile("sessions/s1/.pi-mcp-1/token", []byte("mcp-secret")),
		}
		if link := filepath.Join(hostDir, "sneaky-secret.txt"); os.Symlink(blocked[1], link) == nil {
			blocked = append(blocked, link)
		}
		for _, target := range blocked {
			res, _ := doGet(f.s.URL+"/api/host-file?path="+url.QueryEscape(target), true, "")
			if res.StatusCode != http.StatusNotFound {
				t.Fatalf("blocked path %s returned %d, want 404", target, res.StatusCode)
			}
		}

		allowed := []string{
			writeFile("providers/antigravity/abc/antigravity-acp/brain/conv-1/design.md", []byte("# Artifact")),
			writeFile("providers/codex/c1/visualizations/chart.html", []byte("<p>ok</p>")),
			writeFile("notes/spec.md", []byte("# Note")),
		}
		for _, target := range allowed {
			res, _ := doGet(f.s.URL+"/api/host-file?path="+url.QueryEscape(target), true, "")
			if res.StatusCode != http.StatusOK {
				t.Fatalf("allowed store artifact %s returned %d, want 200", target, res.StatusCode)
			}
		}
	})

	t.Run("rejects invalid paths and directories", func(t *testing.T) {
		for _, bad := range []string{"", "relative.md", "//server/share/file.md", `\\server\share\file.md`, hostDir, filepath.Join(hostDir, "missing.md")} {
			res, _ := doGet(f.s.URL+"/api/host-file?path="+url.QueryEscape(bad), true, "")
			if res.StatusCode < 400 {
				t.Fatalf("invalid path %q returned %d", bad, res.StatusCode)
			}
		}
	})

	t.Run("chat image preview serves linked host images outside tmp and blocks secrets", func(t *testing.T) {
		// Create a host image outside tmp (under a fake home/brain dir).
		brainDir := filepath.Join(t.TempDir(), "brain", "conv-42")
		if err := os.MkdirAll(brainDir, 0700); err != nil {
			t.Fatal(err)
		}
		linkedImg := filepath.Join(brainDir, "mockup.png")
		unlinkedImg := filepath.Join(brainDir, "other.png")
		if err := os.WriteFile(linkedImg, pngData.Bytes(), 0600); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(unlinkedImg, pngData.Bytes(), 0600); err != nil {
			t.Fatal(err)
		}
		secretImg := filepath.Join(f.a.Store.Dir, "channel-secrets", "leak.png")
		if err := os.MkdirAll(filepath.Dir(secretImg), 0700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(secretImg, pngData.Bytes(), 0600); err != nil {
			t.Fatal(err)
		}
		chat := f.chat(f.agent("codex"))
		linkedURL := (&url.URL{Scheme: "file", Path: filepath.ToSlash(linkedImg)}).String()
		secretURL := (&url.URL{Scheme: "file", Path: filepath.ToSlash(secretImg)}).String()
		run := f.send(chat.ID, "main", "", "![Mockup]("+linkedURL+")\n\n![Secret]("+secretURL+")")
		f.wait(run.ID, "completed")

		okRes, okBody := doGet(f.s.URL+"/api/runs/"+run.ID+"/preview?kind=image&path="+url.QueryEscape(filepath.ToSlash(linkedImg)), true, "")
		if okRes.StatusCode != http.StatusOK || !bytes.Equal(okBody, pngData.Bytes()) {
			t.Fatalf("linked host image status = %d", okRes.StatusCode)
		}
		unlinkedRes, _ := doGet(f.s.URL+"/api/runs/"+run.ID+"/preview?kind=image&path="+url.QueryEscape(filepath.ToSlash(unlinkedImg)), true, "")
		if unlinkedRes.StatusCode != http.StatusNotFound {
			t.Fatalf("unlinked host image status = %d, want 404", unlinkedRes.StatusCode)
		}
		secretRes, _ := doGet(f.s.URL+"/api/runs/"+run.ID+"/preview?kind=image&path="+url.QueryEscape(filepath.ToSlash(secretImg)), true, "")
		if secretRes.StatusCode != http.StatusNotFound {
			t.Fatalf("blocked secret image status = %d, want 404", secretRes.StatusCode)
		}
	})
}
