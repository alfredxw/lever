// Package model defines Lever's persisted and HTTP data contracts.
package model

type Root struct {
	ID   string `json:"id"`
	Path string `json:"path"`
}

const SkillEntry = "SKILL.md"

type Skill struct {
	ID               string       `json:"id"`
	Path             string       `json:"path"`
	Name             string       `json:"name"`
	Title            string       `json:"title,omitempty"`
	Description      string       `json:"description"`
	Managed          bool         `json:"managed"`
	Available        bool         `json:"available"`
	AgentIDs         []string     `json:"agentIds"`
	Origin           *SkillOrigin `json:"origin,omitempty"`
	SubscriptionID   string       `json:"subscriptionId,omitempty"`
	SubscriptionName string       `json:"subscriptionName,omitempty"`
	UpdateAvailable  bool         `json:"updateAvailable,omitempty"`
	LocalModified    bool         `json:"localModified,omitempty"`
	FileCount        int          `json:"fileCount,omitempty"`
}

type UpdateSettings struct {
	Mode     string `json:"mode" tstype:"'auto' | 'notify' | 'manual'"`
	Interval string `json:"interval" tstype:"'1h' | '6h' | '24h'"`
}

type SkillSubscription struct {
	ID              string          `json:"id"`
	Name            string          `json:"name"`
	Directory       string          `json:"directory,omitempty"`
	Source          PluginGitSource `json:"source"`
	Commit          string          `json:"commit"`
	Tree            string          `json:"tree"`
	UpdatePolicy    string          `json:"updatePolicy" tstype:"'inherit' | 'auto' | 'notify' | 'manual'"`
	LastCheckedAt   string          `json:"lastCheckedAt,omitempty"`
	LastSyncedAt    string          `json:"lastSyncedAt,omitempty"`
	Available       bool            `json:"available,omitempty"`
	AvailableCommit string          `json:"availableCommit,omitempty"`
	Error           string          `json:"error,omitempty"`
	SkillCount      int             `json:"skillCount"`
	ModifiedCount   int             `json:"modifiedCount,omitempty"`
}

type SkillSubscriptionInput struct {
	Name         string `json:"name,omitempty"`
	URL          string `json:"url"`
	Path         string `json:"path,omitempty"`
	Ref          string `json:"ref,omitempty"`
	UpdatePolicy string `json:"updatePolicy,omitempty" tstype:"'inherit' | 'auto' | 'notify' | 'manual'"`
}

type SkillSubscriptionSyncResult struct {
	Subscription    SkillSubscription `json:"subscription"`
	Added           int               `json:"added"`
	Updated         int               `json:"updated"`
	Removed         int               `json:"removed"`
	SkippedModified int               `json:"skippedModified"`
}

type SkillRemovalResult struct {
	Deleted            bool   `json:"deleted"`
	RemainingDirectory string `json:"remainingDirectory,omitempty"`
}

type SkillOrigin struct {
	Directory string   `json:"directory"`
	ScopePath string   `json:"scopePath,omitempty"`
	Providers []string `json:"providers,omitempty"`
}

type SkillSource struct {
	Path        string  `json:"path"`
	ScopeRootID string  `json:"scopeRootId,omitempty"`
	Skills      []Skill `json:"skills"`
}

type DelegationRule struct {
	AgentID string `json:"agentId"`
	Confirm bool   `json:"confirm"`
}

type Scope struct {
	Roots         []Root `json:"roots"`
	PrimaryRootID string `json:"primaryRootId"`
}

// Project is a named, shareable Scope (directories and worktree setup) that
// multiple Agents and Sessions can reference.
type Project struct {
	ID            string            `json:"id"`
	Name          string            `json:"name"`
	Scope                           `tstype:",extends"`
	WorktreeSetup map[string]string `json:"worktreeSetup,omitempty"` // Keyed by the Git common directory.
	CreatedAt     string            `json:"createdAt"`
	UpdatedAt     string            `json:"updatedAt"`
}

type Profile struct {
	ProjectID                string `json:"projectId,omitempty"`
	Description              string `json:"description,omitempty"`
	Scope                           `tstype:",extends"`
	Instructions             string            `json:"instructions"`
	Provider                 string            `json:"provider"`
	Model                    string            `json:"model"`
	Permission               string            `json:"permission"`
	Skills                   []string          `json:"skills"`
	DisabledSkills           []string          `json:"disabledSkills,omitempty"`
	Delegations              []DelegationRule  `json:"delegations"`
	WorktreeSetup            map[string]string `json:"worktreeSetup,omitempty"` // Keyed by the Git common directory.
	TaskConcurrency          int               `json:"taskConcurrency,omitempty"`
	TaskStartIntervalMinutes int               `json:"taskStartIntervalMinutes,omitempty"`
	TaskQueuePaused          bool              `json:"taskQueuePaused,omitempty"`
}

const (
	DefaultAvatarColor = "gradient-prism"
	DefaultAvatarEmoji = "🤖"
)

const StarterAvatarPreset = "lever"

type Avatar struct {
	Kind  string `json:"kind"`
	Value string `json:"value"` // An empty monogram uses the Agent's current initials.
	Color string `json:"color,omitempty"`
}

type Agent struct {
	ID        string  `json:"id"`
	Name      string  `json:"name"`
	Avatar    *Avatar `json:"avatar,omitempty"`
	Profile   Profile `json:"profile"`
	Archived  bool    `json:"archived"`
	CreatedAt string  `json:"createdAt"`
	UpdatedAt string  `json:"updatedAt"`
}

type SharedScope struct {
	HubID   string `json:"hubId"`
	SpaceID string `json:"spaceId"`
}
type SharedTaskRef struct {
	SharedScope `tstype:",extends"`
	TaskID      string `json:"taskId"`
	DispatchID  string `json:"dispatchId"`
}
type Chat struct {
	SharedScope   *SharedScope   `json:"sharedScope,omitempty"`
	SharedTaskRef *SharedTaskRef `json:"sharedTaskRef,omitempty"`
	ID            string         `json:"id"`
	AgentID       string         `json:"agentId"`
	TaskID        string         `json:"taskId,omitempty"`
	NoteID        string         `json:"noteId,omitempty"`
	TaskSourceID  string         `json:"taskSourceId,omitempty"`
	Channel       string         `json:"channel,omitempty"`
	Title         string         `json:"title"`
	TitleIsCustom bool           `json:"titleIsCustom,omitempty"`
	Source        string         `json:"source"`
	CreatedAt     string         `json:"createdAt"`
	UpdatedAt     string         `json:"updatedAt"`
}

// Conversation is the sidebar projection of a main or Topic session. Its
// unread cursor advances when its view has loaded or the user marks it read.
type Conversation struct {
	BackgroundOnly bool              `json:"backgroundOnly,omitempty"` // No foreground activity in this session yet.
	Comparison     *ComparisonOrigin `json:"comparison,omitempty"`
	ID             string            `json:"id"`
	ChatID         string            `json:"chatId"`
	AgentID        string            `json:"agentId"`
	Kind           string            `json:"kind"`
	Title          string            `json:"title"`
	Preview        string            `json:"preview"`
	MessageAt      string            `json:"messageAt"`
	FinishedAt     string            `json:"finishedAt,omitempty"`
	UnreadSequence int64             `json:"unreadSequence"`
}

// Selection belongs to a turn. Runtime overrides do not change the Agent profile.
type Selection struct {
	Provider   string `json:"provider"`
	Model      string `json:"model"`
	Permission string `json:"permission,omitempty"`
	Effort     string `json:"effort"`
	Fast       bool   `json:"fast"`
}

type ModelInfo struct {
	ID              string   `json:"id"`
	Name            string   `json:"name"`
	Images          *bool    `json:"images,omitempty"` // Omitted when the runtime only reports a connection-wide capability.
	ResolvedModel   string   `json:"resolvedModel,omitempty"`
	RequiresVersion string   `json:"requiresVersion,omitempty"`
	Default         bool     `json:"default"`
	Efforts         []string `json:"efforts"`
	DefaultEffort   string   `json:"defaultEffort"`
	Fast            bool     `json:"fast"`
}

type Catalog struct {
	Commands          []NativeCommand      `json:"commands,omitempty"`
	Provider          string               `json:"provider"`
	Version           string               `json:"version,omitempty"`
	Path              string               `json:"path,omitempty"`
	Models            []ModelInfo          `json:"models"`
	Provisional       bool                 `json:"provisional,omitempty"` // The latest model refresh could not be confirmed.
	FastUnavailable   string               `json:"fastUnavailable,omitempty"`
	Permissions       []PermissionInfo     `json:"permissions"`
	LegacyPermissions []PermissionInfo     `json:"legacyPermissions,omitempty"`
	DefaultPermission string               `json:"defaultPermission"`
	Capabilities      ProviderCapabilities `json:"capabilities"`
}

// NativeCommand is executed by the selected runtime at the start of a prompt.
type NativeCommand struct {
	Name         string `json:"name"`
	Description  string `json:"description,omitempty"`
	ArgumentHint string `json:"argumentHint,omitempty"`
}

type SessionGoal struct {
	Objective string `json:"objective"`
	Status    string `json:"status"`
}

type ContextUsage struct {
	PromptCacheExpiresAt int64  `json:"promptCacheExpiresAt,omitempty"`
	CacheRunID           string `json:"cacheRunId,omitempty"`
	Used                 int64  `json:"used"`
	Window               int64  `json:"window"`
}

// Runtime state belongs to the bound native session, including each Topic.
type SessionRuntime struct {
	Goal    *SessionGoal  `json:"goal,omitempty"`
	Context *ContextUsage `json:"context,omitempty"`
	// nil means the agent has yet to advertise commands. An empty list revokes them.
	Commands *[]NativeCommand `json:"commands,omitempty"`
}

// Provider is a configured runtime. Its ID, rather than its Type, owns native sessions.
type Provider struct {
	PluginID          string   `json:"pluginId"`
	ContributionID    string   `json:"contributionId"`
	ID                string   `json:"id"`
	Type              string   `json:"type"`
	Name              string   `json:"name"`
	Enabled           bool     `json:"enabled"`
	Command           string   `json:"command"`
	Args              []string `json:"args"`
	ConfigDir         string   `json:"configDir,omitempty"`
	ShadowHome        string   `json:"shadowHome,omitempty"`
	AutoCompactWindow int      `json:"autoCompactWindow,omitempty"`
	IdleCompaction    string   `json:"idleCompaction,omitempty"`
	AuthMethod        string   `json:"authMethod,omitempty"`
	GCPProject        string   `json:"gcpProject,omitempty"`
	GCPLocation       string   `json:"gcpLocation,omitempty"`
	ManagedProfile    bool     `json:"managedProfile,omitempty"`
	HiddenModels      []string `json:"hiddenModels,omitempty"`
}

type ProviderType struct {
	ID                  string   `json:"id"`
	Name                string   `json:"name"`
	Arguments           bool     `json:"arguments"`
	ConfigEnv           string   `json:"configEnv,omitempty"`
	ShadowHome          bool     `json:"shadowHome,omitempty"`
	AutoCompactWindow   bool     `json:"autoCompactWindow,omitempty"`
	IdleCompactionModes []string `json:"idleCompactionModes,omitempty"`
	AuthMethods         []string `json:"authMethods,omitempty"`
}

// ProviderCandidate is a local launch source offered by an enabled plugin.
type ProviderCandidate struct {
	PluginID       string `json:"pluginId"`
	ContributionID string `json:"contributionId"`
	Name           string `json:"name"`
	Path           string `json:"path"`
	ConfigPath     string `json:"configPath,omitempty"`
}

// ProviderSetup is transient host-owned installation or sign-in progress.
type ProviderSetup struct {
	Phase string `json:"phase"`
	URL   string `json:"url,omitempty"`
	Error string `json:"error,omitempty"`
}

type PermissionInfo struct {
	ID           string  `json:"id"`
	Name         string  `json:"name"`
	Description  *string `json:"description,omitempty"`
	Mode         string  `json:"mode,omitempty"` // Equivalent permission in another provider.
	NextTurnOnly bool    `json:"nextTurnOnly,omitempty"`
}

type ProviderCapabilities struct {
	Steering         bool `json:"steering"`
	Images           bool `json:"images"`
	Audio            bool `json:"audio,omitempty"`
	Files            bool `json:"files"`
	FileLinksOnly    bool `json:"fileLinksOnly,omitempty"`
	MultiRoot        bool `json:"multiRoot"`
	DirectoryContext bool `json:"directoryContext,omitempty"` // Additional paths can be included as context under the runtime's own permissions.
	MCP              bool `json:"mcp"`
	Skills           bool `json:"skills"`
	SkillContext     bool `json:"skillContext,omitempty"`
	Resume           bool `json:"resume"`
}

type Attachment struct {
	ID        string `json:"id"`
	ChatID    string `json:"chatId"`
	Name      string `json:"name"`
	MediaType string `json:"mediaType"`
	Size      int64  `json:"size"`
}

// Reference identifies a scoped file or skill, a local Lever object, or a selected webpage element.
// Chat and Topic references both identify exactly one session. Offsets are UTF-16.
type Reference struct {
	ArgumentHint string          `json:"argumentHint,omitempty"`
	Kind         string          `json:"kind"`
	Name         string          `json:"name"`
	ID           string          `json:"id,omitempty"`
	Path         string          `json:"path"`
	Provider     string          `json:"provider,omitempty"`
	Description  string          `json:"description,omitempty"`
	Element      *BrowserElement `json:"element,omitempty"`
	Start        *int            `json:"start,omitempty"`
	End          *int            `json:"end,omitempty"`
}

type BrowserElement struct {
	URL      string `json:"url"`
	Tag      string `json:"tag"`
	Text     string `json:"text"`
	Selector string `json:"selector"`
}

func (ref Reference) RequiresMCP() bool {
	return ref.MCPTool() != ""
}

func (ref Reference) MCPTool() string {
	switch ref.Kind {
	case "chat", "topic":
		return "read_chat_context"
	case "note", "workItem", "noteTask", "externalTask", "automationTask":
		return "read_reference"
	case "agent":
		return "delegate_start"
	}
	return ""
}

type Session struct {
	Runtime         *SessionRuntime `json:"runtime,omitempty"`
	ProjectID       string          `json:"projectId,omitempty"`
	WorkingCopyID   string          `json:"workingCopyId,omitempty"`
	WorkingCopyName string          `json:"workingCopyName,omitempty"`
	Title           string          `json:"title,omitempty"`
	Scope           `tstype:",extends"`
	ID              string            `json:"id"`
	ChatID          string            `json:"chatId"`
	AgentID         string            `json:"agentId"`
	Kind            string            `json:"kind"`
	TaskID          string            `json:"taskId,omitempty"`
	Channel         *ChannelOrigin    `json:"channel,omitempty"`
	NativeID        string            `json:"nativeId"`
	Selection       Selection         `json:"selection"`
	ParentRunID     string            `json:"parentRunId,omitempty"`
	SourceRunID     string            `json:"sourceRunId,omitempty"`
	Comparison      *ComparisonOrigin `json:"comparison,omitempty"`
	QueuePaused     bool              `json:"queuePaused,omitempty"`
	CreatedAt       string            `json:"createdAt"`
}

type Item struct {
	ID         string            `json:"id"`
	Kind       string            `json:"kind"`
	Title      string            `json:"title"`
	Text       string            `json:"text"`
	Status     string            `json:"status"`
	ToolAction ToolAction        `json:"toolAction,omitempty"`
	ExitCode   *int              `json:"exitCode,omitempty"`
	Message    *Message          `json:"message,omitempty"`
	Subagent   *SubagentActivity `json:"subagent,omitempty"`
}

type ToolAction string

const (
	ToolActionCommand ToolAction = "command"
	ToolActionEdit    ToolAction = "edit"
	ToolActionList    ToolAction = "list"
	ToolActionRead    ToolAction = "read"
	ToolActionSearch  ToolAction = "search"
)

type SubagentActivity struct {
	Prompt     string `json:"prompt,omitempty"`
	Progress   string `json:"progress,omitempty"`
	StartedAt  string `json:"startedAt"`
	FinishedAt string `json:"finishedAt,omitempty"`
}

// Message is user input embedded at its delivery position in an active run.
type Message struct {
	ID          string        `json:"id"`
	Input       string        `json:"input"`
	Attachments []Attachment  `json:"attachments"`
	References  []Reference   `json:"references,omitempty"`
	Quote       *MessageQuote `json:"quote,omitempty"`
	CreatedAt   string        `json:"createdAt"`
}

// MessageQuote keeps the referenced message separate from the reply text.
// Author and Text are resolved from the source run when the reply is accepted.
type MessageQuote struct {
	RunID  string `json:"runId"`
	Role   string `json:"role"`
	Author string `json:"author"`
	Text   string `json:"text"`
}

// CreatedAgent records the result and idempotency key of an Agent creation in a Run.
type CreatedAgent struct {
	AgentID    string `json:"agentId"`
	Name       string `json:"name"`
	RequestKey string `json:"requestKey"`
	InputHash  string `json:"inputHash"`
}

type Run struct {
	ID                      string         `json:"id"`
	SessionID               string         `json:"sessionId"`
	ChatID                  string         `json:"chatId"`
	AgentID                 string         `json:"agentId"`
	ComparisonID            string         `json:"comparisonId,omitempty"`
	AutomationID            string         `json:"automationId,omitempty"`
	Quiet                   bool           `json:"quiet,omitempty"`
	Task                    *RunTask       `json:"task,omitempty"`
	TaskCompletionRequested bool           `json:"taskCompletionRequested,omitempty"` // Explicit delivery requested by this execution.
	Sequence                int64          `json:"sequence"`                          // Position in the conversation timeline.
	UnreadSequence          int64          `json:"unreadSequence,omitempty"`          // Event sequence when this turn last surfaced an unread result or pending request.
	Input                   string         `json:"input"`
	ChannelPrompt           string         `json:"channelPrompt,omitempty"`  // Additional instructions captured when a personal channel accepts this turn.
	ChannelContext          string         `json:"channelContext,omitempty"` // External conversation context attached by a personal channel; passed to the runtime without polluting visible titles.
	Selection               Selection      `json:"selection"`
	PermissionMutable       bool           `json:"permissionMutable,omitempty"`
	AllowApprovals          bool           `json:"allowApprovals,omitempty"`
	Attachments             []Attachment   `json:"attachments"`
	References              []Reference    `json:"references,omitempty"`
	Quote                   *MessageQuote  `json:"quote,omitempty"`
	Handoff                 bool           `json:"handoff"`
	Status                  string         `json:"status"`
	Superseded              bool           `json:"superseded,omitempty"` // Excluded from the active conversation.
	Items                   []Item         `json:"items"`
	CreatedAgents           []CreatedAgent `json:"createdAgents,omitempty"`
	Error                   string         `json:"error,omitempty"`
	CreatedAt               string         `json:"createdAt"`
	StartedAt               string         `json:"startedAt,omitempty"`
	FinishedAt              string         `json:"finishedAt,omitempty"`
	// A nil native turn ID permits lookup by the original client message ID.
	// An empty ID records a continuation whose delivery has yet to be confirmed.
	NativeTurnID        *string         `json:"nativeTurnId,omitempty"`
	CanPause            bool            `json:"canPause,omitempty"`
	CanSteer            bool            `json:"canSteer,omitempty"`
	SteerPending        bool            `json:"steerPending,omitempty"`
	PauseRequested      bool            `json:"pauseRequested,omitempty"`
	Continued           bool            `json:"continued,omitempty"`
	ResumeAfterShutdown bool            `json:"resumeAfterShutdown,omitempty"`
	Operation           string          `json:"operation,omitempty"`
	Delivery            string          `json:"delivery,omitempty"`
	SteerRunID          string          `json:"steerRunId,omitempty"`
	AfterRunIDs         []string        `json:"afterRunIds,omitempty"`
	WaitingOn           []RunDependency `json:"waitingOn,omitempty"`
	ScopePaths          []string        `json:"scopePaths,omitempty"`
	TurnDiff           *TurnPatch          `json:"turnDiff,omitempty"`
	Changes            []RunChanges        `json:"changes,omitempty"`
	Channel            *ChannelTurn        `json:"channel,omitempty"`
	DelegationReceipts []DelegationReceipt `json:"delegationReceipts,omitempty"`
}

// RunDependency is the live status projection of an upstream run this turn waits on.
type RunDependency struct {
	RunID     string `json:"runId"`
	SessionID string `json:"sessionId"`
	ChatID    string `json:"chatId"`
	AgentID   string `json:"agentId"`
	Topic     bool   `json:"topic,omitempty"`
	Title     string `json:"title"`
	Status    string `json:"status"`
	Blocked   bool   `json:"blocked,omitempty"`
}

func (run Run) UserMessage() *Message {
	return &Message{ID: run.ID, Input: run.Input, Attachments: run.Attachments, References: run.References, Quote: run.Quote, CreatedAt: run.CreatedAt}
}

// TurnPatch summarizes the native Codex diff. The raw patch is stored separately
// from chat history. Paths in it are relative to the runtime cwd or absolute.
type TurnPatch struct {
	Root     Root       `json:"root"`
	Reported bool       `json:"reported"`
	Files    []DiffFile `json:"files"`
	Error    string     `json:"error,omitempty"`
}

// TurnReview pins both review sources to the same execution for subsequent file requests.
type TurnReview struct {
	RunID    string       `json:"runId"`
	TurnDiff *TurnPatch   `json:"turnDiff,omitempty"`
	Changes  []RunChanges `json:"changes"`
}

// RunChanges pins the workspace before and after one execution, independently
// of HEAD and the user's staging area. Roots follow the session's scope.
type RunChanges struct {
	GitDir   string     `json:"gitDir,omitempty"`
	Relative string     `json:"relative,omitempty"`
	Root     Root       `json:"root"`
	Before   string     `json:"before,omitempty"`
	After    string     `json:"after,omitempty"`
	Files    []DiffFile `json:"files"`
	Error    string     `json:"error,omitempty"`
}

type DiffFile struct {
	Path      string `json:"path"`
	Status    string `json:"status"`
	Additions int    `json:"additions"`
	Deletions int    `json:"deletions"`
	Binary    bool   `json:"binary,omitempty"`
}

type GitCommit struct {
	Hash        string `json:"hash"`
	Subject     string `json:"subject"`
	CommittedAt string `json:"committedAt,omitempty"`
}

type GitRootSummary struct {
	Root      Root   `json:"root"`
	Branch    string `json:"branch,omitempty"`
	Head      string `json:"head,omitempty"`
	Upstream  string `json:"upstream,omitempty"`
	Ahead     int    `json:"ahead,omitempty"`
	Behind    int    `json:"behind,omitempty"`
	Files     int    `json:"files"`
	Additions int    `json:"additions"`
	Deletions int    `json:"deletions"`
	Truncated bool   `json:"truncated,omitempty"`
	Error     string `json:"error,omitempty"`
}

type GitBranch struct {
	Name string `json:"name"`
	Ref  string `json:"ref"`
}

type GitBranches struct {
	Branches    []GitBranch `json:"branches"`
	Current     string      `json:"current"`
	DefaultBase string      `json:"defaultBase"`
}

type QuestionOption struct {
	ID          string `json:"id"`
	Label       string `json:"label"`
	Description string `json:"description,omitempty"`
}

type Question struct {
	ID       string           `json:"id"`
	Text     string           `json:"text"`
	Options  []QuestionOption `json:"options"`
	Multiple bool             `json:"multiple"`
}

type Request struct {
	AnsweredByUserID  string          `json:"answeredByUserId,omitempty"`
	ID                string          `json:"id"`
	RunID             string          `json:"runId"`
	ChatID            string          `json:"chatId"`
	SessionID         string          `json:"sessionId"`
	Kind              string          `json:"kind"`
	Title             string          `json:"title"`
	Detail            string          `json:"detail"`
	DelegationAgentID string          `json:"delegationAgentId,omitempty"`
	SubagentID        string          `json:"subagentId,omitempty"`
	Questions         []Question      `json:"questions"`
	Options           []RequestOption `json:"options,omitempty"`
	AllowOnce         *Answer         `json:"allowOnce,omitempty"`
	Status            string          `json:"status"`
	Answer            *Answer         `json:"answer,omitempty"`
}

type RequestOption struct {
	ID    string `json:"id"`
	Name  string `json:"name"`
	Allow bool   `json:"allow"`
}

type Answer struct {
	Allow    bool                `json:"allow"`
	Answers  map[string][]string `json:"answers"`
	OptionID string              `json:"optionId,omitempty"`
}

type SendInput struct {
	SharedScope   *SharedScope  `json:"sharedScope,omitempty"`
	WorkingCopyID string        `json:"workingCopyId,omitempty"`
	CommandID     string        `json:"commandId"`
	ChatID        string        `json:"chatId"`
	AgentID       string        `json:"agentId,omitempty"`
	Operation     string        `json:"operation"`
	SessionID     string        `json:"sessionId,omitempty"`
	Text          string        `json:"text"`
	Selection     *Selection    `json:"selection,omitempty"`
	AttachmentIDs []string      `json:"attachmentIds,omitempty"`
	References    []Reference   `json:"references,omitempty"`
	Quote         *MessageQuote `json:"quote,omitempty"`
	Delivery      string        `json:"delivery,omitempty"`
	SteerRunID    string        `json:"steerRunId,omitempty"`
	AfterRunIDs   []string      `json:"afterRunIds,omitempty"`
	EditRunID     string        `json:"editRunId,omitempty"`
	ReplaceRunID  string        `json:"replaceRunId,omitempty"`
}

type TimelineEntry struct {
	SessionID     string `json:"sessionId"`
	RunID         string `json:"runId"`
	Kind          string `json:"kind"`
	Sequence      int64  `json:"sequence"`
	ReplyCount    int    `json:"replyCount"`
	ComparisonID  string `json:"comparisonId,omitempty"`
	SourceTopicID string `json:"sourceTopicId,omitempty"`
}

type ChatView struct {
	Chat        Chat            `json:"chat"`
	Sessions    []Session       `json:"sessions"`
	Entries     []TimelineEntry `json:"entries"`
	Runs        []Run           `json:"runs"`
	Requests    []Request       `json:"requests"`
	Comparisons []Comparison    `json:"comparisons,omitempty"`
	Cursor      int64           `json:"cursor"`
	HasMore     bool            `json:"hasMore"`
}

type SessionView struct {
	Session Session      `json:"session"`
	Root    *Run         `json:"root,omitempty"`
	Source  *TopicSource `json:"source,omitempty"`
}

// TopicSource is the visible dialogue from a Topic's original Chat turn.
type TopicSource struct {
	Message    Message `json:"message"`
	Items      []Item  `json:"items"`
	FinishedAt string  `json:"finishedAt"`
}

type TopicSummary struct {
	ID        string `json:"id"`
	RootRunID string `json:"rootRunId,omitempty"`
	Title     string `json:"title"`
	Status    string `json:"status,omitempty"`
	CreatedAt string `json:"createdAt"`
}

type ChatTopicsPage struct {
	Topics     []TopicSummary `json:"topics"`
	NextBefore int64          `json:"nextBefore,omitempty"`
}

type MessageMatch struct {
	ChatID  string             `json:"chatId"`
	TopicID string             `json:"topicId,omitempty"`
	RunID   string             `json:"runId"`
	Text    string             `json:"text"`
	Preview []MessageMatchPart `json:"preview,omitempty"`
}

type MessageMatchPart struct {
	Text      string   `json:"text"`
	Tags      []string `json:"tags,omitempty"`
	Highlight bool     `json:"highlight,omitempty"`
}

type SessionRuns struct {
	Runs   []Run `json:"runs"`
	Cursor int64 `json:"cursor"`
}

type ProviderInfo struct {
	ContributionName string `json:"contributionName,omitempty"`
	LoginStatus      string `json:"loginStatus,omitempty"` // signedIn, signedOut, or omitted when unconfirmed.
	Available        bool   `json:"available"`
	Provider         `tstype:",extends"`
	Path             string               `json:"path"`
	Version          string               `json:"version"`
	Installed        bool                 `json:"installed"`
	CanLogin         bool                 `json:"canLogin,omitempty"`
	HasAPIKey        bool                 `json:"hasApiKey,omitempty"`
	ReportsUsage     bool                 `json:"reportsUsage"`
	Auth             string               `json:"auth"`
	ConfigPath       string               `json:"configPath,omitempty"`
	Error            string               `json:"error,omitempty"`
	Capabilities     ProviderCapabilities `json:"capabilities"`
}

type UsageWindow struct {
	ID          string  `json:"id"`
	Group       string  `json:"group,omitempty"`
	Minutes     int     `json:"minutes,omitempty"`
	UsedPercent float64 `json:"usedPercent"`
	ResetsAt    string  `json:"resetsAt,omitempty"`
}

// Plugin installations retain their identity after uninstall so conversations
// can display their original provider without executing uninstalled code.
type Plugin struct {
	ID           string         `json:"id"`
	Manifest     PluginManifest `json:"manifest"`
	Enabled      bool           `json:"enabled"`
	Installed    bool           `json:"installed"`
	Builtin      bool           `json:"builtin"`
	Directory    string         `json:"directory"`
	Revision     int64          `json:"revision,omitempty"`
	Current      *PluginRelease `json:"current,omitempty"`
	Previous     *PluginRelease `json:"previous,omitempty"`
	UpdatePolicy string         `json:"updatePolicy,omitempty" tstype:"'inherit' | 'auto' | 'notify' | 'manual'"`
}

// Ref is the resolved branch or tag name, or a full commit for a pinned revision.
type PluginGitSource struct {
	URL  string `json:"url"`
	Path string `json:"path,omitempty"`
	Ref  string `json:"ref"`
	Kind string `json:"kind" tstype:"'branch' | 'tag' | 'commit'"`
}

type PluginRelease struct {
	Source  PluginGitSource `json:"source"`
	Commit  string          `json:"commit"`
	Tree    string          `json:"tree"`
	Version string          `json:"version"`
	Package string          `json:"package"`
}

type PluginPreview struct {
	ID       string         `json:"id"`
	Manifest PluginManifest `json:"manifest"`
	Release  PluginRelease  `json:"release"`
	Blockers []string       `json:"blockers"`
}

type PluginPreviewInput struct {
	URL      string `json:"url,omitempty"`
	Ref      string `json:"ref,omitempty"`
	Path     string `json:"path,omitempty"`
	Commit   string `json:"commit,omitempty"`
	Revision int64  `json:"revision,omitempty"`
}

type PluginUpdate struct {
	Available bool   `json:"available"`
	Commit    string `json:"commit"`
}

type PluginManifest struct {
	ManifestVersion int                 `json:"manifestVersion"`
	ID              string              `json:"id"`
	Name            string              `json:"name"`
	Version         string              `json:"version"`
	Description     string              `json:"description,omitempty"`
	Contributes     PluginContributions `json:"contributes"`
}

type PluginContributions struct {
	Providers    []ProviderContribution    `json:"providers"`
	TaskSources  []TaskSourceContribution  `json:"taskSources,omitempty"`
	Channels     []ChannelContribution     `json:"channels,omitempty"`
	EventSources []EventSourceContribution `json:"eventSources,omitempty"`
}

type EventSourceContribution struct {
	ID      string             `json:"id"`
	Name    string             `json:"name"`
	Driver  string             `json:"driver,omitempty"`
	Command string             `json:"command,omitempty"`
	Fields  []EventSourceField `json:"fields"`
}

type EventSourceField struct {
	ID          string `json:"id"`
	Label       string `json:"label"`
	Kind        string `json:"kind" tstype:"'text' | 'secret'"`
	Required    bool   `json:"required,omitempty"`
	Default     string `json:"default,omitempty"`
	Placeholder string `json:"placeholder,omitempty"`
}

type ChannelContribution struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Driver  string `json:"driver,omitempty"`
	Command string `json:"command,omitempty"`
}

type TaskSourceContribution struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

type ProviderContribution struct {
	ID      string   `json:"id"`
	Name    string   `json:"name"`
	Driver  string   `json:"driver"`
	Command string   `json:"command"`
	Args    []string `json:"args"`
}

type Overview struct {
	Cursor        int64          `json:"cursor"`
	Agents        []Agent        `json:"agents"`
	Projects      []Project      `json:"projects"`
	Chats         []Chat         `json:"chats"`
	Conversations []Conversation `json:"conversations"`
	Runs          []Run          `json:"runs"`
	Requests      []Request      `json:"requests"`
	DataDir       string         `json:"dataDir"`
	HomeDir       string         `json:"homeDir"`
	DeviceID      string         `json:"deviceId"`
	DeviceName    string         `json:"deviceName"`
	Platform      string         `json:"platform"`
}

type Event struct {
	SessionID    string              `json:"sessionId,omitempty"`
	RunID        string              `json:"runId,omitempty"`
	RequestID    string              `json:"requestId,omitempty"`
	Sequence     int64               `json:"sequence"`
	Type         string              `json:"type"`
	ChatID       string              `json:"chatId,omitempty"`
	TaskNoteID   string              `json:"taskNoteId,omitempty"`
	Run          *Run                `json:"run,omitempty"`
	Request      *Request            `json:"request,omitempty"`
	Conversation *Conversation       `json:"conversation,omitempty"`
	TaskReminder *TaskReminderNotice `json:"taskReminder,omitempty"`
}

type FileEntry struct {
	Name       string `json:"name"`
	Path       string `json:"path"`
	Directory  bool   `json:"directory"`
	Size       int64  `json:"size"`
	GitIgnored bool   `json:"gitIgnored,omitempty"`
}

type FileContent struct {
	Path      string `json:"path"`
	Content   string `json:"content"`
	Truncated bool   `json:"truncated"`
	Version   string `json:"version"`
}

type FileWrite struct {
	Content  string `json:"content"`
	Version  string `json:"version"`
	RootPath string `json:"rootPath"`
}

type FileMatch struct {
	RootID    string `json:"rootId"`
	Path      string `json:"path"`
	Line      int    `json:"line"`
	Column    int    `json:"column"`
	EndColumn int    `json:"endColumn"`
	Text      string `json:"text"`
}

type FileSearch struct {
	Matches   []FileMatch `json:"matches"`
	Truncated bool        `json:"truncated"`
}

type DiffResult struct {
	Repository string     `json:"repository"`
	Patch      string     `json:"patch"`
	Untracked  []string   `json:"untracked"`
	Files      []DiffFile `json:"files"`
	SingleFile bool       `json:"singleFile"`
}

type Delegation struct {
	ID              string   `json:"id"`
	ParentSessionID string   `json:"parentSessionId,omitempty"`
	ParentRunID     string   `json:"parentRunId"`
	AgentID         string   `json:"agentId,omitempty"`
	SessionID       string   `json:"sessionId"`
	ChatID          string   `json:"chatId"`
	RunID           string   `json:"runId"`
	RunIDs          []string `json:"runIds,omitempty"`
	Turn            int      `json:"turn,omitempty"`
	Workspace       string   `json:"workspace,omitempty"`
	WorkingCopyName string   `json:"workingCopyName,omitempty"`
	AutoWake        bool     `json:"autoWake,omitempty"`
}

const DelegationCommandPrefix = "delegate:"

type DelegationTarget struct {
	RunLocation `tstype:",extends"`
	AgentID     string `json:"agentId"`
	Title       string `json:"title"`
}

type DelegatedRun struct {
	DelegationTarget `tstype:",extends"`
	DelegationID     string `json:"delegationId,omitempty"`
	Status           string `json:"status"`
	Turn             int    `json:"turn,omitempty"`
	Turns            int    `json:"turns,omitempty"`
	Provider         string `json:"provider,omitempty"`
	Model            string `json:"model,omitempty"`
	Workspace        string `json:"workspace,omitempty"`
	WorkingCopyName  string `json:"workingCopyName,omitempty"`
	Summary          string `json:"summary,omitempty"`
}

type DelegationReceipt struct {
	DelegationID string `json:"delegationId"`
	AgentID      string `json:"agentId"`
	AgentName    string `json:"agentName"`
	ChatID       string `json:"chatId"`
	SessionID    string `json:"sessionId"`
	RunID        string `json:"runId"`
	Turn         int    `json:"turn,omitempty"`
	Status       string `json:"status"`
	Title        string `json:"title,omitempty"`
	Summary      string `json:"summary,omitempty"`
	Error        string `json:"error,omitempty"`
}

type ChatDelegations struct {
	Outgoing map[string][]DelegatedRun `json:"outgoing"`
	Source   *DelegationTarget         `json:"source,omitempty"`
}

func Active(status string) bool {
	return status == "starting" || status == "running" || status == "waiting_user" || status == "cancelling" || status == "unknown"
}
