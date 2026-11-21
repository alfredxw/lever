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

func TestFileImageAssets(t *testing.T) {
	f := newFixture(t)
	agent := f.agent("codex")
	var pngData bytes.Buffer
	if err := png.Encode(&pngData, image.NewRGBA(image.Rect(0, 0, 4, 4))); err != nil {
		t.Fatal(err)
	}
	// Images bypass the text editor's 2 MiB limit and UTF-8 validation.
	large := append(bytes.Clone(pngData.Bytes()), make([]byte, workspace.MaxFileBytes+1)...)
	images := map[string][]byte{
		"small image.png": pngData.Bytes(),
		"large.png":       large,
		"drawing.svg":     []byte(`<svg xmlns="http://www.w3.org/2000/svg"><script>window.assetExecuted=true</script><rect width="4" height="4"/></svg>`),
	}
	for name, data := range images {
		if err := os.WriteFile(filepath.Join(f.root, name), data, 0600); err != nil {
			t.Fatal(err)
		}
	}
	request := func(path string) *http.Request {
		t.Helper()
		req, err := http.NewRequest("GET", f.s.URL+"/api/agents/"+agent.ID+"/file?root=root&asset=true&path="+url.QueryEscape(path), nil)
		if err != nil {
			t.Fatal(err)
		}
		req.Header.Set("Authorization", "Bearer "+f.s.Token)
		return req
	}
	for name, data := range images {
		t.Run(name, func(t *testing.T) {
			response, err := http.DefaultClient.Do(request(name))
			if err != nil {
				t.Fatal(err)
			}
			defer response.Body.Close()
			body, err := io.ReadAll(response.Body)
			if err != nil || response.StatusCode != 200 || !bytes.Equal(body, data) {
				t.Fatalf("image response: %d, %v, %d bytes", response.StatusCode, err, len(body))
			}
			mediaType := "image/png"
			if strings.HasSuffix(name, ".svg") {
				mediaType = "image/svg+xml"
			}
			if response.Header.Get("Content-Type") != mediaType || response.Header.Get("X-Content-Type-Options") != "nosniff" || !strings.Contains(response.Header.Get("Content-Security-Policy"), "sandbox;") || response.Header.Get("Cache-Control") != "no-cache" {
				t.Fatalf("unsafe or stale image headers: %v", response.Header)
			}
		})
	}
	t.Run("range", func(t *testing.T) {
		req := request("large.png")
		req.Header.Set("Range", "bytes=0-7")
		response, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer response.Body.Close()
		data, err := io.ReadAll(response.Body)
		if err != nil || response.StatusCode != 206 || !bytes.Equal(data, large[:8]) {
			t.Fatalf("partial image: %d, %v, %q", response.StatusCode, err, data)
		}
	})
	if err := os.WriteFile(filepath.Join(f.root, "not-an-image.png"), []byte("<html>not an image</html>"), 0600); err != nil {
		t.Fatal(err)
	}
	tooLarge, err := os.Create(filepath.Join(f.root, "too-large.png"))
	if err != nil {
		t.Fatal(err)
	}
	if err := tooLarge.Truncate(workspace.MaxImageBytes + 1); err != nil {
		t.Fatal(err)
	}
	tooLarge.Close()
	outside := filepath.Join(t.TempDir(), "outside.png")
	if err := os.WriteFile(outside, pngData.Bytes(), 0600); err != nil {
		t.Fatal(err)
	}
	paths := []string{".", "not-an-image.png", "too-large.png", "../outside.png", outside, "missing.png"}
	if err := os.Symlink(outside, filepath.Join(f.root, "escape.png")); err == nil {
		paths = append(paths, "escape.png")
	}
	for _, path := range paths {
		t.Run(path, func(t *testing.T) {
			response, err := http.DefaultClient.Do(request(path))
			if err != nil {
				t.Fatal(err)
			}
			defer response.Body.Close()
			if response.StatusCode < 400 {
				t.Fatalf("invalid asset accepted: %d", response.StatusCode)
			}
		})
	}
	t.Run("authentication", func(t *testing.T) {
		req := request("small image.png")
		req.Header.Del("Authorization")
		response, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer response.Body.Close()
		if response.StatusCode != 401 {
			t.Fatalf("unauthenticated image access: %d", response.StatusCode)
		}
	})
}
