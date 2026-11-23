package main

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"runtime"
	"time"

	"github.com/egoist/mygo"
	"github.com/egoist/mygo/plugins/push"
	p "lever/internal/remoteproto"
)

const pushKey = "push-controller-v1"

type pushPreference struct {
	DeviceID string
	Firebase *p.FirebaseClient
	Token    string
	Key      []byte
}

func preference() pushPreference {
	var pref pushPreference
	raw, err := mygo.Secrets.Get(pushKey)
	if err == nil {
		_ = json.Unmarshal(raw, &pref)
	}
	return pref
}
func (m *Mobile) savePreference(device string, pref pushPreference) error {
	m.accountMu.Lock()
	defer m.accountMu.Unlock()
	st, err := paired()
	if err != nil || st.Membership.DeviceID != device {
		return errors.New("手机配对已变更")
	}
	b, _ := json.Marshal(pref)
	return mygo.Secrets.Set(pushKey, b)
}
func (m *Mobile) disablePush(ctx context.Context, st p.ClientState) error {
	if err := st.Do(ctx, "DELETE", st.SpacePath()+"/push", nil, nil); err != nil {
		return err
	}
	return m.savePreference(st.Membership.DeviceID, pushPreference{})
}
func configurePush(ctx context.Context, f *p.FirebaseClient) error {
	if runtime.GOOS != "android" {
		return nil
	}
	if f == nil {
		return errors.New("Hub 缺少 Firebase 手机配置")
	}
	return mygo.Native("leverMobile").Call(ctx, "configureFirebase", f, nil)
}
func (m *Mobile) SetPush(enabled bool) error {
	m.pushMu.Lock()
	defer m.pushMu.Unlock()
	st, err := paired()
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	path := st.SpacePath() + "/push"
	if !enabled {
		return m.disablePush(ctx, st)
	}
	var status p.PushSettings
	if err = st.Do(ctx, "GET", path, nil, &status); err != nil {
		return err
	}
	if !status.Available {
		return errors.New("Hub 尚未配置此平台的系统推送")
	}
	if err = configurePush(ctx, status.Firebase); err != nil {
		return err
	}
	token, err := push.Register(ctx)
	if err != nil {
		return err
	}
	pref := preference()
	if pref.DeviceID != st.Membership.DeviceID || len(pref.Key) != 32 {
		pref = pushPreference{DeviceID: st.Membership.DeviceID, Key: make([]byte, 32)}
		rand.Read(pref.Key)
	}
	pref.Firebase, pref.Token = status.Firebase, token
	if err = m.savePreference(st.Membership.DeviceID, pref); err != nil {
		return err
	}
	return st.Do(ctx, "PUT", path, p.PushRegistration{Token: token, Key: pref.Key}, nil)
}
func (m *Mobile) restorePush(ctx context.Context, st p.ClientState) {
	m.pushMu.Lock()
	defer m.pushMu.Unlock()
	pref := preference()
	if pref.DeviceID != st.Membership.DeviceID {
		return
	}
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	if configurePush(ctx, pref.Firebase) != nil {
		return
	}
	// Ask the OS for its current token after a cold start; a rotation event
	// may have happened while the process was suspended.
	token, err := push.Register(ctx)
	if err == nil {
		m.registerToken(ctx, st, pref, token)
		return
	}
	var native *mygo.NativeError
	if errors.As(err, &native) && native.Code == "Denied" && m.disablePush(ctx, st) == nil {
		m.signal("refresh")
	}
}
func (m *Mobile) registerToken(ctx context.Context, st p.ClientState, pref pushPreference, token string) {
	if token == "" || pref.DeviceID != st.Membership.DeviceID {
		return
	}
	if token != pref.Token {
		pref.Token = token
		if m.savePreference(st.Membership.DeviceID, pref) != nil {
			return
		}
	}
	_ = st.Do(ctx, "PUT", st.SpacePath()+"/push", p.PushRegistration{Token: token, Key: pref.Key}, nil)
}
func (m *Mobile) listenPush() {
	push.OnToken(func(token string) {
		go func() {
			m.pushMu.Lock()
			defer m.pushMu.Unlock()
			st, err := paired()
			if err == nil {
				ctx, cancel := context.WithTimeout(context.Background(), 12*time.Second)
				defer cancel()
				m.registerToken(ctx, st, preference(), token)
			}
		}()
	})
	push.OnMessage(func(_ []byte) { m.signal("refresh") })
	push.OnOpened(func(data []byte) {
		var envelope struct {
			Lever string `json:"lever"`
		}
		if json.Unmarshal(data, &envelope) != nil || len(envelope.Lever) > 4096 {
			return
		}
		m.mu.Lock()
		m.opened = envelope.Lever
		m.mu.Unlock()
		m.signal("opened")
	})
}
func (m *Mobile) OpenedNotice() *p.PushNotice {
	m.mu.Lock()
	payload := m.opened
	m.opened = ""
	m.mu.Unlock()
	if payload == "" {
		return nil
	}
	st, err := paired()
	if err != nil {
		return nil
	}
	pref := preference()
	n, err := p.OpenPush(payload, pref.Key)
	if err != nil || pref.DeviceID != st.Membership.DeviceID || n.HubID != st.Membership.Hub.ID || n.SpaceID != st.Membership.SpaceID {
		return nil
	}
	return &n
}
