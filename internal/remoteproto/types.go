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
type PairInput struct {
	Code     string `json:"code"`
	Identity `tstype:",extends"`
	Name     string `json:"name"`
	Platform string `json:"platform"`
	Role     Role   `json:"role"`
	Proof    []byte `json:"proof"`
}
type Membership struct {
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
	Identity `tstype:",extends"`
	SpaceID  string `json:"spaceId"`
	Name     string `json:"name"`
	Role     Role   `json:"role"`
	Platform string `json:"platform"`
	Online   bool   `json:"online"`
	Draining bool   `json:"draining"`
	Revoked  bool   `json:"revoked"`
	LastSeen int64  `json:"lastSeen"`
	Version  int64  `json:"version"`
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
	ID    string `json:"id"`
	Name  string `json:"name"`
	Allow bool   `json:"allow,omitempty"`
}
type Question struct {
	ID       string   `json:"id"`
	Text     string   `json:"text"`
	Multiple bool     `json:"multiple,omitempty"`
	Options  []Option `json:"options,omitempty"`
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
type Record struct {
	CanSteer          bool       `json:"canSteer,omitempty"`
	Files             []FileStat `json:"files,omitempty"`
	Error             string     `json:"error,omitempty"`
	WorkingCopyID     string     `json:"workingCopyId,omitempty"`
	WorkingCopyName   string     `json:"workingCopyName,omitempty"`
	AnsweredByUserID  string     `json:"answeredByUserId,omitempty"`
	Avatar            string     `json:"avatar,omitempty"`
	Description       string     `json:"description,omitempty"`
	Permission        string     `json:"permission,omitempty"`
	AcceptDelegations *bool      `json:"acceptDelegations,omitempty"`
	Private           bool       `json:"private,omitempty"`
	Kind              string     `json:"kind"`
	ID               string     `json:"id"`
	AgentID          string     `json:"agentId,omitempty"`
	ChatID           string     `json:"chatId,omitempty"`
	SessionID        string     `json:"sessionId,omitempty"`
	RunID            string     `json:"runId,omitempty"`
	TaskID           string     `json:"taskId,omitempty"`
	DispatchID       string     `json:"dispatchId,omitempty"`
	Title            string     `json:"title,omitempty"`
	Status           string     `json:"status,omitempty"`
	Type             string     `json:"type,omitempty"`
	Model            string     `json:"model,omitempty"`
	Provider         string     `json:"provider,omitempty"`
	Groups           []Group    `json:"groups,omitempty"`
	Text             string     `json:"text,omitempty"`
	Items            []Item     `json:"items,omitempty"`
	Truncated        bool       `json:"truncated,omitempty"`
	Superseded       bool       `json:"superseded,omitempty"`
	QueuePaused      bool       `json:"queuePaused,omitempty"`
	UnreadSequence   int64      `json:"unreadSequence,omitempty"`
	ReadSequence     int64      `json:"readSequence,omitempty"`
	Preview          string     `json:"preview,omitempty"`
	MessageAt        string     `json:"messageAt,omitempty"`
	ActiveStatus     string     `json:"activeStatus,omitempty"`
	PendingCount     int        `json:"pendingCount,omitempty"`
	ReplyCount       int        `json:"replyCount,omitempty"`
	SourceRunID      string     `json:"sourceRunId,omitempty"`
	Sequence         int64      `json:"sequence,omitempty"`
	CreatedAt        string     `json:"createdAt,omitempty"`
	UpdatedAt        string     `json:"updatedAt,omitempty"`
	Questions        []Question `json:"questions,omitempty"`
	Options          []Option   `json:"options,omitempty"`
	Answer           *Answer    `json:"answer,omitempty"`
	AllowOnce        *Answer    `json:"allowOnce,omitempty"`
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
	Available bool            `json:"available"`
	Enabled   bool            `json:"enabled"`
	Firebase  *FirebaseClient `json:"firebase,omitempty"`
}
type ReadMark struct {
	SessionID string `json:"sessionId"`
	Sequence  int64  `json:"sequence"`
}
type ReadSync struct {
	DeviceID string     `json:"deviceId,omitempty"`
	Items    []ReadMark `json:"items"`
}
type Frame struct {
	ControllerID string     `json:"controllerId,omitempty"`
	Delegation   bool       `json:"delegation,omitempty"`
	Digest       string     `json:"digest,omitempty"`
	Receipt      *Receipt   `json:"receipt,omitempty"`
	Completed    bool       `json:"completed,omitempty"`
	Policy       int64      `json:"policy,omitempty"`
	RPCID        string     `json:"rpcId,omitempty"`
	SessionID    string     `json:"sessionId,omitempty"`
	RunID        string     `json:"runId,omitempty"`
	Idle         bool       `json:"idle,omitempty"`
	Type         string     `json:"type"`
	Protocol     int        `json:"protocol,omitempty"`
	SpaceID      string     `json:"spaceId"`
	DeviceID     string     `json:"deviceId"`
	Epoch        string     `json:"epoch,omitempty"`
	Base         int64      `json:"base,omitempty"`
	Version      int64      `json:"version,omitempty"`
	Full         bool       `json:"full,omitempty"`
	Changes      []Change   `json:"changes,omitempty"`
	ReadMarks    []ReadMark `json:"readMarks,omitempty"`
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
