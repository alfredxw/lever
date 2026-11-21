package larktodos

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"strconv"
	"strings"
	"testing"
	"time"

	"lever/internal/device"
	"lever/internal/model"
	"lever/internal/plugin"
)

const fixtureAccount = `{"profile":"fixture","appId":"cli_fixture","brand":"feishu","identity":"user","available":true,"onBehalfOf":{"openId":"ou_owner","userName":"Owner"}}`

func TestPullReconcilesLarkTasks(t *testing.T) {
	source := taskSource{run: func(_ context.Context, args ...string) ([]byte, error) {
		if args[0] == "whoami" {
			return []byte(fixtureAccount), nil
		}
		if !slices.Contains(args, "--profile=fixture") {
			t.Fatalf("request did not select the verified CLI profile: %v", args)
		}
		if args[2] == "list" {
			if !slices.Contains(args, `{"completed":false,"page_size":100,"type":"my_tasks"}`) ||
				!slices.Contains(args, "--page-all") {
				t.Fatalf("expected a complete pending-task list: %v", args)
			}
			return []byte(`{"ok":true,"identity":"user","data":{"has_more":false,"items":[
				{"guid":"listed","task_id":"t123","summary":"Review change","description":"Details","url":"https://applink.feishu.cn/client/todo/detail?guid=listed"},
				{"guid":"listed","summary":"Duplicate"}]}}`), nil
		}
		const detail = `{"ok":true,"identity":"user","data":{"task":`
		switch args[slices.Index(args, "--params")+1] {
		case `{"task_guid":"completed"}`:
			return []byte(detail + `{"guid":"completed","summary":"Completed","status":"done"}}}`), nil
		case `{"task_guid":"signed"}`:
			return []byte(detail + `{"guid":"signed","summary":"Signed","status":"todo","assignee_related":[{"id":"ou_owner","completed_at":"123"}]}}}`), nil
		case `{"task_guid":"reassigned"}`:
			return []byte(detail + `{"guid":"reassigned","summary":"Reassigned","status":"todo"}}}`), nil
		case `{"task_guid":"removed"}`:
			return nil, &device.OutputError{Err: errors.New("exit status 1"), Stderr: `{"ok":false,"error":{"type":"api","code":1470404}}`}
		default:
			t.Fatalf("unexpected lark-cli call: %v", args)
			return nil, nil
		}
	}}
	ctx := context.Background()
	target, err := source.Resolve(ctx, "")
	if err != nil || target.ID != "feishu/cli_fixture/ou_owner" || target.Name != DefaultName {
		t.Fatalf("unexpected source account: %#v, %v", target, err)
	}
	batch, err := source.Pull(ctx, target, "", []plugin.TaskSourceRef{
		{ExternalID: "listed"}, {ExternalID: "completed"}, {ExternalID: "signed"},
		{ExternalID: "reassigned"}, {ExternalID: "removed"},
	})
	if err != nil {
		t.Fatal(err)
	}
	var states []string
	for _, item := range batch.Items {
		states = append(states, item.ExternalID+":"+item.State)
	}
	want := []string{"listed:open", "completed:completed", "signed:completed", "reassigned:unavailable", "removed:unavailable"}
	if !slices.Equal(states, want) || !slices.Equal(batch.VisibleIDs, []string{"listed"}) {
		t.Fatalf("unexpected task states %v or visibility %v", states, batch.VisibleIDs)
	}
	if item := batch.Items[0]; item.Kind != "todo" || item.Reference != "t123" ||
		item.Title != "Review change" || item.Body != "Details" || item.URL == "" {
		t.Fatalf("unexpected task projection: %#v", item)
	}
}

func TestLarkRulesFilterAllAssignmentsWithoutGroupPermission(t *testing.T) {
	now := time.Now()
	overdue := now.Add(-48 * time.Hour).UnixMilli()
	soon := now.Add(48 * time.Hour).UnixMilli()
	later := now.Add(20 * 24 * time.Hour).UnixMilli()
	var renamed bool
	source := taskSource{run: func(_ context.Context, args ...string) ([]byte, error) {
		if args[0] == "whoami" {
			return []byte(fixtureAccount), nil
		}
		if args[1] == "sections" {
			return nil, &device.OutputError{Err: errors.New("exit status 1"), Stderr: `{"ok":false,"error":{"type":"api","code":99991672}}`}
		}
		title := "Customer update"
		if renamed {
			title = "Customer report"
		}
		return fmt.Appendf(nil, `{"ok":true,"identity":"user","data":{"has_more":false,"items":[
			{"guid":"overdue","summary":"REPORT","due":{"timestamp":"%d"}},
			{"guid":"soon","summary":"Prepare report","due":{"timestamp":"%d"}},
			{"guid":"draft","summary":"Report draft","due":{"timestamp":"%d"}},
			{"guid":"repeat","summary":"Report","repeat_rule":"FREQ=DAILY","due":{"timestamp":"%d"}},
			{"guid":"later","summary":"Report","due":{"timestamp":"%d"}},
			{"guid":"undated","summary":"Report"},
			{"guid":"renamed","summary":"%s","due":{"timestamp":"%d"}},
			{"guid":"skipped","summary":"Report","due":{"timestamp":"%d"}}
		]}}`, overdue, soon, soon, soon, later, title, soon, soon), nil
	}}
	const id = "feishu/cli_fixture/ou_owner"
	preview, err := source.Preview(t.Context(), id)
	if err != nil || preview.SectionError != "larkSectionAuth" || preview.AsOf == 0 || len(preview.Tasks) != 8 ||
		preview.Tasks[1].DueAt != soon || !preview.Tasks[3].Recurring {
		t.Fatalf("missing assignment preview without group access: %+v, %v", preview, err)
	}
	filters := &model.LarkTaskFilters{
		DueWindow:     model.LarkTaskDueWindowWeek,
		TitleIncludes: []string{"report", "计划"},
		TitleExcludes: []string{"draft"},
		SkipRecurring: true,
	}
	target := plugin.TaskSourceTarget{ID: id, LarkScope: &model.LarkTaskScope{
		AllAssigned: true, ExcludedTaskIDs: []string{"skipped"}, Filters: filters,
	}}
	check := func(want ...string) {
		t.Helper()
		batch, err := source.Pull(t.Context(), target, "", nil)
		if err != nil || !slices.Equal(batch.VisibleIDs, want) || len(batch.Items) != len(want) {
			t.Fatalf("scope returned %+v, %v; want %v", batch, err, want)
		}
	}
	check("overdue", "soon")
	renamed = true
	check("overdue", "soon", "renamed")
	filters.DueWindow = model.LarkTaskDueWindowNone
	check("undated")
}

func TestLarkAllDayDueDateExpiresAtLocalDayEnd(t *testing.T) {
	date := time.Date(2026, time.November, 18, 0, 0, 0, 0, time.UTC)
	var item task
	item.Due.Timestamp = strconv.FormatInt(date.UnixMilli(), 10)
	item.Due.AllDay = true
	preview := item.preview()
	end := time.Date(2026, time.November, 19, 0, 0, 0, 0, time.Local)
	overdue := &model.LarkTaskFilters{DueWindow: model.LarkTaskDueWindowOverdue}
	if preview.DueDate != "2026-11-18" || preview.DueAt != end.UnixMilli()-1 ||
		matchesFilters(preview, overdue, end.Add(-time.Hour)) || !matchesFilters(preview, overdue, end) {
		t.Fatalf("incorrect all-day deadline: %+v", preview)
	}
}

func TestPullDiscardsPartialOrMismatchedLarkResults(t *testing.T) {
	for _, scenario := range []struct {
		name      string
		list      string
		switchAt  int
		wantError error
	}{
		{name: "partial pagination", list: `{"has_more":true,"items":[]}`, wantError: errResponse},
		{name: "missing items", list: `{"has_more":false}`, wantError: errResponse},
		{name: "account changed before pull", switchAt: 1, wantError: errAccount},
		{name: "account changed during pull", list: `{"has_more":false,"items":[{"guid":"pending"}]}`, switchAt: 2, wantError: errAccount},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			identities := 0
			source := taskSource{run: func(_ context.Context, args ...string) ([]byte, error) {
				if args[0] == "whoami" {
					identities++
					if identities == scenario.switchAt {
						return []byte(strings.Replace(fixtureAccount, "ou_owner", "ou_other", 1)), nil
					}
					return []byte(fixtureAccount), nil
				}
				if identities == 1 && scenario.switchAt == 1 {
					t.Fatal("queried tasks after the CLI account changed")
				}
				return []byte(`{"ok":true,"identity":"user","data":` + scenario.list + `}`), nil
			}}
			batch, err := source.Pull(context.Background(), plugin.TaskSourceTarget{ID: "feishu/cli_fixture/ou_owner"}, "", nil)
			if !errors.Is(err, scenario.wantError) || len(batch.Items) != 0 {
				t.Fatalf("expected an empty batch and %v, got %#v, %v", scenario.wantError, batch, err)
			}
		})
	}
}

func TestPullScopesPendingTasksToMySelectedSections(t *testing.T) {
	const targetID = "feishu/cli_fixture/ou_owner"
	target := plugin.TaskSourceTarget{ID: targetID, LarkScope: &model.LarkTaskScope{SectionIDs: []string{"daily", "long-term", "deleted"}}}
	var partial, previewing, newTask bool
	source := taskSource{run: func(_ context.Context, args ...string) ([]byte, error) {
		if args[0] == "whoami" {
			return []byte(fixtureAccount), nil
		}
		if !slices.Contains(args, "--profile=fixture") || !slices.Contains(args, "--page-all") {
			t.Fatalf("expected a complete list for the bound user: %v", args)
		}
		params := args[slices.Index(args, "--params")+1]
		var items string
		switch args[1] + "/" + args[2] {
		case "sections/list":
			items = `[{"guid":"default"},{"guid":"daily"},{"guid":"long-term"}]`
		case "sections/tasks":
			switch params {
			case `{"completed":false,"page_size":100,"section_guid":"default"}`:
				if !previewing {
					t.Fatal("sync read an unsubscribed group")
				}
				items = `[]`
			case `{"completed":false,"page_size":100,"section_guid":"daily"}`:
				items = `[{"guid":"one"},{"guid":"one"},{"guid":"signed"}]`
				if newTask {
					items = `[{"guid":"one"},{"guid":"new"}]`
				}
			case `{"completed":false,"page_size":100,"section_guid":"long-term"}`:
				if partial {
					return []byte(`{"ok":true,"identity":"user","data":{"has_more":true,"items":[]}}`), nil
				}
				items = `[{"guid":"two"},{"guid":"one"},{"guid":"no-longer-assigned"}]`
			default:
				t.Fatalf("read an unselected or deleted group: %s", params)
			}
		case "tasks/list":
			items = `[{"guid":"one","summary":"Details from full task","task_id":"t1","updated_at":"1670000000000","url":"https://applink.feishu.cn/task/one"},
				{"guid":"two"},{"guid":"old"},{"guid":"signed","assignee_related":[{"id":"ou_owner","completed_at":"12"}]}]`
			if newTask {
				items = `[{"guid":"one","summary":"Renamed old task"},{"guid":"two"},{"guid":"new"}]`
			}
		default:
			t.Fatalf("unexpected call: %v", args)
		}
		return []byte(`{"ok":true,"identity":"user","data":{"has_more":false,"items":` + items + `}}`), nil
	}}
	previewing = true
	preview, err := source.Preview(t.Context(), targetID)
	if err != nil || preview.Target != targetID || preview.Name != "Owner" || len(preview.Sections) != 3 ||
		preview.Sections[0].Tasks == nil || len(preview.Sections[0].Tasks) != 0 || len(preview.Sections[1].Tasks) != 1 ||
		len(preview.Sections[2].Tasks) != 2 || preview.Sections[1].Tasks[0] != (model.LarkPreviewTask{GUID: "one", Title: "Details from full task", URL: "https://applink.feishu.cn/task/one", UpdatedAt: 1670000000000}) {
		t.Fatalf("preview disagrees with pending assignments: %+v, %v", preview, err)
	}
	previewing = false
	open := []plugin.TaskSourceRef{{ExternalID: "old"}, {ExternalID: "signed"}}
	batch, err := source.Pull(t.Context(), target, "", open)
	if err != nil || !slices.Equal(batch.VisibleIDs, []string{"one", "two"}) ||
		len(batch.Items) != 3 || batch.Items[0].Reference != "t1" || batch.Items[2].State != "completed" {
		t.Fatalf("incorrect filtered snapshot: %+v, %v", batch, err)
	}
	partial = true
	batch, err = source.Pull(t.Context(), target, "", open)
	if !errors.Is(err, errResponse) || batch.VisibleIDs != nil || len(batch.Items) != 0 {
		t.Fatalf("accepted an incomplete group: %+v, %v", batch, err)
	}
	target.LarkScope.SectionIDs = []string{"deleted"}
	batch, err = source.Pull(t.Context(), target, "", open)
	if err != nil || batch.VisibleIDs == nil || len(batch.VisibleIDs) != 0 ||
		len(batch.Items) != 1 || batch.Items[0].ExternalID != "signed" || batch.Items[0].State != "completed" {
		t.Fatalf("deleted group widened the selection: %+v, %v", batch, err)
	}
	partial, newTask = false, true
	target.LarkScope = &model.LarkTaskScope{SectionIDs: []string{"daily", "long-term"}, ExcludedTaskIDs: []string{"one", "two", "gone"}}
	batch, err = source.Pull(t.Context(), target, "", []plugin.TaskSourceRef{{ExternalID: "gone"}})
	if err != nil || !slices.Equal(batch.VisibleIDs, []string{"new"}) || len(batch.Items) != 1 {
		t.Fatalf("skipped tasks reappeared or new assignment missing: %+v, %v", batch, err)
	}
}
