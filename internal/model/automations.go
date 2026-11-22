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

type AutomationTarget struct {
	ID            string `json:"id"`
	AgentID       string `json:"agentId"`
	ChatID        string `json:"chatId,omitempty"`
	WorkingCopyID string `json:"workingCopyId,omitempty"`
	Prompt        string `json:"prompt,omitempty"`  // Optional per-target supplemental instructions.
	Enabled       *bool  `json:"enabled,omitempty"` // Defaults to true.
}

func (t AutomationTarget) IsEnabled() bool { return t.Enabled == nil || *t.Enabled }

type AutomationInput struct {
	Name         string                `json:"name"`
	Prompt       string                `json:"prompt"`
	Trigger      AutomationTrigger     `json:"trigger"`
	Destination  AutomationDestination `json:"destination"`
	Targets      []AutomationTarget    `json:"targets,omitempty"` // Optional multi-Agent / multi-Scope execution targets.
	NotifyPolicy string                `json:"notifyPolicy,omitempty" tstype:"'' | 'always' | 'actionable' | 'silent'"`
	DeliveryMode string                `json:"deliveryMode,omitempty" tstype:"'' | 'deliver' | 'audit' | 'propose' | 'curate'"`
	WorkItem     *bool                 `json:"workItem,omitempty"` // Defaults to true for existing automations.
	Quiet        bool                  `json:"quiet,omitempty"`    // Surface only activity that needs attention.
}

func (a AutomationInput) CreatesWorkItem() bool { return a.WorkItem == nil || *a.WorkItem }

func (a AutomationInput) EffectiveNotifyPolicy() string {
	switch a.NotifyPolicy {
	case "always", "actionable", "silent":
		return a.NotifyPolicy
	}
	if a.Quiet {
		return "silent"
	}
	return "always"
}

func (a AutomationInput) EffectiveTargets() []AutomationTarget {
	if len(a.Targets) == 0 {
		return []AutomationTarget{{
			AgentID:       a.Destination.AgentID,
			ChatID:        a.Destination.ChatID,
			WorkingCopyID: a.Destination.WorkingCopyID,
		}}
	}
	out := make([]AutomationTarget, 0, len(a.Targets))
	for _, target := range a.Targets {
		if target.IsEnabled() {
			out = append(out, target)
		}
	}
	return out
}

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
	BoundChats      map[string]string      `json:"boundChats,omitempty"`
	SourceReady     bool                   `json:"sourceReady,omitempty"`
	SourceDisabled  bool                   `json:"sourceDisabled,omitempty"`
	SourceError     string                 `json:"sourceError,omitempty"`
	SourceSecrets   []string               `json:"sourceSecrets,omitempty"`
	RecentRuns      []AutomationRunSummary `json:"recentRuns,omitempty"`
}

type AutomationRunSummary struct {
	RunID     string `json:"runId,omitempty"`
	TargetID  string `json:"targetId,omitempty"`
	AgentID   string `json:"agentId,omitempty"`
	Status    string `json:"status"`
	CreatedAt string `json:"createdAt"`
}

type AutomationPullRequest struct {
	Repository string `json:"repository"`
	Number     string `json:"number"`
	Label      string `json:"label,omitempty"`
}

type AutomationChangeSummary struct {
	Files     int `json:"files"`
	Additions int `json:"additions"`
	Deletions int `json:"deletions"`
}

type AutomationRun struct {
	CanPause         bool                     `json:"canPause,omitempty"`
	ID               string                   `json:"id"`
	AutomationID     string                   `json:"automationId"`
	TargetID         string                   `json:"targetId,omitempty"`
	AgentID          string                   `json:"agentId,omitempty"`
	Name             string                   `json:"name"`
	Trigger          string                   `json:"trigger" tstype:"'schedule' | 'event' | 'manual'"`
	CreatedAt        string                   `json:"createdAt"`
	FinishedAt       string                   `json:"finishedAt,omitempty"`
	PlannedAt        int64                    `json:"plannedAt,omitempty"`
	EventCount       int                      `json:"eventCount,omitempty"`
	EventPayload     string                   `json:"eventPayload,omitempty"`
	Status           string                   `json:"status"`
	Error            string                   `json:"error,omitempty"`
	Summary          string                   `json:"summary,omitempty"`
	PullRequests     []AutomationPullRequest  `json:"pullRequests,omitempty"`
	ReportItems      []string                 `json:"reportItems,omitempty"`
	ChangeSummary    *AutomationChangeSummary `json:"changeSummary,omitempty"`
	ScopePath        string                   `json:"scopePath,omitempty"`
	NextFireSequence int64                    `json:"nextFireSequence,omitempty"`
	ReplyCount       int                      `json:"replyCount,omitempty"`
	WorkItemIDs      []string                 `json:"workItemIds,omitempty"`
	Execution        *TaskExecution           `json:"execution,omitempty"`
}
