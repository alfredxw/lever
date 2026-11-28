// Lever mobile app serves only the bundled workbench in the native WebView.
// Device tokens and signing keys stay inside the native credential store.
package main

import (
	"context"
	"crypto/ed25519"
	"encoding/json"
	"errors"
	"lever/internal/multinode"
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
	directory multinode.MobileDirectory
	workspace multinode.MobileWorkspace
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
func accounts() (multinode.Accounts, error) {
	var a multinode.Accounts
	raw, err := mygo.Secrets.Get(accountKey)
	if err != nil {
		return a, err
	}
	if err = json.Unmarshal(raw, &a); err != nil {
		return a, err
	}
	if len(a.Key) != ed25519.PrivateKeySize || a.Membership.Role != p.Controller {
		return a, errors.New("invalid controller credential")
	}
	return a, nil
}
func paired() (p.ClientState, error) { a, err := accounts(); return a.ClientState, err }
func validPairLink(link string) bool {
	if _, isDirect, err := p.ParseDirectPairLink(link); isDirect {
		return err == nil
	}
	_, _, err := parsePair(link)
	return err == nil
}
func parsePair(link string) (string, string, error) {
	u, err := url.Parse(strings.TrimSpace(link))
	if err != nil || u.Scheme != "leverdevice" || u.Host != "pair" || u.User != nil {
		return "", "", errors.New("请在电脑「设置 → 远程与设备」点击配对新设备获取二维码或链接")
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
	a, err := accounts()
	if err != nil && !errors.Is(err, mygo.ErrSecretNotFound) {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	if err = a.Pair(ctx, link, "Lever", runtime.GOOS); err != nil {
		return err
	}
	raw, err := json.Marshal(a)
	if err != nil {
		return err
	}
	if err = mygo.Secrets.Set(accountKey, raw); err != nil {
		return err
	}
	m.mu.Lock()
	if m.stopWatch != nil {
		m.stopWatch()
		m.stopWatch = nil
	}
	m.mu.Unlock()
	return nil
}
func (m *Mobile) requestDirect(ctx context.Context, st p.ClientState, method, path, body string) (string, error) {
	if out, ok, err := m.lan.Local(ctx, st, method, path, []byte(body)); ok {
		return string(out), err
	}
	mb := st.Membership
	spacePath := st.SpacePath()
	if method == "GET" && path == "/api/me" {
		name := st.HostName
		if name == "" {
			name = "局域网直连"
		}
		raw, _ := json.Marshal(map[string]any{
			"hub":      mb.Hub,
			"userId":   mb.UserID,
			"spaces":   []p.Space{{ID: mb.SpaceID, Kind: "personal", Name: name}},
			"deviceId": mb.DeviceID,
			"origin":   "",
		})
		return string(raw), nil
	}
	if method == "GET" && path == spacePath+"/devices" {
		hostName := st.HostName
		if hostName == "" {
			hostName = "我的电脑"
		}
		hostPlatform := st.HostPlatform
		if hostPlatform == "" {
			hostPlatform = "darwin"
		}
		hostDev := p.Device{
			Identity: mb.Hub,
			SpaceID:  mb.SpaceID,
			Name:     hostName,
			Role:     p.Workstation,
			Platform: hostPlatform,
			Online:   false,
		}
		pingCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
		defer cancel()
		if live, err := m.lan.HostInfo(pingCtx, st, mb.Hub.ID); err == nil {
			hostDev = live
		}
		selfDev := p.Device{
			Identity: p.Identity{ID: mb.DeviceID},
			SpaceID:  mb.SpaceID,
			Name:     "Lever",
			Role:     p.Controller,
			Platform: runtime.GOOS,
			Online:   true,
		}
		raw, _ := json.Marshal([]p.Device{hostDev, selfDev})
		return string(raw), nil
	}
	if method == "GET" && path == spacePath+"/tasks" {
		return "[]", nil
	}
	if method == "GET" && path == spacePath+"/read" {
		return "{}", nil
	}
	if method == "GET" && path == spacePath+"/push" {
		return `{"available":false,"enabled":false}`, nil
	}
	if strings.HasPrefix(path, spacePath+"/archive/") {
		return "", errors.New("当前不在同一局域网，暂时无法连接电脑")
	}
	return "", errors.New("该功能需要连接 Lever Hub（当前为局域网直连模式）")
}
func (m *Mobile) Request(method, path, body string) (string, error) {
	accounts, err := accounts()
	if err != nil {
		return "", err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	if raw, ok, e := m.directory.Request(ctx, accounts.SpacePath(), method, path, body); ok {
		return string(raw), e
	}
	st, path, _ := accounts.Resolve(method, path, body)
	if method == "GET" && path == accounts.SpacePath()+"/devices" && accounts.IsDirect() {
		base := []p.Device{{Identity: p.Identity{ID: accounts.Membership.DeviceID}, Name: "Lever", Role: p.Controller, Online: true}}
		raw, err := json.Marshal(m.directory.Refresh(ctx, accounts, &m.lan, base))
		return string(raw), err
	}
	if st.IsDirect() {
		return m.requestDirect(ctx, st, method, path, body)
	}
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
					_ = m.forget(st)
					m.signal("unpaired")
				}
				m.accountMu.Unlock()
			}
			return "", err
		}
		// Remember which space owns cached reads when both transports go away.
		if directory && len(accounts.Peers) > 0 {
			raw, err := json.Marshal(m.directory.Refresh(ctx, accounts, &m.lan, nil))
			return string(raw), err
		}
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
		out, _ = json.Marshal(m.directory.Refresh(ctx, accounts, &m.lan, devices))
	}
	return string(out), nil
}

type nodeReply struct {
	Data   json.RawMessage `json:"data,omitempty"`
	Status int             `json:"status,omitempty"`
	Error  string          `json:"error,omitempty"`
}

func (m *Mobile) RequestNode(method, path, body string) (nodeReply, error) {
	if !strings.HasPrefix(path, "/api/nodes/") {
		return nodeReply{}, errors.New("invalid node resource")
	}
	raw, err := m.Request(method, path, body)
	if err == nil {
		return nodeReply{Data: json.RawMessage(raw)}, nil
	}
	var he *p.HTTPError
	if errors.As(err, &he) {
		return nodeReply{Status: he.Status, Error: he.Message}, nil
	}
	return nodeReply{}, err
}

func (m *Mobile) Unpair() error { return m.unpair("") }
func (m *Mobile) UnpairPeer(id string) error {
	if id == "" {
		return errors.New("missing node id")
	}
	return m.unpair(id)
}
func (m *Mobile) DirectPeers() ([]string, error) { a, err := accounts(); return a.DirectIDs(), err }
func (m *Mobile) unpair(id string) error {
	m.accountMu.Lock()
	a, err := accounts()
	m.accountMu.Unlock()
	if err != nil {
		return err
	}
	st, err := a.SelectForRemoval(id)
	if err != nil {
		return err
	}
	if err = multinode.Revoke(context.Background(), &m.lan, st); err != nil {
		return err
	}
	m.accountMu.Lock()
	defer m.accountMu.Unlock()
	return m.forget(st)
}

// Called under accountMu so an old HTTP response cannot erase a new pairing.
func (m *Mobile) forget(st p.ClientState) error {
	a, err := accounts()
	if err != nil {
		return err
	}
	removed, remaining := a.Remove(st)
	if !removed {
		return nil
	}
	m.lan.Forget(st)
	m.workspace.Close()
	m.directory.Clear()
	m.mu.Lock()
	if m.stopWatch != nil {
		m.stopWatch()
		m.stopWatch = nil
	}
	m.opened = ""
	m.mu.Unlock()
	if remaining {
		raw, err := json.Marshal(a)
		if err != nil {
			return err
		}
		if err = mygo.Secrets.Set(accountKey, raw); err != nil {
			return err
		}
		if !st.IsDirect() {
			_ = mygo.Secrets.Delete(pushKey)
			_ = mygo.Secrets.Delete(grantsKey)
		}
		return nil
	}
	_ = mygo.Secrets.Delete(grantsKey)
	_ = mygo.Secrets.Delete(pushKey)
	return mygo.Secrets.Delete(accountKey)
}

func (m *Mobile) OpenWorkspace(node, agent, chat string) error {
	address, err := m.workspace.Open(&m.directory, hubassets.Assets(), node, agent, chat)
	if err != nil {
		return err
	}
	if runtime.GOOS == "android" {
		if err = mygo.Native("leverMobile").Call(context.Background(), "workspace", map[string]string{"url": address}, nil); err != nil {
			if link, parseErr := url.Parse(address); parseErr == nil {
				m.workspace.CloseHost(link.Host)
			}
		}
		return err
	}
	// Other shells can use their system browser for the isolated workbench.
	return mygo.Shell.OpenExternal(address)
}

func main() {
	m := &Mobile{}
	if runtime.GOOS == "android" {
		mygo.Native("leverMobile").On("workspaceClosed", func(raw []byte) {
			var host string
			if json.Unmarshal(raw, &host) == nil {
				m.workspace.CloseHost(host)
			}
		})
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
		if validPairLink(link) {
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
