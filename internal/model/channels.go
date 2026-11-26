package model

// ChannelView is the renderer's view of a built-in channel connection.
// Credentials and routing identifiers stay in the host. The pending pair
// exposes only the sender's app-scoped open ID for local confirmation.
type ChannelView struct {
	Configured    bool                 `json:"configured"`
	Enabled       bool                 `json:"enabled"`
	Connection    string               `json:"connection"`
	AppID         string               `json:"appId,omitempty"`
	Brand         string               `json:"brand,omitempty"`
	BotName       string               `json:"botName,omitempty"`
	OwnerName     string               `json:"ownerName,omitempty"`
	AgentID       string               `json:"agentId,omitempty"`
	ChatID        string               `json:"chatId,omitempty"`
	Paused        bool                 `json:"paused"`
	PairCode      string               `json:"pairCode,omitempty"`
	PairCandidate string               `json:"pairCandidate,omitempty"`
	PairLocked    bool                 `json:"pairLocked,omitempty"`
	LastMessageAt string               `json:"lastMessageAt,omitempty"`
	Registration  *ChannelRegistration `json:"registration,omitempty"`
	Bots          []FeishuBotView      `json:"bots,omitempty"`
}

type FeishuBotView struct {
	ID            string            `json:"id"`
	AppID         string            `json:"appId"`
	Brand         string            `json:"brand"`
	BotName       string            `json:"botName,omitempty"`
	Enabled       bool              `json:"enabled"`
	Connection    string            `json:"connection"`
	OwnerName     string            `json:"ownerName,omitempty"`
	ChatID        string            `json:"chatId,omitempty"`
	Paired        bool              `json:"paired"`
	PairCode      string            `json:"pairCode,omitempty"`
	PairCandidate string            `json:"pairCandidate,omitempty"`
	PairLocked    bool              `json:"pairLocked,omitempty"`
	LastMessageAt string            `json:"lastMessageAt,omitempty"`
	MissingScopes []string          `json:"missingScopes,omitempty"`
	Settings      FeishuBotSettings `json:"settings"`
}

type FeishuBotSettings struct {
	DisplayName      string               `json:"displayName,omitempty"`
	AgentID          string               `json:"agentId,omitempty"`
	Selection        *Selection           `json:"selection,omitempty"`
	DMMode           string               `json:"dmMode,omitempty"`           // "continuous" | "topic"
	ReplyStyle       string               `json:"replyStyle,omitempty"`       // "card" | "text"
	GroupEnabled     bool                 `json:"groupEnabled"`
	GroupMention     string               `json:"groupMention,omitempty"`     // "at_only" | "thread_free" | "yield" | "free"
	GroupReplyTarget string               `json:"groupReplyTarget,omitempty"` // "topic" | "main" | "quote"
	DMAccess         string               `json:"dmAccess,omitempty"`         // "admin" | "whitelist" | "all"
	DMWhitelist      []string             `json:"dmWhitelist,omitempty"`
	GroupAccess      string               `json:"groupAccess,omitempty"`      // "whitelist" | "any"
	ReplyMention     string               `json:"replyMention,omitempty"`     // "none" | "requester" | "members"
	Admins           []string             `json:"admins,omitempty"`
	DefaultPrompt    string               `json:"defaultPrompt,omitempty"`
	ChatOverrides    []FeishuChatOverride `json:"chatOverrides,omitempty"`
	Advanced         FeishuBotAdvanced    `json:"advanced"`
}

type FeishuChatOverride struct {
	ID               string     `json:"id"`
	ChatID           string     `json:"chatId"`
	ChatName         string     `json:"chatName,omitempty"`
	Enabled          bool       `json:"enabled"`
	PromptMode       string     `json:"promptMode,omitempty"`       // "append" | "replace"
	Prompt           string     `json:"prompt,omitempty"`
	Selection        *Selection `json:"selection,omitempty"`
	GroupMention     string     `json:"groupMention,omitempty"`     // "" (inherit) | "at_only" | "thread_free" | "yield" | "free"
	GroupReplyTarget string     `json:"groupReplyTarget,omitempty"` // "" (inherit) | "topic" | "main" | "quote" | "dm_first"
	ReplyStyle       string     `json:"replyStyle,omitempty"`       // "" (inherit) | "card" | "text"
}

type FeishuBotAdvanced struct {
	ReactionAck        bool     `json:"reactionAck"`
	SenderTag          bool     `json:"senderTag"`
	HideLocalAddresses bool     `json:"hideLocalAddresses"`
	HistoryLimit       int      `json:"historyLimit"`
	TrustSameOwnerBots bool     `json:"trustSameOwnerBots"`
	SessionMapping     string   `json:"sessionMapping,omitempty"` // "single_chat_topics" | "per_feishu_chat"
	ApprovalMode       string   `json:"approvalMode,omitempty"`   // "lever" | "feishu_card"
	BlockedUsers       []string `json:"blockedUsers,omitempty"`
}

type FeishuKnownChat struct {
	ChatID  string `json:"chatId"`
	Name    string `json:"name"`
	Members int    `json:"members,omitempty"`
}

type FeishuBotCreateInput struct {
	AppID       string             `json:"appId"`
	AppSecret   string             `json:"appSecret"`
	Brand       string             `json:"brand,omitempty"`
	DisplayName string             `json:"displayName,omitempty"`
	AgentID     string             `json:"agentId,omitempty"`
	Preset      string             `json:"preset,omitempty"` // "personal" | "dev" | "oncall"
	Settings    *FeishuBotSettings `json:"settings,omitempty"`
}

type FeishuBotCredentialsInput struct {
	DisplayName string `json:"displayName,omitempty"`
	AppID       string `json:"appId"`
	AppSecret   string `json:"appSecret,omitempty"`
	Brand       string `json:"brand,omitempty"`
}

type FeishuRegistrationInput struct {
	DisplayName string             `json:"displayName,omitempty"`
	AgentID     string             `json:"agentId,omitempty"`
	Preset      string             `json:"preset,omitempty"`
	Brand       string             `json:"brand,omitempty"`
	Settings    *FeishuBotSettings `json:"settings,omitempty"`
}

type ChannelRegistration struct {
	Phase string `json:"phase"`
	URL   string `json:"url,omitempty"`
	AppID string `json:"appId,omitempty"`
	Brand string `json:"brand,omitempty"`
}

type ChannelPairInput struct {
	Candidate string             `json:"candidate"`
	AgentID   string             `json:"agentId,omitempty"`
	Name      string             `json:"name,omitempty"`
	NewAgent  *ChannelAgentDraft `json:"newAgent,omitempty"`
}

type ChannelAgentDraft struct {
	Provider  string `json:"provider"`
	Directory string `json:"directory"`
}

type ChannelTurn struct {
	Status string `json:"status"`
}

type ChannelOrigin struct {
	Channel  string `json:"channel"`
	ChatID   string `json:"chatId,omitempty"`
	ChatName string `json:"chatName,omitempty"`
	Kind     string `json:"kind,omitempty"`
	Command  string `json:"command,omitempty"`
}

type PersonalChannelChatMode string

const (
	PersonalChannelChatSingle PersonalChannelChatMode = "single"
	PersonalChannelChatByChat PersonalChannelChatMode = "byChat"
)

func (mode PersonalChannelChatMode) Valid() bool {
	return mode == PersonalChannelChatSingle || mode == PersonalChannelChatByChat
}

type PersonalChannelRoute struct {
	AgentID   string     `json:"agentId"`
	Commands  []string   `json:"commands"`
	Enabled   bool       `json:"enabled"`
	Selection *Selection `json:"selection,omitempty"` // nil follows the Agent's current profile.
}

type PersonalChannelSettings struct {
	Routes       []PersonalChannelRoute  `json:"routes"`
	ChatIDs      []string                `json:"chatIds"`
	ChatMode     PersonalChannelChatMode `json:"chatMode"`
	ThreadReply  bool                    `json:"threadReply"`
	Reaction     string                  `json:"reaction"`
	Prompt       string                  `json:"prompt"`
	Signature    string                  `json:"signature"`
	ContextLimit int                     `json:"contextLimit"`
}

type PersonalChannelView struct {
	Settings PersonalChannelSettings `json:"settings"`
	State    string                  `json:"state"`
	Region   string                  `json:"region"`
	Account  string                  `json:"account,omitempty"`
	QR       string                  `json:"qr,omitempty"`
	Last     *PersonalChannelReceipt `json:"last,omitempty"`
}

type PersonalChannelReceipt struct {
	Command        string    `json:"command"`
	ChatID         string    `json:"chatId"`
	SessionID      string    `json:"sessionId,omitempty"`
	RunID          string    `json:"runId,omitempty"`
	Topic          bool      `json:"topic,omitempty"`
	ChatName       string    `json:"chatName,omitempty"`
	AgentID        string    `json:"agentId"`
	Status         string    `json:"status"`
	RunStatus      string    `json:"runStatus"`
	Selection      Selection `json:"selection"`
	ContextReady   bool      `json:"contextReady"`
	Reaction       string    `json:"reaction,omitempty"`
	ReactionStatus string    `json:"reactionStatus,omitempty"` // Empty for turns accepted before reaction tracking.
}
