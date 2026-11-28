package provider

import (
	"context"
	"database/sql"
	"errors"
	"os"
	"strings"

	"lever/internal/model"
)

func codexSharedEntry(item object, turn, id, at string) (sharedEntry, bool) {
	entry := newSharedEntry(turn+"/"+id, "assistant", "tool", at)
	entry.TurnID = turn
	switch strings.ToLower(str(item["status"])) {
	case "inprogress", "in_progress", "running":
		entry.Status = "running"
	case "failed", "declined":
		entry.Status = "failed"
	}
	kind := strings.ToLower(str(item["type"]))
	switch kind {
	case "usermessage", "agentmessage":
		entry.Kind = "text"
		if kind == "usermessage" {
			entry.Role = "user"
		} else {
			switch str(item["phase"]) {
			case "commentary":
				entry.Kind = "commentary"
			case "final_answer":
				entry.Kind = "final"
			}
		}
		entry.Text = str(item["text"])
		useParts := entry.Text == ""
		for _, value := range arr(item["content"]) {
			part := obj(value)
			switch str(part["type"]) {
			case "text", "output_text":
				if useParts {
					entry.Text += str(part["text"])
				}
			case "localImage", "local_image":
				entry.addImage(sharedImage{path: str(part["path"])})
			case "image":
				entry.addImageURL(str(part["url"]))
			}
		}
	case "reasoning":
		entry.Kind = "reasoning"
		entry.Text = codexReasoning(nil).text(item)
	case "commandexecution":
		entry.Title = str(item["command"])
		entry.Text = str(item["aggregatedOutput"])
		applyCodexCommandOutcome(&entry.Item, item)
	case "filechange":
		entry.Title, entry.Text = "File changes", pretty(item["changes"])
	case "mcptoolcall", "dynamictoolcall":
		entry.Title = str(item["tool"])
		if server := str(item["server"]); server != "" {
			entry.Title = server + " / " + entry.Title
		}
		result := obj(item["result"])
		parts := []string{pretty(item["arguments"])}
		for _, value := range append(arr(result["content"]), arr(item["contentItems"])...) {
			part := obj(value)
			switch str(part["type"]) {
			case "text", "inputText":
				parts = append(parts, sharedDetail(str(part["text"])))
			case "image":
				entry.addImage(sharedImage{data: str(part["data"])})
			case "inputImage":
				entry.addImageURL(str(part["imageUrl"]))
			}
		}
		if item["error"] != nil || result["isError"] == true || item["success"] == false {
			entry.Status = "failed"
			parts = append(parts, pretty(item["error"]))
		}
		entry.Text = strings.TrimSpace(strings.Join(parts, "\n\n"))
	case "collabagenttoolcall":
		entry.Title, entry.Text = str(item["tool"]), str(item["prompt"])
	case "websearch":
		entry.Title, entry.Text = "Web search", str(item["query"])
	case "plan":
		entry.Title, entry.Text = "Plan", str(item["text"])
	case "imageview":
		entry.Title = "View image"
		entry.ToolAction = model.ToolActionRead
		entry.addImage(sharedImage{path: str(item["path"])})
	case "imagegeneration":
		entry.Title = "Generate image"
		entry.ToolAction = model.ToolActionImage
		if item["failure"] != nil {
			entry.Status = "failed"
		}
		entry.addImage(sharedImage{path: str(item["savedPath"]), data: str(item["result"])})
		if len(entry.Images) > 0 {
			entry.Kind = "image"
		} else {
			var transparent *bool
			if flag, ok := item["transparentBackground"].(bool); ok {
				transparent = &flag
			}
			entry.Text = formatCodexImageGenDetail(strings.TrimSpace(str(item["revisedPrompt"])), transparent, strings.TrimSpace(str(item["savedPath"])), item["failure"])
		}
	default:
		return entry, false
	}
	if entry.Kind == "tool" || entry.Kind == "reasoning" {
		entry.Text = sharedDetail(entry.Text)
	}
	return entry, entry.Kind == "tool" || strings.TrimSpace(entry.Text) != "" || len(entry.Images) > 0
}

func readSharedCodexEntry(ctx context.Context, config model.Provider, id, messageID string) (sharedEntry, error) {
	turnID, itemID, ok := strings.Cut(messageID, "/")
	if !ok || itemID == "" {
		return sharedEntry{}, os.ErrNotExist
	}
	threads, err := sharedCodexThreads(ctx, config, id)
	if err != nil {
		return sharedEntry{}, err
	}
	if thread := threads[0]; thread.usesProjection() {
		db, err := openSharedCodexDB(SharedStore(config), "thread_history_")
		if err != nil {
			return sharedEntry{}, err
		}
		defer db.Close()
		var raw []byte
		err = db.QueryRowContext(ctx, `SELECT item_json FROM thread_items WHERE thread_id=? AND turn_id=? AND item_id=?`, id, turnID, itemID).Scan(&raw)
		if errors.Is(err, sql.ErrNoRows) {
			return sharedEntry{}, os.ErrNotExist
		}
		if err != nil {
			return sharedEntry{}, err
		}
		item, err := decode(raw)
		entry, _ := codexSharedEntry(item, turnID, itemID, "")
		return entry, err
	}
	client, err := openDiscovery(ctx, config, "", nil)
	if err != nil {
		return sharedEntry{}, err
	}
	defer client.close()
	if threads[0].mode == "paginated" {
		params := object{"threadId": id, "turnId": turnID, "limit": 32}
		for {
			result, err := client.call("thread/items/list", params)
			if err != nil {
				return sharedEntry{}, err
			}
			for _, value := range arr(result["data"]) {
				if item := obj(obj(value)["item"]); str(item["id"]) == itemID {
					entry, _ := codexSharedEntry(item, turnID, itemID, "")
					return entry, nil
				}
			}
			cursor := str(result["nextCursor"])
			if cursor == "" {
				break
			}
			params["cursor"] = cursor
		}
	} else {
		turns, err := codexLegacySharedTurns(client, id)
		if err != nil {
			return sharedEntry{}, err
		}
		for _, value := range turns {
			turn := obj(value)
			if str(turn["id"]) != turnID {
				continue
			}
			for _, value := range arr(turn["items"]) {
				if item := obj(value); str(item["id"]) == itemID {
					entry, _ := codexSharedEntry(item, turnID, itemID, "")
					return entry, nil
				}
			}
		}
	}
	return sharedEntry{}, os.ErrNotExist
}
