package httpapi

import (
	"bytes"
	"image"
	"image/png"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestPreviewImages(t *testing.T) {
	root := t.TempDir()
	report := filepath.Join(root, "report")
	if err := os.Mkdir(report, 0700); err != nil {
		t.Fatal(err)
	}
	var picture bytes.Buffer
	if err := png.Encode(&picture, image.NewRGBA(image.Rect(0, 0, 2, 1))); err != nil {
		t.Fatal(err)
	}
	for name, data := range map[string][]byte{
		"report/screen #1.png": picture.Bytes(), "outside.png": picture.Bytes(), "report/text.png": []byte("not a picture"),
	} {
		if err := os.WriteFile(filepath.Join(root, name), data, 0600); err != nil {
			t.Fatal(err)
		}
	}
	const untouched = "<!-- preserve -->\n<script>const text = '<img src=outside.png>'</script>\n"
	doc := untouched + `<a href="./screen%20%231.png"><img alt="actual" src="screen%20%231.png?v=1"></a>` +
		`<img src="../outside.png"><img src="missing.png"><img src="text.png"><a href="#notes">notes</a>`
	result := string(previewImages([]byte(doc), root, "report/compare.html"))
	if !strings.HasPrefix(result, untouched) || strings.Count(result, "data:image/png;base64,") != 2 ||
		!strings.HasSuffix(result, doc[strings.Index(doc, `<img src="../outside`):]) {
		t.Fatalf("unexpected preview: %s", result)
	}
	if err := os.Symlink(filepath.Join(root, "outside.png"), filepath.Join(report, "link.png")); err == nil {
		const link = `<img src="link.png">`
		if got := string(previewImages([]byte(link), root, "report/compare.html")); got != link {
			t.Fatal("image outside the HTML directory was embedded")
		}
	}
	for _, raw := range []string{"file:///picture.png", "https://example.org/picture.png", "/absolute.png", "%2e%2e/outside.png", "//server/share.png", "page.html", "icon.svg", "file.png%00"} {
		if got := relativeRasterPath(raw); got != "" {
			t.Errorf("unexpected local raster for %q: %q", raw, got)
		}
	}
	dir, err := os.OpenRoot(report)
	if err != nil {
		t.Fatal(err)
	}
	defer dir.Close()
	if got := readPreviewRaster(dir, "screen #1.png", 16); got != "" {
		t.Fatal("embedded image exceeded the preview byte budget")
	}
}
