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
