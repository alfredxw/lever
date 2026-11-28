package remoteproto

import (
	"errors"
	"lever/internal/model"
	"net/url"
	"slices"
	"strings"
)

// MaxPeerBody includes multipart overhead or escaped JSON for a workspace file.
const MaxPeerBody = 21 << 20

func (l AccessLevel) Allows(required AccessLevel) bool {
	switch required {
	case AccessChat:
		return l == AccessChat || l == AccessWorkspace || l == AccessAdmin
	case AccessWorkspace:
		return l == AccessWorkspace || l == AccessAdmin
	case AccessAdmin:
		return l == AccessAdmin
	}
	return false
}

func (n NodeDescriptor) Supports(feature string) bool {
	return n.MinCompatibleProtocol > 0 && n.MinCompatibleProtocol <= Version && n.ProtocolVersion >= Version && slices.Contains(n.Features, feature)
}

func HubPairLink(link string) (origin, code string, err error) {
	u, err := url.Parse(strings.TrimSpace(link))
	if err != nil || u.Scheme != "leverdevice" || u.Host != "pair" || u.User != nil || u.Query().Get("lan") != "" {
		return "", "", errors.New("invalid Hub pairing link")
	}
	origin, err = Origin(u.Query().Get("hub"))
	code = strings.TrimSpace(u.Query().Get("code"))
	if err != nil || code == "" {
		return "", "", errors.New("Hub pairing link requires a Hub and a pairing code")
	}
	return origin, code, nil
}

// NodeOverview contains the same resource types that the local workbench uses.
type NodeOverview struct {
	ActiveRuns    *[]Record            `json:"activeRuns,omitempty"` // Present only on a live progress request.
	Node          NodeDescriptor       `json:"node"`
	Agents        []model.Agent        `json:"agents"`
	Chats         []model.Chat         `json:"chats"`
	Conversations []model.Conversation `json:"conversations"`
	Cursor        int64                `json:"cursor"`
}
type CacheIndex struct {
	NodeOverview
	Revisions map[string]int64 `json:"revisions"`
}

func (v *NodeOverview) TagResources() {
	for i := range v.Agents {
		v.Agents[i].NodeID = v.Node.NodeID
	}
	for i := range v.Chats {
		v.Chats[i].NodeID = v.Node.NodeID
	}
	for i := range v.Conversations {
		v.Conversations[i].NodeID = v.Node.NodeID
	}
}

type PeerRun struct {
	Run      model.Run       `json:"run"`
	Requests []model.Request `json:"requests"`
}
