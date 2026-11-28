package httpapi_test

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"
	"time"

	"lever/internal/app"
	"lever/internal/model"
	"lever/internal/store"
)

func runTextOutput(run model.Run) string {
	var b strings.Builder
	for _, item := range run.Items {
		if item.Kind == "text" {
			b.WriteString(item.Text)
		}
	}
	return b.String()
}

func (f *fixture) pendingRequestForRun(runID string) model.Request {
	f.t.Helper()
	var overview model.Overview
	f.request("GET", "/overview", nil, 200, &overview)
	for _, req := range overview.Requests {
		if req.RunID == runID {
			return req
		}
	}
	f.t.Fatalf("no pending request for run %s: %+v", runID, overview.Requests)
	return model.Request{}
}

func TestProviderQuestionsACPAndAntigravity(t *testing.T) {
	f := newFixture(t)

	// 1. Generic ACP elicitation/create (ordered fields, choice-only, titled multi-select, optional default, cancel)
	acpCfg := f.acpProvider("elicitation")
	acpChat := f.chat(f.acpAgent(acpCfg))

	run := f.send(acpChat.ID, "main", "", "[elicitation]")
	f.wait(run.ID, "waiting_user")
	req := f.pendingRequestForRun(run.ID)
	if req.Kind != "question" || req.Title != "Fixture preferences" || len(req.Questions) != 3 {
		t.Fatalf("unexpected ACP elicitation request: %+v", req)
	}
	if req.Questions[0].ID != "mode" || req.Questions[1].ID != "areas" || req.Questions[2].ID != "note" {
		t.Fatalf("ACP elicitation lost field order: %+v", req.Questions)
	}
	if req.Questions[0].AllowsCustom() || !req.Questions[0].IsRequired() {
		t.Fatalf("unexpected mode question metadata: %+v", req.Questions[0])
	}
	if !req.Questions[1].Multiple || !req.Questions[1].IsRequired() || len(req.Questions[1].Options) != 2 || req.Questions[1].Options[0].ID != "schemas" || req.Questions[1].Options[0].Label != "Schemas" {
		t.Fatalf("unexpected areas question metadata: %+v", req.Questions[1])
	}
	if req.Questions[2].IsRequired() || req.Questions[2].InitialAnswer != "default note" {
		t.Fatalf("unexpected optional note metadata: %+v", req.Questions[2])
	}
	// Missing required question is rejected.
	f.request("POST", "/requests/"+req.ID+"/answer", model.Answer{
		Allow:   true,
		Answers: map[string][]string{"mode": {"Strict (Recommended)"}},
	}, 400, nil)
	// Skipping optional "note" succeeds.
	f.request("POST", "/requests/"+req.ID+"/answer", model.Answer{
		Allow: true,
		Answers: map[string][]string{
			"mode":  {"Strict (Recommended)"},
			"areas": {"ui", "schemas"},
		},
	}, 200, nil)
	receipt := acpReceipt(t, f.wait(run.ID, "completed"))
	caps, _ := receipt["clientCapabilities"].(map[string]any)
	elicitCaps, _ := caps["elicitation"].(map[string]any)
	if elicitCaps == nil || elicitCaps["form"] == nil {
		t.Fatalf("ACP initialize did not advertise elicitation.form: %#v", caps)
	}
	elicitResp, _ := receipt["elicitation"].(map[string]any)
	if elicitResp["action"] != "accept" {
		t.Fatalf("unexpected elicitation response: %#v", elicitResp)
	}
	content, _ := elicitResp["content"].(map[string]any)
	if content["mode"] != "Strict (Recommended)" || !reflect.DeepEqual(content["areas"], []any{"ui", "schemas"}) {
		t.Fatalf("unexpected elicitation content: %#v", content)
	}
	if _, hasNote := content["note"]; hasNote {
		t.Fatalf("skipped optional note should be omitted: %#v", content)
	}

	// Dismissing ACP elicitation sends action: cancel.
	cancelRun := f.send(acpChat.ID, "main", "", "[elicitation] cancel")
	f.wait(cancelRun.ID, "waiting_user")
	cancelReq := f.pendingRequestForRun(cancelRun.ID)
	f.request("POST", "/requests/"+cancelReq.ID+"/answer", model.Answer{Allow: false}, 200, nil)
	cancelReceipt := acpReceipt(t, f.wait(cancelRun.ID, "completed"))
	if cancelReceipt["elicitation"].(map[string]any)["action"] != "cancel" {
		t.Fatalf("dismissed elicitation should return cancel: %#v", cancelReceipt["elicitation"])
	}

	// 2. Antigravity ask_question (title becomes question text, _other companion folds into custom answer)
	agAgent := f.agent("antigravity")
	agChat := f.chat(agAgent)

	agRun := f.send(agChat.ID, "main", "", "[agy-ask-question]")
	f.wait(agRun.ID, "waiting_user")
	agReq := f.pendingRequestForRun(agRun.ID)
	if agReq.Kind != "question" || len(agReq.Questions) != 2 {
		t.Fatalf("unexpected antigravity ask_question request: %+v", agReq)
	}
	if agReq.Questions[0].Header != "Question 1" || agReq.Questions[0].Text != "Which database should we use?" {
		t.Fatalf("antigravity title was not promoted to question text: %+v", agReq.Questions[0])
	}
	if !agReq.Questions[1].AllowsCustom() || agReq.Questions[1].IsRequired() {
		t.Fatalf("companion _other field did not fold into custom-capable optional question: %+v", agReq.Questions[1])
	}
	f.request("POST", "/requests/"+agReq.ID+"/answer", model.Answer{
		Allow: true,
		Answers: map[string][]string{
			"q1": {"Postgres"},
			"q2": {"Only on Fridays"},
		},
	}, 200, nil)
	agReceipt := acpReceipt(t, f.wait(agRun.ID, "completed"))
	agContent := agReceipt["elicitation"].(map[string]any)["content"].(map[string]any)
	if agContent["q1"] != "Postgres" || agContent["q2_other"] != "Only on Fridays" {
		t.Fatalf("unexpected antigravity elicitation content: %#v", agContent)
	}

	// 3. Antigravity legacy interaction_* via session/request_permission renders as structured question.
	interRun := f.send(agChat.ID, "main", "", "[agy-interaction]")
	f.wait(interRun.ID, "waiting_user")
	interReq := f.pendingRequestForRun(interRun.ID)
	if interReq.Kind != "question" || len(interReq.Options) != 0 || len(interReq.Questions) != 1 {
		t.Fatalf("interaction_* should produce structured question without permission options: %+v", interReq)
	}
	if interReq.Questions[0].Text != "Pick a deployment target" || interReq.Questions[0].AllowsCustom() {
		t.Fatalf("unexpected interaction question: %+v", interReq.Questions[0])
	}
	f.request("POST", "/requests/"+interReq.ID+"/answer", model.Answer{
		Allow:   true,
		Answers: map[string][]string{"interaction_1": {"target:staging"}},
	}, 200, nil)
	interReceipt := acpReceipt(t, f.wait(interRun.ID, "completed"))
	if interReceipt["permission"].(map[string]any)["optionId"] != "target:staging" {
		t.Fatalf("interaction_* answer not mapped back to selected optionId: %#v", interReceipt["permission"])
	}
}

func TestProviderQuestionsCodexClaudeAndPi(t *testing.T) {
	f := newFixture(t)

	// 1. Codex multi-question (header + isSecret) + MCP form elicitation
	codexChat := f.chat(f.agent("codex"))

	codexMulti := f.send(codexChat.ID, "main", "", "[question-multi]")
	f.wait(codexMulti.ID, "waiting_user")
	cmReq := f.pendingRequestForRun(codexMulti.ID)
	if cmReq.Kind != "question" || len(cmReq.Questions) != 2 {
		t.Fatalf("unexpected codex multi question: %+v", cmReq)
	}
	if cmReq.Questions[0].Header != "Rollout" || !cmReq.Questions[1].Secret || cmReq.Questions[1].Header != "Deploy key" {
		t.Fatalf("codex question header/secret missing: %+v", cmReq.Questions)
	}
	f.request("POST", "/requests/"+cmReq.ID+"/answer", model.Answer{
		Allow: true,
		Answers: map[string][]string{
			"strategy": {"Canary"},
			"token":    {"s3cr3t"},
		},
	}, 200, nil)
	completed := f.wait(codexMulti.ID, "completed")
	if out := runTextOutput(completed); !strings.Contains(out, "Canary") || !strings.Contains(out, "s3cr3t") {
		t.Fatalf("codex answers missing from reply: %s", out)
	}

	codexElicit := f.send(codexChat.ID, "main", "", "[codex-elicitation]")
	f.wait(codexElicit.ID, "waiting_user")
	ceReq := f.pendingRequestForRun(codexElicit.ID)
	if ceReq.Kind != "question" || len(ceReq.Questions) != 2 {
		t.Fatalf("unexpected codex elicitation: %+v", ceReq)
	}
	f.request("POST", "/requests/"+ceReq.ID+"/answer", model.Answer{
		Allow: true,
		Answers: map[string][]string{
			"env":     {"prod"},
			"retries": {"4"},
		},
	}, 200, nil)
	ceDone := f.wait(codexElicit.ID, "completed")
	if out := runTextOutput(ceDone); !strings.Contains(out, "accept") || !strings.Contains(out, "prod") || !strings.Contains(out, "retries:4") {
		t.Fatalf("codex elicitation result missing: %s", out)
	}

	// 2. Claude AskUserQuestion (header, preview, multiSelect) + elicitation
	claudeChat := f.chat(f.agent("claude"))

	claudeQ := f.send(claudeChat.ID, "main", "", "[claude-question]")
	f.wait(claudeQ.ID, "waiting_user")
	cqReq := f.pendingRequestForRun(claudeQ.ID)
	if cqReq.Kind != "question" || len(cqReq.Questions) != 2 {
		t.Fatalf("unexpected claude question: %+v", cqReq)
	}
	if cqReq.Questions[0].Header != "Auth" || !strings.Contains(cqReq.Questions[0].Options[0].Preview, "useOAuth()") {
		t.Fatalf("claude header/preview missing: %+v", cqReq.Questions[0])
	}
	if !cqReq.Questions[1].Multiple || cqReq.Questions[1].Header != "Scopes" {
		t.Fatalf("claude multiSelect/header missing: %+v", cqReq.Questions[1])
	}
	f.request("POST", "/requests/"+cqReq.ID+"/answer", model.Answer{
		Allow: true,
		Answers: map[string][]string{
			"Which auth method?": {"OAuth"},
			"Select scopes":      {"read", "write"},
		},
	}, 200, nil)
	cqDone := f.wait(claudeQ.ID, "completed")
	if out := runTextOutput(cqDone); !strings.Contains(out, `"Which auth method?":"OAuth"`) || !strings.Contains(out, `"Select scopes":"read, write"`) {
		t.Fatalf("claude AskUserQuestion answers missing: %s", out)
	}

	claudeElicit := f.send(claudeChat.ID, "main", "", "[claude-elicitation]")
	f.wait(claudeElicit.ID, "waiting_user")
	cleReq := f.pendingRequestForRun(claudeElicit.ID)
	if cleReq.Kind != "question" || len(cleReq.Questions) != 1 || cleReq.Questions[0].ID != "region" {
		t.Fatalf("unexpected claude elicitation: %+v", cleReq)
	}
	f.request("POST", "/requests/"+cleReq.ID+"/answer", model.Answer{
		Allow:   true,
		Answers: map[string][]string{"region": {"eu"}},
	}, 200, nil)
	cleDone := f.wait(claudeElicit.ID, "completed")
	if out := runTextOutput(cleDone); !strings.Contains(out, `"action":"accept"`) || !strings.Contains(out, `"region":"eu"`) {
		t.Fatalf("claude elicitation response missing: %s", out)
	}

	// 3. Pi select (structured question) + editor (initialAnswer prefill + empty submit)
	piChat := f.chat(f.agent("pi"))

	piSelect := f.send(piChat.ID, "main", "", "[pi-select]")
	f.wait(piSelect.ID, "waiting_user")
	psReq := f.pendingRequestForRun(piSelect.ID)
	if psReq.Kind != "question" || len(psReq.Options) != 0 || len(psReq.Questions) != 1 || psReq.Questions[0].AllowsCustom() {
		t.Fatalf("pi select should produce choice-only question: %+v", psReq)
	}
	f.request("POST", "/requests/"+psReq.ID+"/answer", model.Answer{
		Allow:   true,
		Answers: map[string][]string{"value": {"Beta"}},
	}, 200, nil)
	psDone := f.wait(piSelect.ID, "completed")
	var piResp map[string]any
	if err := json.Unmarshal([]byte(runTextOutput(psDone)), &piResp); err != nil || piResp["value"] != "Beta" {
		t.Fatalf("unexpected pi select response: %s (%v)", runTextOutput(psDone), err)
	}

	piEditor := f.send(piChat.ID, "main", "", "[pi-editor]")
	f.wait(piEditor.ID, "waiting_user")
	peReq := f.pendingRequestForRun(piEditor.ID)
	if peReq.Kind != "question" || len(peReq.Questions) != 1 || peReq.Questions[0].Text != "Edit release notes" || peReq.Questions[0].InitialAnswer != "Initial notes" || peReq.Questions[0].IsRequired() {
		t.Fatalf("pi editor question metadata invalid: %+v", peReq)
	}
	// Empty submit sends value:"" (not cancelled:true).
	f.request("POST", "/requests/"+peReq.ID+"/answer", model.Answer{
		Allow:   true,
		Answers: map[string][]string{},
	}, 200, nil)
	peDone := f.wait(piEditor.ID, "completed")
	piResp = nil
	if err := json.Unmarshal([]byte(runTextOutput(peDone)), &piResp); err != nil || piResp["value"] != "" || piResp["cancelled"] != nil {
		t.Fatalf("pi editor empty submit should send empty string, got: %s (%v)", runTextOutput(peDone), err)
	}
}

func TestQuestionTimeoutSettingsAndAutoProceedAcrossProviders(t *testing.T) {
	f := newFixture(t)

	// 1. Default question settings exposed in Overview and GET /settings/questions.
	var ov model.Overview
	f.request("GET", "/overview", nil, 200, &ov)
	if ov.QuestionSettings.TimeoutSeconds != model.DefaultQuestionTimeoutSeconds {
		t.Fatalf("unexpected default overview questionSettings: %+v", ov.QuestionSettings)
	}
	var current model.QuestionSettings
	f.request("GET", "/settings/questions", nil, 200, &current)
	if current.TimeoutSeconds != model.DefaultQuestionTimeoutSeconds {
		t.Fatalf("unexpected GET /settings/questions: %+v", current)
	}
	f.request("PUT", "/settings/questions", map[string]int{"timeoutSeconds": -5}, 400, nil)
	f.request("PUT", "/settings/questions", map[string]int{"timeoutSeconds": model.MaxQuestionTimeoutSeconds + 1}, 400, nil)

	// Configure a short 1s timeout for automated verification.
	var saved model.QuestionSettings
	f.request("PUT", "/settings/questions", model.QuestionSettings{TimeoutSeconds: 1}, 200, &saved)
	if saved.TimeoutSeconds != 1 {
		t.Fatalf("unexpected saved questionSettings: %+v", saved)
	}
	f.request("GET", "/overview", nil, 200, &ov)
	if ov.QuestionSettings.TimeoutSeconds != 1 {
		t.Fatalf("overview did not reflect saved questionSettings: %+v", ov.QuestionSettings)
	}

	assertAutoAnswered := func(requestID string) model.Request {
		t.Helper()
		stored, err := store.Get[model.Request](t.Context(), f.a.Store.DB, "SELECT data FROM requests WHERE id=?", requestID)
		if err != nil {
			t.Fatal(err)
		}
		if stored.Status != "answered" || !stored.AutoAnswered || stored.Answer == nil {
			t.Fatalf("expected auto-answered request %s, got: %+v", requestID, stored)
		}
		return stored
	}

	// 2. ACP elicitation: picks "(Recommended)" option, first option for required multi-select, and default note.
	acpCfg := f.acpProvider("elicitation-timeout")
	acpChat := f.chat(f.acpAgent(acpCfg))
	acpRun := f.send(acpChat.ID, "main", "", "[elicitation]")
	f.wait(acpRun.ID, "waiting_user")
	acpReq := f.pendingRequestForRun(acpRun.ID)
	if acpReq.ExpiresAt == "" {
		t.Fatalf("expected expiresAt on pending ACP question: %+v", acpReq)
	}
	acpReceiptData := acpReceipt(t, f.wait(acpRun.ID, "completed"))
	assertAutoAnswered(acpReq.ID)
	elicitResp := acpReceiptData["elicitation"].(map[string]any)
	if elicitResp["action"] != "accept" {
		t.Fatalf("ACP elicitation auto-answer failed: %#v", elicitResp)
	}
	content := elicitResp["content"].(map[string]any)
	if content["mode"] != "Strict (Recommended)" || !reflect.DeepEqual(content["areas"], []any{"schemas"}) || content["note"] != "default note" {
		t.Fatalf("unexpected ACP elicitation auto-answer content: %#v", content)
	}

	// 3. Antigravity interaction_* (choice-only): picks first option cleanly.
	agChat := f.chat(f.agent("antigravity"))
	interRun := f.send(agChat.ID, "main", "", "[agy-interaction]")
	f.wait(interRun.ID, "waiting_user")
	interReq := f.pendingRequestForRun(interRun.ID)
	interReceipt := acpReceipt(t, f.wait(interRun.ID, "completed"))
	assertAutoAnswered(interReq.ID)
	if interReceipt["permission"].(map[string]any)["optionId"] != "target:staging" {
		t.Fatalf("unexpected antigravity interaction auto-answer: %#v", interReceipt["permission"])
	}

	// 4. Codex requestUserInput (options without Recommended marker, custom allowed): sends recommendation fallback instruction.
	codexChat := f.chat(f.agent("codex"))
	codexRun := f.send(codexChat.ID, "main", "", "[question]")
	f.wait(codexRun.ID, "waiting_user")
	codexReq := f.pendingRequestForRun(codexRun.ID)
	codexDone := f.wait(codexRun.ID, "completed")
	assertAutoAnswered(codexReq.ID)
	if out := runTextOutput(codexDone); !strings.Contains(out, app.QuestionTimeoutFallbackAnswer) {
		t.Fatalf("codex auto-answer did not send fallback instruction: %s", out)
	}

	// 5. Codex MCP elicitation (strict enum + optional integer): selects first enum option and omits optional integer.
	codexElicit := f.send(codexChat.ID, "main", "", "[codex-elicitation]")
	f.wait(codexElicit.ID, "waiting_user")
	ceReq := f.pendingRequestForRun(codexElicit.ID)
	ceDone := f.wait(codexElicit.ID, "completed")
	assertAutoAnswered(ceReq.ID)
	if out := runTextOutput(ceDone); !strings.Contains(out, "accept") || !strings.Contains(out, "staging") {
		t.Fatalf("codex elicitation auto-answer failed: %s", out)
	}

	// 6. Claude AskUserQuestion (no explicit Recommended label): sends recommendation fallback so Claude proceeds.
	claudeChat := f.chat(f.agent("claude"))
	claudeRun := f.send(claudeChat.ID, "main", "", "[claude-question]")
	f.wait(claudeRun.ID, "waiting_user")
	claudeReq := f.pendingRequestForRun(claudeRun.ID)
	claudeDone := f.wait(claudeRun.ID, "completed")
	assertAutoAnswered(claudeReq.ID)
	if out := runTextOutput(claudeDone); !strings.Contains(out, app.QuestionTimeoutFallbackAnswer) {
		t.Fatalf("claude AskUserQuestion auto-answer missing fallback instruction: %s", out)
	}

	// 7. Pi select (choice-only) + editor (prefill): auto-selects first option and uses prefill.
	piChat := f.chat(f.agent("pi"))
	piSelect := f.send(piChat.ID, "main", "", "[pi-select]")
	f.wait(piSelect.ID, "waiting_user")
	psReq := f.pendingRequestForRun(piSelect.ID)
	psDone := f.wait(piSelect.ID, "completed")
	assertAutoAnswered(psReq.ID)
	var piResp map[string]any
	if err := json.Unmarshal([]byte(runTextOutput(psDone)), &piResp); err != nil || piResp["value"] != "Alpha" {
		t.Fatalf("unexpected pi select auto-answer: %s (%v)", runTextOutput(psDone), err)
	}

	piEditor := f.send(piChat.ID, "main", "", "[pi-editor]")
	f.wait(piEditor.ID, "waiting_user")
	peReq := f.pendingRequestForRun(piEditor.ID)
	peDone := f.wait(piEditor.ID, "completed")
	assertAutoAnswered(peReq.ID)
	piResp = nil
	if err := json.Unmarshal([]byte(runTextOutput(peDone)), &piResp); err != nil || piResp["value"] != "Initial notes" {
		t.Fatalf("unexpected pi editor auto-answer: %s (%v)", runTextOutput(peDone), err)
	}

	// 8. Cancel-timeout pauses auto-proceed for a specific pending question.
	f.request("PUT", "/settings/questions", model.QuestionSettings{TimeoutSeconds: 1}, 200, &saved)
	holdRun := f.send(codexChat.ID, "main", "", "[question]")
	f.wait(holdRun.ID, "waiting_user")
	holdReq := f.pendingRequestForRun(holdRun.ID)
	f.request("POST", "/requests/"+holdReq.ID+"/cancel-timeout", map[string]any{}, 200, nil)
	holdReqAfter := f.pendingRequestForRun(holdRun.ID)
	if holdReqAfter.ExpiresAt != "" {
		t.Fatalf("expected expiresAt cleared after cancel-timeout: %+v", holdReqAfter)
	}
	time.Sleep(1300 * time.Millisecond)
	stillPending := f.pendingRequestForRun(holdRun.ID)
	if stillPending.Status != "pending" {
		t.Fatalf("cancelled-timeout question should remain pending: %+v", stillPending)
	}
	f.request("POST", "/requests/"+holdReq.ID+"/answer", model.Answer{
		Allow:   true,
		Answers: map[string][]string{"choice": {"Blue"}},
	}, 200, nil)
	holdDone := f.wait(holdRun.ID, "completed")
	if out := runTextOutput(holdDone); !strings.Contains(out, "Blue") {
		t.Fatalf("manual answer after cancel-timeout failed: %s", out)
	}

	// 9. Timeout disabled (0) omits expiresAt and never auto-answers.
	f.request("PUT", "/settings/questions", model.QuestionSettings{TimeoutSeconds: 0}, 200, &saved)
	offRun := f.send(codexChat.ID, "main", "", "[question]")
	f.wait(offRun.ID, "waiting_user")
	offReq := f.pendingRequestForRun(offRun.ID)
	if offReq.ExpiresAt != "" {
		t.Fatalf("expected empty expiresAt when timeout is disabled: %+v", offReq)
	}
	f.request("POST", "/requests/"+offReq.ID+"/answer", model.Answer{
		Allow:   true,
		Answers: map[string][]string{"choice": {"Green"}},
	}, 200, nil)
	f.wait(offRun.ID, "completed")
}
