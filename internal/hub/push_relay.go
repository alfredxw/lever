package hub

import (
	"bytes"
	"context"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"strings"
	"time"

	p "lever/internal/remoteproto"
)

type relayConfig struct {
	Origin    string
	TokenFile string
	IOS       bool
	Firebase  *p.FirebaseClient
	key       string
}
type relayDelivery struct {
	Activity *activityState `json:"activity,omitempty"`
	Platform string         `json:"platform"`
	Token    string         `json:"token"`
	Notice   p.PushEnvelope `json:"notice"`
}

func readRelayKey(path string) (string, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	key := strings.TrimSpace(string(b))
	if len(key) < 32 || len(key) > 256 || strings.ContainsAny(key, " \t\r\n") {
		return "", errors.New("invalid push relay credential")
	}
	return key, nil
}
func (c *relayConfig) forward(ctx context.Context, msg relayDelivery) error {
	raw, _ := json.Marshal(msg)
	req, err := http.NewRequestWithContext(ctx, "POST", c.Origin+"/api/push-relay", bytes.NewReader(raw))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+c.key)
	resp, err := p.Client.Do(req)
	if err != nil {
		return errors.New("push relay connection failed")
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusGone {
		return errInvalidPushToken
	}
	if resp.StatusCode/100 != 2 {
		return fmt.Errorf("push relay HTTP %d", resp.StatusCode)
	}
	return nil
}

// Only a publisher that explicitly supplies a relay credential serves this
// route. A tenant cannot select a destination URL, title or notification body.
func (h *Hub) relayPush(w http.ResponseWriter, r *http.Request, _ principal) error {
	if h.push == nil || h.push.relayKey == "" {
		return problem{404, "not found"}
	}
	if subtle.ConstantTimeCompare([]byte(r.Header.Get("Authorization")), []byte("Bearer "+h.push.relayKey)) != 1 {
		return denied
	}
	r.Body = http.MaxBytesReader(w, r.Body, 12<<10)
	var d relayDelivery
	if err := read(r, &d); err != nil {
		return err
	}
	if d.Activity != nil {
		token, e := hex.DecodeString(d.Token)
		if e != nil || len(token) < 16 || len(token) > 256 || d.Platform != "ios" || !d.Activity.valid() {
			return invalid("invalid live activity")
		}
		ctx, cancel := context.WithTimeout(r.Context(), 12*time.Second)
		defer cancel()
		err := h.push.sendActivity(ctx, d.Token, *d.Activity)
		if errors.Is(err, errInvalidPushToken) {
			return problem{410, "activity expired"}
		}
		if err != nil {
			return problem{502, "platform delivery failed"}
		}
		return send(w, true)
	}
	if !h.push.available(d.Platform) || len(d.Token) < 16 || len(d.Token) > 4096 || strings.ContainsAny(d.Token, " \t\r\n") || len(d.Notice.Payload) > 4096 || len(d.Notice.Tag) != 64 {
		return invalid("invalid notification")
	}
	if d.Platform == "ios" {
		if _, err := hex.DecodeString(d.Token); err != nil {
			return invalid("invalid APNs token")
		}
	}
	if _, err := hex.DecodeString(d.Notice.Tag); err != nil {
		return invalid("invalid notification tag")
	}
	raw, err := base64.RawURLEncoding.DecodeString(d.Notice.Payload)
	if err != nil || len(raw) < 28 {
		return invalid("invalid notification payload")
	}
	switch d.Notice.Kind {
	case "request", "failure", "result":
	default:
		return invalid("invalid notification kind")
	}
	ctx, cancel := context.WithTimeout(r.Context(), 12*time.Second)
	defer cancel()
	err = h.push.send(ctx, d.Platform, d.Token, d.Notice)
	if errors.Is(err, errInvalidPushToken) {
		return problem{410, "device token expired"}
	}
	if err != nil {
		return problem{502, "platform delivery failed"}
	}
	return send(w, true)
}
