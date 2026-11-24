package httpapi_test

import (
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"lever/internal/app"
	"lever/internal/model"
)

func TestACPSkillProfileAppliesToNextTurn(t *testing.T) {
	for _, kind := range []string{"traex", "antigravity", "dsh"} {
		t.Run(kind, func(t *testing.T) {
			f := newFixture(t)
			config := model.Provider{ID: kind, Name: kind}
			if kind == "traex" {
				binary := os.Getenv("LEVER_CODEX_PATH")
				path := filepath.Join(t.TempDir(), "traex"+filepath.Ext(binary))
				if err := os.Link(binary, path); err != nil {
					t.Fatal(err)
				}
				config = model.Provider{PluginID: "lever.acp", ContributionID: "acp", Type: "acp", Name: kind, Enabled: true, Command: path, Args: []string{"acp", "serve"}}
				f.request("POST", "/providers", config, 200, &config)
			}
			newAgent := func(name string) model.Agent {
				agent := model.Agent{Name: name, Profile: model.Profile{Provider: config.ID, Scope: model.Scope{PrimaryRootID: "primary", Roots: []model.Root{{ID: "primary", Path: f.root}}}}}
				f.request("POST", "/agents", agent, 200, &agent)
				return agent
			}
			agent, sibling := newAgent("first"), newAgent("second")
			chat, siblingChat := f.chat(agent), f.chat(sibling)
			var managed model.Skill
			f.request("POST", "/skills", map[string]string{"name": "shared-policy-example"}, 200, &managed)
			attached := filepath.Join(t.TempDir(), "extra-directory")
			if err := os.Mkdir(attached, 0700); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(filepath.Join(attached, model.SkillEntry), []byte("---\nname: private-policy-example\ndescription: Only for the first Agent.\n---\nRead companion.txt."), 0600); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(filepath.Join(attached, "companion.txt"), []byte("isolated package"), 0600); err != nil {
				t.Fatal(err)
			}
			patch := func(body map[string]any) {
				body["updatedAt"] = agent.UpdatedAt
				var saved model.Agent
				f.request("PATCH", "/agents/"+agent.ID+"/skills", body, 200, &saved)
				agent = saved
			}
			send := func(chatID string) (model.Run, map[string]any) {
				var run model.Run
				f.request("POST", "/messages", model.SendInput{ChatID: chatID, Operation: "main", CommandID: app.ID(), Text: "[skill-policy]"}, 200, &run)
				run = f.wait(run.ID, "completed")
				return run, acpReceipt(t, run)
			}
			patch(map[string]any{"attach": attached})
			first, receipt := send(chat.ID)
			catalog := receipt["input"].(string)
			copyDir := filepath.Join(f.a.Store.Dir, "sessions", first.SessionID, "agent-skills", "skills", filepath.Base(attached))
			encoded, _ := json.Marshal(filepath.Join(copyDir, model.SkillEntry))
			if !strings.Contains(catalog, managed.Name) || !strings.Contains(catalog, string(encoded)) || !strings.Contains(catalog, "Only for the first Agent.") {
				t.Fatalf("missing model-visible catalog or working copy: %s", catalog)
			}
			if data, err := os.ReadFile(filepath.Join(copyDir, "companion.txt")); err != nil || string(data) != "isolated package" {
				t.Fatalf("missing package companion: %s, %v", data, err)
			}
			if kind == "antigravity" {
				dirs, _ := receipt["directories"].([]any)
				root := filepath.Dir(filepath.Dir(copyDir))
				if len(dirs) != 1 || dirs[0] != root {
					t.Fatalf("expected only the session's Skills workspace, got %v", dirs)
				}
				data, err := os.ReadFile(filepath.Join(root, ".agents", "skills.json"))
				var manifest struct{ Entries []struct{ Path string } }
				if err != nil || json.Unmarshal(data, &manifest) != nil || len(manifest.Entries) != 1 || manifest.Entries[0].Path != "skills" {
					t.Fatalf("working copies not registered for native discovery: %s, %v", data, err)
				}
			}
			patch(map[string]any{"disabledSkills": []string{managed.Name, "extra-directory"}})
			_, off := send(chat.ID)
			if off["native"] != receipt["native"] || strings.Contains(off["input"].(string), managed.Name) || strings.Contains(off["input"].(string), "private-policy-example") {
				t.Fatalf("disabled entries survived on resume: %v", off)
			}
			if _, err := os.Lstat(copyDir); !os.IsNotExist(err) {
				t.Fatalf("disabled working copy is still reachable: %v", err)
			}
			if (kind == "traex" && !strings.Contains(fmt.Sprint(off["args"]), `name="private-policy-example",enabled=false`)) || (kind == "antigravity" && !strings.Contains(fmt.Sprint(off["skillExcludes"]), managed.Name)) {
				t.Fatalf("native exclusion not applied: %v", off)
			}
			_, other := send(siblingChat.ID)
			if !strings.Contains(other["input"].(string), managed.Name) || strings.Contains(other["input"].(string), "private-policy-example") || other["skillExcludes"] != nil {
				t.Fatalf("another Agent inherited this profile: %v", other)
			}
			patch(map[string]any{"disabledSkills": []string{}, "detach": attached})
			_, on := send(chat.ID)
			if on["native"] != receipt["native"] || !strings.Contains(on["input"].(string), managed.Name) || strings.Contains(on["input"].(string), "private-policy-example") || on["skillExcludes"] != nil || strings.Contains(fmt.Sprint(on["args"]), "skills.config=") {
				t.Fatalf("re-enable/detach not applied: %v", on)
			}
		})
	}
}

func TestComposerInlineSkillReferences(t *testing.T) {
	for _, runtime := range []string{"antigravity", "pi", "acp", "dsh"} {
		t.Run(runtime, func(t *testing.T) {
			f := newFixture(t)
			id := runtime
			if runtime == "acp" {
				id = f.acpProvider("inline-skills").ID
			}
			agent := model.Agent{Name: runtime, Profile: model.Profile{Provider: id, Scope: model.Scope{Roots: []model.Root{{ID: "root", Path: f.root}}, PrimaryRootID: "root"}}}
			f.request("POST", "/agents", agent, 200, &agent)
			root := agent.Profile.Roots[0].Path
			collection := filepath.Join(root, ".agents", "skills")
			switch runtime {
			case "antigravity":
				t.Setenv("GEMINI_HOME", "gemini-home")
				collection = filepath.Join(root, "gemini-home", "config", "skills")
			case "pi":
				collection = filepath.Join(root, ".pi", "skills")
			}
			dir := filepath.Join(collection, "selected-package")
			if err := os.MkdirAll(dir, 0700); err != nil {
				t.Fatal(err)
			}
			entry := filepath.Join(dir, model.SkillEntry)
			if err := os.WriteFile(entry, []byte("---\nname: inline-review\ndescription: Selected project package.\n---\n"), 0600); err != nil {
				t.Fatal(err)
			}
			var managed model.Skill
			f.request("POST", "/skills", map[string]string{"name": "inline-review"}, 200, &managed)
			var refs []model.Reference
			query := "/suggestions?kind=slash&provider=" + agent.Profile.Provider
			f.request("GET", "/agents/"+agent.ID+query, nil, 200, &refs)
			var selected model.Reference
			var paths []string
			for _, ref := range refs {
				if ref.Kind == "skill" && ref.Name == managed.Name && ref.Provider == agent.Profile.Provider {
					paths = append(paths, ref.Path)
					if ref.Path == entry {
						selected = ref
					}
				}
			}
			if len(paths) != 2 || selected.Path == "" || !slices.Contains(paths, filepath.Join(managed.Path, model.SkillEntry)) {
				t.Fatalf("same-name Skill sources: got %v, want %s and the managed manifest", paths, entry)
			}
			chat := f.chat(agent)
			input := model.SendInput{CommandID: app.ID(), ChatID: chat.ID, Operation: "main", Text: "before $inline-review after", References: []model.Reference{selected}}
			var run model.Run
			f.request("POST", "/messages", input, 200, &run)
			run = f.wait(run.ID, "completed")
			var prompt string
			if runtime == "pi" {
				var history []string
				for _, item := range run.Items {
					if item.Kind == "text" && json.Unmarshal([]byte(item.Text), &history) == nil && len(history) > 0 {
						prompt = history[len(history)-1]
					}
				}
			} else {
				prompt = acpReceipt(t, run)["input"].(string)
			}
			if !strings.Contains(prompt, input.Text) || (runtime == "antigravity" && !strings.HasPrefix(prompt, "/inline-review-")) || (runtime != "antigravity" && !strings.Contains(prompt, entry)) {
				t.Fatalf("lost inline text or Skill identity: %s", prompt)
			}
			agent.Profile.Roots[0].Path = t.TempDir()
			f.request("PUT", "/agents/"+agent.ID, agent, 200, &agent)
			sessionQuery := "/chats/" + chat.ID + query + "&sessionId=" + run.SessionID
			f.request("GET", sessionQuery, nil, 200, &refs)
			if !slices.ContainsFunc(refs, func(ref model.Reference) bool { return ref.Path == entry }) {
				t.Fatal("changing the Agent scope removed a Skill from its existing session")
			}
			params := url.Values{"agentId": {agent.ID}, "sessionId": {run.SessionID}, "provider": {id}, "path": {entry}, "name": {selected.Name}}
			var preview model.Skill
			f.request("GET", "/skills/reference?"+params.Encode(), nil, 200, &preview)
			if preview.Path != dir {
				t.Fatalf("opened %q instead of %q", preview.Path, dir)
			}
			agent.Profile.DisabledSkills = []string{filepath.Base(dir)}
			f.request("PUT", "/agents/"+agent.ID, agent, 200, &agent)
			f.request("GET", sessionQuery, nil, 200, &refs)
			if slices.ContainsFunc(refs, func(ref model.Reference) bool { return ref.Path == entry }) {
				t.Fatal("disabled Skill was suggested on resume")
			}
			input.CommandID = app.ID()
			f.request("POST", "/messages", input, 400, nil)
			outside := filepath.Join(t.TempDir(), model.SkillEntry)
			if err := os.WriteFile(outside, []byte("outside the Skill sources"), 0600); err != nil {
				t.Fatal(err)
			}
			input.CommandID, input.References[0].Path = app.ID(), outside
			f.request("POST", "/messages", input, 400, nil)
		})
	}
}

func TestMessageAdaptsDraftSkillToSelectedRuntime(t *testing.T) {
	f := newFixture(t)
	agent := f.agent("claude")
	var skill model.Skill
	f.request("POST", "/skills", map[string]string{"name": "draft-review"}, 200, &skill)
	entry := filepath.Join(skill.Path, model.SkillEntry)
	for _, target := range []string{"codex", "claude", "pi", f.acpProvider("draft-acp").ID, "dsh", "antigravity"} {
		t.Run(target, func(t *testing.T) {
			ref := model.Reference{Kind: "skill", Provider: "claude", Name: skill.Name}
			if target == "claude" {
				ref.Provider, ref.Path = "codex", entry
			}
			input := model.SendInput{
				CommandID: app.ID(), AgentID: agent.ID, Operation: "main", Text: "[wire] $draft-review https://example.test/review",
				Selection: &model.Selection{Provider: target}, References: []model.Reference{ref},
			}
			var run model.Run
			f.request("POST", "/messages", input, 200, &run)
			run = f.wait(run.ID, "completed")
			if len(run.References) != 1 || run.References[0].Provider != ref.Provider || run.References[0].Path != entry || run.Input != input.Text {
				t.Fatalf("lost the selected Skill or rewrote the draft: %+v", run)
			}
			var prompt string
			switch target {
			case "codex", "claude":
				var wire struct{ Input string }
				if err := json.Unmarshal([]byte(strings.TrimPrefix(run.Items[0].Text, "wire:")), &wire); err != nil {
					t.Fatal(err)
				}
				prompt = wire.Input
			case "pi":
				var history []string
				if err := json.Unmarshal([]byte(run.Items[len(run.Items)-1].Text), &history); err != nil {
					t.Fatal(err)
				}
				prompt = history[len(history)-1]
			default:
				prompt = acpReceipt(t, run)["input"].(string)
			}
			if !strings.Contains(prompt, input.Text) || (target == "antigravity" && !strings.HasPrefix(prompt, "/draft-review-")) || (target != "antigravity" && !strings.Contains(prompt, entry)) {
				t.Fatalf("wrong Skill or message at %s: %s", target, prompt)
			}
		})
	}
}

func TestMessageDoesNotSubstituteAnUnverifiedDraftSkill(t *testing.T) {
	f := newFixture(t)
	agent := f.agent("codex")
	const name = "draft-review"
	var skill model.Skill
	f.request("POST", "/skills", map[string]string{"name": name}, 200, &skill)
	source := filepath.Join(agent.Profile.Roots[0].Path, ".pi", "skills", name)
	entry := filepath.Join(source, model.SkillEntry)
	if err := os.MkdirAll(source, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(entry, []byte("# Source package"), 0600); err != nil {
		t.Fatal(err)
	}
	f.request("PUT", "/plugins/lever.pi", map[string]bool{"enabled": false}, 200, nil)
	input := model.SendInput{
		AgentID: agent.ID, Operation: "main", Text: "[wire] $draft-review",
		References: []model.Reference{{Kind: "skill", Provider: "pi", Name: name, Path: entry}},
	}
	send := func(status int, out any) {
		t.Helper()
		input.CommandID = app.ID()
		f.request("POST", "/messages", input, status, out)
	}
	var run model.Run
	send(200, &run)
	run = f.wait(run.ID, "completed")
	if !strings.Contains(run.Items[0].Text, entry) || strings.Contains(run.Items[0].Text, filepath.Join(skill.Path, model.SkillEntry)) {
		t.Fatal("a target namesake replaced the source-only Pi package")
	}
	input.References[0].Path = ""
	send(409, nil)
	input.References[0].Name = "no-such-skill"
	send(400, nil)
	input.References[0].Name, input.References[0].Path = name, entry
	agent.Profile.DisabledSkills = []string{name}
	f.request("PUT", "/agents/"+agent.ID, agent, 200, &agent)
	send(400, nil)
	if err := os.WriteFile(entry, []byte("---\nname: guarded-review\n---\n"), 0600); err != nil {
		t.Fatal(err)
	}
	agent.Profile.DisabledSkills = []string{"guarded-review"}
	f.request("PUT", "/agents/"+agent.ID, agent, 200, &agent)
	send(400, nil)
	agent.Profile.DisabledSkills = nil
	f.request("PUT", "/agents/"+agent.ID, agent, 200, &agent)
	if err := os.Remove(entry); err != nil {
		t.Fatal(err)
	}
	send(400, nil)
	outside := filepath.Join(t.TempDir(), model.SkillEntry)
	if err := os.WriteFile(outside, []byte("# Unlisted"), 0600); err != nil {
		t.Fatal(err)
	}
	input.References[0].Path = outside
	send(400, nil)
}

func TestAntigravitySkillManifestReferences(t *testing.T) {
	f := newFixture(t)
	userHome, external := t.TempDir(), t.TempDir()
	t.Setenv("GEMINI_HOME", userHome)
	agent := f.acpAgent(model.Provider{ID: "antigravity", Name: "Antigravity"})
	root := agent.Profile.Roots[0].Path
	write := func(path, text string) {
		t.Helper()
		if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(text), 0600); err != nil {
			t.Fatal(err)
		}
	}
	for _, name := range []string{"allowed-ok", "allowed-secret", "other"} {
		write(filepath.Join(root, "packs", name, model.SkillEntry), "---\nname: "+name+"\ndescription: Manifest-selected package\n---\n# "+name)
	}
	for _, name := range []string{"user-skill", "outside-skill"} {
		write(filepath.Join(external, name, model.SkillEntry), "# "+name)
	}
	global, _ := json.Marshal(map[string]any{"entries": []any{map[string]any{"path": external, "include_only": []string{"user-skill"}}}})
	outsidePath, _ := json.Marshal(filepath.Join(external, "outside-skill"))
	write(filepath.Join(userHome, "config", "skills.json"), string(global))
	write(filepath.Join(root, ".agents", "skills.json"), `{"inherits":[{"path":"layers/shared.json","include_only":["allowed-.*"],"exclude":["allowed-secret"]}],"entries":[{"path":`+string(outsidePath)+`}]}`)
	write(filepath.Join(root, "layers", "shared.json"), `{"inherits":[{"path":"../.agents/skills.json"}],"entries":[{"path":"../packs","include_only":["allowed-ok","allowed-secret","other"]}]}`)
	chat := f.chat(agent)
	suggestions := func() map[string]model.Reference {
		t.Helper()
		var refs []model.Reference
		f.request("GET", "/chats/"+chat.ID+"/suggestions?kind=skill&provider=antigravity", nil, 200, &refs)
		byName := map[string]model.Reference{}
		for _, ref := range refs {
			byName[ref.Name] = ref
		}
		return byName
	}
	refs := suggestions()
	if refs["allowed-ok"].Path != filepath.Join(root, "packs", "allowed-ok", model.SkillEntry) || refs["user-skill"].Path == "" {
		t.Fatalf("missing selected skills: %+v", refs)
	}
	for name, path := range map[string]string{"allowed-secret": filepath.Join(root, "packs"), "other": filepath.Join(root, "packs"), "outside-skill": external} {
		if refs[name].Path != "" {
			t.Fatalf("filtered skill %s was suggested", name)
		}
		ref := model.Reference{Provider: "antigravity", Kind: "skill", Name: name, Path: filepath.Join(path, name, model.SkillEntry)}
		f.request("POST", "/messages", model.SendInput{ChatID: chat.ID, CommandID: app.ID(), Operation: "main", Text: "use it", References: []model.Reference{ref}}, 400, nil)
	}
	var run model.Run
	f.request("POST", "/messages", model.SendInput{ChatID: chat.ID, CommandID: app.ID(), Operation: "main", Text: "use it", References: []model.Reference{refs["allowed-ok"]}}, 200, &run)
	if prompt := acpReceipt(t, f.wait(run.ID, "completed"))["input"].(string); !strings.HasPrefix(prompt, "/allowed-ok-") {
		t.Fatal("missing selected skill on the wire:", prompt)
	}
	t.Setenv("GEMINI_HOME", "project-profile")
	write(filepath.Join(root, "project-profile", "config", "skills.json"), string(global))
	if suggestions()["user-skill"].Path != "" {
		t.Fatal("a project-owned profile granted access outside the workspace")
	}
}

func TestSkillScopeAndProfileDisableOnResumedRuns(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	codexConfig, claudeConfig := filepath.Join(home, "codex-account"), filepath.Join(home, "claude-account")
	t.Setenv("CODEX_HOME", codexConfig)
	t.Setenv("CLAUDE_CONFIG_DIR", claudeConfig)
	writeSkill := func(root, name string) {
		t.Helper()
		dir := filepath.Join(root, name)
		if err := os.MkdirAll(dir, 0700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dir, model.SkillEntry),
			[]byte("---\nname: "+name+"\ndescription: Test directory Skill\n---\n\n# Fixture\n"), 0600); err != nil {
			t.Fatal(err)
		}
	}
	writeSkill(filepath.Join(home, ".agents", "skills"), "shared-default")
	writeSkill(filepath.Join(codexConfig, "skills"), "codex-user")
	writeSkill(filepath.Join(claudeConfig, "skills"), "claude-user")
	writeSkill(filepath.Join(home, ".agents", "skills"), "block-in-agent")
	for _, runtime := range []string{"codex", "claude"} {
		t.Run(runtime, func(t *testing.T) {
			f := newFixture(t)
			agent := f.agent(runtime)
			second := t.TempDir()
			writeSkill(filepath.Join(f.root, ".agents", "skills"), "primary-project")
			writeSkill(filepath.Join(second, ".codex", "skills"), "secondary-codex")
			writeSkill(filepath.Join(second, ".claude", "skills"), "secondary-claude")
			writeSkill(filepath.Join(second, "skills"), "block-in-agent")
			f.request("POST", "/skills", map[string]string{"name": "lever-library"}, 200, nil)
			agent.Profile.Roots = append(agent.Profile.Roots, model.Root{ID: "second", Path: second})
			f.request("PUT", "/agents/"+agent.ID, agent, 200, &agent)
			var sources []model.SkillSource
			f.request("POST", "/skills/scope", map[string]any{"scope": agent.Profile.Scope, "provider": runtime}, 200, &sources)
			hasSource := func(id, name string) bool {
				return slices.ContainsFunc(sources, func(source model.SkillSource) bool {
					return source.ScopeRootID == id && slices.ContainsFunc(source.Skills, func(skill model.Skill) bool {
						return skill.Name == name
					})
				})
			}
			if !hasSource("", "shared-default") || !hasSource("root", "primary-project") || !hasSource("second", "secondary-codex") {
				t.Fatalf("missing directory Skills in Scope: %#v", sources)
			}
			chat := f.chat(agent)
			suggest := func(sessionID string) []model.Reference {
				t.Helper()
				var refs []model.Reference
				f.request("GET", "/chats/"+chat.ID+"/suggestions?"+url.Values{
					"kind": {"skill"}, "provider": {runtime}, "sessionId": {sessionID},
				}.Encode(), nil, 200, &refs)
				return refs
			}
			lookup := func(refs []model.Reference, name string) (model.Reference, bool) {
				for _, ref := range refs {
					if ref.Name == name {
						return ref, true
					}
				}
				return model.Reference{}, false
			}
			expected := []string{"shared-default", "codex-user", "claude-user", "primary-project", "secondary-codex", "secondary-claude", "lever-library"}
			suggestions := suggest("")
			for _, name := range expected {
				if _, ok := lookup(suggestions, name); !ok {
					t.Fatalf("slash suggestions are missing %s: %#v", name, suggestions)
				}
			}
			stale, ok := lookup(suggestions, "block-in-agent")
			if !ok {
				t.Fatal("Skill should be available by default")
			}
			type wire struct {
				Native          string
				AvailableSkills []string
			}
			run := func() (model.Run, wire) {
				t.Helper()
				result := f.send(chat.ID, "main", "", "[wire] list directory Skills")
				result = f.wait(result.ID, "completed")
				var receipt wire
				if len(result.Items) != 1 || json.Unmarshal([]byte(strings.TrimPrefix(result.Items[0].Text, "wire:")), &receipt) != nil {
					t.Fatalf("missing runtime receipt: %#v", result.Items)
				}
				for _, name := range expected {
					if !slices.Contains(receipt.AvailableSkills, name) {
						t.Fatalf("runtime failed to load %s: %#v", name, receipt.AvailableSkills)
					}
				}
				return result, receipt
			}
			first, before := run()
			if !slices.Contains(before.AvailableSkills, "block-in-agent") {
				t.Fatal("Skill was not loaded by default")
			}

			agent.Profile.DisabledSkills = []string{"block-in-agent"}
			agent.Profile.Roots = agent.Profile.Roots[:1]
			f.request("PUT", "/agents/"+agent.ID, agent, 200, &agent)
			suggestions = suggest(first.SessionID)
			if _, ok := lookup(suggestions, "block-in-agent"); ok {
				t.Fatal("disabled Skill remains in slash suggestions")
			}
			ref, ok := lookup(suggestions, "secondary-codex")
			if !ok {
				t.Fatal("editing Agent Scope changed an existing session's Skill sources")
			}
			params := url.Values{
				"agentId": {agent.ID}, "sessionId": {first.SessionID},
				"provider": {ref.Provider}, "name": {ref.Name}, "path": {ref.Path},
			}
			var skill model.Skill
			f.request("GET", "/skills/reference?"+params.Encode(), nil, 200, &skill)
			params.Set("path", model.SkillEntry)
			params.Set("root", skill.ID)
			params.Set("rootPath", skill.Path)
			var file model.FileContent
			f.request("GET", "/skills/"+skill.ID+"/file?"+params.Encode(), nil, 200, &file)
			if skill.Managed || !strings.Contains(file.Content, "name: secondary-codex") {
				t.Fatalf("unexpected Skill preview from session scope: %#v", skill)
			}
			_, after := run()
			if before.Native == "" || before.Native != after.Native ||
				slices.Contains(after.AvailableSkills, "block-in-agent") {
				t.Fatalf("disabled Skill was not excluded on native resume: %#v, %#v", before, after)
			}
			f.request("POST", "/messages", model.SendInput{
				CommandID: app.ID(), ChatID: chat.ID, Operation: "main", References: []model.Reference{stale},
			}, 400, nil)
		})
	}
}

func TestSkillLibraryAndFileScopes(t *testing.T) {
	f := newFixture(t)
	agent := f.agent("codex")
	external := filepath.Join(t.TempDir(), "review-code")
	if err := os.Mkdir(external, 0700); err != nil {
		t.Fatal(err)
	}
	manifest := "---\nname: review-code\ndescription: >-\n  Review code changes\n  for compatibility.\n---\n\n# Team review\n"
	if err := os.WriteFile(filepath.Join(external, model.SkillEntry), []byte(manifest), 0600); err != nil {
		t.Fatal(err)
	}
	agent.Profile.Skills = []string{external}
	f.request("PUT", "/agents/"+agent.ID, agent, 200, &agent)

	var catalog []model.Skill
	f.request("GET", "/skills", nil, 200, &catalog)
	if len(catalog) != 1 || catalog[0].Managed || !catalog[0].Available ||
		catalog[0].Title != "Team review" || catalog[0].Description != "Review code changes for compatibility." ||
		!slices.Equal(catalog[0].AgentIDs, []string{agent.ID}) {
		t.Fatalf("existing Profile attachment missing or misclassified: %#v", catalog)
	}
	original := catalog[0]
	f.request("POST", "/skills", map[string]string{"directory": external}, 200, nil)
	agent.Profile.Skills = nil
	f.request("PUT", "/agents/"+agent.ID, agent, 200, &agent)

	var managed model.Skill
	f.request("POST", "/skills", map[string]string{"name": "review-code"}, 200, &managed)
	f.request("POST", "/skills", map[string]string{"name": "review-code"}, 409, nil)
	if !managed.Managed || managed.ID == original.ID {
		t.Fatalf("same-name skills should retain distinct directories: %#v %#v", original, managed)
	}
	f.request("GET", "/skills", nil, 200, &catalog)
	if len(catalog) != 2 || catalog[1].ID != original.ID || len(catalog[1].AgentIDs) != 0 {
		t.Fatalf("registered directory should remain after detaching: %#v", catalog)
	}

	file := func(skill model.Skill, path string) string {
		return "/skills/" + skill.ID + "/file?" + url.Values{"path": {path}}.Encode()
	}
	var before, after model.FileContent
	f.request("GET", file(original, model.SkillEntry), nil, 200, &before)
	f.request("PUT", file(original, model.SkillEntry), model.FileWrite{
		Content: "outside", Version: before.Version, RootPath: original.Path,
	}, 403, nil)
	f.request("POST", "/skills/"+original.ID+"/files?path=asset.txt", map[string]any{
		"rootPath": original.Path,
	}, 403, nil)
	f.request("GET", file(managed, model.SkillEntry)+"&root="+original.ID, nil, 400, nil)
	f.request("GET", "/agents/"+agent.ID+"/files?root="+managed.ID, nil, 400, nil)

	f.request("GET", file(managed, model.SkillEntry), nil, 200, &before)
	content := "---\nname: review-code\ndescription: Updated description\n---\n\n# Managed review\n"
	write := model.FileWrite{Content: content, Version: before.Version, RootPath: managed.Path}
	f.request("PUT", file(managed, model.SkillEntry), write, 200, &after)
	write.Content += "Stale edit"
	f.request("PUT", file(managed, model.SkillEntry), write, 409, nil)
	f.request("POST", "/skills/"+managed.ID+"/files/operation?path=SKILL.md", map[string]string{
		"rootPath": managed.Path, "operation": "move", "destination": "renamed.md",
	}, 400, nil)
	f.request("GET", "/skills", nil, 200, &catalog)
	if after.Content != content || catalog[0].Name != "review-code" || catalog[0].Title != "Managed review" || catalog[0].Description != "Updated description" {
		t.Fatalf("managed edit did not update the file and catalog: %#v %#v", after, catalog)
	}
	f.request("GET", file(original, model.SkillEntry), nil, 200, &after)
	if after.Content != manifest {
		t.Fatal("editing the managed skill changed the same-name external skill")
	}

	other := f.agent("codex")
	other.Profile.Skills = []string{original.Path}
	f.request("PUT", "/agents/"+other.ID, other, 200, &other)
	agent.Profile.Skills = []string{managed.Path}
	agent.Profile.DisabledSkills = []string{managed.Name}
	f.request("PUT", "/agents/"+agent.ID, agent, 200, &agent)
	f.request("DELETE", "/skills/"+managed.ID, nil, 200, nil)
	f.request("DELETE", "/skills/"+managed.ID, nil, 404, nil)
	f.request("GET", file(managed, model.SkillEntry), nil, 404, nil)
	if got, err := os.ReadFile(filepath.Join(managed.Path, model.SkillEntry)); err != nil || string(got) != content {
		t.Fatalf("default removal changed the managed original: %q, %v", got, err)
	}
	f.request("GET", "/skills", nil, 200, &catalog)
	if len(catalog) != 1 || catalog[0].ID != original.ID || !slices.Equal(catalog[0].AgentIDs, []string{other.ID}) {
		t.Fatalf("deletion affected the same-name external Skill: %#v", catalog)
	}
	var overview model.Overview
	f.request("GET", "/overview", nil, 200, &overview)
	index := slices.IndexFunc(overview.Agents, func(item model.Agent) bool { return item.ID == agent.ID })
	if index < 0 || len(overview.Agents[index].Profile.Skills) != 0 || overview.Agents[index].UpdatedAt == agent.UpdatedAt ||
		!slices.Equal(overview.Agents[index].Profile.DisabledSkills, []string{managed.Name}) {
		t.Fatal("deletion must detach only the directory and invalidate the changed Profile version")
	}

	var restored model.Skill
	f.request("POST", "/skills", map[string]string{"directory": managed.Path}, 200, &restored)
	if restored.ID != managed.ID || !restored.Managed {
		t.Fatalf("restored Skill lost its managed identity: %#v", restored)
	}
	f.request("DELETE", "/skills/"+managed.ID+"?deleteFiles=true", nil, 200, nil)
	if _, err := os.Stat(managed.Path); !os.IsNotExist(err) {
		t.Fatalf("expected the managed directory to be deleted: %v", err)
	}
	f.request("DELETE", "/skills/"+original.ID, nil, 200, nil)
	f.request("GET", "/skills", nil, 200, &catalog)
	if len(catalog) != 0 {
		t.Fatalf("external registration or Profile reference survived: %#v", catalog)
	}
	if content, err := os.ReadFile(filepath.Join(original.Path, model.SkillEntry)); err != nil || string(content) != manifest {
		t.Fatalf("unlink changed external files: %q, %v", content, err)
	}
	f.request("POST", "/skills", map[string]string{"directory": original.Path}, 200, nil)
	if err := os.Remove(filepath.Join(original.Path, model.SkillEntry)); err != nil {
		t.Fatal(err)
	}
	f.request("DELETE", "/skills/"+original.ID+"?deleteFiles=true", nil, 409, nil)
	f.request("DELETE", "/skills/"+original.ID, nil, 200, nil)
}

func TestSkillLibraryDiscoversUserAndScopeDirectories(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	t.Setenv("CODEX_HOME", filepath.Join(home, ".codex"))
	t.Setenv("CLAUDE_CONFIG_DIR", filepath.Join(home, ".claude"))
	f := newFixture(t)
	account := t.TempDir()
	var providers []model.ProviderInfo
	f.request("GET", "/providers", nil, 200, &providers)
	for _, runtime := range providers {
		if runtime.ID == "codex" {
			config := runtime.Provider
			config.ID, config.Name, config.ConfigDir = "", "Additional Codex account", account
			f.request("POST", "/providers", config, 200, nil)
			break
		}
	}
	second := t.TempDir()
	fixtures := []struct{ root, collection, content string }{
		{"", filepath.Join(home, ".agents", "skills"), "Shared user Skill"},
		{"", filepath.Join(account, "skills"), "Runtime account Skill"},
		{f.root, filepath.Join(f.root, ".codex", "skills"), "Primary Scope Skill"},
		{second, filepath.Join(second, ".claude", "skills"), "Secondary Scope Skill"},
	}
	for i, item := range fixtures {
		dir := filepath.Join(item.collection, "review")
		if err := os.MkdirAll(dir, 0700); err != nil {
			t.Fatal(err)
		}
		manifest := "---\nname: review\n---\n\n# " + item.content + "\n"
		if err := os.WriteFile(filepath.Join(dir, model.SkillEntry), []byte(manifest), 0600); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dir, "notes.md"), []byte(item.content), 0600); err != nil {
			t.Fatal(err)
		}
		canonical, err := filepath.EvalSymlinks(item.collection)
		if err != nil {
			t.Fatal(err)
		}
		fixtures[i].collection = canonical
		if item.root != "" {
			root, err := filepath.EvalSymlinks(item.root)
			if err != nil {
				t.Fatal(err)
			}
			fixtures[i].root = root
		}
	}
	var catalog []model.Skill
	f.request("GET", "/skills", nil, 200, &catalog)
	if len(catalog) != 2 {
		t.Fatalf("expected user Skills before creating an Agent: %#v", catalog)
	}
	agent := f.agent("codex")
	agent.Profile.Roots = append(agent.Profile.Roots, model.Root{ID: "second", Path: second})
	agent.Profile.Skills = []string{filepath.Join(fixtures[2].collection, "review")}
	f.request("PUT", "/agents/"+agent.ID, agent, 200, &agent)
	f.request("GET", "/skills", nil, 200, &catalog)
	if len(catalog) != len(fixtures) {
		t.Fatalf("expected one entry per discovered Skill directory: %#v", catalog)
	}
	var removedID string
	for _, item := range fixtures {
		index := slices.IndexFunc(catalog, func(skill model.Skill) bool {
			return skill.Path == filepath.Join(item.collection, "review")
		})
		if index < 0 {
			t.Fatalf("missing Skill from %q", item.collection)
		}
		skill := catalog[index]
		if skill.Name != "review" || !skill.Available || skill.Managed ||
			skill.Origin == nil || skill.Origin.Directory != item.collection || skill.Origin.ScopePath != item.root {
			t.Fatalf("unexpected Skill source: %#v", skill)
		}
		if item.root == agent.Profile.Roots[0].Path && !slices.Equal(skill.AgentIDs, []string{agent.ID}) {
			t.Fatalf("missing explicit Profile reference: %#v", skill)
		}
		if item.root == agent.Profile.Roots[1].Path {
			removedID = skill.ID
		}
		base := "/skills/" + skill.ID
		f.request("GET", base+"/files", nil, 200, nil)
		var preview model.FileContent
		f.request("GET", base+"/file?path=notes.md", nil, 200, &preview)
		if preview.Content != item.content {
			t.Fatalf("opened a different source for %s: %q", skill.ID, preview.Content)
		}
		f.request("PUT", base+"/file?path=notes.md", model.FileWrite{Content: "change", Version: preview.Version, RootPath: skill.Path}, 403, nil)
	}

	agent.Profile.Roots = agent.Profile.Roots[:1]
	f.request("PUT", "/agents/"+agent.ID, agent, 200, &agent)
	f.request("GET", "/skills/"+removedID+"/files", nil, 404, nil)
	f.request("GET", "/skills", nil, 200, &catalog)
	if len(catalog) != len(fixtures)-1 {
		t.Fatalf("removed Scope still contributes Skills: %#v", catalog)
	}
	discovered := catalog[0]
	f.request("DELETE", "/skills/"+discovered.ID, nil, 200, nil)
	f.request("GET", "/skills/"+discovered.ID+"/files", nil, 404, nil)
	f.request("GET", "/skills", nil, 200, &catalog)
	if len(catalog) != len(fixtures)-2 || slices.ContainsFunc(catalog, func(s model.Skill) bool { return s.ID == discovered.ID }) {
		t.Fatalf("a removed discovered directory reappeared or affected a sibling: %#v", catalog)
	}
	var sources []model.SkillSource
	f.request("POST", "/skills/scope", map[string]any{"scope": agent.Profile.Scope, "provider": agent.Profile.Provider}, 200, &sources)
	for _, src := range sources {
		if slices.ContainsFunc(src.Skills, func(s model.Skill) bool { return s.ID == discovered.ID }) {
			t.Fatal("a removed Skill reappeared through scope discovery")
		}
	}
	f.request("POST", "/skills", map[string]string{"directory": discovered.Path}, 200, nil)
	f.request("GET", "/skills/"+discovered.ID+"/files", nil, 200, nil)
	f.request("DELETE", "/skills/"+discovered.ID+"?deleteFiles=true", nil, 200, nil)
	if _, err := os.Stat(discovered.Path); !os.IsNotExist(err) {
		t.Fatalf("expected discovered directory to be deleted: %v", err)
	}
}

func TestDeleteSkillKeepsWorkspaceRoot(t *testing.T) {
	f := newFixture(t)
	f.agent("codex")
	manifest := filepath.Join(f.root, model.SkillEntry)
	if err := os.WriteFile(manifest, []byte("# Project Skill"), 0600); err != nil {
		t.Fatal(err)
	}
	var skill model.Skill
	f.request("POST", "/skills", map[string]string{"directory": f.root}, 200, &skill)
	f.request("DELETE", "/skills/"+skill.ID+"?deleteFiles=true", nil, 409, nil)
	f.request("GET", "/skills/"+skill.ID+"/files", nil, 200, nil)
	f.request("DELETE", "/skills/"+skill.ID, nil, 200, nil)
	if _, err := os.Stat(manifest); err != nil {
		t.Fatal(err)
	}
}

func TestRemovedSkillStaysOutOfLibraryAfterRestart(t *testing.T) {
	data := t.TempDir()
	first, err := app.Open(data)
	if err != nil {
		t.Fatal(err)
	}
	skill, err := first.CreateSkill("retained-skill")
	if err == nil {
		_, err = first.DeleteSkill(t.Context(), skill.ID, false)
	}
	if closeErr := first.Close(); closeErr != nil || err != nil {
		t.Fatalf("remove and close: %v, %v", err, closeErr)
	}
	reopened, err := app.Open(data)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	catalog, err := reopened.Skills(t.Context())
	if err != nil || slices.ContainsFunc(catalog, func(s model.Skill) bool { return s.ID == skill.ID }) {
		t.Fatalf("removed directory returned after restart: %v, %v", catalog, err)
	}
	restored, err := reopened.AddSkillDirectory(t.Context(), skill.Path)
	if err != nil || !restored.Managed || restored.ID != skill.ID {
		t.Fatalf("could not restore the retained original: %#v, %v", restored, err)
	}
}

func TestDeleteSkillReportsFilesLeftOnDisk(t *testing.T) {
	f := newFixture(t)
	path := filepath.Join(t.TempDir(), "read-only-original")
	if err := os.Mkdir(path, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(path, model.SkillEntry), []byte("# Read only"), 0600); err != nil {
		t.Fatal(err)
	}
	var skill model.Skill
	f.request("POST", "/skills", map[string]string{"directory": path}, 200, &skill)
	if err := os.Chmod(path, 0500); err != nil {
		t.Fatal(err)
	}
	var result model.SkillRemovalResult
	t.Cleanup(func() {
		_ = os.Chmod(path, 0700)
		if result.RemainingDirectory != "" {
			_ = os.Chmod(result.RemainingDirectory, 0700)
		}
	})
	if err := os.WriteFile(filepath.Join(path, "probe"), nil, 0600); err == nil {
		t.Skip("test account can write to read-only directories")
	}
	f.request("POST", "/skills/"+skill.ID+"/remove", map[string]bool{"deleteFiles": true}, 200, &result)
	if !result.Deleted || filepath.Dir(result.RemainingDirectory) != filepath.Dir(skill.Path) {
		t.Fatalf("missing retained files location: %#v", result)
	}
	if _, err := os.Stat(filepath.Join(result.RemainingDirectory, model.SkillEntry)); err != nil {
		t.Fatal(err)
	}
	f.request("GET", "/skills/"+skill.ID+"/files", nil, 404, nil)
}

func TestSkillPreferenceUpdatePreservesProfile(t *testing.T) {
	f := newFixture(t)
	agent := f.agent("codex")
	path := "/agents/" + agent.ID + "/skills"
	var saved model.Agent
	f.request("PATCH", path, map[string]any{"updatedAt": agent.UpdatedAt}, 400, nil)
	// Toggle a preference even when an unrelated Scope directory is gone.
	if err := os.Remove(f.root); err != nil {
		t.Fatal(err)
	}
	f.request("PATCH", path, map[string]any{
		"updatedAt": agent.UpdatedAt, "disabledSkills": []string{"  review  ", "Review"},
	}, 200, &saved)
	if saved.UpdatedAt == agent.UpdatedAt || !slices.Equal(saved.Profile.DisabledSkills, []string{"review"}) ||
		saved.Profile.Instructions != agent.Profile.Instructions || !slices.Equal(saved.Profile.Roots, agent.Profile.Roots) {
		t.Fatalf("unexpected Profile update: %#v", saved)
	}
	f.request("PATCH", path, map[string]any{
		"updatedAt": agent.UpdatedAt, "disabledSkills": []string{"stale"},
	}, 409, nil)
	f.request("PATCH", path, map[string]any{
		"updatedAt": saved.UpdatedAt, "disabledSkills": []string{},
	}, 200, &saved)
	// The JSON response omits the field when the list is empty.
	var state model.Overview
	f.request("GET", "/overview", nil, 200, &state)
	if len(state.Agents) != 1 || len(state.Agents[0].Profile.DisabledSkills) != 0 {
		t.Fatalf("re-enabling Skill left disabled names: %#v", state.Agents)
	}
}
