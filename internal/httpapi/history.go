package httpapi

import (
	"strings"

	"lever/internal/model"
)

func deferHistoryToolOutput(runs []model.Run) {
	for i := range runs {
		deferRunToolOutput(&runs[i])
	}
}

// Only the response copy is compacted. Live output and small tool results
// stay inline, and clients that request the full run see its original items.
func deferRunToolOutput(run *model.Run) {
	switch run.Status {
	case "completed", "failed", "interrupted":
	default:
		return
	}
	toolIDs := make(map[string]bool)
	for _, item := range run.Items {
		// Historical citation markers resolve against the original tool output.
		if item.Kind == "text" && len(item.Citations) == 0 && strings.ContainsRune(item.Text, '\ue200') {
			return
		}
		if item.Kind == "tool" && item.ID != "" {
			// A detail URL must identify exactly one tool in this run.
			if toolIDs[item.ID] {
				return
			}
			toolIDs[item.ID] = true
		}
	}
	const inlineToolBytes = 1024
	for i := range run.Items {
		item := &run.Items[i]
		if item.Kind == "tool" && item.ID != "" && len(item.Text) > inlineToolBytes {
			item.DetailIDs = []string{item.ID}
			item.Text = ""
		}
	}
}
