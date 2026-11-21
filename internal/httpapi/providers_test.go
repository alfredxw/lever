package httpapi_test

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"net/url"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"testing/fstest"

	"lever/internal/app"
	"lever/internal/httpapi"
	"lever/internal/model"
)

func (f *fixture) acpProvider(identity string, flags ...string) model.Provider {
	f.t.Helper()
	config := model.Provider{PluginID: "lever.acp", ContributionID: "acp", Type: "acp", Name: identity, Enabled: true, Command: os.Getenv("LEVER_CODEX_PATH"), Args: append([]string{"--acp", identity}, flags...)}
	f.request("POST", "/providers", config, 200, &config)
	return config
}

func (f *fixture) acpAgent(config model.Provider) model.Agent {
	f.t.Helper()
	agent := model.Agent{Name: config.Name, Profile: model.Profile{Provider: config.ID, Model: "acp-model", Permission: "review-mode", Instructions: "Keep the native context marker.", Scope: model.Scope{Roots: []model.Root{{ID: "root", Path: f.root}}, PrimaryRootID: "root"}, Skills: []string{}, Delegations: []model.DelegationRule{}}}
	f.request("POST", "/agents", agent, 200, &agent)
	return agent
}

func acpReceipt(t *testing.T, run model.Run) map[string]any {
	t.Helper()
	text := ""
	for _, item := range run.Items {
		if item.Kind == "text" {
			text += item.Text
		}
	}
	var receipt map[string]any
	if err := json.Unmarshal([]byte(text), &receipt); err != nil {
		t.Fatalf("invalid ACP receipt: %s: %v", text, err)
	}
	return receipt
}

func TestProviderInstancesRunAndResumeACPWithoutReplayingHistory(t *testing.T) {
	f := newFixture(t)
	marker := filepath.Join(f.root, "must-not-be-created")
	alpha := f.acpProvider("alpha", "$(touch "+marker+")")
	beta := f.acpProvider("beta")
	var catalog model.Catalog
	f.request("GET", "/providers/"+alpha.ID+"/models?cwd="+url.QueryEscape(f.root), nil, 200, &catalog)
	if catalog.Provider != alpha.ID || catalog.Capabilities.Steering || !catalog.Capabilities.Resume || !catalog.Capabilities.Images || !catalog.Capabilities.Files || len(catalog.Models) != 2 || catalog.DefaultPermission != "review-mode" {
		t.Fatalf("invalid capabilities/catalog: %+v", catalog)
	}
	changed := alpha
	changed.Command = "another-executable"
	f.request("POST", "/providers", changed, 409, nil)
	agent := f.acpAgent(alpha)
	chat := f.chat(agent)
	file := f.upload(chat.ID, "notes.txt", []byte("attached evidence"))
	input := model.SendInput{CommandID: app.ID(), ChatID: chat.ID, Operation: "main", Text: "remember alpha-marker", Selection: &model.Selection{Provider: alpha.ID, Model: "acp-other", Permission: "build-mode", Effort: "deep"}, AttachmentIDs: []string{file.ID}}
	var first model.Run
	f.request("POST", "/messages", input, 200, &first)
	first = f.wait(first.ID, "completed")
	receipt := acpReceipt(t, first)
	native := receipt["native"]
	if receipt["model"] != "acp-other" || receipt["mode"] != "build-mode" || receipt["effort"] != "deep" || receipt["resources"] != float64(1) {
		t.Fatal("native selection/attachment was not delivered", receipt)
	}
	if _, err := os.Stat(marker); !os.IsNotExist(err) {
		t.Fatal("runtime arguments were interpreted by a shell", err)
	}
	second := f.wait(f.send(chat.ID, "main", "", "continue alpha").ID, "completed")
	receipt = acpReceipt(t, second)
	if receipt["native"] != native || len(receipt["history"].([]any)) != 2 || strings.Contains(second.Items[len(second.Items)-1].Text, "REPLAY MUST NOT APPEAR") {
		t.Fatal("native resume or replay suppression failed", second)
	}
	input.CommandID, input.Text, input.AttachmentIDs = app.ID(), "switch to beta", nil
	input.Selection = &model.Selection{Provider: beta.ID, Model: "acp-model", Permission: "review-mode"}
	var switched model.Run
	f.request("POST", "/messages", input, 200, &switched)
	switched = f.wait(switched.ID, "completed")
	receipt = acpReceipt(t, switched)
	if !switched.Handoff || !strings.HasPrefix(receipt["native"].(string), "beta-") || receipt["resources"] != float64(1) {
		t.Fatal("same-type instance switch crossed native identities", switched, receipt)
	}
	f.request("DELETE", "/providers/"+alpha.ID, nil, 409, nil)
	alpha.Name = "Renamed alpha"
	f.request("POST", "/providers", alpha, 200, &alpha)
	alpha.Enabled = false
	f.request("POST", "/providers", alpha, 200, &alpha)
	input.CommandID = app.ID()
	input.Selection.Provider = alpha.ID
	f.request("POST", "/messages", input, 400, nil)
	alpha.Enabled = true
	f.request("POST", "/providers", alpha, 200, &alpha)
	// Native drivers also accept multiple configured instances without changing their protocol.
	clone := model.Provider{PluginID: "lever.codex", ContributionID: "codex", Type: "codex", Name: "Another Codex", Enabled: true, Args: []string{}}
	f.request("POST", "/providers", clone, 200, &clone)
	f.request("GET", "/providers/"+clone.ID+"/models", nil, 200, &catalog)
	if catalog.Provider != clone.ID || !catalog.Capabilities.Steering {
		t.Fatal(catalog)
	}
	nativeChat := f.chat(f.agent(clone.ID))
	f.wait(f.send(nativeChat.ID, "main", "", "native clone").ID, "completed")
	unused := f.acpProvider("unused")
	f.request("DELETE", "/providers/"+unused.ID, nil, 200, nil)
}

func TestACPApprovalOptionsStopAndUnknownDelivery(t *testing.T) {
	f := newFixture(t)
	config := f.acpProvider("control")
	chat := f.chat(f.acpAgent(config))
	run := f.send(chat.ID, "main", "", "[approval]")
	f.wait(run.ID, "waiting_user")
	var overview model.Overview
	f.request("GET", "/overview", nil, 200, &overview)
	request := overview.Requests[0]
	if len(request.Options) != 2 || request.Options[0].ID != "native:allow:once" {
		t.Fatal("native options lost", request)
	}
	f.request("POST", "/requests/"+request.ID+"/answer", model.Answer{Allow: true, OptionID: "display-label"}, 400, nil)
	f.request("POST", "/requests/"+request.ID+"/answer", model.Answer{Allow: false, OptionID: "native:reject:once"}, 200, nil)
	receipt := acpReceipt(t, f.wait(run.ID, "completed"))
	if receipt["permission"].(map[string]any)["optionId"] != "native:reject:once" {
		t.Fatal("native rejection not returned", receipt)
	}
	pendingApproval := f.send(chat.ID, "main", "", "[approval] stop pending approval")
	f.wait(pendingApproval.ID, "waiting_user")
	f.request("POST", "/runs/"+pendingApproval.ID+"/stop", map[string]bool{}, 200, nil)
	f.wait(pendingApproval.ID, "interrupted")
	// Stop immediately after admission, including before the runtime accepts Prompt.
	hang := f.send(chat.ID, "main", "", "[hang] stop at startup")
	f.request("POST", "/runs/"+hang.ID+"/stop", map[string]bool{}, 200, nil)
	f.wait(hang.ID, "interrupted")
	hang = f.send(chat.ID, "main", "", "[hang] active task")
	f.wait(hang.ID, "running")
	var queued model.Run
	f.request("POST", "/messages", model.SendInput{CommandID: app.ID(), ChatID: chat.ID, Operation: "main", Text: "must remain queued", Delivery: "queue"}, 200, &queued)
	f.request("POST", "/messages", model.SendInput{CommandID: app.ID(), ChatID: chat.ID, Operation: "main", Text: "unsupported steer", Delivery: "steer"}, 400, nil)
	config.Enabled = false
	f.request("POST", "/providers", config, 409, nil)
	f.request("POST", "/runs/"+hang.ID+"/stop", map[string]bool{}, 200, nil)
	f.wait(hang.ID, "interrupted")
	f.wait(queued.ID, "queued")
	config.Enabled = true
	other := f.chat(f.acpAgent(config))
	disconnected := f.send(other.ID, "main", "", "[disconnect]")
	f.wait(disconnected.ID, "unknown")
	f.request("POST", "/messages", model.SendInput{CommandID: app.ID(), ChatID: other.ID, Operation: "main", Text: "must not replay"}, 409, nil)
	approvalChat := f.chat(f.acpAgent(config))
	dropped := f.send(approvalChat.ID, "main", "", "[approval] [drop-approval]")
	f.wait(dropped.ID, "unknown")
	restartProviderFixture(t, f)
	f.wait(dropped.ID, "unknown")
	f.wait(disconnected.ID, "unknown")
	f.wait(queued.ID, "queued")
	if f.a.RunningCount() != 0 {
		t.Fatal("restart replayed ACP work")
	}
}

func TestACPCapabilitiesRejectUnsupportedWorkBeforePrompt(t *testing.T) {
	f := newFixture(t)
	limited := f.acpProvider("limited", "--limited")
	agent := f.acpAgent(limited)
	agent.Profile.Roots = append(agent.Profile.Roots, model.Root{ID: "other", Path: t.TempDir()})
	f.request("PUT", "/agents/"+agent.ID, agent, 200, &agent)
	chat := f.chat(agent)
	run := f.wait(f.send(chat.ID, "main", "", "must not execute").ID, "failed")
	if !strings.Contains(run.Error, "multiple working directories") || len(run.Items) != 0 {
		t.Fatal(run)
	}
	agent.Profile.Roots = agent.Profile.Roots[:1]
	f.request("PUT", "/agents/"+agent.ID, agent, 200, &agent)
	chat = f.chat(agent)
	original := f.wait(f.send(chat.ID, "topic", "", "A quote for an ACP runtime without HTTP MCP").ID, "completed")
	var quoted model.Run
	f.request("POST", "/messages", model.SendInput{CommandID: app.ID(), ChatID: chat.ID, Operation: "main", Text: "Use this context", Quote: &model.MessageQuote{RunID: original.ID, Role: "user"}}, 200, &quoted)
	receipt := acpReceipt(t, f.wait(quoted.ID, "completed"))
	servers, _ := receipt["servers"].([]any)
	if len(servers) != 1 || servers[0].(map[string]any)["command"] == nil || !strings.Contains(receipt["input"].(string), original.Input) {
		t.Fatal("text quote or stdio MCP setup was lost for a runtime without HTTP MCP")
	}
	file := f.upload(chat.ID, "notes.txt", []byte("unsupported attachment"))
	var attached model.Run
	f.request("POST", "/messages", model.SendInput{CommandID: app.ID(), ChatID: chat.ID, Operation: "main", Text: "must not execute", AttachmentIDs: []string{file.ID}}, 200, &attached)
	attached = f.wait(attached.ID, "failed")
	if !strings.Contains(attached.Error, "embedded files") || len(attached.Items) != 0 {
		t.Fatal(attached)
	}
	noResume := f.acpProvider("no-resume", "--no-resume")
	chat = f.chat(f.acpAgent(noResume))
	run = f.wait(f.send(chat.ID, "main", "", "must not execute").ID, "failed")
	if !strings.Contains(run.Error, "cannot restore native sessions") || len(run.Items) != 0 {
		t.Fatal(run)
	}
	legacy := f.acpProvider("legacy", "--legacy")
	chat = f.chat(f.acpAgent(legacy))
	var result model.Run
	f.request("POST", "/messages", model.SendInput{CommandID: app.ID(), ChatID: chat.ID, Operation: "main", Text: "legacy native model", Selection: &model.Selection{Provider: legacy.ID, Model: "acp-other", Permission: "build-mode"}}, 200, &result)
	receipt = acpReceipt(t, f.wait(result.ID, "completed"))
	if receipt["model"] != "acp-other" || receipt["mode"] != "build-mode" {
		t.Fatal(receipt)
	}
}

func TestACPSharesAdditionalDirectoriesAsContextOnNewAndResumedTurns(t *testing.T) {
	f := newFixture(t)
	config := f.acpProvider("context", "--single-root")
	var catalog model.Catalog
	f.request("GET", "/providers/"+config.ID+"/models", nil, 200, &catalog)
	if catalog.Capabilities.MultiRoot || !catalog.Capabilities.DirectoryContext {
		t.Fatal("wrong directory capabilities", catalog.Capabilities)
	}
	// An existing installation can return its saved catalog before rediscovery.
	if _, err := f.a.Store.DB.Exec("UPDATE provider_catalogs SET data=json_remove(data,'$.capabilities.directoryContext') WHERE provider_id=?", config.ID); err != nil {
		t.Fatal(err)
	}
	restartProviderFixture(t, f)
	var cached model.Catalog
	f.request("GET", "/providers/"+config.ID+"/models", nil, 200, &cached)
	if !cached.Provisional || cached.Capabilities.MultiRoot || !cached.Capabilities.DirectoryContext {
		t.Fatal("saved catalog lost directory fallback", cached.Capabilities)
	}
	agent := f.acpAgent(config)
	extra := filepath.Join(t.TempDir(), "other repo")
	if err := os.Mkdir(extra, 0700); err != nil {
		t.Fatal(err)
	}
	extra, err := filepath.EvalSymlinks(extra)
	if err != nil {
		t.Fatal(err)
	}
	agent.Profile.Roots = append([]model.Root{{ID: "extra", Path: extra}}, agent.Profile.Roots...)
	f.request("PUT", "/agents/"+agent.ID, agent, 200, &agent)
	chat := f.chat(agent)
	var native any
	for _, text := range []string{"check both repos", "continue", "/compact"} {
		run := f.wait(f.send(chat.ID, "main", "", text).ID, "completed")
		receipt := acpReceipt(t, run)
		if receipt["cwd"] != agent.Profile.Roots[1].Path || receipt["directories"] != nil ||
			receipt["mode"] != "review-mode" || native != nil && receipt["native"] != native {
			t.Fatal("unexpected native session or workspace", receipt)
		}
		native = receipt["native"]
		blocks := receipt["prompt"].([]any)
		if text == "/compact" {
			if len(blocks) != 1 || receipt["input"] != text {
				t.Fatal("native command was modified", blocks)
			}
			continue
		}
		if len(blocks) != 2 {
			t.Fatal("missing directory context", blocks)
		}
		resource := blocks[1].(map[string]any)["resource"].(map[string]any)
		var scope struct{ AdditionalDirectories []string }
		if resource["uri"] != "lever://workspace/additional-directories" ||
			json.Unmarshal([]byte(resource["text"].(string)), &scope) != nil ||
			!slices.Equal(scope.AdditionalDirectories, []string{extra}) {
			t.Fatal("wrong directory context", resource)
		}
	}
}

func restartProviderFixture(t *testing.T, f *fixture) {
	t.Helper()
	dir := f.a.Store.Dir
	if err := f.a.Close(); err != nil {
		t.Fatal(err)
	}
	_ = f.s.HTTP.Close()
	a, err := app.Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	s, err := httpapi.New(a, "127.0.0.1:0", "", fstest.MapFS{"index.html": {Data: []byte("Lever")}})
	if err != nil {
		t.Fatal(err)
	}
	go s.Serve()
	f.a, f.s = a, s
	t.Cleanup(func() { a.Close(); s.HTTP.Close() })
}

func TestProviderModelVisibilityPreservesCatalogAndSession(t *testing.T) {
	f := newFixture(t)
	config := f.acpProvider("visibility")
	chat := f.chat(f.acpAgent(config))
	first := f.wait(f.send(chat.ID, "main", "", "Start with the configured model").ID, "completed")
	modelID := first.Selection.Model
	if modelID != "acp-model" {
		t.Fatal("unexpected starting model", modelID)
	}
	models := "/providers/" + config.ID + "/models"
	visibility := models + "/visibility"
	f.request("PATCH", visibility, map[string]any{"models": []string{modelID}, "visible": false}, 200, nil)
	// An older runtime editor only sends the original settings fields.
	config.Name = "Renamed provider"
	f.request("POST", "/providers", config, 200, &config)
	if !slices.Equal(config.HiddenModels, []string{modelID}) {
		t.Fatal("editing the provider lost its model visibility preferences", config)
	}
	restartProviderFixture(t, f)
	var providers []model.ProviderInfo
	f.request("GET", "/providers", nil, 200, &providers)
	if !slices.ContainsFunc(providers, func(item model.ProviderInfo) bool {
		return item.ID == config.ID && slices.Equal(item.HiddenModels, []string{modelID})
	}) {
		t.Fatal("model visibility did not survive restart", providers)
	}
	var catalog model.Catalog
	f.request("GET", models+"?cwd="+url.QueryEscape(f.root), nil, 200, &catalog)
	if !slices.ContainsFunc(catalog.Models, func(item model.ModelInfo) bool { return item.ID == modelID }) {
		t.Fatal("hiding a model removed it from the execution catalog", catalog)
	}
	next := f.wait(f.send(chat.ID, "main", "", "Keep this model").ID, "completed")
	if next.SessionID != first.SessionID || next.Selection.Model != modelID || next.Handoff {
		t.Fatal("hiding a model changed the existing conversation", next)
	}
	var restored model.Provider
	f.request("PATCH", visibility, map[string]any{"models": []string{modelID}, "visible": true}, 200, &restored)
	if len(restored.HiddenModels) != 0 {
		t.Fatal("model was not restored to the picker", restored)
	}
}

func TestProviderMigrationPreservesExistingProfilesAndNativeSessions(t *testing.T) {
	f := newFixture(t)
	agent := f.agent("codex")
	chat := f.chat(agent)
	run := f.wait(f.send(chat.ID, "main", "", "old data marker").ID, "completed")
	var before model.ChatView
	f.request("GET", "/chats/"+chat.ID, nil, 200, &before)
	if _, err := f.a.Store.DB.ExecContext(context.Background(), "DROP TABLE providers; PRAGMA user_version=2"); err != nil {
		t.Fatal(err)
	}
	restartProviderFixture(t, f)
	var providers []model.ProviderInfo
	f.request("GET", "/providers", nil, 200, &providers)
	if len(providers) != 5 || providers[0].ID != "codex" || providers[1].ID != "claude" || providers[2].ID != "antigravity" || providers[3].ID != "pi" || providers[4].ID != "dsh" {
		t.Fatal(providers)
	}
	next := f.wait(f.send(chat.ID, "main", "", "after additive migration").ID, "completed")
	var after model.ChatView
	f.request("GET", "/chats/"+chat.ID, nil, 200, &after)
	if next.SessionID != run.SessionID || after.Sessions[0].NativeID != before.Sessions[0].NativeID || len(after.Runs) != 2 {
		t.Fatal("migration changed existing bindings", after)
	}
}

func (f *fixture) piAgent() model.Agent {
	f.t.Helper()
	agent := model.Agent{Name: "Pi", Profile: model.Profile{Provider: "pi", Scope: model.Scope{
		Roots: []model.Root{{ID: "root", Path: f.root}}, PrimaryRootID: "root",
	}}}
	f.request("POST", "/agents", agent, 200, &agent)
	return agent
}

func TestPiModelsAndNativeResume(t *testing.T) {
	f := newFixture(t)
	var catalog model.Catalog
	f.request("GET", "/providers/pi/models?cwd="+url.QueryEscape(f.root), nil, 200, &catalog)
	if len(catalog.Models) != 2 || !catalog.Models[0].Default || !catalog.Capabilities.Resume {
		t.Fatalf("unexpected Pi catalog: %+v", catalog)
	}
	reasoner := catalog.Models[1]
	if !catalog.Capabilities.Images || catalog.Models[0].Images == nil || *catalog.Models[0].Images ||
		reasoner.Images == nil || !*reasoner.Images {
		t.Fatalf("unexpected Pi image support: %+v", catalog.Models)
	}
	if reasoner.ID != "gateway/org/reasoner" || !slices.Contains(reasoner.Efforts, "xhigh") ||
		slices.Contains(reasoner.Efforts, "minimal") || slices.Contains(reasoner.Efforts, "max") {
		t.Fatalf("unexpected Pi model: %+v", reasoner)
	}

	chat := f.chat(f.piAgent())
	input := model.SendInput{
		CommandID: app.ID(), ChatID: chat.ID, Operation: "main", Text: "first Pi message",
		Selection: &model.Selection{Provider: "pi", Model: reasoner.ID, Effort: "xhigh"},
	}
	var first model.Run
	f.request("POST", "/messages", input, 200, &first)
	first = f.wait(first.ID, "completed")
	if len(first.Items) != 3 || first.Items[0].Kind != "tool" || first.Items[0].Text != "Tool result" ||
		first.Items[1].Kind != "reasoning" || first.Items[2].Text != `["first Pi message"]` {
		t.Fatal(first.Items)
	}
	second := f.wait(f.send(chat.ID, "main", "", "second Pi message").ID, "completed")
	if second.SessionID != first.SessionID || second.Items[2].Text != `["first Pi message","second Pi message"]` {
		t.Fatal(second)
	}

	f.wait(f.send(chat.ID, "main", "", "[pi-handled]").ID, "completed")
	rejected := f.wait(f.send(chat.ID, "main", "", "[pi-reject]").ID, "failed")
	if !strings.Contains(rejected.Error, "Pi fixture rejected prompt") {
		t.Fatal(rejected.Error)
	}
	afterReject := f.wait(f.send(chat.ID, "main", "", "after rejection").ID, "completed")
	if afterReject.Items[2].Text != `["first Pi message","second Pi message","after rejection"]` {
		t.Fatal(afterReject)
	}
	f.wait(f.send(chat.ID, "main", "", "[pi-disconnect]").ID, "unknown")
}

const providerPNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII="

func TestDeepSeekHarnessUsesBuiltInACPProfile(t *testing.T) {
	f := newFixture(t)
	var catalog model.Catalog
	f.request("GET", "/providers/dsh/models?cwd="+url.QueryEscape(f.root), nil, 200, &catalog)
	if !catalog.Capabilities.Resume || !catalog.Capabilities.Images || len(catalog.Models) != 3 {
		t.Fatal(catalog)
	}
	agent := model.Agent{Name: "DSH", Profile: model.Profile{Provider: "dsh", Scope: model.Scope{
		Roots: []model.Root{{ID: "root", Path: f.root}}, PrimaryRootID: "root",
	}}}
	f.request("POST", "/agents", agent, 200, &agent)
	chat := f.chat(agent)
	first := acpReceipt(t, f.wait(f.send(chat.ID, "main", "", "dsh first").ID, "completed"))
	png, _ := base64.StdEncoding.DecodeString(providerPNG)
	file := f.upload(chat.ID, "second.png", png)
	var imageRun model.Run
	f.request("POST", "/messages", model.SendInput{
		CommandID: app.ID(), ChatID: chat.ID, Operation: "main", Text: "dsh second", AttachmentIDs: []string{file.ID},
		Selection: &model.Selection{Provider: "dsh", Model: `["deepseek-official","deepseek-v4-flash"]`},
	}, 200, &imageRun)
	second := acpReceipt(t, f.wait(imageRun.ID, "completed"))
	args := second["args"].([]any)
	if len(args) != 4 || !slices.Equal(args[:3], []any{"--profile", "acp", "--patch"}) ||
		second["native"] != first["native"] || second["model"] != `["deepseek-official","deepseek-flash"]` ||
		second["images"] != float64(1) || !slices.Equal(second["history"].([]any), []any{"dsh first", second["input"]}) {
		t.Fatal(first, second)
	}

	codexChat := f.chat(f.agent("codex"))
	f.wait(f.send(codexChat.ID, "main", "", "portable history").ID, "completed")
	var switched model.Run
	f.request("POST", "/messages", model.SendInput{
		CommandID: app.ID(), ChatID: codexChat.ID, Operation: "main", Text: "switch to DSH",
		Selection: &model.Selection{Provider: "dsh"},
	}, 200, &switched)
	switched = f.wait(switched.ID, "completed")
	receipt := acpReceipt(t, switched)
	if !switched.Handoff || !strings.Contains(receipt["input"].(string), "portable history") || receipt["resources"] != float64(0) {
		t.Fatal(switched, receipt)
	}
}

func TestDSHKeepsItsOriginalRouteWhenImagesAreUnavailable(t *testing.T) {
	t.Setenv("LEVER_FIXTURE_DSH_TEXT_ONLY", "1")
	f := newFixture(t)
	var catalog model.Catalog
	f.request("GET", "/providers/dsh/models?cwd="+url.QueryEscape(f.root), nil, 200, &catalog)
	if catalog.Capabilities.Images || !slices.ContainsFunc(catalog.Models, func(m model.ModelInfo) bool {
		return m.Default && m.ID == `["deepseek-official","deepseek-v4-flash"]`
	}) {
		t.Fatal(catalog)
	}
}

func TestPiImageInputFollowsTheSelectedModel(t *testing.T) {
	f := newFixture(t)
	agent := model.Agent{Name: "Pi", Profile: model.Profile{Provider: "pi", Scope: model.Scope{
		Roots: []model.Root{{ID: "root", Path: f.root}}, PrimaryRootID: "root",
	}}}
	f.request("POST", "/agents", agent, 200, &agent)
	chat := f.chat(agent)
	data, _ := base64.StdEncoding.DecodeString(providerPNG)
	file := f.upload(chat.ID, "picture.png", data)
	input := model.SendInput{CommandID: app.ID(), ChatID: chat.ID, Operation: "main", AttachmentIDs: []string{file.ID},
		Selection: &model.Selection{Provider: "pi", Model: "local/plain"}}
	var run model.Run
	f.request("POST", "/messages", input, 200, &run)
	if rejected := f.wait(run.ID, "failed"); !strings.Contains(rejected.Error, "model does not accept images") {
		t.Fatal(rejected.Error)
	}
	input.CommandID, input.Selection.Model = app.ID(), "gateway/org/reasoner"
	f.request("POST", "/messages", input, 200, &run)
	run = f.wait(run.ID, "completed")
	var images []struct{ Type, MimeType, Data string }
	if len(run.Items) != 3 || json.Unmarshal([]byte(run.Items[2].Text), &images) != nil ||
		len(images) != 1 || images[0].Type != "image" || images[0].MimeType != "image/png" || images[0].Data != providerPNG {
		t.Fatalf("Pi did not receive the original PNG: %+v", run.Items)
	}
}

func TestACPModelSpecificThoughtLevelsFallBackAndCloseProbeSessions(t *testing.T) {
	f := newFixture(t)
	config := f.acpProvider("efforts", "--model-efforts")
	var catalog model.Catalog
	f.request("GET", "/providers/"+config.ID+"/models?cwd="+url.QueryEscape(f.root), nil, 200, &catalog)
	if len(catalog.Models) != 3 {
		t.Fatalf("unexpected catalog: %+v", catalog)
	}
	probeSessions, _ := filepath.Glob(filepath.Join(f.root, ".fixture-acp", "efforts", "*.json"))
	if len(probeSessions) != 0 {
		t.Fatalf("discoverACP did not close its probe session: %v", probeSessions)
	}
	chat := f.chat(f.acpAgent(config))

	// Switching to a model with no thought_level option skips the inherited effort on both new and resumed turns.
	var plain model.Run
	f.request("POST", "/messages", model.SendInput{
		CommandID: app.ID(), ChatID: chat.ID, Operation: "main", Text: "plain first",
		Selection: &model.Selection{Provider: config.ID, Model: "acp-plain", Permission: "build-mode", Effort: "deep"},
	}, 200, &plain)
	receipt := acpReceipt(t, f.wait(plain.ID, "completed"))
	if receipt["model"] != "acp-plain" || receipt["mode"] != "build-mode" || receipt["effort"] != "" {
		t.Fatal("plain model did not ignore unsupported thought_level", receipt)
	}
	var resumed model.Run
	f.request("POST", "/messages", model.SendInput{
		CommandID: app.ID(), ChatID: chat.ID, Operation: "main", Text: "plain second",
		Selection: &model.Selection{Provider: config.ID, Model: "acp-plain", Permission: "build-mode", Effort: "deep"},
	}, 200, &resumed)
	receipt = acpReceipt(t, f.wait(resumed.ID, "completed"))
	if receipt["model"] != "acp-plain" || receipt["effort"] != "" {
		t.Fatal("resumed plain model did not ignore unsupported thought_level", receipt)
	}

	// Switching to a model with narrower thought_level values falls back to that model's default.
	var narrowed model.Run
	f.request("POST", "/messages", model.SendInput{
		CommandID: app.ID(), ChatID: chat.ID, Operation: "main", Text: "narrowed effort",
		Selection: &model.Selection{Provider: config.ID, Model: "acp-other", Permission: "review-mode", Effort: "deep"},
	}, 200, &narrowed)
	receipt = acpReceipt(t, f.wait(narrowed.ID, "completed"))
	if receipt["model"] != "acp-other" || receipt["mode"] != "review-mode" || receipt["effort"] != "balanced" {
		t.Fatal("narrowed model did not fall back to its default thought_level", receipt)
	}

	// Permission mode validation remains strict.
	var rejected model.Run
	f.request("POST", "/messages", model.SendInput{
		CommandID: app.ID(), ChatID: chat.ID, Operation: "main", Text: "bad permission",
		Selection: &model.Selection{Provider: config.ID, Model: "acp-plain", Permission: "unknown-mode", Effort: "deep"},
	}, 200, &rejected)
	if failed := f.wait(rejected.ID, "failed"); !strings.Contains(failed.Error, "Unsupported ACP mode") {
		t.Fatal("unsupported permission mode was not rejected", failed)
	}
}
