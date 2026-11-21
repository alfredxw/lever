package httpapi_test

import (
	"encoding/json"
	"net/url"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"lever/internal/app"
	"lever/internal/model"
)

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
		catalog[0].Description != "Review code changes for compatibility." ||
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
	if after.Content != content || catalog[0].Description != "Updated description" {
		t.Fatalf("managed edit did not update the file and catalog: %#v %#v", after, catalog)
	}
	f.request("GET", file(original, model.SkillEntry), nil, 200, &after)
	if after.Content != manifest {
		t.Fatal("editing the managed skill changed the same-name external skill")
	}
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
