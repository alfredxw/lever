package provider

import (
	"bytes"
	"encoding/base64"
	"image"
	"image/png"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func testPNGBytes(t *testing.T) []byte {
	t.Helper()
	var buf bytes.Buffer
	if err := png.Encode(&buf, image.NewRGBA(image.Rect(0, 0, 1, 1))); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func TestAppendGeneratedImageEmbeds(t *testing.T) {
	t.Run("appends to prose and image-only replies and deduplicates inputs", func(t *testing.T) {
		p1 := "/tmp/generated/one.png"
		p2 := "/tmp/generated/two.png"

		got := appendGeneratedImageEmbeds("Here is your image.", []string{p1, "file://" + p1, p2})
		want := "Here is your image.\n\n![](</tmp/generated/one.png>)\n\n![](</tmp/generated/two.png>)"
		if got != want {
			t.Fatalf("got:\n%s\nwant:\n%s", got, want)
		}

		// Image-only reply starts directly with embeds (no leading blank lines).
		only := appendGeneratedImageEmbeds("", []string{p1})
		if only != "![](</tmp/generated/one.png>)" {
			t.Fatalf("image-only reply = %q", only)
		}

		// Idempotent when called twice.
		if again := appendGeneratedImageEmbeds(got, []string{p1, p2}); again != got {
			t.Fatalf("not idempotent:\nfirst:\n%s\nsecond:\n%s", got, again)
		}
	})

	t.Run("skips already embedded images across markdown, html, picture, and file urls", func(t *testing.T) {
		dir := t.TempDir()
		spaced := filepath.Join(dir, "my folder", "cat pic.png")
		if err := os.MkdirAll(filepath.Dir(spaced), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(spaced, testPNGBytes(t), 0o600); err != nil {
			t.Fatal(err)
		}
		alias := filepath.Join(dir, "alias.png")
		_ = os.Symlink(spaced, alias)

		encoded := strings.ReplaceAll(filepath.ToSlash(spaced), " ", "%20")
		cases := []struct {
			name string
			md   string
			path string
		}{
			{"markdown angle", "Done.\n\n![](<" + spaced + ">)", spaced},
			{"markdown percent-encoded", "Done.\n\n![cat](" + encoded + ")", spaced},
			{"markdown file url", "Done.\n\n![cat](file://" + encoded + ")", spaced},
			{"html img", `Done. <img src="` + spaced + `" alt="cat">`, spaced},
			{"html picture source", `<picture><source srcset="` + encoded + `"><img src="fallback.png"></picture>`, spaced},
			{"symlink alias", "Done.\n\n![](<" + alias + ">)", spaced},
		}
		for _, tc := range cases {
			if got := appendGeneratedImageEmbeds(tc.md, []string{tc.path}); got != tc.md {
				t.Errorf("%s: unexpectedly appended:\ngot:  %q\nwant: %q", tc.name, got, tc.md)
			}
		}
	})

	t.Run("still appends when image only appears as link, inline code, fenced code, or escaped", func(t *testing.T) {
		p := "/tmp/generated/art.png"
		cases := []string{
			"Saved at [art](" + p + ").",
			"Saved at `" + p + "`.",
			"```md\n![](" + p + ")\n```",
			`\![]` + "(" + p + ")",
		}
		for _, md := range cases {
			got := appendGeneratedImageEmbeds(md, []string{p})
			if !strings.HasSuffix(got, "\n\n![](</tmp/generated/art.png>)") {
				t.Errorf("expected embed appended for %q, got %q", md, got)
			}
		}
	})

	t.Run("closes unclosed trailing fences and html blocks without breaking closed empty fences", func(t *testing.T) {
		p := "/tmp/out.png"

		// Unclosed backtick fence.
		got := appendGeneratedImageEmbeds("```ts\nconst x = 1", []string{p})
		want := "```ts\nconst x = 1\n```\n\n![](</tmp/out.png>)"
		if got != want {
			t.Fatalf("unclosed backtick fence:\ngot:\n%s\nwant:\n%s", got, want)
		}

		// Unclosed tilde fence of length 4.
		got = appendGeneratedImageEmbeds("~~~~sh\necho hi", []string{p})
		want = "~~~~sh\necho hi\n~~~~\n\n![](</tmp/out.png>)"
		if got != want {
			t.Fatalf("unclosed tilde fence:\ngot:\n%s\nwant:\n%s", got, want)
		}

		// Already-closed empty fence must NOT get an extra closing fence.
		got = appendGeneratedImageEmbeds("```ts\n```", []string{p})
		want = "```ts\n```\n\n![](</tmp/out.png>)"
		if got != want {
			t.Fatalf("closed empty fence:\ngot:\n%s\nwant:\n%s", got, want)
		}

		// Unclosed HTML comment.
		got = appendGeneratedImageEmbeds("<!-- trailing note", []string{p})
		want = "<!-- trailing note\n-->\n\n![](</tmp/out.png>)"
		if got != want {
			t.Fatalf("unclosed html comment:\ngot:\n%s\nwant:\n%s", got, want)
		}

		// Unclosed <pre> block.
		got = appendGeneratedImageEmbeds("<pre>\nsome text", []string{p})
		want = "<pre>\nsome text\n</pre>\n\n![](</tmp/out.png>)"
		if got != want {
			t.Fatalf("unclosed pre block:\ngot:\n%s\nwant:\n%s", got, want)
		}
	})

	t.Run("escapes special characters and windows paths cleanly and stays idempotent", func(t *testing.T) {
		special := `/tmp/dir with space/100% ?a#b&c.png`
		got := appendGeneratedImageEmbeds("Special", []string{special})
		want := "Special\n\n![](</tmp/dir with space/100%25 %3Fa%23b%26c.png>)"
		if got != want {
			t.Fatalf("special chars:\ngot:  %q\nwant: %q", got, want)
		}
		if again := appendGeneratedImageEmbeds(got, []string{special}); again != got {
			t.Fatalf("special chars not idempotent:\ngot:  %q\nwant: %q", again, got)
		}

		win := `C:\work\artifacts\out.png`
		gotWin := appendGeneratedImageEmbeds("Win", []string{win})
		wantWin := "Win\n\n![](<C:/work/artifacts/out.png>)"
		if gotWin != wantWin {
			t.Fatalf("windows path:\ngot:  %q\nwant: %q", gotWin, wantWin)
		}
		if again := appendGeneratedImageEmbeds(gotWin, []string{win}); again != gotWin {
			t.Fatalf("windows path not idempotent:\ngot:  %q\nwant: %q", again, gotWin)
		}
	})
}

func TestMaterializeBase64Image(t *testing.T) {
	assets := t.TempDir()
	raw := testPNGBytes(t)
	encoded := base64.StdEncoding.EncodeToString(raw)

	budget := newTurnImageBudget()
	img, ok := materializeBase64Image(assets, "run-123", "item-1", "data:image/png;base64,\n "+encoded[:12]+"\n"+encoded[12:], budget)
	if !ok {
		t.Fatal("expected valid PNG data URL to materialize")
	}
	if !strings.HasSuffix(img.Path, ".png") || !strings.Contains(filepath.ToSlash(img.Path), "/generated-images/run-123/") {
		t.Fatalf("unexpected materialized path: %+v", img)
	}
	disk, err := os.ReadFile(img.Path)
	if err != nil || !bytes.Equal(disk, raw) {
		t.Fatalf("written bytes mismatch: err=%v len=%d want=%d", err, len(disk), len(raw))
	}

	// Rejects non-raster payloads (SVG, plain text, invalid base64).
	for _, bad := range []string{
		base64.StdEncoding.EncodeToString([]byte(`<svg xmlns="http://www.w3.org/2000/svg"></svg>`)),
		base64.StdEncoding.EncodeToString([]byte("<html><script>alert(1)</script></html>")),
		"!!!not-base64!!!",
	} {
		if _, ok := materializeBase64Image(assets, "run-123", "bad", bad, newTurnImageBudget()); ok {
			t.Fatalf("expected payload %q to be rejected", bad)
		}
	}

	// Empty assets dir refuses safely.
	if _, ok := materializeBase64Image("", "run-123", "no-assets", encoded, newTurnImageBudget()); ok {
		t.Fatal("expected empty assets dir to fail")
	}

	// Enforces per-turn count budget.
	capped := newTurnImageBudget()
	for i := range maxTurnGeneratedImages {
		if _, ok := materializeBase64Image(assets, "run-cap", "k", encoded, capped); !ok {
			t.Fatalf("expected image %d within budget to succeed", i)
		}
	}
	if _, ok := materializeBase64Image(assets, "run-cap", "overflow", encoded, capped); ok {
		t.Fatal("expected image beyond maxTurnGeneratedImages to be rejected")
	}
}

func TestExtractToolOutputImages(t *testing.T) {
	assets := t.TempDir()
	raw := testPNGBytes(t)
	encoded := base64.StdEncoding.EncodeToString(raw)
	existing := filepath.Join(t.TempDir(), "local.png")
	if err := os.WriteFile(existing, raw, 0o600); err != nil {
		t.Fatal(err)
	}

	payload := map[string]any{
		"content": []any{
			map[string]any{"type": "text", "text": "rendered"},
			map[string]any{"type": "image", "data": encoded, "mimeType": "image/png"},
			map[string]any{"type": "image", "source": map[string]any{"type": "base64", "media_type": "image/png", "data": encoded}},
			map[string]any{"type": "inputImage", "imageUrl": "data:image/png;base64," + encoded},
			map[string]any{"type": "inputImage", "imageUrl": "file://" + filepath.ToSlash(existing)},
		},
	}

	images, sanitized := extractToolOutputImages(assets, "run-tool", "call-1", "", payload, newTurnImageBudget())
	if len(images) != 4 {
		t.Fatalf("expected 4 extracted images, got %d: %+v", len(images), images)
	}
	text := pretty(sanitized)
	if strings.Contains(text, encoded) {
		t.Fatalf("sanitized output still contains raw base64: %s", text)
	}
	if !strings.Contains(text, "rendered") {
		t.Fatalf("sanitized output lost text block: %s", text)
	}
}

func TestExtractExistingImagePaths(t *testing.T) {
	dir := t.TempDir()
	img1 := filepath.Join(dir, "one.png")
	img2 := filepath.Join(dir, "sub dir", "two.jpg")
	txt := filepath.Join(dir, "notes.txt")
	if err := os.MkdirAll(filepath.Dir(img2), 0o700); err != nil {
		t.Fatal(err)
	}
	for _, p := range []string{img1, img2, txt} {
		if err := os.WriteFile(p, []byte("x"), 0o600); err != nil {
			t.Fatal(err)
		}
	}

	report := "Saved images:\n- ![first](" + filepath.ToSlash(img1) + ")\n- `" + img2 + "`\n- missing: " + filepath.Join(dir, "missing.png") + "\n- doc: `" + txt + "`"
	got := extractExistingImagePaths(report, dir)
	if len(got) != 2 {
		t.Fatalf("expected 2 existing images, got %d: %+v", len(got), got)
	}
	if got[0].Path != img1 || got[1].Path != img2 {
		t.Fatalf("unexpected extracted paths: %+v", got)
	}
}
