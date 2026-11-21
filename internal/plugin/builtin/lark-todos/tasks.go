package larktodos

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"os/exec"
	"slices"
	"strconv"
	"strings"
	"time"

	"lever/internal/device"
	"lever/internal/model"
	"lever/internal/plugin"
)

const (
	PluginID       = "lever.lark-todos"
	ContributionID = "lark-todos"
	// DefaultName labels a new source. Users can rename it, so pulls keep the saved name.
	DefaultName = "Lark Todos"
)

type taskSource struct {
	run func(context.Context, ...string) ([]byte, error)
}

func NewTaskSource() taskSource {
	return taskSource{run: func(ctx context.Context, args ...string) ([]byte, error) {
		return device.OutputEnv(ctx, "lark-cli", []string{
			"LARKSUITE_CLI_NO_UPDATE_NOTIFIER=1",
			"LARKSUITE_CLI_NO_SKILLS_NOTIFIER=1",
		}, args...)
	}}
}

type account struct {
	Profile    string
	AppID      string
	Brand      string
	Identity   string
	Available  bool
	OnBehalfOf struct {
		OpenID   string
		UserName string
	}
}

func (a account) id() string {
	return a.Brand + "/" + a.AppID + "/" + a.OnBehalfOf.OpenID
}

func (a account) name() string {
	if name := strings.TrimSpace(a.OnBehalfOf.UserName); name != "" {
		return name
	}
	return DefaultName
}

type task struct {
	GUID        string `json:"guid"`
	Reference   string `json:"task_id"`
	Summary     string `json:"summary"`
	Description string `json:"description"`
	URL         string `json:"url"`
	Status      string `json:"status"`
	CompletedAt string `json:"completed_at"`
	UpdatedAt   string `json:"updated_at"`
	RepeatRule  string `json:"repeat_rule"`
	Due         struct {
		Timestamp string `json:"timestamp"`
		AllDay    bool   `json:"is_all_day"`
	} `json:"due"`
	Assignees []struct {
		ID          string `json:"id"`
		CompletedAt string `json:"completed_at"`
	} `json:"assignee_related"`
}

func (t task) title() string {
	if title := strings.TrimSpace(t.Summary); title != "" {
		return title
	}
	return "Lark Todo"
}

func (t task) item(state string) plugin.TaskSourceItem {
	return plugin.TaskSourceItem{
		TaskSourceRef: plugin.TaskSourceRef{ExternalID: t.GUID, Reference: t.Reference},
		Kind:          "todo", State: state, Title: t.title(), URL: t.URL, Body: t.Description,
	}
}

func (t task) preview() model.LarkPreviewTask {
	updated, _ := strconv.ParseInt(t.UpdatedAt, 10, 64)
	due, _ := strconv.ParseInt(t.Due.Timestamp, 10, 64)
	item := model.LarkPreviewTask{
		GUID: t.GUID, Title: t.title(), URL: t.URL, UpdatedAt: updated, Recurring: t.RepeatRule != "",
	}
	if due > 0 {
		item.DueAt = due
		if t.Due.AllDay {
			// Lark encodes a calendar date at midnight UTC regardless of display timezone.
			date := time.UnixMilli(due).UTC()
			item.DueDate = date.Format(time.DateOnly)
			item.DueAt = time.Date(date.Year(), date.Month(), date.Day()+1, 0, 0, 0, 0, time.Local).UnixMilli() - 1
		}
	}
	return item
}

func matchesFilters(t model.LarkPreviewTask, filters *model.LarkTaskFilters, now time.Time) bool {
	if filters.SkipRecurring && t.Recurring {
		return false
	}
	switch filters.DueWindow {
	case model.LarkTaskDueWindowOverdue:
		if t.DueAt == 0 || t.DueAt >= now.UnixMilli() {
			return false
		}
	case model.LarkTaskDueWindowWeek:
		if t.DueAt == 0 || t.DueAt > now.Add(7*24*time.Hour).UnixMilli() {
			return false
		}
	case model.LarkTaskDueWindowNone:
		if t.DueAt != 0 {
			return false
		}
	}
	title := strings.ToLower(t.Title)
	contains := func(term string) bool { return strings.Contains(title, strings.ToLower(term)) }
	return (len(filters.TitleIncludes) == 0 || slices.ContainsFunc(filters.TitleIncludes, contains)) &&
		!slices.ContainsFunc(filters.TitleExcludes, contains)
}

func (t task) completedBy(openID string) bool {
	if t.Status == "done" || (t.CompletedAt != "" && t.CompletedAt != "0") {
		return true
	}
	for _, assignee := range t.Assignees {
		if assignee.ID == openID && assignee.CompletedAt != "" && assignee.CompletedAt != "0" {
			return true
		}
	}
	return false
}

type cliResponse struct {
	OK       bool
	Identity string
	Data     json.RawMessage
	Error    struct {
		Type string
		Code int
	}
}

var (
	errTaskUnavailable = errors.New("Lark task is unavailable")
	errCLI             = &plugin.TaskSourceError{Status: http.StatusPreconditionFailed, Code: "larkCLI", Message: "Install the official lark-cli to add Lark Todos"}
	errAuth            = &plugin.TaskSourceError{Status: http.StatusPreconditionFailed, Code: "larkAuth", Message: "Sign in with lark-cli and grant task:task:read"}
	errSectionAuth     = &plugin.TaskSourceError{Status: http.StatusPreconditionFailed, Code: "larkSectionAuth", Message: "Grant task:section:read to filter Lark Todos by group"}
	errAccount         = &plugin.TaskSourceError{Status: http.StatusConflict, Code: "larkAccount", Message: "Switch lark-cli back to the account bound to this source"}
	errResponse        = &plugin.TaskSourceError{Status: http.StatusBadGateway, Code: "response", Message: "Could not read the Lark API response"}
	errOffline         = &plugin.TaskSourceError{Status: http.StatusBadGateway, Code: "offline", Message: "Could not connect to Lark"}
	errRateLimit       = &plugin.TaskSourceError{Status: http.StatusTooManyRequests, Code: "rateLimit", Message: "Lark rate limited this source. Try again later."}
)

func (s taskSource) command(ctx context.Context, args ...string) ([]byte, error) {
	out, err := s.run(ctx, args...)
	if err == nil {
		return out, nil
	}
	if errors.Is(err, exec.ErrNotFound) {
		return nil, errCLI
	}
	if ctx.Err() != nil {
		return nil, errOffline
	}
	var failure *device.OutputError
	var response cliResponse
	if !errors.As(err, &failure) || json.Unmarshal([]byte(failure.Stderr), &response) != nil {
		return nil, errResponse
	}
	switch response.Error.Code {
	case 1470403, 1470404:
		return nil, errTaskUnavailable
	case 99991668, 99991672:
		return nil, errAuth
	case 99991400:
		return nil, errRateLimit
	}
	switch response.Error.Type {
	case "auth", "permission", "config":
		return nil, errAuth
	case "network":
		return nil, errOffline
	}
	return nil, errResponse
}

func (s taskSource) account(ctx context.Context, targetID string) (account, error) {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	var a account
	out, err := s.command(ctx, "whoami", "--as", "user")
	if err != nil {
		return a, err
	}
	if json.Unmarshal(out, &a) != nil {
		return a, errResponse
	}
	if a.Identity != "user" || !a.Available || a.Brand == "" || a.AppID == "" || a.OnBehalfOf.OpenID == "" {
		return a, errAuth
	}
	if targetID != "" && a.id() != targetID {
		return a, errAccount
	}
	return a, nil
}

func (s taskSource) api(ctx context.Context, a account, resource, method string, params map[string]any, into any, options ...string) error {
	encoded, err := json.Marshal(params)
	if err != nil {
		return err
	}
	args := []string{"task", resource, method, "--as", "user", "--format", "json", "--params", string(encoded)}
	if a.Profile != "" {
		args = append(args, "--profile="+a.Profile)
	}
	args = append(args, options...)
	out, err := s.command(ctx, args...)
	if err != nil {
		if resource == "sections" && errors.Is(err, errAuth) {
			return errSectionAuth
		}
		return err
	}
	var response cliResponse
	if json.Unmarshal(out, &response) != nil || !response.OK || response.Identity != "user" ||
		len(response.Data) == 0 || string(response.Data) == "null" || json.Unmarshal(response.Data, into) != nil {
		return errResponse
	}
	return nil
}

func listAll[T any](ctx context.Context, s taskSource, a account, resource, method string, params map[string]any) ([]T, error) {
	var list struct {
		HasMore *bool `json:"has_more"`
		Items   []T   `json:"items"`
	}
	params["page_size"] = 100
	if err := s.api(ctx, a, resource, method, params, &list, "--page-all", "--page-limit", "0"); err != nil {
		return nil, err
	}
	if list.HasMore == nil || *list.HasMore || list.Items == nil {
		return nil, errResponse
	}
	return list.Items, nil
}

type assignedTasks struct {
	byID    map[string]task
	pending []task
}

func (s taskSource) assigned(ctx context.Context, a account) (assignedTasks, error) {
	tasks, err := listAll[task](ctx, s, a, "tasks", "list", map[string]any{"type": "my_tasks", "completed": false})
	if err != nil {
		return assignedTasks{}, err
	}
	list := assignedTasks{byID: make(map[string]task, len(tasks))}
	for _, t := range tasks {
		if t.GUID == "" {
			return assignedTasks{}, errResponse
		}
		if _, exists := list.byID[t.GUID]; exists {
			continue
		}
		list.byID[t.GUID] = t
		if !t.completedBy(a.OnBehalfOf.OpenID) {
			list.pending = append(list.pending, t)
		}
	}
	return list, nil
}

// Intersect personal section membership with the account's pending assignments.
// Preview reads every section. A pull requests only the subscribed sections.
func (s taskSource) pendingSections(ctx context.Context, a account, ids []string, pending []task) ([]model.LarkTaskSection, error) {
	sections, err := listAll[model.LarkTaskSection](ctx, s, a, "sections", "list", map[string]any{"resource_type": "my_tasks"})
	if err != nil {
		return nil, err
	}
	byID := make(map[string]task, len(pending))
	for _, t := range pending {
		byID[t.GUID] = t
	}
	result := make([]model.LarkTaskSection, 0, len(sections))
	for _, section := range sections {
		if section.GUID == "" {
			return nil, errResponse
		}
		if len(ids) > 0 && !slices.Contains(ids, section.GUID) {
			continue
		}
		items, err := listAll[struct{ GUID string }](ctx, s, a, "sections", "tasks", map[string]any{"section_guid": section.GUID, "completed": false})
		if err != nil {
			return nil, err
		}
		section.Tasks = []model.LarkPreviewTask{}
		seen := make(map[string]bool, len(items))
		for _, item := range items {
			if item.GUID == "" {
				return nil, errResponse
			}
			t, ok := byID[item.GUID]
			if !ok || seen[item.GUID] {
				continue
			}
			seen[item.GUID] = true
			section.Tasks = append(section.Tasks, t.preview())
		}
		result = append(result, section)
	}
	return result, nil
}

func (s taskSource) Preview(ctx context.Context, targetID string) (*model.LarkTaskPreview, error) {
	ctx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()
	a, err := s.account(ctx, targetID)
	if err != nil {
		return nil, err
	}
	list, err := s.assigned(ctx, a)
	if err != nil {
		return nil, err
	}
	sections, err := s.pendingSections(ctx, a, nil, list.pending)
	var sectionError string
	if err != nil {
		if ctx.Err() != nil {
			return nil, err
		}
		sectionError = "response"
		var failure *plugin.TaskSourceError
		if errors.As(err, &failure) {
			sectionError = failure.Code
		}
		sections = []model.LarkTaskSection{}
	}
	if _, err := s.account(ctx, a.id()); err != nil {
		return nil, err
	}
	tasks := make([]model.LarkPreviewTask, 0, len(list.pending))
	for _, t := range list.pending {
		tasks = append(tasks, t.preview())
	}
	return &model.LarkTaskPreview{
		Target: a.id(), Name: a.name(), AsOf: time.Now().UnixMilli(),
		Tasks: tasks, Sections: sections, SectionError: sectionError,
	}, nil
}

func (s taskSource) Resolve(ctx context.Context, targetID string) (plugin.TaskSourceTarget, error) {
	a, err := s.account(ctx, targetID)
	if err != nil {
		return plugin.TaskSourceTarget{}, err
	}
	return plugin.TaskSourceTarget{ID: a.id(), Name: DefaultName}, nil
}

func (s taskSource) Pull(ctx context.Context, target plugin.TaskSourceTarget, _ string, open []plugin.TaskSourceRef) (plugin.TaskSourceBatch, error) {
	if target.ID == "" {
		return plugin.TaskSourceBatch{}, errAccount
	}
	a, err := s.account(ctx, target.ID)
	if err != nil {
		return plugin.TaskSourceBatch{}, err
	}
	list, err := s.assigned(ctx, a)
	if err != nil {
		return plugin.TaskSourceBatch{}, err
	}
	var selected map[string]bool
	var excluded map[string]bool
	var filters *model.LarkTaskFilters
	if scope := target.LarkScope; scope != nil {
		if len(scope.SectionIDs) > 0 {
			sections, err := s.pendingSections(ctx, a, scope.SectionIDs, list.pending)
			if err != nil {
				return plugin.TaskSourceBatch{}, err
			}
			selected = make(map[string]bool)
			for _, section := range sections {
				for _, t := range section.Tasks {
					selected[t.GUID] = true
				}
			}
		}
		excluded = make(map[string]bool, len(scope.ExcludedTaskIDs))
		for _, id := range scope.ExcludedTaskIDs {
			excluded[id] = true
		}
		filters = scope.Filters
	}

	batch := plugin.TaskSourceBatch{VisibleIDs: []string{}}
	now := time.Now()
	for _, t := range list.pending {
		if (selected != nil && !selected[t.GUID]) || excluded[t.GUID] ||
			(filters != nil && !matchesFilters(t.preview(), filters, now)) {
			continue
		}
		batch.Items = append(batch.Items, t.item("open"))
		batch.VisibleIDs = append(batch.VisibleIDs, t.GUID)
	}
	for _, ref := range open {
		if excluded[ref.ExternalID] {
			continue
		}
		if t, ok := list.byID[ref.ExternalID]; ok {
			if t.completedBy(a.OnBehalfOf.OpenID) {
				batch.Items = append(batch.Items, t.item("completed"))
			}
			continue
		}
		var detail struct{ Task task }
		err := s.api(ctx, a, "tasks", "get", map[string]any{"task_guid": ref.ExternalID}, &detail)
		if err != nil && !errors.Is(err, errTaskUnavailable) {
			return plugin.TaskSourceBatch{}, err
		}
		if err == nil {
			if detail.Task.GUID != ref.ExternalID {
				return plugin.TaskSourceBatch{}, errResponse
			}
			if detail.Task.completedBy(a.OnBehalfOf.OpenID) {
				batch.Items = append(batch.Items, detail.Task.item("completed"))
				continue
			}
		}
		batch.Items = append(batch.Items, plugin.TaskSourceItem{TaskSourceRef: ref, State: "unavailable"})
	}

	// Each CLI invocation resolves its own user. Discard the whole pull if
	// the CLI account changed while we listed tasks or looked up details.
	if _, err := s.account(ctx, a.id()); err != nil {
		return plugin.TaskSourceBatch{}, err
	}
	return batch, nil
}
