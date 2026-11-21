package httpapi_test

import (
	"bytes"
	"image"
	"image/png"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"lever/internal/workspace"
)

func TestVisualizationPreview(t *testing.T) {
	codexHome := t.TempDir()
	t.Setenv("CODEX_HOME", codexHome)
	root := filepath.Join(codexHome, "visualizations")
	if err := os.Mkdir(root, 0700); err != nil {
		t.Fatal(err)
	}
	f := newFixture(t)
	const fragment = `<button onclick="this.textContent='Done'">Toggle</button>`
	write := func(path, data string) string {
		t.Helper()
		if err := os.WriteFile(path, []byte(data), 0600); err != nil {
			t.Fatal(err)
		}
		return path
	}
	artifact := write(filepath.Join(root, "Report #1.HTML"), fragment)
	wrongType := write(filepath.Join(root, "notes.txt"), fragment)
	outside := write(filepath.Join(codexHome, "private.html"), "private")
	workspacePath := write(filepath.Join(f.root, "page.htm"), fragment)
	large := write(filepath.Join(root, "large.html"), strings.Repeat("x", workspace.MaxFileBytes+1))
	agent := f.agent("codex")
	chat := f.chat(agent)
	run := f.send(chat.ID, "main", "", "HTML preview fixture")
	f.wait(run.ID, "completed")

	request := func(path, runID string, paired bool, want int) {
		t.Helper()
		query := url.Values{"path": {path}, "run": {runID}}
		req, err := http.NewRequest(http.MethodGet, f.s.URL+"/api/visualizations?"+query.Encode(), nil)
		if err != nil {
			t.Fatal(err)
		}
		if paired {
			req.Header.Set("Authorization", "Bearer "+f.s.Token)
		}
		req.Header.Set("Sec-Fetch-Dest", "iframe")
		response, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer response.Body.Close()
		if response.StatusCode != want {
			t.Fatalf("status %d, want %d", response.StatusCode, want)
		}
		if want != http.StatusOK {
			return
		}
		body, err := io.ReadAll(response.Body)
		policy := response.Header.Get("Content-Security-Policy")
		if err != nil || !strings.Contains(string(body), fragment) ||
			response.Header.Get("Content-Type") != "text/html; charset=utf-8" ||
			!strings.Contains(policy, "sandbox allow-scripts;") ||
			!strings.Contains(policy, "default-src 'none'") ||
			strings.Contains(policy, "allow-same-origin") {
			t.Fatalf("unexpected HTML preview headers: %v, read error: %v", response.Header, err)
		}
	}
	request(artifact, "", true, http.StatusOK)
	request(artifact, "", false, http.StatusUnauthorized)
	request(wrongType, "", true, http.StatusNotFound)
	request(outside, run.ID, true, http.StatusNotFound)
	request(filepath.Base(artifact), "", true, http.StatusNotFound)
	request(workspacePath, "", true, http.StatusNotFound)
	request(workspacePath, run.ID, true, http.StatusOK)
	request(large, "", true, http.StatusRequestEntityTooLarge)
	if link := filepath.Join(root, "escape.html"); os.Symlink(outside, link) == nil {
		request(link, "", true, http.StatusNotFound)
	}
}

func TestChatPreviewFiles(t *testing.T) {
	codexHome := t.TempDir()
	t.Setenv("CODEX_HOME", codexHome)
	f := newFixture(t)
	const html = "<!doctype html><button>Preview</button>"
	const svg = "<svg xmlns='http://www.w3.org/2000/svg'/>"
	const page = "page #1.html"
	temp := t.TempDir()
	screenshot := filepath.ToSlash(filepath.Join(temp, "screen #1.png"))
	unlinkedScreenshot := filepath.ToSlash(filepath.Join(temp, "screen #10.png"))
	tempPage := filepath.ToSlash(filepath.Join(temp, "preview.html"))
	var pngData bytes.Buffer
	if err := png.Encode(&pngData, image.NewRGBA(image.Rect(0, 0, 1, 1))); err != nil {
		t.Fatal(err)
	}
	generated := filepath.Join(codexHome, "generated_images")
	if err := os.Mkdir(generated, 0700); err != nil {
		t.Fatal(err)
	}
	generatedImage := filepath.Join(generated, "result.svg")
	outside := filepath.Join(codexHome, "other.svg")
	for path, content := range map[string]string{
		filepath.Join(f.root, page): html, filepath.Join(f.root, "drawing.svg"): svg,
		generatedImage: svg, outside: svg,
		screenshot: pngData.String(), unlinkedScreenshot: pngData.String(), tempPage: html,
	} {
		if err := os.WriteFile(path, []byte(content), 0600); err != nil {
			t.Fatal(err)
		}
	}
	chat := f.chat(f.agent("codex"))
	screenshotURL := (&url.URL{Path: screenshot}).EscapedPath()
	tempPageURL := (&url.URL{Path: tempPage}).EscapedPath()
	reply := "[Screenshot](" + screenshotURL + ")\n\n[HTML](" + tempPageURL + ")"
	run := f.send(chat.ID, "main", "", reply)
	f.wait(run.ID, "completed")
	for _, tc := range []struct {
		kind, path, mime, content string
		status                    int
	}{
		{"html", page, "text/html; charset=utf-8", html, http.StatusOK},
		{"image", "drawing.svg", "image/svg+xml", svg, http.StatusOK},
		{"image", generatedImage, "image/svg+xml", svg, http.StatusOK},
		{"image", screenshot, "image/png", pngData.String(), http.StatusOK},
		{"image", unlinkedScreenshot, "", "", http.StatusNotFound},
		{"image", outside, "", "", http.StatusNotFound},
		{"html", generatedImage, "", "", http.StatusNotFound},
		{"html", tempPage, "", "", http.StatusNotFound},
		{"image", tempPage, "", "", http.StatusBadRequest},
		{"image", page, "", "", http.StatusBadRequest},
	} {
		query := url.Values{"kind": {tc.kind}, "path": {tc.path}}
		req, _ := http.NewRequest(http.MethodGet, f.s.URL+"/api/runs/"+run.ID+"/preview?"+query.Encode(), nil)
		req.Header.Set("Authorization", "Bearer "+f.s.Token)
		req.Header.Set("Sec-Fetch-Dest", "iframe")
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		body, err := io.ReadAll(res.Body)
		res.Body.Close()
		if err != nil || res.StatusCode != tc.status {
			t.Fatalf("%s %s: status %d, want %d, read error %v", tc.kind, tc.path, res.StatusCode, tc.status, err)
		}
		if tc.status == http.StatusOK && (string(body) != tc.content || res.Header.Get("Content-Type") != tc.mime ||
			!strings.HasPrefix(res.Header.Get("Content-Security-Policy"), "sandbox") || res.Header.Get("X-Content-Type-Options") != "nosniff") {
			t.Fatalf("incorrect %s preview: %s %q", tc.kind, res.Header, body)
		}
	}
}
