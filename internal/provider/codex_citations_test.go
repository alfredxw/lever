package provider

import (
	"reflect"
	"strings"
	"testing"

	"lever/internal/model"
)

func TestCodexCitationIndexExtraction(t *testing.T) {
	idx := codexCitationIndex{}
	idx.addMCPResult(object{
		"_meta": object{
			"raw_messages": []any{
				object{
					"content": object{
						"ref_id": "turn3view0",
						"title":  "App Store Connect API - Get started",
						"url":    "https://developer.apple.com/help/app-store-connect/get-started/app-store-connect-api/",
					},
					"metadata": object{
						"sonic_browser_tool": object{
							"content": object{
								"turn2search0": object{
									"title": "Apple Developer Program Roles",
									"url":   "https://developer.apple.com/help/account/access/roles",
								},
								"turnUnsafe": object{
									"title": "Bad",
									"url":   "javascript:alert(1)",
								},
							},
						},
					},
				},
			},
		},
		"content": []any{
			object{
				"type": "text",
				"text": "Synchronizing code signing identities (Xcode) (https://developer.apple.com/documentation/Xcode/sharing-your-teams-signing-certificates)\n【turn1search0】 [wordlim: 200] Crawled: today;",
			},
			object{
				"type": "text",
				// Truncated JSON envelope like Codex thread_history_*.sqlite stores.
				"text": `{"content":[{"type":"text","text":"Add internal testers - Apple Developer (https://developer.apple.com/help/app-store-connect/test-a-beta-version/add-internal-testers)\n【turn4search0】 [wordlim: 200] truncated...`,
			},
		},
	})

	want := codexCitationIndex{
		"turn3view0": {
			Title: "App Store Connect API - Get started",
			URL:   "https://developer.apple.com/help/app-store-connect/get-started/app-store-connect-api/",
		},
		"turn2search0": {
			Title: "Apple Developer Program Roles",
			URL:   "https://developer.apple.com/help/account/access/roles",
		},
		"turn1search0": {
			Title: "Synchronizing code signing identities (Xcode)",
			URL:   "https://developer.apple.com/documentation/Xcode/sharing-your-teams-signing-certificates",
		},
		"turn4search0": {
			Title: "Add internal testers - Apple Developer",
			URL:   "https://developer.apple.com/help/app-store-connect/test-a-beta-version/add-internal-testers",
		},
	}
	if !reflect.DeepEqual(idx, want) {
		t.Fatalf("extracted index mismatch:\ngot:  %#v\nwant: %#v", idx, want)
	}
}

func TestResolveCodexCitationsAndOffsets(t *testing.T) {
	idx := codexCitationIndex{
		"turn3view0": {
			Title: "App Store Connect API",
			URL:   "https://developer.apple.com/help/app-store-connect/get-started/app-store-connect-api/",
		},
		"turn2search0": {
			Title: "Apple Developer Program Roles",
			URL:   "https://developer.apple.com/help/account/access/roles",
		},
		"turn1search1": {
			Title: "Creating API Keys",
			URL:   "https://developer.apple.com/documentation/AppStoreConnectAPI/creating-api-keys-for-app-store-connect-api",
		},
		"turn1search0": {
			Title: "Synchronizing code signing identities",
			URL:   "https://developer.apple.com/documentation/Xcode/sharing-your-teams-signing-certificates",
		},
	}

	raw := "🚀 [打开团队密钥页面](https://appstoreconnect.apple.com/access/integrations/api) \uE200cite\uE202turn3view0\uE202turn2search0\uE202turn1search1\uE202turn2search0\uE201\n" +
		"继续即可。\uE200cite\uE202turn999search0\uE201\n" +
		"参考 \uE200cite\uE202turn1search0\uE201 说明。\n" +
		"`\uE200cite\uE202turn1search0\uE201`\n" +
		"```\n\uE200cite\uE202turn1search0\uE201\n```\n" +
		"\uE200visualize\uE202{\"path\":\"/tmp/chart.html\"}\uE201"

	gotText, gotCitations := resolveCodexCitations(raw, idx, false)
	wantText := "🚀 [打开团队密钥页面](https://appstoreconnect.apple.com/access/integrations/api)\n" +
		"继续即可。\n" +
		"参考 说明。\n" +
		"`\uE200cite\uE202turn1search0\uE201`\n" +
		"```\n\uE200cite\uE202turn1search0\uE201\n```\n" +
		"\uE200visualize\uE202{\"path\":\"/tmp/chart.html\"}\uE201"
	if gotText != wantText {
		t.Fatalf("cleaned text mismatch:\ngot:  %q\nwant: %q", gotText, wantText)
	}

	// First line starts with 🚀 (2 UTF-16 code units).
	line1 := "🚀 [打开团队密钥页面](https://appstoreconnect.apple.com/access/integrations/api)"
	prefix2 := line1 + "\n继续即可。\n参考"
	wantCitations := []model.Citation{
		{
			Offset: utf16StringLen(line1),
			Sources: []model.CitationSource{
				idx["turn3view0"],
				idx["turn2search0"],
				idx["turn1search1"],
			},
		},
		{
			Offset:  utf16StringLen(prefix2),
			Sources: []model.CitationSource{idx["turn1search0"]},
		},
	}
	if !reflect.DeepEqual(gotCitations, wantCitations) {
		t.Fatalf("citations mismatch:\ngot:  %#v\nwant: %#v", gotCitations, wantCitations)
	}
}

func TestResolveCodexCitationsStreamingBuffer(t *testing.T) {
	idx := codexCitationIndex{
		"turn1search0": {Title: "Apple Docs", URL: "https://developer.apple.com/docs"},
	}

	// Partial citation marker should be held back without leaking PUA glyphs.
	for _, partial := range []string{
		"完成。 \uE200",
		"完成。 \uE200ci",
		"完成。 \uE200cite",
		"完成。 \uE200cite\uE202turn1search",
	} {
		text, citations := resolveCodexCitations(partial, idx, true)
		if text != "完成。" || len(citations) != 0 {
			t.Fatalf("streaming partial %q -> (%q, %#v), want (%q, nil)", partial, text, citations, "完成。")
		}
	}

	// Non-citation PUA markers (visualize) must flush untouched once disambiguated.
	vis := "\uE200visualize\uE202{\"path\":\"/tmp/a.html\"}"
	if text, _ := resolveCodexCitations(vis, idx, true); text != vis {
		t.Fatalf("visualize marker altered during streaming: got %q, want %q", text, vis)
	}

	// Once closed, citation resolves immediately.
	done := "完成。 \uE200cite\uE202turn1search0\uE201"
	text, citations := resolveCodexCitations(done, idx, true)
	if text != "完成。" || len(citations) != 1 || citations[0].Offset != utf16StringLen("完成。") {
		t.Fatalf("closed streaming citation -> (%q, %#v)", text, citations)
	}

	// Unclosed truncated citation on completion is stripped rather than leaked.
	if text, citations := resolveCodexCitations("完成。 \uE200cite\uE202turn1search0", idx, false); text != "完成。" || len(citations) != 0 || strings.Contains(text, puaStart) {
		t.Fatalf("unclosed completed citation -> (%q, %#v)", text, citations)
	}
}

func TestApplyCodexSharedCitations(t *testing.T) {
	turns := map[string]codexCitationIndex{}
	recordCodexSharedCitations(turns, "turn-1", object{
		"type": "mcpToolCall",
		"result": object{
			"content": []any{
				object{
					"type": "text",
					"text": "Apple Docs (https://developer.apple.com/docs)\n【turn1search0】 snippet",
				},
			},
		},
	})

	messages := []model.SharedMessage{
		{
			Item:   model.Item{ID: "turn-1/m1", Kind: "final", Text: "说明。\uE200cite\uE202turn1search0\uE201"},
			Role:   "assistant",
			TurnID: "turn-1",
		},
		{
			Item:   model.Item{ID: "turn-2/m2", Kind: "final", Text: "另一轮。\uE200cite\uE202turn1search0\uE201"},
			Role:   "assistant",
			TurnID: "turn-2",
		},
	}

	resolved := applyCodexSharedCitations(messages, turns)
	if resolved[0].Text != "说明。" || len(resolved[0].Citations) != 1 {
		t.Fatalf("turn-1 message not resolved: %#v", resolved[0])
	}
	// turn-2 does not inherit turn-1's ref_id, and still strips the raw token.
	if resolved[1].Text != "另一轮。" || len(resolved[1].Citations) != 0 {
		t.Fatalf("turn-2 message should strip without cross-turn leakage: %#v", resolved[1])
	}
}

func TestClaudeCitations(t *testing.T) {
	got := claudeCitations([]any{
		object{"type": "web_search_result_location", "title": "Docs", "url": "https://docs.anthropic.com/en"},
		object{"type": "web_search_result_location", "title": "Dup", "url": "https://docs.anthropic.com/en"},
		object{"type": "web_search_result_location", "title": "Unsafe", "url": "javascript:alert(1)"},
		object{"type": "char_location", "title": "Local"},
	})
	want := []model.CitationSource{{Title: "Docs", URL: "https://docs.anthropic.com/en"}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("claudeCitations mismatch: got %#v, want %#v", got, want)
	}
}
