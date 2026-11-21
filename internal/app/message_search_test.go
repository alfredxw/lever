package app

import (
	"regexp"
	"strings"
	"testing"
)

func TestMarkdownSearchPreviewClipsAfterRendering(t *testing.T) {
	source := "**" + strings.Repeat("中", 40) + "设备** [同步文档](/" +
		strings.Repeat("long-path/", 20) + "remote-devices.md) 和 `session_id`。"
	parts := markdownSearchPreview(source, regexp.MustCompile("设备"))
	var visible strings.Builder
	formatted := map[string]string{}
	var highlight string
	for _, part := range parts {
		visible.WriteString(part.Text)
		formatted[strings.Join(part.Tags, ",")] += part.Text
		if part.Highlight {
			highlight += part.Text
		}
	}
	if want := "…" + strings.Repeat("中", 27) + "设备 同步文档 和 session_id。"; visible.String() != want {
		t.Fatalf("preview = %q, want %q", visible.String(), want)
	}
	if highlight != "设备" || !strings.HasSuffix(formatted["strong"], highlight) ||
		formatted["a"] != "同步文档" || formatted["code"] != "session_id" {
		t.Fatalf("preview lost formatting or highlighting: %+v", parts)
	}
	if parts := markdownSearchPreview(source, regexp.MustCompile(`remote-devices\.md`)); len(parts) != 0 {
		t.Fatalf("a match in the URL should use the literal snippet: %+v", parts)
	}
}
