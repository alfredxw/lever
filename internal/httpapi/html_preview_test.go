package httpapi_test

import (
	"bytes"
	"image"
	"image/png"
	"io"
	"mime"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"lever/internal/model"
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
	t.Run("HTML attachment preview uses only the uploaded file", func(t *testing.T) {
		file := f.upload(chat.ID, page, []byte(html))
		preview := "/attachments/" + file.ID + "/preview?kind=html&path="
		var info struct{ Path string }
		f.request("GET", preview+url.QueryEscape(page)+"&info=true", nil, http.StatusOK, &info)
		if info.Path != f.a.AttachmentPath(file) {
			t.Fatalf("attachment path = %s", info.Path)
		}
		report := f.upload(chat.ID, "compare.html", []byte(`<img src="screen.png">`))
		var reportInfo struct{ NeedsImages bool }
		f.request("GET", "/attachments/"+report.ID+"/preview?kind=html&path=compare.html&info=true", nil, http.StatusOK, &reportInfo)
		if !reportInfo.NeedsImages {
			t.Fatal("missing attachment companion images were not reported")
		}
		f.request("GET", preview+"another.html&info=true", nil, http.StatusNotFound, nil)
		f.request("GET", "/attachments/"+file.ID+"/preview?kind=image&path="+url.QueryEscape(page), nil, http.StatusNotFound, nil)
	})
	t.Run("file manager receives only a scoped regular HTML file", func(t *testing.T) {
		endpoint := "/runs/" + run.ID + "/preview?kind=html&info=true&path="
		var info struct{ Path string }
		f.request("GET", endpoint+url.QueryEscape(page), nil, http.StatusOK, &info)
		want, err := filepath.EvalSymlinks(filepath.Join(f.root, page))
		if err != nil || info.Path != want {
			t.Fatalf("resolved file = %q, want %q: %v", info.Path, want, err)
		}
		for _, path := range []string{tempPage, "drawing.svg", "missing.html"} {
			f.request("GET", endpoint+url.QueryEscape(path), nil, http.StatusNotFound, nil)
		}
		if err := os.Symlink(tempPage, filepath.Join(f.root, "outside.html")); err == nil {
			f.request("GET", endpoint+"outside.html", nil, http.StatusNotFound, nil)
		}
		res, err := http.Get(f.s.URL + "/api" + endpoint + url.QueryEscape(page))
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		if res.StatusCode != http.StatusUnauthorized {
			t.Fatalf("unpaired metadata status = %d", res.StatusCode)
		}
	})
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

func TestAntigravityHTMLPreview(t *testing.T) {
	profile := t.TempDir()
	t.Setenv("ANTIGRAVITY_CLI_CONFIG_DIR", profile)
	t.Setenv("GEMINI_HOME", t.TempDir())
	f := newFixture(t)
	chat := f.chat(f.acpAgent(model.Provider{ID: "antigravity", Name: "Antigravity"}))
	run := f.send(chat.ID, "main", "", "HTML report")
	f.wait(run.ID, "completed")
	session := f.waitNative(run.SessionID)
	brain := filepath.Join(profile, "brain")
	const name = "report #1.html"
	const document = `<!doctype html><img src="screen.png"><button id="part">Try</button>`
	writeReport := func(directory string) string {
		t.Helper()
		if err := os.MkdirAll(directory, 0700); err != nil {
			t.Fatal(err)
		}
		path := filepath.Join(directory, name)
		if err := os.WriteFile(path, []byte(document), 0600); err != nil {
			t.Fatal(err)
		}
		return path
	}
	report := writeReport(filepath.Join(brain, session.NativeID, "scratch"))
	if err := os.WriteFile(filepath.Join(filepath.Dir(report), "screen.png"), []byte("\x89PNG\r\n\x1a\n"), 0600); err != nil {
		t.Fatal(err)
	}
	endpoint := "/runs/" + run.ID + "/preview?kind=html&path="
	var info struct{ Path string }
	f.request("GET", endpoint+url.QueryEscape(report)+"&info=true", nil, http.StatusOK, &info)
	want, err := filepath.EvalSymlinks(report)
	if err != nil || info.Path != want {
		t.Fatalf("original path = %q, want %q (%v)", info.Path, want, err)
	}
	for _, download := range []bool{false, true} {
		address := f.s.URL + "/api" + endpoint + url.QueryEscape(report)
		if download {
			address += "&download=true"
		}
		req, err := http.NewRequest(http.MethodGet, address, nil)
		if err != nil {
			t.Fatal(err)
		}
		req.Header.Set("Authorization", "Bearer "+f.s.Token)
		req.Header.Set("Sec-Fetch-Dest", "iframe")
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		body, err := io.ReadAll(res.Body)
		res.Body.Close()
		if err != nil || res.StatusCode != http.StatusOK {
			t.Fatalf("read report (download=%t): %d, %v", download, res.StatusCode, err)
		}
		if download {
			disposition, params, err := mime.ParseMediaType(res.Header.Get("Content-Disposition"))
			if err != nil || string(body) != document || disposition != "attachment" || params["filename"] != name {
				t.Fatalf("download did not return the original file: %v, %q", res.Header, body)
			}
		} else if !strings.Contains(string(body), `src="data:image/png;base64,`) || !strings.Contains(res.Header.Get("Content-Security-Policy"), "sandbox allow-scripts;") {
			t.Fatalf("report was not previewed in the sandbox: %v, %q", res.Header, body)
		}
	}
	other := writeReport(filepath.Join(brain, "another-session", "scratch"))
	denied := func(path string) {
		t.Helper()
		for _, suffix := range []string{"", "&info=true", "&download=true"} {
			f.request("GET", endpoint+url.QueryEscape(path)+suffix, nil, http.StatusNotFound, nil)
		}
	}
	denied(other)
	if err := os.Symlink(other, filepath.Join(filepath.Dir(report), "linked.html")); err == nil {
		denied(filepath.Join(filepath.Dir(report), "linked.html"))
	}
	nativeDir := filepath.Join(brain, session.NativeID)
	if err := os.Rename(nativeDir, nativeDir+"-old"); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(brain, "another-session"), nativeDir); err == nil {
		denied(report)
	}
}
