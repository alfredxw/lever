package httpapi

import (
	"bytes"
	"encoding/base64"
	"io"
	"io/fs"
	"iter"
	"net/http"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"strings"

	"golang.org/x/net/html"
)

func previewImages(document []byte, root, relative string) []byte {
	const maxFiles = 64
	const maxEmbeddedBytes = 16 << 20
	parent, err := os.OpenRoot(root)
	if err != nil {
		return document
	}
	defer parent.Close()
	directory, err := parent.OpenRoot(filepath.Dir(relative))
	if err != nil {
		return document
	}
	defer directory.Close()

	cache := make(map[string]string)
	remaining := maxEmbeddedBytes
	var out bytes.Buffer
	unchanged := 0
	for ref := range previewRasters(bytes.NewReader(document)) {
		data, seen := cache[ref.name]
		if !seen && len(cache) < maxFiles {
			data = readPreviewRaster(directory, ref.name, remaining)
			cache[ref.name] = data
		}
		if data != "" && len(data) <= remaining {
			remaining -= len(data)
			ref.tag.Attr[ref.attr].Val = data
			out.Write(document[unchanged:ref.start])
			out.WriteString(ref.tag.String())
			unchanged = ref.end
		}
		if remaining == 0 {
			break
		}
	}
	if unchanged == 0 {
		return document
	}
	out.Write(document[unchanged:])
	return out.Bytes()
}

type rasterReference struct {
	tag              html.Token
	name             string
	start, end, attr int
}

func previewRasters(reader io.Reader) iter.Seq[rasterReference] {
	return func(yield func(rasterReference) bool) {
		tokens := html.NewTokenizer(reader)
		offset := 0
		for {
			kind := tokens.Next()
			start := offset
			offset += len(tokens.Raw())
			if kind == html.ErrorToken {
				break
			}
			if kind != html.StartTagToken && kind != html.SelfClosingTagToken {
				continue
			}
			token := tokens.Token()
			key := ""
			switch token.Data {
			case "img":
				key = "src"
			case "a":
				key = "href"
			default:
				continue
			}
			for index, attr := range token.Attr {
				if attr.Key != key {
					continue
				}
				name := relativeRasterPath(attr.Val)
				if name != "" && !yield(rasterReference{tag: token, name: name, start: start, end: offset, attr: index}) {
					return
				}
				break
			}
		}
	}
}

func relativeRasterPath(raw string) string {
	raw = strings.TrimSpace(raw)
	if len(raw) == 0 || len(raw) > 4096 {
		return ""
	}
	link, err := url.Parse(raw)
	if err != nil || link.IsAbs() || link.Host != "" || strings.ContainsAny(link.Path, `\:`) {
		return ""
	}
	name := path.Clean(link.Path)
	if !fs.ValidPath(name) {
		return ""
	}
	switch strings.ToLower(path.Ext(name)) {
	case ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".ico":
		local, _ := filepath.Localize(name)
		return local
	}
	return ""
}

func readPreviewRaster(directory *os.Root, name string, remaining int) string {
	limit := int64(remaining / 4 * 3)
	info, err := directory.Stat(name)
	if err != nil || !info.Mode().IsRegular() || info.Size() > limit {
		return ""
	}
	file, err := directory.Open(name)
	if err != nil {
		return ""
	}
	defer file.Close()
	if opened, err := file.Stat(); err != nil || !os.SameFile(info, opened) {
		return ""
	}
	data, err := io.ReadAll(io.LimitReader(file, limit+1))
	if err != nil || int64(len(data)) > limit {
		return ""
	}
	mime := http.DetectContentType(data)
	if !strings.HasPrefix(mime, "image/") || len("data:;base64,")+len(mime)+base64.StdEncoding.EncodedLen(len(data)) > remaining {
		return ""
	}
	return "data:" + mime + ";base64," + base64.StdEncoding.EncodeToString(data)
}
