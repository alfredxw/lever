package multinode

import (
	"bufio"
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"slices"
	"strings"
	"sync"
	"time"

	"lever/internal/lanclient"
	p "lever/internal/remoteproto"
)

// The primary slot remains at the original keychain location and shape. Older
// installations with a single credential decode without a destructive migration.
type Accounts struct {
	p.ClientState
	Peers []p.ClientState `json:"peers,omitempty"`
}

func (a *Accounts) Pair(ctx context.Context, link, name, platform string) error {
	params, direct, err := p.ParseDirectPairLink(link)
	if err != nil {
		return err
	}
	if !direct && a.Origin != "" {
		return errors.New("已有 Hub 连接，请先解除该 Hub 配对")
	}
	key := a.Key
	id := a.Membership.DeviceID
	if len(key) == 0 {
		_, key, err = ed25519.GenerateKey(rand.Reader)
		if err != nil {
			return err
		}
		id = p.NewID()
	}
	if len(key) != ed25519.PrivateKeySize {
		return errors.New("invalid controller identity")
	}
	in := p.PairInput{Identity: p.Identity{ID: id, PublicKey: key.Public().(ed25519.PublicKey)}, Role: p.Controller, Name: name, Platform: platform}
	var st p.ClientState
	if direct {
		for _, saved := range a.direct() {
			if saved.Membership.Hub.ID == params.HostID {
				return errors.New("该设备已配对")
			}
		}
		var receipt p.DirectPairReceipt
		st, receipt, err = p.PairDirect(ctx, params, in, key)
		if err != nil {
			return err
		}
		st.DirectGrant = receipt.Grant
	} else {
		var base string
		base, in.Code, err = p.HubPairLink(link)
		if err != nil {
			return err
		}
		st, err = p.Pair(ctx, base, in, key)
		if err != nil {
			return err
		}
	}
	switch {
	case id == a.Membership.DeviceID && !direct:
		a.Peers = append([]p.ClientState{a.ClientState}, a.Peers...)
		a.ClientState = st
	case a.Membership.DeviceID == "":
		a.ClientState = st
	default:
		a.Peers = append(a.Peers, st)
	}
	return nil
}
func (a Accounts) direct() []p.ClientState {
	if a.IsDirect() && a.Membership.DeviceID != "" {
		return append([]p.ClientState{a.ClientState}, a.Peers...)
	}
	return a.Peers
}
func (a Accounts) DirectIDs() []string {
	peers := a.direct()
	ids := make([]string, 0, len(peers))
	for _, st := range peers {
		ids = append(ids, st.Membership.Hub.ID)
	}
	return ids
}

// An empty id selects the primary Hub (or first direct peer on a LAN-only phone).
func (a Accounts) SelectForRemoval(id string) (p.ClientState, error) {
	if id == "" {
		return a.ClientState, nil
	}
	for _, peer := range a.direct() {
		if peer.Membership.Hub.ID == id {
			return peer, nil
		}
	}
	return p.ClientState{}, errors.New("no matching direct pairing")
}

// Revoke first and then compare credentials during the local commit. A slow
// reply from an old session must never remove a newly paired account.
func Revoke(ctx context.Context, lan *lanclient.Client, st p.ClientState) error {
	if st.IsDirect() {
		timeout, cancel := context.WithTimeout(ctx, 2*time.Second)
		defer cancel()
		_ = lan.UnpairDirect(timeout, st, st.Membership.Hub.ID)
		return nil
	}
	timeout, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	err := st.Do(timeout, http.MethodDelete, st.SpacePath()+"/devices/"+url.PathEscape(st.Membership.DeviceID), nil, nil)
	var he *p.HTTPError
	if errors.As(err, &he) && he.Status == http.StatusUnauthorized {
		return nil
	}
	return err
}
func (a *Accounts) Remove(st p.ClientState) (removed, remaining bool) {
	same := func(v p.ClientState) bool {
		return v.Membership.DeviceID == st.Membership.DeviceID && v.Membership.Hub.ID == st.Membership.Hub.ID && v.Membership.SpaceID == st.Membership.SpaceID && v.Membership.Token == st.Membership.Token && v.DirectGrant == st.DirectGrant
	}
	if same(a.ClientState) {
		return true, a.RemovePrimary()
	}
	for i, v := range a.Peers {
		if same(v) {
			a.Peers = slices.Delete(a.Peers, i, i+1)
			return true, true
		}
	}
	return false, a.Membership.DeviceID != ""
}

func (a *Accounts) RemovePrimary() bool {
	if len(a.Peers) == 0 {
		a.ClientState = p.ClientState{}
		return false
	}
	a.ClientState = a.Peers[0]
	a.Peers = a.Peers[1:]
	return true
}

// Route the app's existing space-scoped operations by their authoritative
// device ID. Unknown destinations can never silently reach a different LAN peer.
func (a Accounts) Resolve(method, path, body string) (p.ClientState, string, bool) {
	prefix := a.SpacePath() + "/"
	if !strings.HasPrefix(path, prefix) {
		return a.ClientState, path, false
	}
	suffix := strings.TrimPrefix(path, prefix)
	parts := strings.SplitN(strings.SplitN(suffix, "?", 2)[0], "/", 3)
	var target string
	switch parts[0] {
	case "archive", "private-archive", "commands", "private-commands", "avatars", "attachments", "composer-meta", "starred-models", "nodes":
		if len(parts) > 1 {
			target = parts[1]
		}
	}
	if target == "" && method == "POST" && (suffix == "commands" || suffix == "read" || suffix == "cleared") {
		var in struct {
			DeviceID string `json:"deviceId"`
		}
		if json.Unmarshal([]byte(body), &in) == nil {
			target = in.DeviceID
		}
	}
	for _, st := range a.direct() {
		if target == st.Membership.Hub.ID {
			return st, st.SpacePath() + "/" + suffix, true
		}
	}
	return a.ClientState, path, false
}

func (a Accounts) Devices(ctx context.Context, lan *lanclient.Client, base []p.Device) []p.Device {
	peers := a.direct()
	probed := make([]p.Device, len(peers))
	var wg sync.WaitGroup
	for i, st := range peers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			id := st.Membership.Hub
			device := p.Device{Identity: id, SpaceID: st.Membership.SpaceID, Name: st.HostName, Platform: st.HostPlatform, Role: p.Workstation}
			quick, cancel := context.WithTimeout(ctx, 2500*time.Millisecond)
			defer cancel()
			if d, err := lan.HostInfo(quick, st, id.ID); err == nil && d.ID == id.ID {
				device = d
			}
			probed[i] = device
		}()
	}
	wg.Wait()
	seen := map[string]int{}
	for i, d := range base {
		seen[d.ID] = i
	}
	for _, d := range probed {
		if i, ok := seen[d.ID]; ok {
			if d.Online && bytes.Equal(base[i].PublicKey, d.PublicKey) {
				base[i] = d
			}
		} else {
			base = append(base, d)
		}
	}
	return base
}

// WatchNodes keeps native views current on both personal transports. Each
// stream has an independent cursor and stops when the account changes.
func (a Accounts) WatchNodes(ctx context.Context, lan *lanclient.Client, changed func()) {
	var wg sync.WaitGroup
	watch := func(open func(string) (*http.Response, error)) {
		wg.Add(1)
		go func() {
			defer wg.Done()
			var cursor string
			for delay := time.Second; ctx.Err() == nil; delay = min(delay*2, 30*time.Second) {
				response, err := open(cursor)
				if err == nil {
					if response.StatusCode == http.StatusOK {
						delay = time.Second
						readEventIDs(response.Body, &cursor, changed)
					}
					response.Body.Close()
				}
				select {
				case <-ctx.Done():
					return
				case <-time.After(delay):
				}
			}
		}()
	}
	if !a.IsDirect() && slices.Contains(a.Membership.Features, p.FeatureTunnel) {
		client := &http.Client{CheckRedirect: p.Client.CheckRedirect}
		watch(func(cursor string) (*http.Response, error) {
			req, err := a.Request(ctx, http.MethodGet, a.SpacePath()+"/node-events", nil)
			if err != nil {
				return nil, err
			}
			if cursor != "" {
				req.Header.Set("Last-Event-ID", cursor)
			}
			return client.Do(req)
		})
	}
	for _, st := range a.direct() {
		watch(func(cursor string) (*http.Response, error) {
			probe, cancel := context.WithTimeout(ctx, 3*time.Second)
			info, err := lan.HostInfo(probe, st, st.Membership.Hub.ID)
			cancel()
			if err != nil {
				return nil, err
			}
			if info.Node == nil || !info.Node.Supports(p.FeaturePeer) {
				return nil, errors.New("peer events unavailable")
			}
			return lan.OpenPeer(ctx, st, info.ID, http.MethodGet, "/peer/v1/events?after="+url.QueryEscape(cursor), nil, nil)
		})
	}
	wg.Wait()
}

// The native projections only need the cursor. Skip large transcript frames
// without retaining them in a second buffer.
func readEventIDs(body io.Reader, cursor *string, changed func()) {
	reader := bufio.NewReader(body)
	var id string
	for {
		line, prefix, err := reader.ReadLine()
		if err != nil {
			return
		}
		if !prefix && len(line) == 0 && id != "" {
			*cursor = id
			id = ""
			changed()
		} else if bytes.HasPrefix(line, []byte("id: ")) {
			id = string(line[4:])
		}
		for prefix {
			_, prefix, err = reader.ReadLine()
			if err != nil {
				return
			}
		}
	}
}
