package remoteproto

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/tls"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"
)

type Grant struct {
	Draining   bool     `json:"draining,omitempty"`
	HubID      string   `json:"hubId"`
	SpaceID    string   `json:"spaceId"`
	UserID     string   `json:"userId"`
	Controller Identity `json:"controller"`
	Host       Identity `json:"host"`
	Policy     int64    `json:"policy"`
	Expires    int64    `json:"expires"`
}
type SignedGrant struct {
	Grant     Grant  `json:"grant"`
	Signature []byte `json:"signature"`
}

func IssueGrant(g Grant, key ed25519.PrivateKey) string {
	body, _ := json.Marshal(g)
	raw, _ := json.Marshal(SignedGrant{g, ed25519.Sign(key, append([]byte("lever-lan-v1\n"), body...))})
	return base64.RawURLEncoding.EncodeToString(raw)
}
func ParseGrant(token string) (SignedGrant, error) {
	var s SignedGrant
	if len(token) > 8192 {
		return s, errors.New("invalid LAN grant")
	}
	raw, err := base64.RawURLEncoding.DecodeString(token)
	if err == nil {
		err = Decode(raw, &s)
	}
	return s, err
}
func (s SignedGrant) Valid(hub Identity, host, space string, policy int64, t time.Time) bool {
	return s.Grant.Expires > t.Unix() && s.Grant.Expires <= t.Add(5*time.Minute+5*time.Second).Unix() && s.Grant.Policy == policy && s.Authentic(hub, host, space)
}

// Authentic verifies the identities on the Hub's certificate. Using an expired
// certificate also requires a separate, revocable authorization on the Host.
func (s SignedGrant) Authentic(hub Identity, host, space string) bool {
	g := s.Grant
	b, _ := json.Marshal(g)
	return len(hub.PublicKey) == ed25519.PublicKeySize && len(g.Controller.PublicKey) == ed25519.PublicKeySize && len(g.Host.PublicKey) == ed25519.PublicKeySize && g.Host.ID == host && g.SpaceID == space && g.HubID == hub.ID && ed25519.Verify(hub.PublicKey, append([]byte("lever-lan-v1\n"), b...), s.Signature)
}

// LANCommand keeps the controller's proof with the proposed action. A Host can
// report the original request after reconnecting without impersonating a user.
type LANCommand struct {
	HubID   string `json:"hubId"`
	SpaceID string `json:"spaceId"`
	Intent  Intent `json:"intent"`
	Proof   []byte `json:"proof"`
}

func (c LANCommand) message() []byte {
	c.Proof = nil
	b, _ := json.Marshal(c)
	return append([]byte("lever-lan-command-v1\n"), b...)
}
func (c *LANCommand) Sign(key ed25519.PrivateKey) { c.Proof = ed25519.Sign(key, c.message()) }
func (c LANCommand) Verify(key []byte) bool {
	return len(key) == ed25519.PublicKeySize && ed25519.Verify(key, c.message(), c.Proof)
}

type LANReport struct {
	Command LANCommand `json:"command"`
	Receipt Receipt    `json:"receipt"`
}

type DirectPairParams struct {
	Reciprocal bool
	LANAddr    string
	HostID     string
	HostPub    ed25519.PublicKey
	Code       string
	HostName   string
}

func DirectPairLink(lanAddr, hostID string, hostPub ed25519.PublicKey, code, hostName string) string {
	q := url.Values{}
	q.Set("lan", lanAddr)
	q.Set("host", hostID) // Compatibility with older controllers.
	q.Set("node", hostID)
	q.Set("feature", "reciprocal_v1")
	q.Set("pub", base64.RawURLEncoding.EncodeToString(hostPub))
	q.Set("code", code)
	if hostName != "" {
		q.Set("name", hostName)
	}
	return "leverdevice://pair?" + q.Encode()
}

func ParseDirectPairLink(link string) (DirectPairParams, bool, error) {
	var out DirectPairParams
	u, err := url.Parse(strings.TrimSpace(link))
	if err != nil || u.Scheme != "leverdevice" || u.Host != "pair" || u.User != nil {
		return out, false, nil
	}
	q := u.Query()
	lanAddr := strings.TrimSpace(q.Get("lan"))
	if lanAddr == "" {
		return out, false, nil
	}
	if _, _, err := net.SplitHostPort(lanAddr); err != nil {
		return out, true, errors.New("局域网配对地址格式无效")
	}
	hostID := strings.TrimSpace(q.Get("node"))
	if hostID == "" {
		hostID = strings.TrimSpace(q.Get("host"))
	} else if old := q.Get("host"); old != "" && old != hostID {
		return out, true, errors.New("conflicting node identities")
	}
	code := strings.TrimSpace(q.Get("code"))
	pubRaw, err := base64.RawURLEncoding.DecodeString(strings.TrimSpace(q.Get("pub")))
	if hostID == "" || code == "" || err != nil || len(pubRaw) != ed25519.PublicKeySize {
		return out, true, errors.New("局域网配对链接缺少有效设备公钥或配对码")
	}
	out = DirectPairParams{
		Reciprocal: q.Get("feature") == "reciprocal_v1",
		LANAddr:    lanAddr,
		HostID:     hostID,
		HostPub:    ed25519.PublicKey(pubRaw),
		Code:       code,
		HostName:   strings.TrimSpace(q.Get("name")),
	}
	return out, true, nil
}

// PairDirect pairs a controller directly with a Host over TLS 1.3 on the LAN
// without requiring a Hub. The TLS certificate is pinned to hostPub from the QR.
func PairDirect(ctx context.Context, params DirectPairParams, in PairInput, key ed25519.PrivateKey) (ClientState, DirectPairReceipt, error) {
	var state ClientState
	var receipt DirectPairReceipt
	if len(params.HostPub) != ed25519.PublicKeySize {
		return state, receipt, errors.New("invalid host public key")
	}
	in.Code = params.Code
	in.Sign(key)
	body, err := json.Marshal(in)
	if err != nil {
		return state, receipt, err
	}
	client := http.Client{
		Timeout:       12 * time.Second,
		CheckRedirect: Client.CheckRedirect,
		Transport: &http.Transport{
			DisableKeepAlives: true,
			TLSClientConfig: &tls.Config{
				MinVersion:         tls.VersionTLS13,
				InsecureSkipVerify: true,
				VerifyConnection: func(cs tls.ConnectionState) error {
					_, err := PeerCertificate(cs, params.HostPub)
					return err
				},
			},
		},
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, "https://"+params.LANAddr+"/pair", bytes.NewReader(body))
	if err != nil {
		return state, receipt, err
	}
	req.Header.Set("Content-Type", "application/json")
	if err = Exchange(&client, req, &receipt); err != nil {
		return state, receipt, err
	}
	m := receipt.Membership
	if m.DeviceID != in.ID || m.Hub.ID != params.HostID || !bytes.Equal(m.Hub.PublicKey, params.HostPub) || m.SpaceID == "" {
		return state, receipt, errors.New("invalid direct pairing receipt")
	}
	grant, err := ParseGrant(receipt.Grant)
	if err != nil || !grant.Authentic(m.Hub, params.HostID, m.SpaceID) || grant.Grant.Controller.ID != in.ID || !bytes.Equal(grant.Grant.Controller.PublicKey, in.PublicKey) {
		return state, receipt, errors.New("invalid direct LAN grant")
	}
	lanAddr := receipt.LANAddr
	if lanAddr == "" {
		lanAddr = params.LANAddr
	}
	hostName := receipt.Host.Name
	if hostName == "" {
		hostName = params.HostName
	}
	state = ClientState{
		Origin:       "",
		Direct:       true,
		LANAddr:      lanAddr,
		HostName:     hostName,
		HostPlatform: receipt.Host.Platform,
		Membership:   m,
		Key:          key,
	}
	return state, receipt, nil
}
