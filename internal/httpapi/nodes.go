package httpapi

import (
	"net/http"
	"os"
	"runtime"

	"lever/internal/model"
	p "lever/internal/remoteproto"
)

func (s *Server) overview(w http.ResponseWriter, r *http.Request) {
	local, err := s.App.Overview(r.Context())
	if err != nil {
		respond(w, nil, err)
		return
	}
	id := s.App.Store.DeviceID
	name, _ := os.Hostname()
	localView := p.NodeOverview{Node: p.NodeDescriptor{NodeID: id, Name: name, Platform: runtime.GOOS, Online: true, CanControl: true, ProtocolVersion: p.Version, MinCompatibleProtocol: p.Version, AccessLevel: p.AccessAdmin}, Agents: local.Agents, Chats: local.Chats, Conversations: local.Conversations}
	localView.TagResources()
	nodes := []p.NodeDescriptor{localView.Node}
	if r.URL.Query().Get("scope") != "local" {
		for _, v := range s.Remote.Nodes() {
			nodes = append(nodes, v.Node)
			local.Agents = append(local.Agents, v.Agents...)
			local.Chats = append(local.Chats, v.Chats...)
			local.Conversations = append(local.Conversations, v.Conversations...)
		}
	}
	respond(w, struct {
		model.Overview
		LocalNodeID string             `json:"localNodeId"`
		Nodes       []p.NodeDescriptor `json:"nodes"`
	}{local, id, nodes}, nil)
}
