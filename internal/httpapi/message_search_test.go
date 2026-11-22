package httpapi_test

import (
	"slices"
	"testing"

	"lever/internal/app"
	"lever/internal/model"
)

func TestMessageSearchFiltersChatMessageKinds(t *testing.T) {
	f := newFixture(t)
	owner, other := f.agent("codex"), f.agent("codex")
	chat := f.chat(owner)
	main := f.wait(f.send(chat.ID, "main", "", "kind-needle main").ID, "completed")
	topic := f.wait(f.send(chat.ID, "topic", "", "kind-needle topic").ID, "completed")
	compare := func(text string, status string) []string {
		t.Helper()
		var comparison model.Comparison
		f.request("POST", "/comparisons", model.ComparisonInput{
			CommandID: app.ID(), ChatID: chat.ID, AgentIDs: []string{owner.ID, other.ID}, Text: text,
		}, 200, &comparison)
		var results []model.ComparisonResult
		f.request("GET", "/comparisons/"+comparison.ID, nil, 200, &results)
		ids := []string{}
		for _, result := range results {
			ids = append(ids, f.wait(result.Run.ID, status).ID)
		}
		return ids
	}
	// The other Agent's reply belongs to its own Chat and appears in this Chat's comparison.
	replies := compare("kind-needle compare", "completed")
	search := func(query, kind string) []string {
		t.Helper()
		var matches []model.MessageMatch
		f.request("GET", "/search/messages?query="+query+"&chatId="+chat.ID+"&kind="+kind, nil, 200, &matches)
		ids := []string{}
		for _, match := range matches {
			ids = append(ids, match.RunID)
		}
		slices.Sort(ids)
		return ids
	}
	sorted := func(ids ...string) []string {
		slices.Sort(ids)
		return ids
	}
	for kind, want := range map[string][]string{
		"":           sorted(main.ID, topic.ID, replies[0], replies[1]),
		"main":       {main.ID},
		"topic":      {topic.ID},
		"comparison": sorted(replies...),
	} {
		if got := search("kind-needle", kind); !slices.Equal(got, want) {
			t.Fatalf("kind %q returned %v, want %v", kind, got, want)
		}
	}
	f.request("GET", "/search/messages?query=kind-needle&kind=reply", nil, 400, nil)

	// Every comparison Topic stores the shared prompt; show the prompt once.
	compare("shared-prompt [hang]", "running")
	if got := search("shared-prompt", "comparison"); len(got) != 1 {
		t.Fatalf("expected one shared prompt, got %v", got)
	}
}
