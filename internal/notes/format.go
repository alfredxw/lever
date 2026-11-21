// Package notes defines Lever's on-disk rich-text document format.
package notes

import (
	"bytes"
	"encoding/json"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"regexp"
	"strings"
)

const MaxContent = 1 << 20

var (
	IDPattern = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)
	nodeName  = regexp.MustCompile(`^[a-zA-Z][a-zA-Z0-9_-]*$`)
)

type Node struct {
	Type    string     `xml:"type,attr" json:"type"`
	Attrs   Attributes `xml:"attrs,attr,omitempty" json:"attrs,omitempty"`
	Marks   []Mark     `xml:"mark" json:"marks,omitempty"`
	Text    string     `xml:"text,omitempty" json:"text,omitempty"`
	Content []Node     `xml:"node" json:"content,omitempty"`
}

type Mark struct {
	Type  string     `xml:"type,attr" json:"type"`
	Attrs Attributes `xml:"attrs,attr,omitempty" json:"attrs,omitempty"`
}

// Attributes are stored as compact JSON objects in XML attributes. The codec
// can carry extension attributes without knowing their editor schema.
type Attributes json.RawMessage

func (a *Attributes) UnmarshalJSON(data []byte) error {
	data = bytes.TrimSpace(data)
	if len(data) == 0 || (data[0] != '{' && !bytes.Equal(data, []byte("null"))) || !json.Valid(data) {
		return errors.New("note attributes must be a JSON object")
	}
	*a = append((*a)[:0], data...)
	return nil
}

func (a Attributes) MarshalJSON() ([]byte, error)     { return json.RawMessage(a).MarshalJSON() }
func (a Attributes) MarshalText() ([]byte, error)     { return a, nil }
func (a *Attributes) UnmarshalText(data []byte) error { return a.UnmarshalJSON(data) }

type Document struct {
	ID      string `xml:"id,attr"`
	Title   string `xml:"title"`
	Project string `xml:"project,omitempty"`
	Blocks  []Node `xml:"body>block"`
}

type Marker struct {
	Done  bool
	Title string
}

func ParseContent(raw json.RawMessage) ([]Node, map[string]Marker, error) {
	var doc Node
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if len(raw) > MaxContent || decoder.Decode(&doc) != nil || decoder.Decode(new(any)) != io.EOF || doc.Type != "doc" || len(doc.Content) == 0 {
		return nil, nil, errors.New("a note must contain a document up to 1 MiB")
	}
	markers, err := Markers(doc.Content)
	return doc.Content, markers, err
}

func Markers(blocks []Node) (map[string]Marker, error) {
	tasks := map[string]Marker{}
	var walk func([]Node, int) error
	walk = func(nodes []Node, depth int) error {
		if depth > 64 {
			return errors.New("note nesting exceeds 64 levels")
		}
		for _, node := range nodes {
			if !nodeName.MatchString(node.Type) || !validText(node.Text) {
				return errors.New("invalid note node type")
			}
			if len(node.Attrs) != 0 {
				var attrs struct {
					TaskID string `json:"taskId"`
					Done   bool   `json:"done"`
				}
				if err := json.Unmarshal(node.Attrs, &attrs); err != nil {
					return errors.New("invalid node attributes")
				}
				if attrs.TaskID != "" {
					if _, exists := tasks[attrs.TaskID]; exists || !IDPattern.MatchString(attrs.TaskID) || node.Type != "paragraph" {
						return errors.New("invalid or repeated task marker")
					}
					var title strings.Builder
					for _, inline := range node.Content {
						title.WriteString(inline.Text)
						if inline.Type == "hardBreak" {
							title.WriteByte(' ')
						}
					}
					tasks[attrs.TaskID] = Marker{Done: attrs.Done, Title: strings.Join(strings.Fields(title.String()), " ")}
				} else if attrs.Done {
					return errors.New("a completed block must have a task marker")
				}
			}
			for _, mark := range node.Marks {
				if !nodeName.MatchString(mark.Type) || (len(mark.Attrs) > 0 && !json.Valid(mark.Attrs)) {
					return errors.New("invalid note mark")
				}
			}
			if len(node.Content) != 0 {
				if err := walk(node.Content, depth+1); err != nil {
					return err
				}
			}
		}
		return nil
	}
	return tasks, walk(blocks, 1)
}

func Content(blocks []Node) (json.RawMessage, error) {
	return json.Marshal(Node{Type: "doc", Content: blocks})
}

type file struct {
	XMLName xml.Name `xml:"lever-note"`
	Format  int      `xml:"format,attr"`
	Document
}

func Encode(doc Document) (string, error) {
	// Indentation is outside text elements; whitespace in text is significant.
	var buf bytes.Buffer
	buf.WriteString(xml.Header)
	enc := xml.NewEncoder(&buf)
	enc.Indent("", "  ")
	if !validText(doc.Title) || !validText(doc.Project) {
		return "", errors.New("note metadata contains invalid XML characters")
	}
	if err := enc.Encode(file{Format: 1, Document: doc}); err != nil {
		return "", err
	}
	buf.WriteByte('\n')
	return buf.String(), nil
}

func validText(text string) bool {
	for _, r := range text {
		if (r < ' ' && r != '\t' && r != '\n' && r != '\r') || r == 0xfffe || r == 0xffff {
			return false
		}
	}
	return true
}

func Decode(source string) (Document, error) {
	var saved file
	dec := xml.NewDecoder(strings.NewReader(source))
	if err := dec.Decode(&saved); err != nil {
		return Document{}, err
	}
	for {
		token, err := dec.Token()
		if errors.Is(err, io.EOF) {
			break
		}
		if c, ok := token.(xml.CharData); err != nil || !ok || len(bytes.TrimSpace(c)) != 0 {
			return Document{}, errors.New("unexpected content after note")
		}
	}
	if saved.Format != 1 || !IDPattern.MatchString(saved.ID) || len(saved.Blocks) == 0 {
		return Document{}, fmt.Errorf("invalid Lever note or unsupported format %d", saved.Format)
	}
	return saved.Document, nil
}
