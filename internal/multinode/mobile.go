package multinode

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"

	"lever/internal/lanclient"
	p "lever/internal/remoteproto"
)

// MobileDirectory ties the same route state machine used by desktop to the
// native foreground refresh. The two credential slots stay independent.
type MobileDirectory struct {
	mu    sync.RWMutex
	nodes map[string]*Node
}

func (d *MobileDirectory) Refresh(ctx context.Context, accounts Accounts, lan *lanclient.Client, hub []p.Device) []p.Device {
	targets := map[string]Target{}
	for _, peer := range accounts.direct() {
		id := peer.Membership.Hub
		targets[id.ID] = Target{Info: p.Device{Identity: id, SpaceID: peer.Membership.SpaceID, Name: peer.HostName, Platform: peer.HostPlatform, Role: p.Workstation}, LAN: &peer}
	}
	result := make([]p.Device, 0, len(hub)+len(targets))
	seen := map[string]bool{}
	for _, dev := range hub {
		if dev.Role.Executes() && !dev.Revoked && accounts.Origin != "" {
			t := targets[dev.ID]
			if t.Info.ID == "" || bytes.Equal(t.Info.PublicKey, dev.PublicKey) {
				t.Info = dev
				t.Hub = &accounts.ClientState
				targets[dev.ID] = t
			}
		}
		seen[dev.ID] = true
		result = append(result, dev)
	}
	d.mu.Lock()
	next := make(map[string]*Node, len(targets))
	for id, t := range targets {
		n := d.nodes[id]
		if n == nil {
			n = New(t, lan)
		} else {
			n.Update(t)
		}
		next[id] = n
		if !seen[id] {
			result = append(result, t.Info)
		}
	}
	d.nodes = next
	d.mu.Unlock()
	var wg sync.WaitGroup
	for i, dev := range result {
		n := next[dev.ID]
		if n == nil {
			continue
		}
		wg.Add(1)
		go func() {
			defer wg.Done()
			n.Probe(ctx)
			st := n.Status()
			if st.NodeID != "" {
				result[i].Online = st.Online
				result[i].Name = st.Name
				result[i].Platform = st.Platform
				if st.Supports(p.FeaturePeer) {
					result[i].Node = &st.NodeDescriptor
				}
			}
		}()
	}
	wg.Wait()
	return result
}
func (d *MobileDirectory) Clear() { d.mu.Lock(); d.nodes = nil; d.mu.Unlock() }
func (d *MobileDirectory) Request(ctx context.Context, space, method, path, body string) (json.RawMessage, bool, error) {
	suffix, ok := strings.CutPrefix(path, space+"/nodes/")
	if !ok {
		suffix, ok = strings.CutPrefix(path, "/api/nodes/")
	}
	if !ok {
		return nil, false, nil
	}
	id, route, ok := strings.Cut(suffix, "/")
	if !ok || route == "" {
		return nil, true, errors.New("invalid node resource")
	}
	d.mu.RLock()
	n := d.nodes[id]
	d.mu.RUnlock()
	if n == nil {
		return nil, true, &p.HTTPError{Status: 404, Message: "unknown device"}
	}
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	resp, err := n.Open(ctx, method, "/"+route, []byte(body), nil)
	if err != nil {
		return nil, true, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		return nil, true, &p.HTTPError{Status: resp.StatusCode, Message: strings.TrimSpace(string(b))}
	}
	var raw json.RawMessage
	err = json.NewDecoder(resp.Body).Decode(&raw)
	return raw, true, err
}
