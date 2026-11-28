package app

import (
	"reflect"
	"testing"

	"lever/internal/model"
)

func boolPtr(v bool) *bool { return &v }

func TestQuestionSettingsDefaultSaveAndReload(t *testing.T) {
	dir := t.TempDir()
	a, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}

	got, err := a.QuestionSettings(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	if got.TimeoutSeconds != model.DefaultQuestionTimeoutSeconds {
		t.Fatalf("default timeout = %d, want %d", got.TimeoutSeconds, model.DefaultQuestionTimeoutSeconds)
	}

	ov, err := a.Overview(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	if ov.QuestionSettings.TimeoutSeconds != model.DefaultQuestionTimeoutSeconds {
		t.Fatalf("overview default timeout = %+v", ov.QuestionSettings)
	}

	if _, err := a.SaveQuestionSettings(t.Context(), model.QuestionSettings{TimeoutSeconds: -1}); err == nil {
		t.Fatal("expected negative timeout to fail validation")
	}
	if _, err := a.SaveQuestionSettings(t.Context(), model.QuestionSettings{TimeoutSeconds: model.MaxQuestionTimeoutSeconds + 1}); err == nil {
		t.Fatal("expected overly large timeout to fail validation")
	}

	saved, err := a.SaveQuestionSettings(t.Context(), model.QuestionSettings{TimeoutSeconds: 300})
	if err != nil {
		t.Fatal(err)
	}
	if saved.TimeoutSeconds != 300 {
		t.Fatalf("saved timeout = %+v", saved)
	}
	if err := a.Close(); err != nil {
		t.Fatal(err)
	}

	reopened, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()

	reloaded, err := reopened.QuestionSettings(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	if reloaded.TimeoutSeconds != 300 {
		t.Fatalf("reloaded timeout = %+v, want 300", reloaded)
	}

	// Zero disables timeout cleanly.
	disabled, err := reopened.SaveQuestionSettings(t.Context(), model.QuestionSettings{TimeoutSeconds: 0})
	if err != nil {
		t.Fatal(err)
	}
	if disabled.TimeoutSeconds != 0 {
		t.Fatalf("disabled timeout = %+v, want 0", disabled)
	}
}

func TestBuildRecommendedQuestionAnswer(t *testing.T) {
	tests := []struct {
		name      string
		questions []model.Question
		want      model.Answer
	}{
		{
			name: "picks option marked recommended in English label",
			questions: []model.Question{{
				ID:   "db",
				Text: "Which database?",
				Options: []model.QuestionOption{
					{ID: "mysql", Label: "MySQL"},
					{ID: "pg", Label: "PostgreSQL (Recommended)"},
				},
			}},
			want: model.Answer{Allow: true, Answers: map[string][]string{"db": {"pg"}}},
		},
		{
			name: "picks option marked recommended in Chinese label and ignores negated option",
			questions: []model.Question{{
				ID:   "strategy",
				Text: "发布策略？",
				Options: []model.QuestionOption{
					{ID: "direct", Label: "全量直接发布（不推荐）", Description: "Not recommended for production"},
					{ID: "canary", Label: "灰度发布（推荐）"},
				},
			}},
			want: model.Answer{Allow: true, Answers: map[string][]string{"strategy": {"canary"}}},
		},
		{
			name: "picks recommended from description and ignores recommendation noun",
			questions: []model.Question{{
				ID:   "svc",
				Text: "Which service?",
				Options: []model.QuestionOption{
					{ID: "rec", Label: "Recommendation service", Description: "Legacy service"},
					{ID: "core", Label: "Core API", Description: "Recommended for most deployments"},
				},
			}},
			want: model.Answer{Allow: true, Answers: map[string][]string{"svc": {"core"}}},
		},
		{
			name: "explicit recommended beats default label",
			questions: []model.Question{{
				ID:   "cfg",
				Text: "Config mode?",
				Options: []model.QuestionOption{
					{ID: "def", Label: "Legacy (Default)"},
					{ID: "v2", Label: "V2 [Recommended]"},
				},
			}},
			want: model.Answer{Allow: true, Answers: map[string][]string{"cfg": {"v2"}}},
		},
		{
			name: "structured Recommended flag from schema default wins",
			questions: []model.Question{{
				ID:          "dry_run",
				Text:        "Dry run?",
				AllowCustom: boolPtr(false),
				Options: []model.QuestionOption{
					{ID: "true", Label: "Yes"},
					{ID: "false", Label: "No", Recommended: true},
				},
			}},
			want: model.Answer{Allow: true, Answers: map[string][]string{"dry_run": {"false"}}},
		},
		{
			name: "multi-select picks all recommended options",
			questions: []model.Question{{
				ID:       "areas",
				Text:     "Which areas?",
				Multiple: true,
				Options: []model.QuestionOption{
					{ID: "docs", Label: "Docs"},
					{ID: "api", Label: "API (Recommended)"},
					{ID: "ui", Label: "UI（推荐）"},
				},
			}},
			want: model.Answer{Allow: true, Answers: map[string][]string{"areas": {"api", "ui"}}},
		},
		{
			name: "choice-only without recommended marker falls back to first option",
			questions: []model.Question{{
				ID:          "target",
				Text:        "Target?",
				AllowCustom: boolPtr(false),
				Options: []model.QuestionOption{
					{ID: "staging", Label: "Staging"},
					{ID: "prod", Label: "Production"},
				},
			}},
			want: model.Answer{Allow: true, Answers: map[string][]string{"target": {"staging"}}},
		},
		{
			name: "choice allowing custom without recommended marker tells agent to use its recommendation",
			questions: []model.Question{{
				ID:   "auth",
				Text: "Auth method?",
				Options: []model.QuestionOption{
					{ID: "oauth", Label: "OAuth"},
					{ID: "apikey", Label: "API Key"},
				},
			}},
			want: model.Answer{Allow: true, Answers: map[string][]string{"auth": {QuestionTimeoutFallbackAnswer}}},
		},
		{
			name: "free-text uses initialAnswer when present",
			questions: []model.Question{{
				ID:            "notes",
				Text:          "Release notes",
				Required:      boolPtr(false),
				InitialAnswer: "Initial notes",
			}},
			want: model.Answer{Allow: true, Answers: map[string][]string{"notes": {"Initial notes"}}},
		},
		{
			name: "single optional free-text question uses recommendation fallback",
			questions: []model.Question{{
				ID:       "branch",
				Text:     "Branch name?",
				Required: boolPtr(false),
			}},
			want: model.Answer{Allow: true, Answers: map[string][]string{"branch": {QuestionTimeoutFallbackAnswer}}},
		},
		{
			name: "optional fields alongside required choice are omitted cleanly",
			questions: []model.Question{
				{
					ID:          "env",
					Text:        "Env?",
					AllowCustom: boolPtr(false),
					Options:     []model.QuestionOption{{ID: "staging", Label: "Staging"}, {ID: "prod", Label: "Prod"}},
				},
				{
					ID:        "retries",
					Text:      "Retries",
					Required:  boolPtr(false),
					InputType: "integer",
				},
				{
					ID:       "note",
					Text:     "Extra note",
					Required: boolPtr(false),
				},
			},
			want: model.Answer{Allow: true, Answers: map[string][]string{"env": {"staging"}}},
		},
		{
			name: "required numeric field without default cancels safely",
			questions: []model.Question{{
				ID:        "port",
				Text:      "Port",
				InputType: "integer",
			}},
			want: model.Answer{Allow: false, Answers: map[string][]string{}},
		},
		{
			name: "required numeric field with default succeeds",
			questions: []model.Question{{
				ID:            "port",
				Text:          "Port",
				InputType:     "integer",
				InitialAnswer: "8080",
			}},
			want: model.Answer{Allow: true, Answers: map[string][]string{"port": {"8080"}}},
		},
		{
			name: "required secret field cancels instead of fabricating a secret",
			questions: []model.Question{
				{
					ID:   "strategy",
					Text: "Strategy",
					Options: []model.QuestionOption{
						{ID: "canary", Label: "Canary (Recommended)"},
					},
				},
				{
					ID:     "token",
					Text:   "Deploy key",
					Secret: true,
				},
			},
			want: model.Answer{Allow: false, Answers: map[string][]string{}},
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := buildRecommendedQuestionAnswer(model.Request{
				Kind:      "question",
				Questions: tc.questions,
			})
			if !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("buildRecommendedQuestionAnswer() = %#v, want %#v", got, tc.want)
			}
		})
	}
}
