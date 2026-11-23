package remoteproto

import (
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"errors"
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
