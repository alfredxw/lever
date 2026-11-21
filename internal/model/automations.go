package model

type AutomationSchedule struct {
	Date            string `json:"date,omitempty"` // One-time date, in the chosen time zone.
	Time            string `json:"time,omitempty"` // HH:MM, omitted for fixed intervals.
	Timezone        string `json:"timezone,omitempty"`
	Weekdays        []int  `json:"weekdays,omitempty"`        // Sunday = 0. With no date, weekdays, day of month, or interval, runs daily.
	DayOfMonth      int    `json:"dayOfMonth,omitempty"`      // 1–31. Months without the day are skipped.
	IntervalMinutes int    `json:"intervalMinutes,omitempty"` // Elapsed minutes between runs.
}

type AutomationTrigger struct {
	Kind      string                 `json:"kind" tstype:"'schedule' | 'event'"`
	Schedule  *AutomationSchedule    `json:"schedule,omitempty"`
	BatchSize int                    `json:"batchSize,omitempty"`
	Source    *AutomationEventSource `json:"source,omitempty"` // Empty uses the custom webhook.
}

type AutomationEventSource struct {
	PluginID       string            `json:"pluginId"`
	ContributionID string            `json:"contributionId"`
	Config         map[string]string `json:"config,omitempty"`
}

type AutomationDestination struct {
	Mode          string `json:"mode" tstype:"'topic' | 'chat' | 'newChat'"`
	ChatID        string `json:"chatId,omitempty"` // Empty with topic or chat creates a dedicated Chat on first run.
	AgentID       string `json:"agentId,omitempty"`
	WorkingCopyID string `json:"workingCopyId,omitempty"`
}

type AutomationInput struct {
	Name        string                `json:"name"`
	Prompt      string                `json:"prompt"`
	Trigger     AutomationTrigger     `json:"trigger"`
	Destination AutomationDestination `json:"destination"`
	WorkItem    *bool                 `json:"workItem,omitempty"` // Defaults to true for existing automations.
	Quiet       bool                  `json:"quiet,omitempty"`    // Surface only activity that needs attention.
}

func (a AutomationInput) CreatesWorkItem() bool { return a.WorkItem == nil || *a.WorkItem }

type Automation struct {
	AutomationInput `tstype:",extends"`
	ID              string                 `json:"id"`
	Enabled         bool                   `json:"enabled"`
	NextAt          int64                  `json:"nextAt,omitempty"` // Unix time, in seconds.
	PendingEvents   int                    `json:"pendingEvents"`
	EventURL        string                 `json:"eventUrl,omitempty"`
	EventToken      string                 `json:"eventToken,omitempty"`
	Error           string                 `json:"error,omitempty"`
	BoundChatID     string                 `json:"boundChatId,omitempty"`
	SourceReady     bool                   `json:"sourceReady,omitempty"`
	SourceDisabled  bool                   `json:"sourceDisabled,omitempty"`
	SourceError     string                 `json:"sourceError,omitempty"`
	SourceSecrets   []string               `json:"sourceSecrets,omitempty"`
	RecentRuns      []AutomationRunSummary `json:"recentRuns,omitempty"`
}

type AutomationRunSummary struct {
	RunID     string `json:"runId,omitempty"`
	Status    string `json:"status"`
	CreatedAt string `json:"createdAt"`
}

type AutomationRun struct {
	ID         string         `json:"id"`
	Name       string         `json:"name"`
	Trigger    string         `json:"trigger" tstype:"'schedule' | 'event' | 'manual'"`
	CreatedAt  string         `json:"createdAt"`
	PlannedAt  int64          `json:"plannedAt,omitempty"`
	EventCount int            `json:"eventCount,omitempty"`
	Status     string         `json:"status"`
	Error      string         `json:"error,omitempty"`
	Execution  *TaskExecution `json:"execution,omitempty"`
}
