// Lever Mobile serves only the bundled workbench in the native WebView.
// Device tokens and signing keys stay inside the native credential store.
package main

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/json"
	"errors"
	"log"
	"net/url"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/egoist/mygo"
	"lever/internal/bonjour"
	"lever/internal/lanclient"
	p "lever/internal/remoteproto"
	"lever/web/hubassets"
)

type Mobile struct {
	lan       lanclient.Client
	mu        sync.Mutex
	link      string
	window    *mygo.Window
	opened    string
	stopWatch context.CancelFunc
	pushMu    sync.Mutex
	accountMu sync.Mutex
}

const accountKey = "paired-controller-v1"

func (m *Mobile) PairingLink() string {
	m.mu.Lock()
	defer m.mu.Unlock()
	s := m.link
	m.link = ""
	return s
}
func paired() (p.ClientState, error) {
	var st p.ClientState
	raw, err := mygo.Secrets.Get(accountKey)
	if err != nil {
		return st, err
	}
	if err = json.Unmarshal(raw, &st); err != nil {
		return st, err
	}
	if len(st.Key) != ed25519.PrivateKeySize || st.Membership.Role != p.Controller {
		return st, errors.New("invalid controller credential")
	}
	return st, nil
}
func parsePair(link string) (string, string, error) {
	u, err := url.Parse(strings.TrimSpace(link))
	if err != nil || u.Scheme != "leverdevice" || u.Host != "pair" || u.User != nil {
		return "", "", errors.New("打开 Hub 设备设置并生成手机配对链接")
	}
	base, err := p.Origin(u.Query().Get("hub"))
	if err != nil {
		return "", "", err
	}
	code := u.Query().Get("code")
	if code == "" {
		return "", "", errors.New("配对链接缺少配对码")
	}
	return base, code, nil
}
func (m *Mobile) Pair(link string) error {
	m.accountMu.Lock()
	defer m.accountMu.Unlock()
	if _, err := paired(); err == nil {
		return errors.New("请先解除原设备配对")
	} else if !errors.Is(err, mygo.ErrSecretNotFound) {
		return err
	}
	base, code, err := parsePair(link)
	if err != nil {
		return err
	}
	pub, key, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	st, err := p.Pair(ctx, base, p.PairInput{Code: code, Identity: p.Identity{ID: p.NewID(), PublicKey: pub}, Platform: runtime.GOOS, Name: "Lever Mobile", Role: p.Controller}, key)
	if err != nil {
		return err
	}
	b, err := json.Marshal(st)
	if err != nil {
		return err
	}
	return mygo.Secrets.Set(accountKey, b)
}
func (m *Mobile) Request(method, path, body string) (string, error) {
	st, err := paired()
	if err != nil {
		return "", err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	if method == "GET" && path == "/api/me" {
		// A paired phone already knows its identity. Limit a black-holed
		// Hub's delay before the offline workspace and LAN become available.
		var quick context.CancelFunc
		ctx, quick = context.WithTimeout(ctx, 2*time.Second)
		defer quick()
	}
	if out, ok, err := m.lan.Local(ctx, st, method, path, []byte(body)); ok {
		return string(out), err
	}
	target := path
	directory := method == "GET" && path == st.SpacePath()+"/devices"
	if directory {
		target += "?lan=1"
	}
	req, err := st.Request(ctx, method, target, []byte(body))
	if err != nil {
		return "", err
	}
	var out json.RawMessage
	err = p.Exchange(p.Client, req, &out)
	if err != nil {
		var response *p.HTTPError
		if errors.As(err, &response) {
			if response.Status == 401 {
				m.accountMu.Lock()
				current, readErr := paired()
				if readErr == nil && current.Membership.Token == st.Membership.Token {
					_ = m.forget()
					m.signal("unpaired")
				}
				m.accountMu.Unlock()
			}
			return "", err
		}
		// Remember which space owns cached reads when both transports go away.
		if method == "GET" && path == "/api/me" {
			m := st.Membership
			raw, _ := json.Marshal(map[string]any{"hub": m.Hub, "userId": m.UserID, "spaces": []p.Space{{ID: m.SpaceID, Kind: "personal", Name: "Hub"}}, "deviceId": m.DeviceID, "origin": st.Origin})
			return string(raw), nil
		}
		var network *url.Error
		if errors.As(err, &network) {
			return "", errors.New("暂时无法连接 Hub")
		}
		return "", err
	}
	if path == "/api/me" {
		var v map[string]any
		if json.Unmarshal(out, &v) == nil {
			v["origin"] = st.Origin
			out, _ = json.Marshal(v)
		}
	}
	if directory {
		var entries []struct {
			p.Device
			LANProof string `json:"lanProof"`
		}
		if err := json.Unmarshal(out, &entries); err != nil {
			return "", err
		}
		devices := make([]p.Device, 0, len(entries))
		for _, d := range entries {
			if d.LANProof != "" {
				m.lan.RememberHost(st, d.ID, d.LANProof)
			}
			devices = append(devices, d.Device)
		}
		out, _ = json.Marshal(devices)
	}
	return string(out), nil
}
func (m *Mobile) Unpair() error {
	m.accountMu.Lock()
	defer m.accountMu.Unlock()
	st, err := paired()
	if err != nil {
		return err
	}
	err = st.Do(context.Background(), "DELETE", st.SpacePath()+"/devices/"+url.PathEscape(st.Membership.DeviceID), nil, nil)
	var e *p.HTTPError
	if err != nil && !(errors.As(err, &e) && e.Status == 401) {
		return err
	}
	return m.forget()
}

// Called under accountMu so an old HTTP response cannot erase a new pairing.
func (m *Mobile) forget() error {
	m.mu.Lock()
	if m.stopWatch != nil {
		m.stopWatch()
		m.stopWatch = nil
	}
	m.opened = ""
	m.mu.Unlock()
	_ = mygo.Secrets.Delete(grantsKey)
	_ = mygo.Secrets.Delete(pushKey)
	return mygo.Secrets.Delete(accountKey)
}

func main() {
	m := &Mobile{}
	if runtime.GOOS == "android" {
		m.lan.Discover = func(ctx context.Context, host string) (string, error) {
			_ = mygo.Native("leverMobile").Call(ctx, "allowDiscovery", nil, nil)
			return bonjour.Discover(ctx, host)
		}
	}
	m.lan.LoadGrant = m.loadGrant
	m.lan.SaveGrant = m.saveGrant
	m.listenPush()
	mygo.Network.OnChanged(func(mygo.NetworkStatus) { m.lan.NetworkChanged(); m.signal("refresh") })
	mygo.SetFrontend(hubassets.Assets())
	mygo.Bind(m)
	mygo.App.OnOpenURL(func(link string) {
		if _, _, err := parsePair(link); err == nil {
			m.mu.Lock()
			m.link = link
			m.mu.Unlock()
		}
	})
	mygo.App.WhenReady(func() {
		w := mygo.NewWindow(mygo.WindowOptions{Title: "Lever", URL: "mygo://localhost/hub.html", Width: 430, Height: 850})
		m.mu.Lock()
		m.window = w
		m.mu.Unlock()
		w.Page().OnWillNavigate(func(e *mygo.NavigateEvent) {
			u, err := url.Parse(e.URL)
			if err != nil || u.User != nil || !(u.Scheme == "mygo" && u.Host == "localhost" || runtime.GOOS == "android" && u.Scheme == "https" && u.Host == "mygo.localhost") {
				e.PreventDefault()
			}
		})
		w.Page().SetWindowOpenHandler(func(mygo.WindowOpenRequest) *mygo.WindowOptions { return nil })
	})
	if err := mygo.App.Run(); err != nil {
		log.Fatal(err)
	}
}
