package model

// A directory group replaces selected Git checkouts in the Agent or Project Scope.
type DirectoryGroup struct {
	ID          string   `json:"id"`
	AgentID     string   `json:"agentId,omitempty"`
	ProjectID   string   `json:"projectId,omitempty"`
	Name        string   `json:"name"`
	Archived    bool     `json:"archived"`
	WorktreeIDs []string `json:"worktreeIds"`
}

// WorkingCopy is the directory group resolved against the current Scope.
type WorkingCopy struct {
	DirectoryGroup `tstype:",extends"`
	Scope          `tstype:",extends"`
	State          string         `json:"state"`
	Checkouts      []CopyCheckout `json:"checkouts"`
	Topics         []CopyTopic    `json:"topics,omitempty"`
	Error          string         `json:"error,omitempty"`
}

type CopyCheckout struct {
	ID     string `json:"id"`
	Name   string `json:"name,omitempty"`
	Ready  bool   `json:"ready"`
	Source string `json:"source"`
	GitDir string `json:"gitDir"`
	Path   string `json:"path"`
	Branch string `json:"branch"`
	Base   string `json:"base,omitempty"` // A base commit denotes a Lever-owned checkout.
	Error  string `json:"error,omitempty"`
}

type CopyTopic struct {
	ID      string `json:"id"`
	ChatID  string `json:"chatId"`
	AgentID string `json:"agentId,omitempty"`
	Title   string `json:"title"`
	Busy    bool   `json:"busy"`
}

type CopyOptions struct {
	Scope  `tstype:",extends"`
	Groups []CheckoutOptions `json:"groups"`
}

type CheckoutOptions struct {
	Source    string        `json:"source"`
	GitDir    string        `json:"gitDir"`
	Setup     string        `json:"setup,omitempty"`
	RootIDs   []string      `json:"rootIds"`
	Head      string        `json:"head"`
	Bases     []GitCommit   `json:"bases"` // Subject is the local branch name.
	Existing  []GitCheckout `json:"existing"`
	NewPath   string        `json:"newPath"`
	NewBranch string        `json:"newBranch"`
}

type GitCheckout struct {
	Path   string `json:"path"`
	Branch string `json:"branch"`
	Name   string `json:"name,omitempty"`
}

type CreateWorkingCopy struct {
	Scope   Scope        `json:"scope"`
	ID      string       `json:"id"`
	Name    string       `json:"name"`
	Choices []CopyChoice `json:"choices"`
}

type CopyChoice struct {
	Source string `json:"source"`
	Base   string `json:"base,omitempty"`
	Path   string `json:"path,omitempty"`
}

type CreateWorktree struct {
	ID     string     `json:"id"`
	Name   string     `json:"name"`
	Choice CopyChoice `json:"choice"`
}
