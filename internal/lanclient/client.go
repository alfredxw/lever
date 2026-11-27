// Package lanclient reads an explicitly shared Chat directly from its Host.
// Discovery only suggests an address. The signed grant pins the TLS identity.
package lanclient

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"lever/internal/bonjour"
	p "lever/internal/remoteproto"
)

type route struct {
	address, token string
	grant          p.SignedGrant
}
type Client struct {
	Discover func(context.Context, string) (string, error)
	// A signed grant contains public identities. Only the native controller
	// holds the private key needed to use it after an app restart.
	LoadGrant func(key string) string
	SaveGrant func(key, token string)
	mu        sync.Mutex
	routes    map[string]route
	misses    map[string]time.Time
}

func routeKey(st p.ClientState, host string) string {
	return st.Membership.Hub.ID + "/" + st.Membership.SpaceID + "/" + st.Membership.DeviceID + "/" + host
}

func (c *Client) RememberHost(st p.ClientState, host, token string) {
	s, err := p.ParseGrant(token)
	if err != nil || !s.Valid(st.Membership.Hub, host, st.Membership.SpaceID, s.Grant.Policy, time.Now()) || s.Grant.Controller.ID != st.Membership.DeviceID {
		return
	}
	key := routeKey(st, host)
	c.mu.Lock()
	r := c.routes[key]
	if r.grant.Grant.Policy > s.Grant.Policy || (r.grant.Grant.Policy == s.Grant.Policy && r.grant.Grant.Expires >= s.Grant.Expires-120) {
		c.mu.Unlock()
		return
	}
	r.grant, r.token = s, token
	if c.routes == nil {
		c.routes = make(map[string]route)
	}
	c.routes[key] = r
	c.mu.Unlock()
	if c.SaveGrant != nil {
		c.SaveGrant(key, token)
	}
}

func (c *Client) NetworkChanged() {
	c.mu.Lock()
	defer c.mu.Unlock()
	clear(c.misses)
	for key, r := range c.routes {
		r.address = ""
		c.routes[key] = r
	}
}

func (c *Client) readRoute(ctx context.Context, st p.ClientState, host string, renew, forceDiscover bool) (route, error) {
	key := routeKey(st, host)
	c.mu.Lock()
	r := c.routes[key]
	c.mu.Unlock()
	if r.address == "" || forceDiscover {
		if !forceDiscover && st.IsDirect() && st.LANAddr != "" && host == st.Membership.Hub.ID {
			r.address = st.LANAddr
		} else {
			discover := c.Discover
			if discover == nil {
				discover = bonjour.Discover
			}
			address, err := discover(ctx, host)
			if err != nil {
				if !forceDiscover && st.LANAddr != "" && host == st.Membership.Hub.ID {
					r.address = st.LANAddr
				} else {
					return route{}, err
				}
			} else {
				r.address = address
			}
		}
	}
	if r.token == "" && !renew && c.LoadGrant != nil {
		token := c.LoadGrant(key)
		s, err := p.ParseGrant(token)
		if err == nil && s.Authentic(st.Membership.Hub, host, st.Membership.SpaceID) && s.Grant.Controller.ID == st.Membership.DeviceID {
			r.token, r.grant = token, s
		}
	}
	if r.token == "" || renew {
		if st.IsDirect() {
			if r.token == "" {
				return route{}, errors.New("缺少局域网直连凭证，请重新扫码配对")
			}
			return route{}, errors.New("电脑端已撤销此设备的局域网授权")
		}
		var out struct {
			Grant string `json:"grant"`
		}
		if err := st.Do(ctx, "GET", st.SpacePath()+"/devices/"+url.PathEscape(host)+"/lan", nil, &out); err != nil {
			return route{}, err
		}
		s, err := p.ParseGrant(out.Grant)
		if err != nil || !s.Valid(st.Membership.Hub, host, st.Membership.SpaceID, s.Grant.Policy, time.Now()) || s.Grant.Controller.ID != st.Membership.DeviceID {
			return route{}, errors.New("invalid Hub authorization for LAN")
		}
		r.token, r.grant = out.Grant, s
		if c.SaveGrant != nil {
			c.SaveGrant(key, out.Grant)
		}
	}
	c.mu.Lock()
	if c.routes == nil {
		c.routes = map[string]route{}
	}
	c.routes[key] = r
	c.mu.Unlock()
	return r, nil
}
func (c *Client) exchange(ctx context.Context, st p.ClientState, host, method, path string, body []byte, out any) error {
	r, err := c.readRoute(ctx, st, host, false, false)
	if err != nil {
		return err
	}
	err = c.direct(ctx, st, r, method, path, body, out)
	var response *p.HTTPError
	if errors.As(err, &response) && response.Status == 403 && response.Message == "LAN authorization expired or revoked" {
		if st.IsDirect() {
			return err
		}
		fresh, renewErr := c.readRoute(ctx, st, host, true, false)
		if renewErr != nil {
			return err
		}
		r = fresh
		err = c.direct(ctx, st, r, method, path, body, out)
	}
	if err != nil && !errors.As(err, &response) {
		// If a saved direct IP failed (e.g. Mac changed Wi-Fi IP), fall back to Bonjour discovery once.
		if st.IsDirect() && st.LANAddr != "" && r.address == st.LANAddr {
			if fresh, discErr := c.readRoute(ctx, st, host, false, true); discErr == nil && fresh.address != r.address {
				r = fresh
				err = c.direct(ctx, st, r, method, path, body, out)
				if err == nil {
					return nil
				}
			}
		}
		key := routeKey(st, host)
		c.mu.Lock()
		if current := c.routes[key]; current.address == r.address && current.token == r.token {
			current.address = ""
			c.routes[key] = current
		}
		c.mu.Unlock()
	}
	return err
}

func (c *Client) HostInfo(ctx context.Context, st p.ClientState, host string) (p.Device, error) {
	var d p.Device
	err := c.exchange(ctx, st, host, http.MethodGet, "/host", nil, &d)
	return d, err
}

func (c *Client) UnpairDirect(ctx context.Context, st p.ClientState, host string) error {
	var ok bool
	return c.exchange(ctx, st, host, http.MethodPost, "/unpair", nil, &ok)
}

func (c *Client) direct(ctx context.Context, st p.ClientState, r route, method, path string, body []byte, out any) error {
	client := http.Client{Timeout: 3 * time.Second, CheckRedirect: p.Client.CheckRedirect, Transport: &http.Transport{DisableKeepAlives: true, TLSClientConfig: &tls.Config{
		MinVersion: tls.VersionTLS13,
		// The self-signed leaf is authenticated by its Hub-registered Ed25519 key.
		InsecureSkipVerify: true, VerifyConnection: func(cs tls.ConnectionState) error {
			if len(cs.PeerCertificates) != 1 {
				return errors.New("unexpected LAN certificate chain")
			}
			leaf := cs.PeerCertificates[0]
			key, ok := leaf.PublicKey.(ed25519.PublicKey)
			if !ok || !bytes.Equal(key, r.grant.Grant.Host.PublicKey) || time.Now().After(leaf.NotAfter) || time.Now().Before(leaf.NotBefore) || leaf.CheckSignature(x509.PureEd25519, leaf.RawTBSCertificate, leaf.Signature) != nil {
				return errors.New("Host key mismatch")
			}
			return nil
		},
	}}}
	u, err := url.ParseRequestURI(path)
	if err != nil {
		return err
	}
	u.Scheme = "https"
	u.Host = r.address
	req, err := http.NewRequestWithContext(ctx, method, u.String(), bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	p.Sign(req, r.token, st.Key, body)
	return p.Exchange(&client, req, out)
}

// TryArchive falls back at the caller using the identical shared resource ID.
func (c *Client) TryArchive(ctx context.Context, st p.ClientState, method, path string) (json.RawMessage, bool) {
	if method != "GET" || !st.Membership.Role.Controls() {
		return nil, false
	}
	u, err := url.ParseRequestURI(path)
	if err != nil {
		return nil, false
	}
	host, ok := strings.CutPrefix(u.Path, st.SpacePath()+"/archive/")
	if !ok || host == "" || strings.Contains(host, "/") {
		return nil, false
	}
	key := routeKey(st, host)
	c.mu.Lock()
	wait := c.misses[key]
	c.mu.Unlock()
	if time.Now().Before(wait) {
		return nil, false
	}
	var out json.RawMessage
	if err = c.exchange(ctx, st, host, "GET", "/archive?"+u.Query().Encode(), nil, &out); err != nil {
		c.mu.Lock()
		if c.misses == nil {
			c.misses = map[string]time.Time{}
		}
		c.misses[key] = time.Now().Add(12 * time.Second)

		c.mu.Unlock()
		return nil, false
	}
	return out, true
}

// A negative acknowledgement is authoritative. A lost connection can retry a
// shared command at its Hub with the same ID. Private traffic stays on LAN.
func (c *Client) TryCommand(ctx context.Context, st p.ClientState, input []byte) (json.RawMessage, bool, error) {
	var i p.Intent
	if err := p.Decode(input, &i); err != nil {
		return nil, true, err
	}
	i.ActorUserID = st.Membership.UserID
	i.OriginDeviceID = st.Membership.DeviceID
	cmd := p.LANCommand{HubID: st.Membership.Hub.ID, SpaceID: st.Membership.SpaceID, Intent: i}
	cmd.Sign(st.Key)
	body, _ := json.Marshal(cmd)
	var out json.RawMessage
	err := c.exchange(ctx, st, i.DeviceID, "POST", "/commands", body, &out)
	var failure *p.HTTPError
	return out, err == nil || i.Private || errors.As(err, &failure) && failure.Status >= 400 && failure.Status < 500, err
}

// Local handles native-only resources before the caller considers Hub transport.
func (c *Client) Local(ctx context.Context, st p.ClientState, method, path string, body []byte) (json.RawMessage, bool, error) {
	if !st.Membership.Role.Controls() {
		return nil, false, nil
	}
	if method == http.MethodPost && path == st.SpacePath()+"/commands" {
		return c.TryCommand(ctx, st, body)
	}
	if method == http.MethodPost && path == st.SpacePath()+"/read" {
		var in p.ReadSync
		if err := p.Decode(body, &in); err != nil {
			return nil, true, err
		}
		if in.DeviceID == "" {
			return nil, st.IsDirect(), errors.New("missing deviceId")
		}
		var out json.RawMessage
		err := c.exchange(ctx, st, in.DeviceID, http.MethodPost, "/read", body, &out)
		if err == nil {
			return out, true, nil
		}
		return nil, st.IsDirect(), err
	}
	if method == http.MethodPost && path == st.SpacePath()+"/cleared" {
		var in p.ClearSync
		if err := p.Decode(body, &in); err != nil {
			return nil, true, err
		}
		if in.DeviceID == "" {
			return nil, st.IsDirect(), errors.New("missing deviceId")
		}
		var out json.RawMessage
		err := c.exchange(ctx, st, in.DeviceID, http.MethodPost, "/cleared", body, &out)
		if err == nil {
			return out, true, nil
		}
		return nil, st.IsDirect(), err
	}
	u, err := url.ParseRequestURI(path)
	if err != nil {
		return nil, true, err
	}
	if method == http.MethodGet {
		suffix := strings.TrimPrefix(u.Path, st.SpacePath()+"/")
		parts := strings.Split(suffix, "/")
		if len(parts) == 3 && (parts[0] == "private-commands" || parts[0] == "commands") && parts[1] != "" && len(parts[2]) == 36 {
			var out json.RawMessage
			err := c.exchange(ctx, st, parts[1], "GET", "/commands/"+url.PathEscape(parts[2]), nil, &out)
			return out, err == nil || parts[0] == "private-commands", err
		}
	}
	if host, ok := strings.CutPrefix(u.Path, st.SpacePath()+"/private-archive/"); ok {
		if method != http.MethodGet || host == "" || strings.Contains(host, "/") {
			return nil, true, errors.New("invalid private archive request")
		}
		var out json.RawMessage
		err := c.exchange(ctx, st, host, "GET", "/private?"+url.Values{"chat": {u.Query().Get("chat")}}.Encode(), nil, &out)
		return out, true, err
	}
	out, handled := c.TryArchive(ctx, st, method, path)
	return out, handled, nil
}
