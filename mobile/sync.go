package main

import (
	"bufio"
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"github.com/egoist/mygo"
	p "lever/internal/remoteproto"
)

const grantsKey = "lan-controller-certificates-v1"

var mobileChanged = mygo.NewEvent[string]("lever:mobile-changed")

func (m *Mobile) signal(reason string) {
	m.mu.Lock()
	w := m.window
	m.mu.Unlock()
	if w != nil {
		_ = mobileChanged.Emit(w, reason)
	}
}
func savedGrants() map[string]string {
	out := map[string]string{}
	raw, err := mygo.Secrets.Get(grantsKey)
	if err == nil {
		_ = json.Unmarshal(raw, &out)
	}
	return out
}
func (m *Mobile) loadGrant(key string) string {
	m.accountMu.Lock()
	defer m.accountMu.Unlock()
	return savedGrants()[key]
}
func (m *Mobile) saveGrant(key, token string) {
	m.accountMu.Lock()
	defer m.accountMu.Unlock()
	st, err := paired()
	if err != nil || !strings.HasPrefix(key, st.Membership.Hub.ID+"/"+st.Membership.SpaceID+"/"+st.Membership.DeviceID+"/") {
		return
	}
	grants := savedGrants()
	grants[key] = token
	raw, _ := json.Marshal(grants)
	_ = mygo.Secrets.Set(grantsKey, raw)
}
func (m *Mobile) Watch(active bool) error {
	var st p.ClientState
	if active {
		var err error
		st, err = paired()
		if err != nil {
			return err
		}
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if !active {
		if m.stopWatch != nil {
			m.stopWatch()
			m.stopWatch = nil
		}
		return nil
	}
	if m.stopWatch != nil {
		return nil
	}
	if st.IsDirect() {
		return nil
	}
	ctx, cancel := context.WithCancel(context.Background())
	m.stopWatch = cancel
	go m.watch(ctx, st)
	go m.restorePush(ctx, st)
	return nil
}

func (m *Mobile) watch(ctx context.Context, st p.ClientState) {
	client := http.Client{CheckRedirect: p.Client.CheckRedirect}
	for ctx.Err() == nil {
		req, err := st.Request(ctx, "GET", st.SpacePath()+"/events", nil)
		if err != nil {
			return
		}
		resp, err := client.Do(req)
		if err == nil {
			if resp.StatusCode == http.StatusUnauthorized {
				resp.Body.Close()
				// Recheck the pairing via the normal credential-clearing path.
				_, _ = m.Request("GET", "/api/me", "")
				return
			}
			if resp.StatusCode == http.StatusOK {
				scanner := bufio.NewScanner(resp.Body)
				for scanner.Scan() {
					if scanner.Text() == "data: refresh" {
						m.signal("refresh")
					}
				}
			}
			resp.Body.Close()
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(3 * time.Second):
		}
	}
}
