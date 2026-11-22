package app

import (
	"regexp"
	"strings"
	"unicode/utf8"

	"github.com/yuin/goldmark"
	"github.com/yuin/goldmark/ast"
	"github.com/yuin/goldmark/extension"
	"github.com/yuin/goldmark/text"

	"lever/internal/model"
)

var automationMarkdown = goldmark.New(goldmark.WithExtensions(extension.Linkify))
var githubPullURL = regexp.MustCompile(`^https://github\.com/([A-Za-z0-9-]+/[A-Za-z0-9_.-]+)/pull/([1-9][0-9]*)(?:[/#?].*)?$`)

func excerpt(value string, limit int) string {
	value = strings.Join(strings.Fields(value), " ")
	if utf8.RuneCountInString(value) <= limit {
		return value
	}
	return string([]rune(value)[:limit]) + "…"
}

func inlineText(node ast.Node, source []byte) string {
	var label strings.Builder
	_ = ast.Walk(node, func(child ast.Node, entering bool) (ast.WalkStatus, error) {
		if entering {
			switch part := child.(type) {
			case *ast.Text:
				label.Write(part.Segment.Value(source))
				if part.SoftLineBreak() || part.HardLineBreak() {
					label.WriteByte(' ')
				}
			case *ast.String:
				label.Write(part.Value)
			case *ast.AutoLink:
				label.Write(part.Label(source))
			}
		}
		return ast.WalkContinue, nil
	})
	return label.String()
}

func summarizeAutomationOutput(run *model.AutomationRun, result string) {
	if result == "" {
		return
	}
	if utf8.RuneCountInString(result) > 16384 {
		result = string([]rune(result)[:16384])
		if end := strings.LastIndexByte(result, '\n'); end >= 0 {
			result = result[:end]
		} else {
			run.Summary = excerpt(result, 260)
			return
		}
	}
	source := []byte(result)
	document := automationMarkdown.Parser().Parse(text.NewReader(source))
	for block := document.FirstChild(); block != nil; block = block.NextSibling() {
		switch block.Kind() {
		case ast.KindParagraph:
			if run.Summary == "" {
				run.Summary = excerpt(inlineText(block, source), 260)
			}
		case ast.KindList:
			for entry := block.FirstChild(); entry != nil && len(run.ReportItems) < 3; entry = entry.NextSibling() {
				if line := entry.FirstChild(); line != nil && (line.Kind() == ast.KindTextBlock || line.Kind() == ast.KindParagraph) {
					if label := excerpt(inlineText(line, source), 160); label != "" {
						run.ReportItems = append(run.ReportItems, label)
					}
				}
			}
		}
	}
	if run.Summary == "" {
		if len(run.ReportItems) > 0 {
			run.Summary = run.ReportItems[0]
		} else {
			run.Summary = excerpt(result, 260)
		}
	}
	_ = ast.Walk(document, func(node ast.Node, entering bool) (ast.WalkStatus, error) {
		if !entering {
			return ast.WalkContinue, nil
		}
		var href, label string
		switch link := node.(type) {
		case *ast.Link:
			href = string(link.Destination)
			label = excerpt(inlineText(link, source), 100)
		case *ast.AutoLink:
			href = string(link.URL(source))
		default:
			return ast.WalkContinue, nil
		}
		if match := githubPullURL.FindStringSubmatch(href); match != nil {
			for _, previous := range run.PullRequests {
				if strings.EqualFold(previous.Repository, match[1]) && previous.Number == match[2] {
					return ast.WalkContinue, nil
				}
			}
			if label == href {
				label = ""
			}
			run.PullRequests = append(run.PullRequests, model.AutomationPullRequest{Repository: match[1], Number: match[2], Label: label})
			if len(run.PullRequests) == 3 {
				return ast.WalkStop, nil
			}
		}
		return ast.WalkContinue, nil
	})
}

func automationChangeSummary(native *model.TurnPatch, changes []model.RunChanges) *model.AutomationChangeSummary {
	var summary model.AutomationChangeSummary
	add := func(files []model.DiffFile) {
		summary.Files += len(files)
		for _, file := range files {
			summary.Additions += file.Additions
			summary.Deletions += file.Deletions
		}
	}
	if native != nil {
		if native.Reported && native.Error == "" {
			add(native.Files)
		}
	} else {
		for _, change := range changes {
			if change.Error == "" {
				add(change.Files)
			}
		}
	}
	if summary.Files == 0 {
		return nil
	}
	return &summary
}
