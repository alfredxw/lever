package httpapi_test

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"testing"

	"lever/internal/app"
	"lever/internal/model"
)

func TestComparisonSharesSelectedSkillAcrossRuntimes(t *testing.T) {
	for _, runtime := range []string{"codex", "claude"} {
		t.Run(runtime, func(t *testing.T) {
			f := newFixture(t)
			owner := f.agent(runtime)
			other := f.acpAgent(model.Provider{ID: "antigravity", Name: "Antigravity"})
			chat := f.chat(owner)
			var skill model.Skill
			f.request("POST", "/skills", map[string]string{"name": "check-ideas"}, 200, &skill)
			const guide = "Review using the selected package's guide."
			if err := os.WriteFile(filepath.Join(skill.Path, "guide.md"), []byte(guide), 0600); err != nil {
				t.Fatal(err)
			}
			other.Profile.Roots[0].Path = t.TempDir()
			otherPackage := filepath.Join(other.Profile.Roots[0].Path, ".agents", "skills", skill.Name)
			if err := os.MkdirAll(otherPackage, 0700); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(filepath.Join(otherPackage, model.SkillEntry), []byte("---\nname: check-ideas\ndescription: Other version.\n---\nDifferent instructions\n"), 0600); err != nil {
				t.Fatal(err)
			}
			f.request("PUT", "/agents/"+other.ID, other, 200, &other)
			var refs []model.Reference
			f.request("GET", "/chats/"+chat.ID+"/suggestions?kind=skill&provider="+runtime, nil, 200, &refs)
			i := slices.IndexFunc(refs, func(ref model.Reference) bool { return ref.Name == skill.Name })
			if i < 0 {
				t.Fatalf("missing Skill suggestion: %+v", refs)
			}
			ref := refs[i]
			input := model.ComparisonInput{
				CommandID: app.ID(), ChatID: chat.ID, AgentIDs: []string{other.ID, owner.ID},
				Text: "[wire] $check-ideas", References: []model.Reference{ref},
			}
			var comparison model.Comparison
			f.request("POST", "/comparisons", input, 200, &comparison)
			if !reflect.DeepEqual(comparison.Message.References, input.References) {
				t.Fatalf("the first recipient changed the shared message: %+v", comparison.Message)
			}
			var results []model.ComparisonResult
			f.request("GET", "/comparisons/"+comparison.ID, nil, 200, &results)
			if len(results) != 2 {
				t.Fatalf("expected two Topics, got %d", len(results))
			}
			entry := filepath.Join(skill.Path, model.SkillEntry)
			foreign := f.wait(results[0].Run.ID, "completed")
			receipt := acpReceipt(t, foreign)
			prompt := receipt["input"].(string)
			command, body, _ := strings.Cut(prompt, " ")
			if !strings.HasPrefix(command, "/check-ideas-") || !strings.Contains(body, other.Profile.Instructions) ||
				!strings.Contains(body, input.Text) || strings.Contains(body, "Read and follow") {
				t.Fatalf("Antigravity did not receive the native Skill and complete prompt: %s", prompt)
			}
			dirs, _ := receipt["directories"].([]any)
			if len(dirs) != 1 {
				t.Fatalf("expected a session Skill directory, got %v", dirs)
			}
			packageDir := filepath.Join(dirs[0].(string), ".agents", "skills", command[1:])
			manifest, err := os.ReadFile(filepath.Join(packageDir, model.SkillEntry))
			if err != nil || !strings.Contains(string(manifest), "# check-ideas") {
				t.Fatalf("native command resolved the wrong manifest: %q, %v", manifest, err)
			}
			if data, err := os.ReadFile(filepath.Join(packageDir, "guide.md")); err != nil || string(data) != guide {
				t.Fatalf("native Skill lost its companion file: %q, %v", data, err)
			}
			var topic model.SessionView
			f.request("GET", "/sessions/"+foreign.SessionID, nil, 200, &topic)
			catalog := topic.Session.Runtime.Commands
			if catalog == nil || slices.ContainsFunc(*catalog, func(c model.NativeCommand) bool { return c.Name == command[1:] }) {
				t.Fatal("the command picker should only expose the runtime's public commands")
			}
			native := f.wait(results[1].Run.ID, "completed")
			if !reflect.DeepEqual(native.References, input.References) {
				t.Fatalf("changed the source runtime's references: %+v", native.References)
			}
			var wire struct {
				Input  string
				Skills []struct{ Name, Path string }
			}
			if err := json.Unmarshal([]byte(strings.TrimPrefix(native.Items[0].Text, "wire:")), &wire); err != nil {
				t.Fatal(err)
			}
			if runtime == "codex" && (len(wire.Skills) != 1 || wire.Skills[0].Name != ref.Name || wire.Skills[0].Path != entry) {
				t.Fatalf("Codex did not receive the native Skill: %+v", wire)
			}
			if runtime == "claude" && !strings.Contains(wire.Input, "/"+ref.Name) {
				t.Fatalf("Claude did not receive the native Skill: %+v", wire)
			}
			var reply model.Run
			f.request("POST", "/messages", model.SendInput{
				CommandID: app.ID(), ChatID: foreign.ChatID, SessionID: foreign.SessionID, Operation: "reply",
				Text: input.Text, References: foreign.References,
			}, 200, &reply)
			reply = f.wait(reply.ID, "completed")
			if reply.References[0].Path != entry || !strings.HasPrefix(acpReceipt(t, reply)["input"].(string), "/check-ideas-") {
				t.Fatal("the reply lost the selected package")
			}
		})
	}
}

func TestComparisonDispatchesSelectedModelsAndEfforts(t *testing.T) {
	f := newFixture(t)
	owner, reviewer := f.agent("claude"), f.agent("codex")
	input := model.ComparisonInput{
		CommandID: app.ID(), AgentID: owner.ID, AgentIDs: []string{owner.ID, reviewer.ID}, Text: "[wire] Compare",
		Selections: map[string]model.ComparisonSelection{
			owner.ID:    {Selection: model.Selection{Provider: "codex", Model: "gpt-review", Effort: "high", Fast: true}, ModelName: "GPT Review"},
			reviewer.ID: {Selection: model.Selection{Provider: "claude", Model: "default", Effort: "max"}, ModelName: "Claude Sonnet"},
		},
	}
	var comparison model.Comparison
	f.request("POST", "/comparisons", input, 200, &comparison)
	var results []model.ComparisonResult
	f.request("GET", "/comparisons/"+comparison.ID, nil, 200, &results)
	if len(results) != len(input.AgentIDs) {
		t.Fatalf("expected a result per Agent, got %d", len(results))
	}
	for _, result := range results {
		want := input.Selections[result.Session.AgentID]
		run := f.wait(result.Run.ID, "completed")
		got := run.Selection
		if got.Provider != want.Provider || got.Model != want.Model || got.Effort != want.Effort || got.Fast != want.Fast || got != result.Session.Selection || result.Session.Comparison.ModelName != want.ModelName {
			t.Fatalf("wrong comparison selection: run %+v, Topic %+v", got, result.Session)
		}
		var wire struct{ Model, Effort string }
		if len(run.Items) != 1 || json.Unmarshal([]byte(strings.TrimPrefix(run.Items[0].Text, "wire:")), &wire) != nil || wire.Model != want.Model || wire.Effort != want.Effort {
			t.Fatalf("runtime did not receive its selection: %+v", run.Items)
		}
	}
	delete(input.Selections, reviewer.ID)
	f.request("POST", "/comparisons", input, 400, nil)
}

func TestComparisonKeepsAgentTopicsAndOneTimelineEntry(t *testing.T) {
	f := newFixture(t)
	owner := f.agent("codex")
	second := f.agent("claude")
	third := f.agent("codex")
	third.Name, third.Profile.Instructions = "Independent reviewer", "third-profile"
	f.request("PUT", "/agents/"+third.ID, third, 200, &third)
	chat := f.chat(owner)
	previous := f.send(chat.ID, "main", "", "before comparison")
	f.wait(previous.ID, "completed")
	file := f.upload(chat.ID, "notes.md", []byte("Shared notes"))
	input := model.ComparisonInput{
		CommandID: app.ID(), ChatID: chat.ID, AgentIDs: []string{second.ID, third.ID, owner.ID},
		Text: "Compare this **request**", AttachmentIDs: []string{file.ID},
		Quote: &model.MessageQuote{RunID: previous.ID, Role: "user"},
	}
	var comparison, duplicate model.Comparison
	f.request("POST", "/comparisons", input, 200, &comparison)
	f.request("POST", "/comparisons", input, 200, &duplicate)
	if !reflect.DeepEqual(comparison, duplicate) || len(comparison.SessionIDs) != 3 {
		t.Fatalf("comparison retry produced a different batch: %+v / %+v", comparison, duplicate)
	}
	changed := input
	changed.Text = "different request"
	f.request("POST", "/comparisons", changed, 409, nil)
	var results []model.ComparisonResult
	f.request("GET", "/comparisons/"+comparison.ID, nil, 200, &results)
	if len(results) != 3 {
		t.Fatalf("want three results, got %d", len(results))
	}
	bindings := map[string]bool{}
	for i, result := range results {
		run := f.wait(result.Run.ID, "completed")
		var topic model.SessionView
		f.request("GET", "/sessions/"+result.Session.ID, nil, 200, &topic)
		session := topic.Session
		if session.Kind != "topic" || session.AgentID != input.AgentIDs[i] || session.Comparison == nil || session.Comparison.ChatID != chat.ID || session.Comparison.ID != comparison.ID {
			t.Fatalf("incorrect Topic identity: %+v", session)
		}
		if session.NativeID == "" || bindings[session.NativeID] || run.Input != input.Text || run.Quote == nil || run.Quote.Text != previous.Input || len(run.Attachments) != 1 || run.Attachments[0].ID != file.ID {
			t.Fatalf("incorrect Topic binding or payload: %+v %+v", session, run)
		}
		bindings[session.NativeID] = true
		if i == 0 && run.Selection.Provider != second.Profile.Provider {
			t.Fatalf("foreign Topic used the source Agent runtime: %+v", run.Selection)
		}
		if i == 1 && !strings.Contains(run.Items[len(run.Items)-1].Text, third.Profile.Instructions) {
			t.Fatal("the runtime did not receive the recipient's instructions")
		}
		if i == 0 {
			reply := f.send(session.ChatID, "reply", session.ID, "Continue with this reply")
			f.wait(reply.ID, "completed")
			f.request("GET", "/sessions/"+session.ID, nil, 200, &topic)
			if topic.Session.NativeID != session.NativeID {
				t.Fatal("continuation opened another native session")
			}
		}
	}
	f.request("GET", "/comparisons/"+comparison.ID, nil, 200, &results)
	if results[0].Run.Input != input.Text || results[0].Run.Status != "completed" {
		t.Fatal("a follow-up replaced the compared reply")
	}
	var view model.ChatView
	f.request("GET", "/chats/"+chat.ID+"?limit=1", nil, 200, &view)
	if len(view.Entries) != 1 || !view.HasMore || view.Entries[0].Kind != "comparison" || view.Entries[0].ComparisonID != comparison.ID || len(view.Comparisons) != 1 {
		t.Fatalf("expected one comparison entry: %+v", view.Entries)
	}
	var older model.ChatView
	f.request("GET", "/chats/"+chat.ID+"?before="+fmt.Sprint(comparison.Sequence), nil, 200, &older)
	if len(older.Entries) != 1 || older.Entries[0].RunID != previous.ID {
		t.Fatalf("comparison position did not paginate with normal messages: %+v", older.Entries)
	}
}

func TestComparisonSharesSourceScope(t *testing.T) {
	for _, source := range []struct {
		name    string
		hasChat bool
		hasMain bool
	}{
		{name: "existing session", hasChat: true, hasMain: true},
		{name: "Chat without a main session", hasChat: true},
		{name: "new Chat"},
	} {
		t.Run(source.name, func(t *testing.T) {
			f := newFixture(t)
			owner, reviewer := f.agent("codex"), f.agent("claude")
			owner.Profile.Roots = append(owner.Profile.Roots, model.Root{ID: "primary", Path: t.TempDir()})
			owner.Profile.PrimaryRootID = "primary"
			f.request("PUT", "/agents/"+owner.ID, owner, 200, &owner)
			reviewer.Profile.Roots[0].Path = t.TempDir()
			f.request("PUT", "/agents/"+reviewer.ID, reviewer, 200, &reviewer)
			want := owner.Profile.Scope
			primary := want.Roots[1].Path
			filename := filepath.Join(primary, "shared-reference.txt")
			if err := os.WriteFile(filename, []byte("A shared file"), 0600); err != nil {
				t.Fatal(err)
			}

			input := model.ComparisonInput{
				CommandID: app.ID(), AgentID: owner.ID, AgentIDs: []string{owner.ID, reviewer.ID},
				SharedScope: true, Text: "[wire] Compare in the same directory",
				References: []model.Reference{{Kind: "file", Name: filepath.Base(filename), Path: filename}},
			}
			if source.hasChat {
				chat := f.chat(owner)
				input.ChatID, input.AgentID = chat.ID, ""
			}
			if source.hasMain {
				previous := f.send(input.ChatID, "main", "", "Start the Chat")
				f.wait(previous.ID, "completed")
				owner.Profile.Scope = reviewer.Profile.Scope
				f.request("PUT", "/agents/"+owner.ID, owner, 200, &owner)
			}

			var comparison, replay model.Comparison
			f.request("POST", "/comparisons", input, 200, &comparison)
			f.request("POST", "/comparisons", input, 200, &replay)
			if comparison.ID != replay.ID {
				t.Fatal("retry created another comparison")
			}
			var results []model.ComparisonResult
			f.request("GET", "/comparisons/"+comparison.ID, nil, 200, &results)
			if len(results) != len(input.AgentIDs) {
				t.Fatalf("expected a result per Agent, got %d", len(results))
			}
			for _, result := range results {
				if !reflect.DeepEqual(result.Session.Scope, want) {
					t.Fatalf("Topic Scope: got %+v, want %+v", result.Session.Scope, want)
				}
				run := f.wait(result.Run.ID, "completed")
				var wire struct{ CWD string }
				if len(run.Items) != 1 || json.Unmarshal([]byte(strings.TrimPrefix(run.Items[0].Text, "wire:")), &wire) != nil || wire.CWD != primary {
					t.Fatalf("expected runtime to start in %q: %+v", primary, run.Items)
				}
			}
		})
	}
}

func TestComparisonValidationRollsBackEveryRecipient(t *testing.T) {
	f := newFixture(t)
	owner := f.agent("codex")
	other := f.agent("claude")
	other.Profile.Roots[0].Path = t.TempDir()
	other.Profile.DisabledSkills = []string{"review"}
	f.request("PUT", "/agents/"+other.ID, other, 200, &other)
	path := filepath.Join(f.root, "only-here.txt")
	if err := os.WriteFile(path, []byte("A scoped file"), 0600); err != nil {
		t.Fatal(err)
	}
	file, err := f.a.UploadDraft(t.Context(), owner.ID, "draft.txt", strings.NewReader("An attachment"))
	if err != nil {
		t.Fatal(err)
	}
	input := model.ComparisonInput{
		CommandID: app.ID(), AgentID: owner.ID, AgentIDs: []string{owner.ID, other.ID},
		Text: "Inspect the file", AttachmentIDs: []string{file.ID},
		References: []model.Reference{{Kind: "file", Name: "only-here.txt", Path: path}},
	}
	f.request("POST", "/comparisons", input, 400, nil)
	var skill model.Skill
	f.request("POST", "/skills", map[string]string{"name": "review"}, 200, &skill)
	input.References = []model.Reference{{Kind: "skill", Provider: "codex", Name: skill.Name, Path: filepath.Join(skill.Path, model.SkillEntry)}}
	var rejected map[string]string
	f.request("POST", "/comparisons", input, 400, &rejected)
	if !strings.Contains(rejected["error"], other.Name) || !strings.Contains(rejected["error"], "disabled") {
		t.Fatalf("missing recipient Skill policy error: %v", rejected)
	}
	var overview model.Overview
	f.request("GET", "/overview", nil, 200, &overview)
	if len(overview.Chats) != 0 || len(overview.Runs) != 0 {
		t.Fatalf("invalid comparison partially dispatched: %+v", overview)
	}
	// The original command and draft attachment remain available for a corrected submission.
	input.References = nil
	var comparison model.Comparison
	f.request("POST", "/comparisons", input, 200, &comparison)
	if len(comparison.SessionIDs) != 2 || len(comparison.Message.Attachments) != 1 || comparison.Message.Attachments[0].ID != file.ID {
		t.Fatalf("corrected comparison lost the draft: %+v", comparison)
	}
}

func TestComparisonRetryReusesSharedAttachmentAndSkill(t *testing.T) {
	f := newFixture(t)
	owner := f.agent("claude")
	reviewer := f.agent("codex")
	if err := os.Mkdir(filepath.Join(f.root, ".git"), 0700); err != nil {
		t.Fatal(err)
	}
	chat := f.chat(owner)
	file := f.upload(chat.ID, "notes.txt", []byte("Shared notes"))
	var skill model.Skill
	f.request("POST", "/skills", map[string]string{"name": "review"}, 200, &skill)
	input := model.ComparisonInput{
		CommandID: app.ID(), ChatID: chat.ID, AgentIDs: []string{owner.ID, reviewer.ID},
		Text: "[fail-once] [wire] Review the notes", AttachmentIDs: []string{file.ID},
		References: []model.Reference{{Kind: "skill", Provider: "claude", Name: skill.Name}},
	}
	var comparison model.Comparison
	f.request("POST", "/comparisons", input, 200, &comparison)
	var results []model.ComparisonResult
	endpoint := "/comparisons/" + comparison.ID
	f.request("GET", endpoint, nil, 200, &results)
	f.wait(results[0].Run.ID, "completed")
	first := f.wait(results[1].Run.ID, "waiting_user")
	var overview model.Overview
	f.request("GET", "/overview", nil, 200, &overview)
	var request model.Request
	for _, pending := range overview.Requests {
		if pending.RunID == first.ID {
			request = pending
			break
		}
	}
	if request.ID == "" || request.AllowOnce == nil {
		t.Fatal("fixture did not request permission")
	}
	f.request("POST", "/requests/"+request.ID+"/answer", *request.AllowOnce, 200, nil)
	f.wait(first.ID, "failed")
	var retry model.Run
	f.request("POST", "/runs/"+first.ID+"/retry", map[string]string{"commandId": app.ID()}, 200, &retry)
	retry = f.wait(retry.ID, "completed")
	var wire struct {
		Input  string
		Skills []model.Reference
	}
	if err := json.Unmarshal([]byte(strings.TrimPrefix(retry.Items[0].Text, "wire:")), &wire); err != nil {
		t.Fatal(err)
	}
	if len(wire.Skills) != 0 || !strings.Contains(wire.Input, fmt.Sprintf("%q", filepath.Join(skill.Path, model.SkillEntry))) {
		t.Fatalf("Codex retry lost the shared Skill or treated it as native: %+v", wire)
	}
	f.request("GET", endpoint, nil, 200, &results)
	if retry.SessionID != first.SessionID || results[1].Run.ID != retry.ID || len(retry.Attachments) != 1 || retry.Attachments[0].ID != file.ID {
		t.Fatalf("retry did not update just the original Topic: %+v", retry)
	}
}
