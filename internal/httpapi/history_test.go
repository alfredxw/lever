package httpapi_test

import (
	"encoding/json"
	"fmt"
	"net/url"
	"reflect"
	"slices"
	"strings"
	"testing"

	"lever/internal/model"
)

func TestHistoryDefersToolTextUntilRequested(t *testing.T) {
	f := newFixture(t)
	chat := f.chat(f.agent("codex"))
	run := f.wait(f.send(chat.ID, "topic", "", "inspect files").ID, "completed")
	items := []model.Item{
		{ID: "read/文件", Kind: "tool", Title: "Read files", Text: strings.Repeat("build output\n", 300), Status: "completed", ToolAction: model.ToolActionRead,
			ImageFiles: []model.ImageFile{{Path: "image.png"}}},
		{ID: "short", Kind: "tool", Text: "ok", Status: "completed"},
		{ID: "answer", Kind: "text", Text: "Final answer", Status: "completed"},
	}
	setItems := func() {
		t.Helper()
		data, err := json.Marshal(items)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := f.a.Store.DB.Exec("UPDATE runs SET data=json_set(data,'$.items',json(?)) WHERE id=?", string(data), run.ID); err != nil {
			t.Fatal(err)
		}
	}
	setItems()
	want := slices.Clone(items)
	want[0].Text, want[0].DetailIDs = "", []string{items[0].ID}
	var chatPage model.ChatView
	var info model.SessionView
	var history model.SessionRuns
	query := "?toolOutput=lazy"
	sessionPath := "/sessions/" + run.SessionID
	f.request("GET", "/chats/"+chat.ID+query, nil, 200, &chatPage)
	f.request("GET", sessionPath+query, nil, 200, &info)
	f.request("GET", sessionPath+"/runs"+query, nil, 200, &history)
	for _, result := range []model.Run{chatPage.Runs[0], *info.Root, history.Runs[0]} {
		if !reflect.DeepEqual(result.Items, want) {
			t.Fatal("compact history lost item ordering, metadata or reply text")
		}
	}
	var detail string
	runPath := "/runs/" + run.ID
	f.request("GET", runPath+"/details/"+url.PathEscape(items[0].ID), nil, 200, &detail)
	if detail != items[0].Text {
		t.Fatal("expanded tool output differs from the original")
	}
	f.request("GET", runPath+"/details/answer", nil, 404, nil)
	f.request("GET", "/runs/missing/details/"+url.PathEscape(items[0].ID), nil, 404, nil)
	var full model.Run
	f.request("GET", runPath, nil, 200, &full)
	if !reflect.DeepEqual(full.Items, items) {
		t.Fatal("full run changed after projecting its history")
	}
	// Legacy replies resolve their raw citation markers against tool text.
	items[2].Text = "Source \ue200cite\ue202turn0search0\ue201"
	setItems()
	var legacy model.SessionRuns
	f.request("GET", sessionPath+"/runs"+query, nil, 200, &legacy)
	if !reflect.DeepEqual(legacy.Runs[0].Items, items) {
		t.Fatal("legacy citation sources missing from history")
	}
	items[2].Text = "Final answer"
	items[1].ID = items[0].ID
	setItems()
	var duplicate model.SessionRuns
	f.request("GET", sessionPath+"/runs"+query, nil, 200, &duplicate)
	if !reflect.DeepEqual(duplicate.Runs[0].Items, items) {
		t.Fatal("tool outputs with ambiguous IDs must stay inline")
	}
	items[1].ID = "short"
	setItems()
	if _, err := f.a.Store.DB.Exec("UPDATE runs SET status='running', data=json_set(data,'$.status','running') WHERE id=?", run.ID); err != nil {
		t.Fatal(err)
	}
	var live model.SessionRuns
	f.request("GET", sessionPath+"/runs"+query, nil, 200, &live)
	if !reflect.DeepEqual(live.Runs[0].Items, items) {
		t.Fatal("live tool output must stay inline")
	}
}

func TestSessionHistoryCursorAcrossPageSizes(t *testing.T) {
	f := newFixture(t)
	chat := f.chat(f.agent("codex"))
	first := f.wait(f.send(chat.ID, "topic", "", "first").ID, "completed")
	second := f.wait(f.send(chat.ID, "reply", first.SessionID, "second").ID, "completed")
	last := f.wait(f.send(chat.ID, "reply", first.SessionID, "last").ID, "completed")
	path := "/sessions/" + first.SessionID + "/runs"
	var head, tail model.SessionRuns
	f.request("GET", path+"?limit=1", nil, 200, &head)
	if len(head.Runs) != 1 || head.Runs[0].ID != last.ID || head.NextBefore != last.Sequence {
		t.Fatal("first page did not return the exclusive position of its oldest run")
	}
	f.request("GET", fmt.Sprintf("%s?limit=2&before=%d", path, head.NextBefore), nil, 200, &tail)
	if len(tail.Runs) != 2 || tail.Runs[0].ID != second.ID || tail.Runs[1].ID != first.ID || tail.NextBefore != 0 {
		t.Fatal("an exactly full final page must contain every remaining run and end pagination")
	}
}
