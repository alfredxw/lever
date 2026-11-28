package provider

import (
	"encoding/json"
	"reflect"
	"testing"
)

func TestParseElicitationFormPreservesOrderAndTypes(t *testing.T) {
	schema := json.RawMessage(`{
		"type": "object",
		"title": "Fixture setup",
		"properties": {
			"second": {"type": "string", "title": "Auth", "description": "Pick auth", "enum": ["oauth", "token"]},
			"first": {"type": "array", "title": "Areas", "description": "Pick areas", "minItems": 1, "items": {"anyOf": [{"const": "ui", "title": "UI", "description": "Web layer"}, {"const": "api", "title": "API"}]}},
			"confirm": {"type": "boolean", "title": "Dry run"},
			"retries": {"type": "integer", "title": "Retries"},
			"ratio": {"type": "number", "title": "Ratio"},
			"note": {"type": "string", "title": "Notes", "default": "hi"}
		},
		"required": ["second", "first", "confirm", "retries"]
	}`)
	form, ok := parseElicitationForm(schema, "Configure fixture", elicitationOptions{})
	if !ok {
		t.Fatal("expected valid elicitation form")
	}
	if len(form.questions) != 6 {
		t.Fatalf("expected 6 questions, got %d", len(form.questions))
	}
	// Exact JSON property order preserved.
	gotOrder := []string{}
	for _, q := range form.questions {
		gotOrder = append(gotOrder, q.ID)
	}
	wantOrder := []string{"second", "first", "confirm", "retries", "ratio", "note"}
	if !reflect.DeepEqual(gotOrder, wantOrder) {
		t.Fatalf("question order = %v, want %v", gotOrder, wantOrder)
	}
	if form.questions[0].AllowsCustom() {
		t.Fatal("enum single-choice should disallow custom answer")
	}
	if !form.questions[1].Multiple || !form.questions[1].IsRequired() {
		t.Fatalf("first question should be required multi-select: %+v", form.questions[1])
	}
	if form.questions[4].IsRequired() || form.questions[5].IsRequired() {
		t.Fatal("optional fields should have IsRequired() == false")
	}
	if form.questions[5].InitialAnswer != "hi" {
		t.Fatalf("expected default initial answer, got %q", form.questions[5].InitialAnswer)
	}

	content, ok := form.content(map[string][]string{
		"second":  {"token"},
		"first":   {"api", "ui"},
		"confirm": {"true"},
		"retries": {"3"},
		"ratio":   {""},
	})
	if !ok {
		t.Fatal("expected valid content")
	}
	want := map[string]any{
		"second":  "token",
		"first":   []string{"api", "ui"},
		"confirm": true,
		"retries": int64(3),
	}
	if !reflect.DeepEqual(content, want) {
		t.Fatalf("content = %#v, want %#v", content, want)
	}
}

func TestParseElicitationFormEnumLabelCollision(t *testing.T) {
	schema := json.RawMessage(`{
		"type": "object",
		"properties": {
			"answer": {"type": "string", "enum": [" a", "a", "\"a\""]}
		},
		"required": ["answer"]
	}`)
	form, ok := parseElicitationForm(schema, "Choose", elicitationOptions{})
	if !ok || len(form.questions) != 1 {
		t.Fatalf("unexpected form: %v %+v", ok, form)
	}
	gotLabels := []string{}
	gotIDs := []string{}
	for _, o := range form.questions[0].Options {
		gotLabels = append(gotLabels, o.Label)
		gotIDs = append(gotIDs, o.ID)
	}
	wantLabels := []string{`" a"`, `"a"`, `"\"a\""`}
	wantIDs := []string{" a", "a", `"a"`}
	if !reflect.DeepEqual(gotLabels, wantLabels) || !reflect.DeepEqual(gotIDs, wantIDs) {
		t.Fatalf("labels=%v ids=%v", gotLabels, gotIDs)
	}
	content, ok := form.content(map[string][]string{"answer": {" a"}})
	if !ok || content["answer"] != " a" {
		t.Fatalf("exact enum value lost: %v %#v", ok, content)
	}
}

func TestParseElicitationFormCompanionOtherField(t *testing.T) {
	schema := json.RawMessage(`{
		"type": "object",
		"properties": {
			"q0": {"type": "string", "title": "Use Postgres?", "description": "Database", "oneOf": [{"const": "Yes", "title": "Yes"}, {"const": "No", "title": "No"}]},
			"q0__other": {"type": "string", "title": "Other"},
			"q1": {"type": "string", "title": "Deploy?", "oneOf": [{"const": "Yes", "title": "Yes"}]},
			"q1_other": {"type": "string", "title": "Other"}
		}
	}`)
	form, ok := parseElicitationForm(schema, "Answer 2 questions", elicitationOptions{})
	if !ok || len(form.questions) != 2 {
		t.Fatalf("expected 2 folded questions, got %v %d", ok, len(form.questions))
	}
	if !form.questions[0].AllowsCustom() || !form.questions[1].AllowsCustom() {
		t.Fatal("folded companion questions should allow custom answers")
	}
	content, ok := form.content(map[string][]string{
		"q0": {"Yes"},
		"q1": {"Only on Fridays"},
	})
	if !ok {
		t.Fatal("expected valid content")
	}
	want := map[string]any{"q0": "Yes", "q1_other": "Only on Fridays"}
	if !reflect.DeepEqual(content, want) {
		t.Fatalf("content = %#v, want %#v", content, want)
	}
}

func TestParseElicitationFormAntigravityTitleAsQuestion(t *testing.T) {
	schema := json.RawMessage(`{
		"type": "object",
		"properties": {
			"q1": {"type": "string", "title": "Which database should we use?", "enum": ["Postgres", "SQLite"]}
		},
		"required": ["q1"]
	}`)
	form, ok := parseElicitationForm(schema, "Please answer 1 question", elicitationOptions{antigravityTitleAsQuestion: true})
	if !ok || len(form.questions) != 1 {
		t.Fatalf("unexpected form: %v", ok)
	}
	q := form.questions[0]
	if q.Header != "Question 1" || q.Text != "Which database should we use?" {
		t.Fatalf("got header=%q text=%q", q.Header, q.Text)
	}
}

func TestParseElicitationFormAllowOtherAndEmptyConfirmation(t *testing.T) {
	schema := json.RawMessage(`{
		"type": "object",
		"properties": {
			"mode": {"type": "string", "title": "Mode", "enum": ["fast", "safe"]}
		},
		"required": ["mode"]
	}`)
	form, ok := parseElicitationForm(schema, "Pick mode", elicitationOptions{allowOther: true})
	if !ok || !form.questions[0].AllowsCustom() {
		t.Fatal("expected allowOther question to allow custom answers")
	}
	content, ok := form.content(map[string][]string{"mode": {"custom mode"}})
	if !ok || content["mode"] != "custom mode" {
		t.Fatalf("got %v %#v", ok, content)
	}

	emptyForm, ok := parseElicitationForm(json.RawMessage(`{"type":"object","properties":{}}`), "Continue?", elicitationOptions{})
	if !ok || !emptyForm.empty || len(emptyForm.questions) != 0 {
		t.Fatalf("expected empty confirmation form, got %v %+v", ok, emptyForm)
	}
}
