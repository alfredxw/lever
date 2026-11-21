package model

import "encoding/json"

type TaskNoteState string

const (
	TaskNoteActive   TaskNoteState = "active"
	TaskNoteArchived TaskNoteState = "archived"
	TaskNoteDeleted  TaskNoteState = "deleted"
)

type TaskNote struct {
	ID        string          `json:"id"`
	Title     string          `json:"title"`
	Project   string          `json:"project,omitempty"`
	State     TaskNoteState   `json:"state"`
	Version   string          `json:"version"`
	Path      string          `json:"path"`
	Directory string          `json:"directory,omitempty"`
	Content   json.RawMessage `json:"content" tstype:"unknown"`
}

type TaskNoteSummary struct {
	ID        string        `json:"id"`
	Title     string        `json:"title"`
	State     TaskNoteState `json:"state"`
	Directory string        `json:"directory,omitempty"`
	Conflict  string        `json:"conflict,omitempty"`
}

type NoteHandover struct {
	AgentID  string `json:"agentId,omitempty"`
	ChatID   string `json:"chatId,omitempty"`
	OneClick bool   `json:"oneClick,omitempty"`
}

type TaskNotesDirectory struct {
	Path string `json:"path"`
}

type TaskNotesDirectoryUpdate struct {
	CurrentPath string `json:"currentPath"`
	Path        string `json:"path"`
	NewFolder   string `json:"newFolder,omitempty"`
}

type TaskView struct {
	ID          string          `json:"id"`
	Name        string          `json:"name"`
	Group       string          `json:"group" tstype:"'status' | 'project' | 'agent'"`
	Filters     TaskViewFilters `json:"filters"`
	QuickFilter string          `json:"quickFilter,omitempty" tstype:"'agent' | 'kind' | 'status' | 'project' | 'none'"`
	Revision    int64           `json:"revision"`
}

type TaskViewFilters struct {
	Status  []string `json:"status,omitempty"`
	Project []string `json:"project,omitempty"`
	Agent   []string `json:"agent,omitempty"`
	Note    []string `json:"note,omitempty"`
	Source  []string `json:"source,omitempty"`
	Kind    []string `json:"kind,omitempty"`
	Remote  []string `json:"remote,omitempty"`
}

type TaskDispatch struct {
	TaskID        string `json:"taskId"`
	NoteID        string `json:"noteId,omitempty"`
	Version       string `json:"version,omitempty"`
	CommandID     string `json:"commandId"`
	AgentID       string `json:"agentId"`
	WorkingCopyID string `json:"workingCopyId,omitempty"`
	Title         string `json:"title"`
	Text          string `json:"text"`
	Note          string `json:"note,omitempty"`
}

type ExternalTaskDispatch struct {
	CommandID     string `json:"commandId"`
	AgentID       string `json:"agentId"`
	WorkingCopyID string `json:"workingCopyId,omitempty"`
	Note          string `json:"note,omitempty"`
}

type TaskQueueInput struct {
	TaskDispatch `tstype:",extends"`
	Record       TaskRecord `json:"record"`
}

type TaskQueueEntry struct {
	ID       string `json:"id"`
	AgentID  string `json:"agentId"`
	Position int    `json:"position,omitempty"`
	Error    string `json:"error,omitempty"`
}

type TaskWorkflow struct {
	TaskID   string          `json:"taskId"`
	Accepted bool            `json:"accepted"`
	Closed   bool            `json:"closed"`
	Queue    *TaskQueueEntry `json:"queue,omitempty"`
}

type TaskWorkflowUpdate struct {
	TaskLocation `tstype:",extends"`
	Action       string `json:"action" tstype:"'accept' | 'close' | 'reopen' | 'withdraw'"`
	QueueID      string `json:"queueId,omitempty"`
}

type TaskExecution struct {
	AutomationID string     `json:"automationId,omitempty"`
	Title        string     `json:"title,omitempty"`
	Topic        bool       `json:"topic,omitempty"`
	Record       TaskRecord `json:"record,omitempty"`
	TaskID       string     `json:"taskId"`
	NoteID       string     `json:"noteId,omitempty"`
	ChatID       string     `json:"chatId"`
	AgentID      string     `json:"agentId"`
	SessionID    string     `json:"sessionId"`
	RunID        string     `json:"runId"`
	Status       string     `json:"status"`
	DispatchedAt string     `json:"dispatchedAt,omitempty"`
	ActivityAt   string     `json:"activityAt,omitempty"` // Finish, start, or creation time of the selected run.
	Done         bool       `json:"done"`
}

type TaskLocation struct {
	Record TaskRecord `json:"record"`
	NoteID string     `json:"noteId,omitempty"`
}

// RunTask binds the completion capability to the item this turn was asked to deliver.
type RunTask struct {
	ID        string     `json:"id"`
	Record    TaskRecord `json:"record,omitempty"` // Task follow-ups resolve their source at execution.
	NoteID    string     `json:"noteId,omitempty"`
	Version   string     `json:"version,omitempty"`   // Version of the dispatched task's blocks.
	Directory string     `json:"directory,omitempty"` // Notes library at dispatch.
}

type TaskRecord string

const (
	TaskRecordNote       TaskRecord = "note"
	TaskRecordExternal   TaskRecord = "external"
	TaskRecordAutomation TaskRecord = "automation"
	TaskRecordWorkItem   TaskRecord = "workItem"
)

type WorkItemInput struct {
	Title      string `json:"title" jsonschema:"A specific follow-up task title"`
	Body       string `json:"body,omitempty" jsonschema:"Task details and context for a future execution"`
	RequestKey string `json:"requestKey,omitempty" jsonschema:"Stable key for this task; reuse the key to retry the same creation"`
}

type RunLocation struct {
	ChatID    string `json:"chatId"`
	SessionID string `json:"sessionId"`
	RunID     string `json:"runId"`
	Topic     bool   `json:"topic,omitempty"`
}

type WorkItem struct {
	ID               string       `json:"id"`
	Title            string       `json:"title"`
	Body             string       `json:"body,omitempty"`
	CreatedByAgentID string       `json:"createdByAgentId"`
	AssigneeAgentID  string       `json:"assigneeAgentId"`
	Origin           *RunLocation `json:"origin,omitempty"`
	CreatedAt        string       `json:"createdAt"`
	Done             bool         `json:"done"`
}

type TaskSourceKind string

const (
	TaskSourceKindIssue TaskSourceKind = "issue"
	TaskSourceKindPR    TaskSourceKind = "pr"
	TaskSourceKindBoth  TaskSourceKind = "both"
)

func (kind TaskSourceKind) Valid() bool {
	return kind == TaskSourceKindIssue || kind == TaskSourceKindPR || kind == TaskSourceKindBoth
}

type LarkTaskSection struct {
	GUID  string            `json:"guid"`
	Name  string            `json:"name"`
	Tasks []LarkPreviewTask `json:"tasks"`
}

type LarkPreviewTask struct {
	GUID      string `json:"guid"`
	Title     string `json:"title"`
	URL       string `json:"url,omitempty"`
	UpdatedAt int64  `json:"updatedAt,omitempty"` // Unix milliseconds from Lark.
	DueAt     int64  `json:"dueAt,omitempty"`     // Unix milliseconds, including the full local due date for all-day tasks.
	DueDate   string `json:"dueDate,omitempty"`   // The calendar date of an all-day deadline.
	Recurring bool   `json:"recurring,omitempty"`
}

type LarkTaskPreview struct {
	Target       string            `json:"target"`
	Name         string            `json:"name"`
	AsOf         int64             `json:"asOf"` // Unix milliseconds when the preview was fetched.
	Tasks        []LarkPreviewTask `json:"tasks"`
	Sections     []LarkTaskSection `json:"sections"`
	SectionError string            `json:"sectionError,omitempty"`
}

type LarkTaskDueWindow string

const (
	LarkTaskDueWindowOverdue LarkTaskDueWindow = "overdue"
	LarkTaskDueWindowWeek    LarkTaskDueWindow = "week"
	LarkTaskDueWindowNone    LarkTaskDueWindow = "none"
)

type LarkTaskFilters struct {
	DueWindow     LarkTaskDueWindow `json:"dueWindow,omitempty"`
	TitleIncludes []string          `json:"titleIncludes,omitempty"`
	TitleExcludes []string          `json:"titleExcludes,omitempty"`
	SkipRecurring bool              `json:"skipRecurring,omitempty"`
}

type LarkTaskScope struct {
	AllAssigned     bool             `json:"allAssigned,omitempty"`
	SectionIDs      []string         `json:"sectionIds"`
	ExcludedTaskIDs []string         `json:"excludedTaskIds"`
	Filters         *LarkTaskFilters `json:"filters,omitempty"`
}

type TaskSourceCreate struct {
	PluginID       string `json:"pluginId"`
	ContributionID string `json:"contributionId"`
	Target         string `json:"target,omitempty"`
	// Name overrides the default display name. Only Lark Todos sources accept it.
	Name      string         `json:"name,omitempty"`
	SyncKind  TaskSourceKind `json:"syncKind,omitempty"`
	LarkScope *LarkTaskScope `json:"larkScope,omitempty"`
}

type TaskSource struct {
	ID             string         `json:"id"`
	PluginID       string         `json:"pluginId"`
	ContributionID string         `json:"contributionId"`
	Name           string         `json:"name"`
	SyncKind       TaskSourceKind `json:"syncKind"`
	LarkScope      *LarkTaskScope `json:"larkScope,omitempty"`
	Enabled        bool           `json:"enabled"`
	PluginEnabled  bool           `json:"pluginEnabled"`
	SyncPending    bool           `json:"syncPending"`
	LastSyncedAt   int64          `json:"lastSyncedAt,omitempty"`
	Error          string         `json:"error,omitempty"`
}

type TaskSourceUpdate struct {
	Name      *string         `json:"name,omitempty"`
	Enabled   *bool           `json:"enabled,omitempty"`
	SyncKind  *TaskSourceKind `json:"syncKind,omitempty"`
	LarkScope *LarkTaskScope  `json:"larkScope,omitempty"`
}

type ExternalTask struct {
	ID        string `json:"id"`
	Source    string `json:"source"`
	Project   string `json:"project"`
	Reference string `json:"reference"`
	Kind      string `json:"kind"`
	State     string `json:"state"`
	Title     string `json:"title"`
	Done      bool   `json:"done"`
	URL       string `json:"url,omitempty"`
	Body      string `json:"body,omitempty"`
}
