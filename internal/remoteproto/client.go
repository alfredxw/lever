package remoteproto

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"strings"
)

type ClientState struct {
	DirectGrant  string             `json:"directGrant,omitempty"`
	Origin       string             `json:"origin"`
	Direct       bool               `json:"direct,omitempty"`
	LANAddr      string             `json:"lanAddr,omitempty"`
	HostName     string             `json:"hostName,omitempty"`
	HostPlatform string             `json:"hostPlatform,omitempty"`
	Membership   Membership         `json:"membership"`
	Key          ed25519.PrivateKey `json:"key"`
}

func (s ClientState) IsDirect() bool { return s.Direct || s.Origin == "" }

func Pair(ctx context.Context, origin string, in PairInput, key ed25519.PrivateKey) (ClientState, error) {
	var state ClientState
	base, err := Origin(origin)
	if err != nil {
		return state, err
	}
	in.Sign(key)
	body, err := json.Marshal(in)
	if err != nil {
		return state, err
	}
	req, err := http.NewRequestWithContext(ctx, "POST", base+"/api/pair", bytes.NewReader(body))
	if err != nil {
		return state, err
	}
	req.Header.Set("Content-Type", "application/json")
	var m Membership
	if err = Exchange(Client, req, &m); err != nil {
		return state, err
	}
	if m.DeviceID != in.ID || m.Role != in.Role || len(m.Hub.PublicKey) != ed25519.PublicKeySize || m.Hub.ID == "" || m.SpaceID == "" || len(m.Token) != 43 {
		return state, errors.New("invalid pairing receipt")
	}
	return ClientState{Origin: base, Membership: m, Key: key}, nil
}
func (s ClientState) SpacePath() string { return "/api/spaces/" + url.PathEscape(s.Membership.SpaceID) }
func (s ClientState) Request(ctx context.Context, method, path string, body []byte) (*http.Request, error) {
	if len(s.Key) != ed25519.PrivateKeySize {
		return nil, errors.New("invalid device key")
	}
	u, err := url.ParseRequestURI(path)
	if err != nil {
		return nil, err
	}
	syncPath := u.Path == "/ws/sync" || u.Path == "/ws/tunnel"
	if u.IsAbs() || u.Host != "" || strings.Contains(u.Path, "..") || (!syncPath && u.Path != "/api/me" && !strings.HasPrefix(u.Path, s.SpacePath()+"/")) {
		return nil, errors.New("request outside paired space")
	}
	req, err := http.NewRequestWithContext(ctx, method, s.Origin+path, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	Sign(req, s.Membership.Token, s.Key, body)
	return req, nil
}
func (s ClientState) Do(ctx context.Context, method, path string, body, out any) error {
	var raw []byte
	var err error
	if body != nil {
		raw, err = json.Marshal(body)
		if err != nil {
			return err
		}
	}
	req, err := s.Request(ctx, method, path, raw)
	if err != nil {
		return err
	}
	return Exchange(Client, req, out)
}
