package app

import (
	"bytes"
	"context"
	"regexp"
	"slices"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/yuin/goldmark"
	"github.com/yuin/goldmark/extension"
	"golang.org/x/net/html"

	"lever/internal/model"
)

var searchMarkdown = goldmark.New(goldmark.WithExtensions(extension.GFM))

// SearchMessages returns the newest matching turns with one snippet per turn.
// A Chat also covers the comparison replies shown in its timeline. A non-empty
// kind keeps only main, topic, or comparison conversations.
func (a *App) SearchMessages(ctx context.Context, query, agentID, chatID, kind string) ([]model.MessageMatch, error) {
	matches := []model.MessageMatch{}
	query = strings.TrimSpace(query)
	if query == "" {
		return matches, nil
	}
	if !utf8.ValidString(query) || utf8.RuneCountInString(query) > 256 {
		return nil, invalid("Search query must be valid UTF-8 and at most 256 characters")
	}
	match := regexp.MustCompile("(?i)" + regexp.QuoteMeta(query))
	statement := "SELECT r.data,s.kind FROM runs r JOIN sessions s ON s.id=r.session_id JOIN chats c ON c.id=r.chat_id WHERE " + contextRunFilter
	switch kind {
	case "":
	case "main":
		statement += " AND s.kind='main'"
	case "topic":
		statement += " AND s.kind='topic' AND json_type(s.data,'$.comparison') IS NULL"
	case "comparison":
		statement += " AND json_type(s.data,'$.comparison')='object'"
	default:
		return nil, invalid("Message kind must be main, topic, or comparison")
	}
	var args []any
	if agentID != "" {
		statement += " AND c.agent_id=?"
		args = append(args, agentID)
	}
	if chatID != "" {
		statement += " AND (r.chat_id=? OR json_extract(s.data,'$.comparison.chatId')=?)"
		args = append(args, chatID, chatID)
	}
	const limit = 40
	// Every comparison Topic starts with the same prompt. Show it once.
	prompts := map[string]bool{}
	err := walkContextRuns(ctx, a.Store.DB, statement+" ORDER BY r.position DESC", args, func(run model.Run, sessionKind string) (bool, error) {
		messages := contextMessages(run, sessionKind)
		for _, message := range slices.Backward(messages) {
			hit := match.FindStringIndex(message.Text)
			if hit == nil {
				continue
			}
			if run.ComparisonID != "" && message.Anchor.ItemID == "" {
				if prompts[run.ComparisonID] {
					break
				}
				prompts[run.ComparisonID] = true
			}
			start, end := messageSnippetBounds(message.Text, hit)
			snippet := message.Text[start:end]
			if start > 0 {
				snippet = "…" + snippet
			}
			if end < len(message.Text) {
				snippet += "…"
			}
			result := model.MessageMatch{
				ChatID: run.ChatID, RunID: run.ID, Text: snippet,
				Preview: markdownSearchPreview(message.Text, match),
			}
			if sessionKind == "topic" {
				result.TopicID = run.SessionID
			}
			matches = append(matches, result)
			break
		}
		return len(matches) < limit, nil
	})
	return matches, err
}

func messageSnippetBounds(text string, hit []int) (int, int) {
	return contextTextEnd(text, 0, max(0, hit[0]-80)), contextTextEnd(text, hit[1], 140)
}

// Parse the complete message so a clipped preview can start inside an emphasis
// span or link. Keep only inline formatting and text in a search result.
func markdownSearchPreview(source string, match *regexp.Regexp) []model.MessageMatchPart {
	var rendered bytes.Buffer
	if err := searchMarkdown.Convert([]byte(source), &rendered); err != nil {
		return nil
	}
	type span struct {
		start, end int
		tags       []string
	}
	var text strings.Builder
	var spans []span
	var tags []string
	var space bool
	appendText := func(value string) {
		start := text.Len()
		for _, char := range value {
			if unicode.IsSpace(char) {
				if text.Len() > 0 && !space {
					text.WriteByte(' ')
					space = true
				}
				continue
			}
			text.WriteRune(char)
			space = false
		}
		if text.Len() > start {
			spans = append(spans, span{start, text.Len(), slices.Clone(tags)})
		}
	}
	tokens := html.NewTokenizer(&rendered)
	for kind := tokens.Next(); kind != html.ErrorToken; kind = tokens.Next() {
		switch kind {
		case html.TextToken:
			appendText(string(tokens.Text()))
		case html.StartTagToken, html.EndTagToken, html.SelfClosingTagToken:
			token := tokens.Token()
			switch token.Data {
			case "strong", "em", "del", "code", "a":
				if kind == html.StartTagToken {
					tags = append(tags, token.Data)
				} else if kind == html.EndTagToken {
					tags = tags[:len(tags)-1]
				}
			case "br", "hr", "td", "th":
				appendText(" ")
			case "img":
				for _, attr := range token.Attr {
					if attr.Key == "alt" {
						appendText(attr.Val)
					}
				}
			}
		}
	}
	visible := strings.TrimSuffix(text.String(), " ")
	hit := match.FindStringIndex(visible)
	if hit == nil {
		// A literal search can also hit markup, such as a link destination.
		return nil
	}
	start, end := messageSnippetBounds(visible, hit)
	var parts []model.MessageMatchPart
	appendPart := func(from, to int, tags []string, highlight bool) {
		if from < to {
			parts = append(parts, model.MessageMatchPart{Text: visible[from:to], Tags: tags, Highlight: highlight})
		}
	}
	if start > 0 {
		parts = append(parts, model.MessageMatchPart{Text: "…"})
	}
	for _, span := range spans {
		from, to := max(start, span.start), min(end, span.end)
		appendPart(from, min(to, hit[0]), span.tags, false)
		appendPart(max(from, hit[0]), min(to, hit[1]), span.tags, true)
		appendPart(max(from, hit[1]), to, span.tags, false)
	}
	if end < len(visible) {
		parts = append(parts, model.MessageMatchPart{Text: "…"})
	}
	return parts
}
