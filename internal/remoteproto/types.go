// Package remoteproto is the wire contract shared by Hub and paired clients.
// Its archive types intentionally contain no provider configuration or paths.
package remoteproto

const Version = 1
const MaxFrame = 2 << 20

type Role string

const (
	Workstation Role = "workstation"
	Executor    Role = "executor"
	Controller  Role = "controller"
)

func (r Role) Valid() bool    { return r == Workstation || r == Executor || r == Controller }
func (r Role) Controls() bool { return r == Workstation || r == Controller }
func (r Role) Executes() bool { return r == Workstation || r == Executor }

type Identity struct {
	ID        string `json:"id"`
	PublicKey []byte `json:"publicKey"`
}
type DirectPairReceipt struct {
	Membership Membership `json:"membership"`
	Grant      string     `json:"grant"`
	Host       Device     `json:"host"`
	LANAddr    string     `json:"lanAddr,omitempty"`
}

type PairInput struct {
	Reciprocal *DirectPairReceipt `json:"reciprocal,omitempty"`
	Code       string             `json:"code"`
	Identity   `tstype:",extends"`
	Name       string `json:"name"`
	Platform   string `json:"platform"`
	Role       Role   `json:"role"`
	Proof      []byte `json:"proof"`
}
type Membership struct {
	Features  []string `json:"features,omitempty"`
	Hub       Identity `json:"hub"`
	SpaceID   string   `json:"spaceId"`
	SpaceKind string   `json:"spaceKind,omitempty"`
	UserID    string   `json:"userId"`
	DeviceID  string   `json:"deviceId"`
	Role      Role     `json:"role"`
	Token     string   `json:"token"`
}
type Space struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	Kind string `json:"kind"`
}
type Device struct {
	Node          *NodeDescriptor `json:"node,omitempty"`
	Identity      `tstype:",extends"`
	SpaceID       string `json:"spaceId"`
	Name          string `json:"name"`
	Role          Role   `json:"role"`
	Platform      string `json:"platform"`
	Online        bool   `json:"online"`
	DesktopActive bool   `json:"desktopActive,omitempty"`
	Draining      bool   `json:"draining"`
	Revoked       bool   `json:"revoked"`
	LastSeen      int64  `json:"lastSeen"`
	Version       int64  `json:"version"`
}
type AvatarSpec struct {
	Kind  string `json:"kind"`
	Value string `json:"value,omitempty"`
	Color string `json:"color,omitempty"`
}
type ModelOption struct {
	ID            string   `json:"id"`
	Name          string   `json:"name,omitempty"`
	Description   string   `json:"description,omitempty"`
	ResolvedModel string   `json:"resolvedModel,omitempty"`
	Efforts       []string `json:"efforts,omitempty"`
	DefaultEffort string   `json:"defaultEffort,omitempty"`
	Fast          bool     `json:"fast,omitempty"`
}
type ModelSelection struct {
	Provider   string `json:"provider,omitempty"`
	Model      string `json:"model,omitempty"`
	Effort     string `json:"effort,omitempty"`
	Fast       bool   `json:"fast,omitempty"`
	Permission string `json:"permission,omitempty"`
}
type AttachmentRef struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	MediaType string `json:"mediaType,omitempty"`
	Size      int64  `json:"size,omitempty"`
}
type AttachmentUpload struct {
	ChatID  string `json:"chatId,omitempty"`
	AgentID string `json:"agentId,omitempty"`
	Name    string `json:"name"`
	Data    string `json:"data"` // base64-encoded file bytes
}
type Reference struct {
	Kind         string `json:"kind"`
	Name         string `json:"name"`
	ID           string `json:"id,omitempty"`
	Path         string `json:"path,omitempty"`
	Provider     string `json:"provider,omitempty"`
	Description  string `json:"description,omitempty"`
	ArgumentHint string `json:"argumentHint,omitempty"`
	Start        *int   `json:"start,omitempty"`
	End          *int   `json:"end,omitempty"`
}
type SlashCommand struct {
	Name         string `json:"name"`
	Description  string `json:"description,omitempty"`
	ArgumentHint string `json:"argumentHint,omitempty"`
}
type ProviderCatalog struct {
	ID       string         `json:"id"`
	Name     string         `json:"name"`
	Type     string         `json:"type"`
	PluginID string         `json:"pluginId,omitempty"`
	Models   []ModelOption  `json:"models,omitempty"`
	Commands []SlashCommand `json:"commands,omitempty"`
}
type ComposerMeta struct {
	Providers     []ProviderCatalog   `json:"providers"`
	StarredModels map[string][]string `json:"starredModels"`
	Skills        []Reference         `json:"skills"`
}
type Group struct {
	ID    string `json:"id"`
	Name  string `json:"name"`
	State string `json:"state,omitempty"`
}
type Item struct {
	ID        string `json:"id"`
	Kind      string `json:"kind"`
	Title     string `json:"title,omitempty"`
	Text      string `json:"text,omitempty"`
	Truncated bool   `json:"truncated,omitempty"`
}
type Option struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Description string `json:"description,omitempty"`
	Preview     string `json:"preview,omitempty"`
	Recommended bool   `json:"recommended,omitempty"`
	Allow       bool   `json:"allow,omitempty"`
}
type Question struct {
	ID            string   `json:"id"`
	Header        string   `json:"header,omitempty"`
	Text          string   `json:"text"`
	Multiple      bool     `json:"multiple,omitempty"`
	AllowCustom   *bool    `json:"allowCustom,omitempty"`
	Required      *bool    `json:"required,omitempty"`
	InitialAnswer string   `json:"initialAnswer,omitempty"`
	Placeholder   string   `json:"placeholder,omitempty"`
	InputType     string   `json:"inputType,omitempty"`
	Secret        bool     `json:"secret,omitempty"`
	Options       []Option `json:"options,omitempty"`
}
type Answer struct {
	Allow    bool                `json:"allow"`
	OptionID string              `json:"optionId,omitempty"`
	Answers  map[string][]string `json:"answers,omitempty"`
}

// Record is a projection of a shared entity. ID is unique within (device, kind).
type FileStat struct {
	Name      string `json:"name"`
	Additions int    `json:"additions"`
	Deletions int    `json:"deletions"`
}
type DiffSummary struct {
	Files     int `json:"files,omitempty"`
	Additions int `json:"additions,omitempty"`
	Deletions int `json:"deletions,omitempty"`
}
type Record struct {
	CanSteer          bool            `json:"canSteer,omitempty"`
	Files             []FileStat      `json:"files,omitempty"`
	Diff              *DiffSummary    `json:"diff,omitempty"`
	Error             string          `json:"error,omitempty"`
	WorkingCopyID     string          `json:"workingCopyId,omitempty"`
	WorkingCopyName   string          `json:"workingCopyName,omitempty"`
	AnsweredByUserID  string          `json:"answeredByUserId,omitempty"`
	Avatar            string          `json:"avatar,omitempty"`
	AvatarSpec        *AvatarSpec     `json:"avatarSpec,omitempty"`
	Description       string          `json:"description,omitempty"`
	Permission        string          `json:"permission,omitempty"`
	AcceptDelegations *bool           `json:"acceptDelegations,omitempty"`
	Private           bool            `json:"private,omitempty"`
	Kind              string          `json:"kind"`
	ID                string          `json:"id"`
	AgentID           string          `json:"agentId,omitempty"`
	ChatID            string          `json:"chatId,omitempty"`
	SessionID         string          `json:"sessionId,omitempty"`
	RunID             string          `json:"runId,omitempty"`
	TaskID            string          `json:"taskId,omitempty"`
	DispatchID        string          `json:"dispatchId,omitempty"`
	Title             string          `json:"title,omitempty"`
	Status            string          `json:"status,omitempty"`
	Type              string          `json:"type,omitempty"`
	Model             string          `json:"model,omitempty"`
	Effort            string          `json:"effort,omitempty"`
	Fast              bool            `json:"fast,omitempty"`
	Provider          string          `json:"provider,omitempty"`
	Models            []ModelOption   `json:"models,omitempty"`
	Groups            []Group         `json:"groups,omitempty"`
	Attachments       []AttachmentRef `json:"attachments,omitempty"`
	Text              string          `json:"text,omitempty"`
	Items             []Item          `json:"items,omitempty"`
	StepCount         int             `json:"stepCount,omitempty"`
	Truncated         bool            `json:"truncated,omitempty"`
	Superseded        bool            `json:"superseded,omitempty"`
	QueuePaused       bool            `json:"queuePaused,omitempty"`
	UnreadSequence    int64           `json:"unreadSequence,omitempty"`
	ReadSequence      int64           `json:"readSequence,omitempty"`
	ClearedSequence   int64           `json:"clearedSequence,omitempty"`
	Preview           string          `json:"preview,omitempty"`
	MessageAt         string          `json:"messageAt,omitempty"`
	ActiveStatus      string          `json:"activeStatus,omitempty"`
	PendingCount      int             `json:"pendingCount,omitempty"`
	ReplyCount        int             `json:"replyCount,omitempty"`
	SourceRunID       string          `json:"sourceRunId,omitempty"`
	Sequence          int64           `json:"sequence,omitempty"`
	CreatedAt         string          `json:"createdAt,omitempty"`
	UpdatedAt         string          `json:"updatedAt,omitempty"`
	Questions         []Question      `json:"questions,omitempty"`
	Options           []Option        `json:"options,omitempty"`
	Answer            *Answer         `json:"answer,omitempty"`
	AllowOnce         *Answer         `json:"allowOnce,omitempty"`
	ExpiresAt         string          `json:"expiresAt,omitempty"`
	AutoAnswered      bool            `json:"autoAnswered,omitempty"`
}
type Change struct {
	Record  `tstype:",extends"`
	Deleted bool `json:"deleted,omitempty"`
}

type ArchiveCursor struct {
	Epoch   string `json:"epoch"`
	Version int64  `json:"version"`
	Stream  string `json:"stream"`
}
type ArchivePage struct {
	Cursor  ArchiveCursor `json:"cursor"`
	Full    bool          `json:"full"`
	Changes []Change      `json:"changes"`
}

// Only routing identifiers cross the system push service.
type PushNotice struct {
	HubID     string `json:"hubId"`
	SpaceID   string `json:"spaceId"`
	DeviceID  string `json:"deviceId"`
	ChatID    string `json:"chatId"`
	SessionID string `json:"sessionId,omitempty"`
	RunID     string `json:"runId,omitempty"`
	RequestID string `json:"requestId,omitempty"`
	Kind      string `json:"kind"`
}
type FirebaseClient struct {
	ProjectID string `json:"projectId"`
	AppID     string `json:"appId"`
	APIKey    string `json:"apiKey"`
	SenderID  string `json:"senderId"`
}
type PushSettings struct {
	Available                bool            `json:"available"`
	Enabled                  bool            `json:"enabled"`
	SilenceWhenDesktopActive bool            `json:"silenceWhenDesktopActive"`
	Firebase                 *FirebaseClient `json:"firebase,omitempty"`
}
type PushPreferences struct {
	SilenceWhenDesktopActive *bool `json:"silenceWhenDesktopActive,omitempty"`
}
type ReadMark struct {
	SessionID string `json:"sessionId"`
	Sequence  int64  `json:"sequence"`
}
type ReadSync struct {
	DeviceID string     `json:"deviceId,omitempty"`
	Items    []ReadMark `json:"items"`
}
type ClearMark struct {
	SessionID string `json:"sessionId"`
	Sequence  int64  `json:"sequence"`
}
type ClearSync struct {
	DeviceID string      `json:"deviceId,omitempty"`
	Items    []ClearMark `json:"items"`
}
type Frame struct {
	Features      []string        `json:"features,omitempty"`
	TunnelID      string          `json:"tunnelId,omitempty"`
	Node          *NodeDescriptor `json:"node,omitempty"`
	ControllerID  string          `json:"controllerId,omitempty"`
	Delegation    bool            `json:"delegation,omitempty"`
	Digest        string          `json:"digest,omitempty"`
	Receipt       *Receipt        `json:"receipt,omitempty"`
	Completed     bool            `json:"completed,omitempty"`
	Policy        int64           `json:"policy,omitempty"`
	RPCID         string          `json:"rpcId,omitempty"`
	SessionID     string          `json:"sessionId,omitempty"`
	RunID         string          `json:"runId,omitempty"`
	Idle          bool            `json:"idle,omitempty"`
	DesktopActive bool            `json:"desktopActive,omitempty"`
	Type          string          `json:"type"`
	Protocol      int             `json:"protocol,omitempty"`
	SpaceID       string          `json:"spaceId"`
	DeviceID      string          `json:"deviceId"`
	Epoch         string          `json:"epoch,omitempty"`
	Base          int64           `json:"base,omitempty"`
	Version       int64           `json:"version,omitempty"`
	Full          bool            `json:"full,omitempty"`
	Changes       []Change        `json:"changes,omitempty"`
	ReadMarks     []ReadMark      `json:"readMarks,omitempty"`
	ClearMarks    []ClearMark     `json:"clearMarks,omitempty"`
}
type ChatRef struct {
	DeviceID  string `json:"deviceId"`
	ChatID    string `json:"chatId"`
	SessionID string `json:"sessionId,omitempty"`
}
type Task struct {
	Project         string   `json:"project,omitempty"`
	Source          *ChatRef `json:"source,omitempty"`
	DeviceID        string   `json:"deviceId,omitempty"`
	ID              string   `json:"id"`
	Title           string   `json:"title"`
	Body            string   `json:"body"`
	Version         int64    `json:"version"`
	Status          string   `json:"status"`
	DispatchID      string   `json:"dispatchId,omitempty"`
	AcceptedRunID   string   `json:"acceptedRunId,omitempty"`
	AcceptedOffline bool     `json:"acceptedOffline,omitempty"`
}
type Dispatch struct {
	Superseded     bool   `json:"superseded,omitempty"`
	ID             string `json:"id"`
	TaskID         string `json:"taskId"`
	DeviceID       string `json:"deviceId"`
	AgentID        string `json:"agentId"`
	WorkingCopyID  string `json:"workingCopyId,omitempty"`
	Instruction    string `json:"instruction"`
	ActorUserID    string `json:"actorUserId"`
	OriginDeviceID string `json:"originDeviceId,omitempty"`
	Status         string `json:"status"`
	ChatID         string `json:"chatId,omitempty"`
	SessionID      string `json:"sessionId,omitempty"`
	RunID          string `json:"runId,omitempty"`
}

type DelegationOrigin struct {
	DeviceID          string   `json:"deviceId"`
	DeviceName        string   `json:"deviceName,omitempty"`
	AgentID           string   `json:"agentId"`
	AgentName         string   `json:"agentName,omitempty"`
	ChatID            string   `json:"chatId"`
	SessionID         string   `json:"sessionId"`
	RunID             string   `json:"runId"`
	DelegationID      string   `json:"delegationId"`
	MaxPermissionMode string   `json:"maxPermissionMode,omitempty"`
	Depth             int      `json:"depth,omitempty"`
	MaxDepth          int      `json:"maxDepth,omitempty"`
	Chain             []string `json:"chain,omitempty"`
}

// Intent is a proposed user action. Execution credentials, providers and paths
// are never chosen by a controller. Only the owning Host can record a receipt.
type Intent struct {
	Private        bool              `json:"private,omitempty"`
	ID             string            `json:"id"`
	Kind           string            `json:"kind"`
	DeviceID       string            `json:"deviceId"`
	AgentID        string            `json:"agentId,omitempty"`
	WorkingCopyID  string            `json:"workingCopyId,omitempty"`
	ChatID         string            `json:"chatId,omitempty"`
	SessionID      string            `json:"sessionId,omitempty"`
	RunID          string            `json:"runId,omitempty"`
	RequestID      string            `json:"requestId,omitempty"`
	TaskID         string            `json:"taskId,omitempty"`
	Operation      string            `json:"operation,omitempty"`
	Delivery       string            `json:"delivery,omitempty"`
	Text           string            `json:"text,omitempty"`
	Selection      *ModelSelection   `json:"selection,omitempty"`
	AttachmentIDs  []string          `json:"attachmentIds,omitempty"`
	References     []Reference       `json:"references,omitempty"`
	Answer         *Answer           `json:"answer,omitempty"`
	Delegation     *DelegationOrigin `json:"delegation,omitempty"`
	ActorUserID    string            `json:"actorUserId,omitempty"`
	OriginDeviceID string            `json:"originDeviceId,omitempty"`
}
type Receipt struct {
	ID        string `json:"id"`
	Status    string `json:"status"`
	ChatID    string `json:"chatId,omitempty"`
	SessionID string `json:"sessionId,omitempty"`
	RunID     string `json:"runId,omitempty"`
	Detail    string `json:"detail,omitempty"`
}
type InboxItem struct {
	Intent  Intent  `json:"intent"`
	Receipt Receipt `json:"receipt"`
}

// Features describe the binary. AccessLevel describes the owner's current grant.
type AccessLevel string

const (
	AccessNone      AccessLevel = "none"
	AccessChat      AccessLevel = "chat"
	AccessWorkspace AccessLevel = "workspace"
	AccessAdmin     AccessLevel = "admin"
)

const (
	FeatureWorkspaceAssets   = "workspace_assets_v1"
	FeatureAgentSkills       = "agent_skills_v1"
	FeatureHealth            = "peer_health_v1"
	FeatureChatControls      = "chat_controls_v1"
	FeatureTerminal          = "terminal_v1"
	FeatureDelegationTargets = "delegation_targets_v1"
	FeatureDelegate          = "delegation_v1"
	FeatureManage            = "agent_manage_v1"
	FeatureGit               = "git_v1"
	FeatureHotCache          = "hot_cache_v1"
	FeaturePeer              = "peer_v1"
	FeatureTunnel            = "tunnel_v1"
	FeatureFiles             = "fs_v1"
)

type BrowseRootInfo struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

type NodeDescriptor struct {
	BrowseRoots           []BrowseRootInfo `json:"browseRoots,omitempty"`
	LeverVersion          string           `json:"leverVersion,omitempty"`
	DelegationEnabled     *bool            `json:"delegationEnabled,omitempty"`
	CacheEpoch            string           `json:"cacheEpoch,omitempty"`
	CacheRevision         int64            `json:"cacheRevision,omitempty"`
	NodeID                string           `json:"nodeId"`
	PublicKey             []byte           `json:"publicKey"`
	Name                  string           `json:"name"`
	Platform              string           `json:"platform"`
	ProtocolVersion       int              `json:"protocolVersion"`
	MinCompatibleProtocol int              `json:"minCompatibleProtocol"`
	Features              []string         `json:"features"`
	Online                bool             `json:"online"`
	Draining              bool             `json:"draining"`
	CanControl            bool             `json:"canControl"`
	AccessLevel           AccessLevel      `json:"accessLevel"`
	ReadOnlyFS            bool             `json:"readOnlyFs"`
}
