package notes

import (
	"encoding/json"
	"strings"
)

func markerID(node Node) string {
	var attrs struct{ TaskID string }
	if node.Type == "paragraph" && len(node.Attrs) > 0 {
		_ = json.Unmarshal(node.Attrs, &attrs)
	}
	return attrs.TaskID
}

// A list task owns the blocks in its list item. Other task markers own just
// their paragraph (including paragraphs in table cells).
func TaskBlocks(blocks []Node, id string) []Node {
	for i, block := range blocks {
		if block.Type == "listItem" && len(block.Content) > 0 && markerID(block.Content[0]) == id {
			return block.Content
		}
		if markerID(block) == id {
			return blocks[i : i+1]
		}
		if body := TaskBlocks(block.Content, id); body != nil {
			return body
		}
	}
	return nil
}

// Text renders the saved document without opening links or attachment files.
// Within a selected task, nested tasks are separate cards.
func Text(blocks []Node, taskID string) string {
	var out strings.Builder
	var write func([]Node)
	write = func(nodes []Node) {
		for _, node := range nodes {
			if taskID != "" {
				title := node
				if node.Type == "listItem" && len(node.Content) > 0 {
					title = node.Content[0]
				}
				if id := markerID(title); id != "" && id != taskID {
					continue
				}
			}
			switch node.Type {
			case "text":
				out.WriteString(node.Text)
				for _, mark := range node.Marks {
					var link struct{ Href string }
					if mark.Type == "link" && json.Unmarshal(mark.Attrs, &link) == nil && link.Href != node.Text {
						out.WriteString(" (" + link.Href + ")")
					}
				}
			case "agentMention", "noteAsset":
				var attrs struct{ Label, Name string }
				_ = json.Unmarshal(node.Attrs, &attrs)
				if node.Type == "agentMention" {
					out.WriteString("@" + attrs.Label)
				} else {
					out.WriteString("[" + attrs.Name + "]")
				}
			case "hardBreak":
				out.WriteByte('\n')
			default:
				write(node.Content)
				switch node.Type {
				case "paragraph", "heading", "codeBlock", "horizontalRule":
					out.WriteByte('\n')
				}
			}
		}
	}
	write(blocks)
	return strings.TrimRight(out.String(), "\n")
}
