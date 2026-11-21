package model

const MaxComparisonAgents = 16

type ComparisonInput struct {
	CommandID     string                         `json:"commandId"`
	ChatID        string                         `json:"chatId"`
	AgentID       string                         `json:"agentId,omitempty"`
	AgentIDs      []string                       `json:"agentIds"`
	SharedScope   bool                           `json:"sharedScope,omitempty"`
	Selections    map[string]ComparisonSelection `json:"selections,omitempty"`
	Text          string                         `json:"text"`
	AttachmentIDs []string                       `json:"attachmentIds,omitempty"`
	References    []Reference                    `json:"references,omitempty"`
	Quote         *MessageQuote                  `json:"quote,omitempty"`
}

// ModelName captures the runtime's display name for model IDs such as "default".
type ComparisonSelection struct {
	Selection `tstype:",extends"`
	ModelName string `json:"modelName,omitempty"`
}

// A comparison uses its first accepted run's position in the source Chat.
// Each participant keeps an ordinary Topic session and its own transcript.
type Comparison struct {
	ID         string   `json:"id"`
	ChatID     string   `json:"chatId"`
	Sequence   int64    `json:"sequence"`
	SessionIDs []string `json:"sessionIds"`
	Message    Message  `json:"message"`
}

type ComparisonOrigin struct {
	ID        string `json:"id"`
	ChatID    string `json:"chatId"`
	ModelName string `json:"modelName,omitempty"`
}

type ComparisonResult struct {
	Session Session `json:"session"`
	Run     Run     `json:"run"`
}
