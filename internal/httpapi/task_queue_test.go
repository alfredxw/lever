package httpapi_test

import (
	"context"
	"net/http"
	"testing"
	"testing/fstest"
	"time"

	"lever/internal/app"
	"lever/internal/httpapi"
	"lever/internal/model"
)

func (f *fixture) taskWorkflow(id string) model.TaskWorkflow {
	f.t.Helper()
	var items []model.TaskWorkflow
	f.request("GET", "/tasks/workflows", nil, 200, &items)
	for _, item := range items {
		if item.TaskID == id {
			return item
		}
	}
	return model.TaskWorkflow{}
}

func (f *fixture) queuedWorkItem(agent model.Agent, title, body string) model.TaskQueueInput {
	f.t.Helper()
	item, err := f.a.CreateWorkItem(context.Background(), agent.ID, nil, model.WorkItemInput{Title: title, Body: body})
	if err != nil {
		f.t.Fatal(err)
	}
	return model.TaskQueueInput{
		Record: model.TaskRecordWorkItem,
		TaskDispatch: model.TaskDispatch{
			TaskID: item.ID, AgentID: agent.ID, CommandID: app.ID(),
		},
	}
}

func (f *fixture) waitForTask(id, status string) model.TaskExecution {
	f.t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		var executions []model.TaskExecution
		f.request("GET", "/tasks/executions", nil, 200, &executions)
		for _, run := range executions {
			if run.TaskID == id && run.Status == status {
				return run
			}
		}
		time.Sleep(20 * time.Millisecond)
	}
	f.t.Fatalf("task %s did not reach %s", id, status)
	return model.TaskExecution{}
}

func TestAgentTaskQueueTriageAndOrder(t *testing.T) {
	f := newFixture(t)
	agent := f.agent("codex")
	first := f.queuedWorkItem(agent, "First", "[approval]")
	second := f.queuedWorkItem(agent, "Second", "[approval]")
	third := f.queuedWorkItem(agent, "Third", "[approval]")
	dropped := f.queuedWorkItem(agent, "Withdraw", "")
	change := func(item model.TaskQueueInput, action string, code int) {
		f.request("PATCH", "/tasks/workflows/"+item.TaskID, model.TaskWorkflowUpdate{
			TaskLocation: model.TaskLocation{Record: item.Record}, Action: action, QueueID: item.CommandID,
		}, code, nil)
	}
	enqueue := func(item model.TaskQueueInput, code int) {
		f.request("POST", "/tasks/queue", item, code, nil)
	}

	change(second, "close", 200)
	if item := f.taskWorkflow(second.TaskID); !item.Closed || item.Accepted {
		t.Fatalf("closed proposal: %+v", item)
	}
	enqueue(second, 409)
	change(second, "reopen", 200)
	if item := f.taskWorkflow(second.TaskID); item.Closed || item.Accepted {
		t.Fatalf("reopened proposal: %+v", item)
	}
	change(second, "accept", 200)
	if item := f.taskWorkflow(second.TaskID); !item.Accepted || item.Queue != nil {
		t.Fatalf("accept should leave item in to-do: %+v", item)
	}

	enqueue(first, 200)
	f.waitForTask(first.TaskID, "waiting_user")
	for _, item := range []model.TaskQueueInput{second, third, dropped} {
		enqueue(item, 200)
	}
	enqueue(third, 200)
	duplicate := third
	duplicate.Note = "different input for the same command"
	enqueue(duplicate, 409)
	if item := f.taskWorkflow(third.TaskID); !item.Accepted || item.Queue == nil || item.Queue.Position != 2 {
		t.Fatalf("queue should accept and rank the proposal: %+v", item)
	}
	var overview model.Overview
	f.request("GET", "/overview", nil, 200, &overview)
	if len(overview.Chats) != 1 {
		t.Fatalf("queued tasks already have Chats: %+v", overview.Chats)
	}
	f.request("PUT", "/tasks/queue/order", map[string]any{
		"agentId": agent.ID, "ids": []string{third.CommandID, second.CommandID, dropped.CommandID},
	}, 200, nil)
	if item := f.taskWorkflow(third.TaskID); item.Queue == nil || item.Queue.Position != 1 {
		t.Fatalf("reordered task: %+v", item)
	}
	change(dropped, "withdraw", 200)
	enqueue(dropped, 200) // A late retry must not put a withdrawn task back in line.
	if item := f.taskWorkflow(dropped.TaskID); item.Queue != nil || !item.Accepted {
		t.Fatalf("withdraw should return the accepted item to to-do: %+v", item)
	}

	agent.Profile.TaskConcurrency = 2
	f.request("PUT", "/agents/"+agent.ID, agent, 200, &agent)
	f.waitForTask(third.TaskID, "waiting_user")
	if item := f.taskWorkflow(second.TaskID); item.Queue == nil || item.Queue.Position != 1 {
		t.Fatalf("third task should fill the second slot: %+v", item)
	}
	change(third, "withdraw", 409)
	f.request("POST", "/requests/"+overview.Requests[0].ID+"/answer", model.Answer{Allow: true}, 200, nil)
	f.waitForTask(first.TaskID, "completed")
	f.waitForTask(second.TaskID, "waiting_user")
}

func TestTaskQueueStartIntervalSurvivesRestart(t *testing.T) {
	f := newFixture(t)
	agent := f.agent("codex")
	agent.Profile.TaskConcurrency = 2
	agent.Profile.TaskStartIntervalMinutes = 1
	f.request("PUT", "/agents/"+agent.ID, agent, http.StatusOK, &agent)
	first := f.queuedWorkItem(agent, "Finish first", "")
	second := f.queuedWorkItem(agent, "Run after the interval", "")
	f.request("POST", "/tasks/queue", first, 200, nil)
	firstRun := f.waitForTask(first.TaskID, "completed")
	f.request("POST", "/tasks/queue", second, 200, nil)
	dataDir := f.a.Store.Dir
	_ = f.s.HTTP.Close()
	if err := f.a.Close(); err != nil {
		t.Fatal(err)
	}
	reopened, err := app.Open(dataDir)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { reopened.Close() })
	server, err := httpapi.New(reopened, "127.0.0.1:0", "", fstest.MapFS{"index.html": {Data: []byte("Lever")}})
	if err != nil {
		t.Fatal(err)
	}
	go server.Serve()
	t.Cleanup(func() { server.HTTP.Close() })
	next := &fixture{t: t, a: reopened, s: server, root: f.root}
	if item := next.taskWorkflow(second.TaskID); item.Queue == nil || item.Queue.Position != 1 {
		t.Fatalf("pending task and start interval must survive restart: %+v", item)
	}
	// Move the persisted start into the past to exercise the next tick without a minute-long test.
	if _, err := reopened.Store.DB.Exec("UPDATE task_queue SET started_at=? WHERE run_id=?", time.Now().Add(-time.Minute).UnixMilli(), firstRun.RunID); err != nil {
		t.Fatal(err)
	}
	next.waitForTask(second.TaskID, "completed")
	var overview model.Overview
	next.request("GET", "/overview", nil, 200, &overview)
	if len(overview.Chats) != 2 {
		t.Fatalf("recovery created duplicate Chats: %+v", overview.Chats)
	}
}
