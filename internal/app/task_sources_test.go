package app

import (
	"slices"
	"testing"
	"time"

	"lever/internal/model"
	"lever/internal/plugin"
	"lever/internal/plugin/builtin"
	"lever/internal/store"
)

func TestLarkTaskSourceStoresExplicitScopeAcrossRestart(t *testing.T) {
	const (
		current = "00000000-0000-4000-8000-000000000001"
		daily   = "00000000-0000-4000-8000-000000000002"
		old     = "00000000000040008000000000000003"
		older   = "00000000000040008000000000000004"
	)
	dir := t.TempDir()
	db, err := store.Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	a := &App{Store: db, taskAdapters: builtin.TaskSourceAdapters()}
	t.Cleanup(func() { a.Store.Close() })
	ctx := t.Context()
	if err := a.initPlugins(ctx); err != nil {
		t.Fatal(err)
	}
	create := model.TaskSourceCreate{PluginID: "lever.lark-todos", ContributionID: "lark-todos", Target: "account"}
	if _, err := a.AddTaskSource(ctx, create); err == nil {
		t.Fatal("created a source without choosing groups")
	}
	create.LarkScope = &model.LarkTaskScope{SectionIDs: []string{current}}
	if _, err := a.AddTaskSource(ctx, create); err == nil {
		t.Fatal("missing item selection implicitly accepted every existing task")
	}
	create.Target = ""
	create.LarkScope.ExcludedTaskIDs = []string{}
	if _, err := a.AddTaskSource(ctx, create); err == nil {
		t.Fatal("created a subscription without the previewed account")
	}
	if _, err := db.DB.Exec(`INSERT INTO task_sources(id,plugin_id,contribution_id,target_id,name)
VALUES('legacy','lever.lark-todos','lark-todos','account','Tasks')`); err != nil {
		t.Fatal(err)
	}
	source, err := taskSource(ctx, db.DB, "legacy")
	if err != nil || source.LarkScope == nil || !source.LarkScope.AllAssigned ||
		len(source.LarkScope.SectionIDs) != 0 || source.LarkScope.Filters != nil {
		t.Fatalf("legacy all-groups scope changed: %+v, %v", source, err)
	}
	if err := a.UpdateTaskSource(ctx, "legacy", model.TaskSourceUpdate{LarkScope: &model.LarkTaskScope{}}); err == nil {
		t.Fatal("an empty edit silently subscribed to all groups")
	}
	if err := a.UpdateTaskSource(ctx, "legacy", model.TaskSourceUpdate{LarkScope: &model.LarkTaskScope{
		SectionIDs: []string{daily, current}, ExcludedTaskIDs: []string{older, old, older},
		Filters: &model.LarkTaskFilters{
			DueWindow:     model.LarkTaskDueWindowWeek,
			TitleIncludes: []string{" Report ", "report", "计划"},
			TitleExcludes: []string{"Draft"},
			SkipRecurring: true,
		},
	}}); err != nil {
		t.Fatal(err)
	}
	paused := false
	if err := a.UpdateTaskSource(ctx, "legacy", model.TaskSourceUpdate{Enabled: &paused}); err != nil {
		t.Fatal(err)
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	reopened, err := store.Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	a.Store = reopened
	source, err = taskSource(ctx, reopened.DB, "legacy")
	if err != nil || source.Enabled || source.LarkScope == nil || source.LarkScope.AllAssigned ||
		!slices.Equal(source.LarkScope.SectionIDs, []string{current, daily}) ||
		!slices.Equal(source.LarkScope.ExcludedTaskIDs, []string{old, older}) {
		t.Fatalf("scope did not survive pause and restart: %+v, %v", source.LarkScope, err)
	}
	filters := source.LarkScope.Filters
	if filters == nil || filters.DueWindow != model.LarkTaskDueWindowWeek || !filters.SkipRecurring ||
		!slices.Equal(filters.TitleIncludes, []string{"Report", "计划"}) || !slices.Equal(filters.TitleExcludes, []string{"Draft"}) {
		t.Fatalf("filters did not survive restart: %+v", filters)
	}
	blank, custom := " ", "  Work todos "
	if err := a.UpdateTaskSource(ctx, "legacy", model.TaskSourceUpdate{Name: &blank}); err == nil {
		t.Fatal("renamed a source to an empty name")
	}
	if err := a.UpdateTaskSource(ctx, "legacy", model.TaskSourceUpdate{Name: &custom}); err != nil {
		t.Fatal(err)
	}
	if err := a.saveTaskSync(ctx, "legacy", plugin.TaskSourceBatch{VisibleIDs: []string{}}, "", time.Now()); err != nil {
		t.Fatal(err)
	}
	source, err = taskSource(ctx, reopened.DB, "legacy")
	if err != nil || source.Name != "Work todos" || source.Enabled {
		t.Fatalf("rename was not kept across a pull or changed sync state: %+v, %v", source, err)
	}
	all := model.LarkTaskScope{AllAssigned: true, SectionIDs: []string{}, ExcludedTaskIDs: []string{old}}
	if err := a.UpdateTaskSource(ctx, "legacy", model.TaskSourceUpdate{LarkScope: &all}); err != nil {
		t.Fatal(err)
	}
	source, err = taskSource(ctx, reopened.DB, "legacy")
	if err != nil || source.LarkScope == nil || !source.LarkScope.AllAssigned ||
		!slices.Equal(source.LarkScope.ExcludedTaskIDs, []string{old}) || source.LarkScope.Filters != nil {
		t.Fatalf("explicit all-assigned scope did not replace the previous rules: %+v, %v", source.LarkScope, err)
	}
}

func TestTaskSourceVisibilityReconcilesCachedRowsAfterSuccessfulPull(t *testing.T) {
	db, err := store.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	a := &App{Store: db}
	ctx := t.Context()
	if err := a.initPlugins(ctx); err != nil {
		t.Fatal(err)
	}
	// A source saved before group filters has no selection or per-item visibility.
	if _, err := db.DB.Exec(`INSERT INTO task_sources(id,plugin_id,contribution_id,target_id,name)
VALUES('source','lever.lark-todos','lark-todos','account','Tasks')`); err != nil {
		t.Fatal(err)
	}
	items := []plugin.TaskSourceItem{}
	for _, id := range []string{"daily", "old", "local"} {
		items = append(items, plugin.TaskSourceItem{TaskSourceRef: plugin.TaskSourceRef{ExternalID: id},
			Kind: "todo", State: "open", Title: id})
	}
	save := func(visible []string, failure string) {
		t.Helper()
		err := a.saveTaskSync(ctx, "source", plugin.TaskSourceBatch{Name: "Tasks", Items: items, VisibleIDs: visible}, failure, time.Now())
		if err != nil {
			t.Fatal(err)
		}
	}
	read := func() []model.ExternalTask {
		t.Helper()
		rows, err := a.ExternalTasks(ctx)
		if err != nil {
			t.Fatal(err)
		}
		return rows
	}
	save(nil, "")
	all := read()
	if len(all) != 3 || all[0].Title != "local" {
		t.Fatalf("unexpected initial tasks: %+v", all)
	}
	if err := a.SetExternalTaskDone(ctx, all[0].ID, true); err != nil {
		t.Fatal(err)
	}
	all[0].Done = true
	items = nil // Already cached items can enter or leave the visible set.
	save([]string{"daily"}, "")
	if got := read(); !slices.Equal(got, []model.ExternalTask{all[0], all[2]}) {
		t.Fatalf("narrowing lost local work or kept an unselected task: %+v", got)
	}
	save([]string{}, "response")
	if got := read(); len(got) != 2 {
		t.Fatalf("failed pull changed the visible snapshot: %+v", got)
	}
	save([]string{}, "")
	if got := read(); !slices.Equal(got, all[:1]) {
		t.Fatalf("empty selection failed to retire old tasks: %+v", got)
	}
	save([]string{"old", "local", "daily"}, "")
	if got := read(); !slices.Equal(got, all) {
		t.Fatalf("restoring groups changed local IDs or completion: %+v", got)
	}
}
