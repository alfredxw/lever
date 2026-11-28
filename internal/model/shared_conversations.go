package model

// SharedConversation identifies a conversation whose history and execution
// belong to a native application.
type SharedConversation struct {
	ID        string          `json:"id"`
	Provider  string          `json:"provider"`
	Runtime   string          `json:"runtime"`
	Title     string          `json:"title"`
	Cwd       string          `json:"cwd"`
	Preview   string          `json:"preview,omitempty"`
	UpdatedAt string          `json:"updatedAt"`
	Activity  *SharedActivity `json:"activity,omitempty"`
}

type SharedActivity struct {
	Status    string `json:"status"`
	TurnID    string `json:"turnId,omitempty"`
	StartedAt string `json:"startedAt,omitempty"`
}

type SharedMessage struct {
	Item      `tstype:",extends"`
	Role      string        `json:"role"`
	TurnID    string        `json:"turnId,omitempty"`
	CreatedAt string        `json:"createdAt"`
	Images    []SharedImage `json:"images,omitempty"`
}

type SharedImage struct {
	ID   string `json:"id"`
	Name string `json:"name,omitempty"`
}

type SharedHistory struct {
	Conversation SharedConversation `json:"conversation"`
	Messages     []SharedMessage    `json:"messages"`
	More         bool               `json:"more"`
	Busy         bool               `json:"busy"`
	CanSend      bool               `json:"canSend"`
}

type SharedConversations struct {
	Conversations []SharedConversation `json:"conversations"`
	Unavailable   []string             `json:"unavailable"`
}
