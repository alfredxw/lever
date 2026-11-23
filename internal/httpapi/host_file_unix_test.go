//go:build !windows

package httpapi_test

import (
	"net/http"
	"net/url"
	"path/filepath"
	"syscall"
	"testing"
)

func TestHostFileRejectsFIFOAndDevFD(t *testing.T) {
	f := newFixture(t)
	fifo := filepath.Join(t.TempDir(), "pipe")
	if err := syscall.Mkfifo(fifo, 0600); err != nil {
		t.Fatal(err)
	}
	for _, target := range []string{fifo, "/dev/fd/0"} {
		req, err := http.NewRequest(http.MethodGet, f.s.URL+"/api/host-file?path="+url.QueryEscape(target), nil)
		if err != nil {
			t.Fatal(err)
		}
		req.Header.Set("Authorization", "Bearer "+f.s.Token)
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		res.Body.Close()
		if res.StatusCode < 400 {
			t.Fatalf("expected error for %s, got %d", target, res.StatusCode)
		}
	}
}
