package httpapi_test

import (
	"context"
	"io"
	"net/http"
	"slices"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"lever/internal/app"
	"lever/internal/model"
)

type githubFixture func(*http.Request) (*http.Response, error)

func (f githubFixture) RoundTrip(req *http.Request) (*http.Response, error) {
	return f(req)
}

func TestGitHubTaskSourceKeepsCursorAndChatAcrossFailedPages(t *testing.T) {
	// Feed the GitHub adapter realistic responses without reaching the network.
	t.Setenv("GH_TOKEN", "fixture")
	original := http.DefaultTransport
	t.Cleanup(func() { http.DefaultTransport = original })
	const updated = "2026-11-13T06:00:00Z"
	started, _ := time.Parse(time.RFC3339, updated)
	var stage atomic.Int32
	var incrementalSince atomic.Value
	openIssue := `{"node_id":"issue1","number":1,"updated_at":"` + updated + `","state":"open","title":"Issue one","body":"Original body"}`
	openPR := `{"node_id":"pr2","number":2,"updated_at":"` + updated + `","state":"open","title":"PR two","pull_request":{"merged_at":null}}`
	mergedPR := strings.Replace(strings.Replace(openPR, `"state":"open"`, `"state":"closed"`, 1), `"merged_at":null`, `"merged_at":"`+updated+`"`, 1)
	mergedPR = strings.Replace(mergedPR, "PR two", "PR two updated", 1)
	closedIssue := strings.Replace(openIssue, `"state":"open"`, `"state":"closed"`, 1)
	http.DefaultTransport = githubFixture(func(req *http.Request) (*http.Response, error) {
		if req.URL.Host != "api.github.com" {
			return original.RoundTrip(req)
		}
		phase := stage.Load()
		h := http.Header{"Date": {started.Add(time.Duration(phase) * time.Hour).Format(http.TimeFormat)}}
		status, body := 200, `{"id":12,"full_name":"example/project"}`
		switch req.URL.Path {
		case "/repos/example/project", "/repositories/12":
		case "/repositories/12/issues":
			q := req.URL.Query()
			if phase == 0 {
				body = "[]"
				if q.Get("state") == "open" {
					body = "[" + openIssue + "," + openPR + "]"
				}
			} else if phase == 1 && q.Get("page") == "2" {
				status, body = 502, "{}"
			} else {
				incrementalSince.Store(q.Get("since"))
				if phase == 1 {
					h.Set("Link", `<https://api.github.com/repositories/12/issues?page=2>; rel="next"`)
				}
				if phase < 3 {
					body = "[" + closedIssue + "," + mergedPR + "]"
				} else {
					body = "[" + openIssue + "]"
				}
			}
		default:
			t.Errorf("unexpected GitHub path %s", req.URL.Path)
			status, body = 404, "{}"
		}
		return &http.Response{StatusCode: status, Header: h, Body: io.NopCloser(strings.NewReader(body))}, nil
	})

	f := newFixture(t)
	agent := f.agent("codex")
	input := map[string]string{"pluginId": "lever.github", "contributionId": "github", "target": "example/project"}
	var source model.TaskSource
	f.request("POST", "/tasks/sources", input, 200, &source)
	f.request("POST", "/tasks/sources", input, 409, nil)
	awaitSource := func(failure string) model.TaskSource {
		t.Helper()
		for deadline := time.Now().Add(5 * time.Second); time.Now().Before(deadline); time.Sleep(25 * time.Millisecond) {
			var list []model.TaskSource
			f.request("GET", "/tasks/sources", nil, 200, &list)
			if len(list) == 1 && !list[0].SyncPending && list[0].LastSyncedAt != 0 && list[0].Error == failure {
				return list[0]
			}
		}
		t.Fatalf("sync did not settle with error %q", failure)
		return model.TaskSource{}
	}
	readTasks := func() []model.ExternalTask {
		t.Helper()
		var tasks []model.ExternalTask
		f.request("GET", "/tasks/external", nil, 200, &tasks)
		return tasks
	}
	first := awaitSource("")
	tasks := readTasks()
	if len(tasks) != 2 || tasks[0].Kind != "pr" || tasks[1].Kind != "issue" {
		t.Fatalf("expected both open items, got %#v", tasks)
	}
	pr := tasks[0]
	issue := readBoardMention(f, agent, "externalTask", tasks[1].ID)
	if issue.Body.State != "open" || !strings.Contains(issue.Body.Text, "Original body") {
		t.Fatal("referenced issue did not read its saved content", issue)
	}
	var run model.Run
	dispatch := model.ExternalTaskDispatch{CommandID: app.ID(), AgentID: agent.ID}
	dispatchPath := "/tasks/external/" + pr.ID + "/dispatch"
	f.request("POST", dispatchPath, dispatch, 200, &run)
	f.wait(run.ID, "completed")

	stage.Store(1)
	syncPath := "/tasks/sources/" + source.ID + "/sync"
	f.request("POST", syncPath, nil, 200, nil)
	if failed := awaitSource("response"); failed.LastSyncedAt != first.LastSyncedAt || !slices.Equal(readTasks(), tasks) {
		t.Fatal("failed pagination replaced the saved snapshot")
	}

	stage.Store(2)
	f.request("POST", syncPath, nil, 200, nil)
	awaitSource("")
	tasks = readTasks()
	if incrementalSince.Load() != "2026-11-13T05:59:00Z" ||
		len(tasks) != 2 || tasks[0].ID != pr.ID || tasks[0].State != "merged" || tasks[1].State != "closed" {
		t.Fatalf("retry did not reconcile the original records: %#v", tasks)
	}
	var executions []model.TaskExecution
	f.request("GET", "/tasks/executions", nil, 200, &executions)
	if len(executions) != 1 || executions[0].ChatID != run.ChatID || executions[0].Done {
		t.Fatalf("merge changed local progress or Chat: %#v", executions)
	}
	var replay model.Run
	f.request("POST", dispatchPath, dispatch, 200, &replay)
	if replay.ID != run.ID || replay.Input != "PR two\n\nhttps://github.com/example/project/pull/2" {
		t.Fatalf("retry did not return the original run and input: %#v", replay)
	}
	f.request("PUT", "/tasks/external/"+pr.ID, map[string]bool{"done": true}, 200, nil)

	stage.Store(3)
	f.request("POST", syncPath, nil, 200, nil)
	awaitSource("")
	tasks = readTasks()
	if len(tasks) != 2 || tasks[1].State != "open" || !tasks[0].Done || tasks[0].ID != pr.ID {
		t.Fatalf("reopening an issue changed task identity or local completion: %#v", tasks)
	}
	f.request("DELETE", "/tasks/sources/"+source.ID, nil, 200, nil)
	if tasks = readTasks(); len(tasks) != 1 || tasks[0].ID != pr.ID {
		t.Fatalf("untracking did not keep the task with local work: %#v", tasks)
	}
	var location model.TaskLocation
	f.request("GET", "/tasks/locate/"+pr.ID, nil, 200, &location)
	var restored model.TaskSource
	f.request("POST", "/tasks/sources", input, 200, &restored)
	if restored.ID != source.ID {
		t.Fatal("adding the repository again changed its identity")
	}
	awaitSource("")
	location = model.TaskLocation{Record: model.TaskRecordExternal}
	f.boardAction(pr.ID, location, "todo", 200)
	f.boardAction(pr.ID, location, "close", 200)
	f.boardAction(pr.ID, location, "delete", 200)
	f.request("POST", syncPath, nil, 200, nil)
	awaitSource("")
	f.request("GET", "/tasks/locate/"+pr.ID, nil, 404, nil)
	f.request("PUT", "/tasks/external/"+pr.ID, map[string]bool{"done": true}, 404, nil)
	var originalPR model.ExternalTask
	f.request("GET", "/tasks/external/"+pr.ID, nil, 200, &originalPR)
	if originalPR.Done || originalPR.State != "merged" {
		t.Fatalf("the board action changed the synced record: %+v", originalPR)
	}
}

func TestGitHubTaskSourceScopeReconcilesOpenTasksAndPreservesLocalWork(t *testing.T) {
	t.Setenv("GH_TOKEN", "fixture")
	original := http.DefaultTransport
	t.Cleanup(func() { http.DefaultTransport = original })
	started := time.Date(2026, time.November, 13, 6, 0, 0, 0, time.UTC)
	var stage atomic.Int32
	var expandedSince atomic.Value
	openIssue := `{"node_id":"issue1","number":1,"updated_at":"2026-11-12T23:00:00Z","state":"open","title":"Older issue"}`
	oldPR := `{"node_id":"pr2","number":2,"updated_at":"2026-11-12T23:00:00Z","state":"open","title":"Previously open PR","pull_request":{}}`
	openPR := `{"node_id":"pr3","number":3,"updated_at":"2026-11-12T23:00:00Z","state":"open","title":"PR with a Chat","pull_request":{}}`
	closedPR := strings.Replace(strings.Replace(oldPR, `"state":"open"`, `"state":"closed"`, 1), "2026-11-12T23:00:00Z", "2026-11-13T07:30:00Z", 1)
	http.DefaultTransport = githubFixture(func(req *http.Request) (*http.Response, error) {
		if req.URL.Host != "api.github.com" {
			return original.RoundTrip(req)
		}
		phase := stage.Load()
		header := http.Header{"Date": {started.Add(time.Duration(phase) * time.Hour).Format(http.TimeFormat)}}
		status, body := 200, `{"id":12,"full_name":"example/project"}`
		switch req.URL.Path {
		case "/repos/example/project", "/repositories/12":
		case "/repositories/12/issues":
			query := req.URL.Query()
			body = "[]"
			if query.Get("state") == "open" {
				body = "[" + openIssue + "," + openPR + "]"
				if phase < 2 {
					body = "[" + openIssue + "," + oldPR + "," + openPR + "]"
				}
			} else if phase == 1 {
				expandedSince.Store(query.Get("since"))
			}
		case "/repositories/12/issues/2":
			body = closedPR
		default:
			t.Errorf("unexpected GitHub path %s", req.URL.Path)
			status, body = 404, "{}"
		}
		return &http.Response{StatusCode: status, Header: header, Body: io.NopCloser(strings.NewReader(body))}, nil
	})

	f := newFixture(t)
	input := map[string]string{
		"pluginId": "lever.github", "contributionId": "github",
		"target": "example/project", "syncKind": "pr",
	}
	var source model.TaskSource
	f.request("POST", "/tasks/sources", input, 200, &source)
	path := "/tasks/sources/" + source.ID
	awaitSync := func(kind model.TaskSourceKind) {
		t.Helper()
		for deadline := time.Now().Add(5 * time.Second); time.Now().Before(deadline); time.Sleep(25 * time.Millisecond) {
			var sources []model.TaskSource
			f.request("GET", "/tasks/sources", nil, 200, &sources)
			if len(sources) == 1 && sources[0].SyncKind == kind && !sources[0].SyncPending && sources[0].LastSyncedAt != 0 && sources[0].Error == "" {
				return
			}
		}
		t.Fatalf("sync did not settle for %q", kind)
	}
	readTasks := func() map[string]model.ExternalTask {
		t.Helper()
		var tasks []model.ExternalTask
		f.request("GET", "/tasks/external", nil, 200, &tasks)
		byRef := make(map[string]model.ExternalTask, len(tasks))
		for _, task := range tasks {
			byRef[task.Reference] = task
		}
		return byRef
	}
	setKind := func(kind model.TaskSourceKind) {
		t.Helper()
		f.request("PUT", path, map[string]model.TaskSourceKind{"syncKind": kind}, 200, nil)
		awaitSync(kind)
	}
	awaitSync(model.TaskSourceKindPR)
	tasks := readTasks()
	pr, otherPR := tasks["#3"], tasks["#2"]
	var stored int
	if err := f.a.Store.DB.QueryRowContext(context.Background(),
		"SELECT count(*) FROM external_tasks WHERE source_id=?", source.ID).Scan(&stored); err != nil {
		t.Fatal(err)
	}
	if len(tasks) != 2 || stored != 2 || pr.Kind != "pr" || otherPR.Kind != "pr" {
		t.Fatalf("PR-only sync imported unexpected tasks: %#v (stored %d)", tasks, stored)
	}
	var run model.Run
	f.request("POST", "/tasks/external/"+pr.ID+"/dispatch", model.ExternalTaskDispatch{
		CommandID: app.ID(), AgentID: f.agent("codex").ID,
	}, 200, &run)
	f.wait(run.ID, "completed")
	f.request("PUT", "/tasks/external/"+pr.ID, map[string]bool{"done": true}, 200, nil)
	f.request("PUT", path, map[string]string{"syncKind": "other"}, 400, nil)

	stage.Store(1)
	setKind(model.TaskSourceKindBoth)
	tasks = readTasks()
	issue := tasks["#1"]
	if len(tasks) != 3 || issue.Kind != "issue" || tasks["#3"].ID != pr.ID ||
		expandedSince.Load() != "2026-11-13T05:59:00Z" {
		t.Fatalf("expanding scope lost the open snapshot or incremental cursor: %#v", tasks)
	}

	stage.Store(2)
	setKind(model.TaskSourceKindIssue)
	tasks = readTasks()
	if len(tasks) != 2 || tasks["#1"].ID != issue.ID || tasks["#3"].ID != pr.ID || !tasks["#3"].Done {
		t.Fatalf("narrowing scope should keep only the issue and the PR with local work: %#v", tasks)
	}
	var archivedPR model.ExternalTask
	f.request("GET", "/tasks/external/"+otherPR.ID, nil, 200, &archivedPR)
	if archivedPR.State != "open" {
		t.Fatalf("PR was updated outside the sync scope: %#v", archivedPR)
	}

	stage.Store(3)
	setKind(model.TaskSourceKindBoth)
	tasks = readTasks()
	if len(tasks) != 3 || tasks["#2"].ID != otherPR.ID || tasks["#2"].State != "closed" || tasks["#1"].ID != issue.ID {
		t.Fatalf("re-enabling PR sync did not reconcile the cached PR: %#v", tasks)
	}
	var executions []model.TaskExecution
	f.request("GET", "/tasks/executions", nil, 200, &executions)
	if len(executions) != 1 || executions[0].ChatID != run.ChatID || !executions[0].Done {
		t.Fatalf("scope changes lost the linked Chat or local completion: %#v", executions)
	}
}
