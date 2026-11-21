package httpapi_test

import (
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestFileRawPreview(t *testing.T) {
	f := newFixture(t)
	agent := f.agent("codex")
	files := map[string]string{"movie.mp4": "\x00\x00\x00\x18ftypmp42", "sound.wav": "RIFF\x00WAVE", "book.pdf": "%PDF-1.7", "page.html": "<script>parent.pwned=true</script>", "font.woff2": "wOF2", "unknown.bin": "\x00\x01\x02"}
	for name, data := range files {
		if err := os.WriteFile(filepath.Join(f.root, name), []byte(data), 0600); err != nil {
			t.Fatal(err)
		}
	}
	request := func(path, extra string, auth bool) *http.Request {
		t.Helper()
		req, err := http.NewRequest("GET", f.s.URL+"/api/agents/"+agent.ID+"/file?root=root&raw=true&path="+url.QueryEscape(path)+extra, nil)
		if err != nil {
			t.Fatal(err)
		}
		if auth {
			req.Header.Set("Authorization", "Bearer "+f.s.Token)
		}
		return req
	}
	for name, content := range files {
		t.Run(name, func(t *testing.T) {
			res, err := http.DefaultClient.Do(request(name, "", true))
			if err != nil {
				t.Fatal(err)
			}
			defer res.Body.Close()
			body, err := io.ReadAll(res.Body)
			if err != nil || res.StatusCode != 200 || string(body) != content {
				t.Fatalf("raw response %d: %q, %v", res.StatusCode, body, err)
			}
			if res.Header.Get("X-Content-Type-Options") != "nosniff" || !strings.Contains(res.Header.Get("Content-Security-Policy"), "sandbox;") {
				t.Fatalf("unsafe headers: %v", res.Header)
			}
		})
	}
	t.Run("interactive HTML uses an opaque origin", func(t *testing.T) {
		for _, destination := range []string{"iframe", "document", ""} {
			req := request("page.html", "&preview=html", true)
			query := req.URL.Query()
			query.Del("raw")
			req.URL.RawQuery = query.Encode()
			req.Header.Set("Sec-Fetch-Dest", destination)
			res, err := http.DefaultClient.Do(req)
			if err != nil {
				t.Fatal(err)
			}
			body, err := io.ReadAll(res.Body)
			res.Body.Close()
			policy := res.Header.Get("Content-Security-Policy")
			if err != nil || res.StatusCode != 200 || string(body) != files["page.html"] ||
				!strings.HasPrefix(policy, "sandbox") ||
				strings.Contains(policy, "allow-scripts") != (destination == "iframe") {
				t.Fatalf("HTML preview (%q) %d: %q, %v, %v", destination, res.StatusCode, body, res.Header, err)
			}
		}
	})
	t.Run("range", func(t *testing.T) {
		req := request("movie.mp4", "", true)
		req.Header.Set("Range", "bytes=4-7")
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		body, _ := io.ReadAll(res.Body)
		if res.StatusCode != 206 || string(body) != files["movie.mp4"][4:8] || res.Header.Get("Content-Type") != "video/mp4" {
			t.Fatalf("range: %d, %q, %v", res.StatusCode, body, res.Header)
		}
	})
	t.Run("download", func(t *testing.T) {
		res, err := http.DefaultClient.Do(request("page.html", "&download=true", true))
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		if !strings.HasPrefix(res.Header.Get("Content-Disposition"), "attachment;") {
			t.Fatal(res.Header)
		}
	})
	t.Run("unsupported text is a preview capability response", func(t *testing.T) {
		req := request("unknown.bin", "", true)
		query := req.URL.Query()
		query.Del("raw")
		req.URL.RawQuery = query.Encode()
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		if res.StatusCode != http.StatusUnsupportedMediaType {
			t.Fatalf("unsupported file returned %d", res.StatusCode)
		}
	})
	outside := filepath.Join(t.TempDir(), "outside.pdf")
	if err := os.WriteFile(outside, []byte("private"), 0600); err != nil {
		t.Fatal(err)
	}
	paths := []string{".", "../outside.pdf", outside, "missing.pdf"}
	if os.Symlink(outside, filepath.Join(f.root, "escape.pdf")) == nil {
		paths = append(paths, "escape.pdf")
	}
	for _, path := range paths {
		res, err := http.DefaultClient.Do(request(path, "", true))
		if err != nil {
			t.Fatal(err)
		}
		res.Body.Close()
		if res.StatusCode < 400 {
			t.Fatalf("escaped scope: %s (%d)", path, res.StatusCode)
		}
	}
	res, err := http.DefaultClient.Do(request("book.pdf", "", false))
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != 401 {
		t.Fatalf("unauthenticated access: %d", res.StatusCode)
	}
}
