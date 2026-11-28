package hub

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"time"

	"github.com/sideshow/apns2"
	"github.com/sideshow/apns2/token"
	"golang.org/x/oauth2"
	"golang.org/x/oauth2/jwt"
	p "lever/internal/remoteproto"
)

type pushProviders struct {
	apple    *apns2.Client
	topic    string
	android  *http.Client
	fcmURL   string
	firebase *p.FirebaseClient
	relay    *relayConfig
	relayKey string
}

var errInvalidPushToken = errors.New("push token is no longer registered")

func (h *Hub) ConfigurePush(ctx context.Context, path string) error {
	if path == "" {
		return nil
	}
	var cfg struct {
		Relay          *relayConfig
		RelayTokenFile string
		APNs           *struct{ KeyFile, KeyID, TeamID, Topic, Environment string }
		FCM            *struct {
			ServiceAccountFile string
			Firebase           p.FirebaseClient
		}
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	if err = p.Decode(raw, &cfg); err != nil {
		return fmt.Errorf("invalid push configuration: %w", err)
	}
	validFirebase := func(c p.FirebaseClient) bool {
		return c.ProjectID != "" && c.AppID != "" && c.APIKey != "" && c.SenderID != ""
	}
	resolve := func(file string) string {
		if filepath.IsAbs(file) {
			return file
		}
		return filepath.Join(filepath.Dir(path), file)
	}
	d := &pushProviders{}
	if cfg.Relay != nil {
		if cfg.APNs != nil || cfg.FCM != nil || cfg.RelayTokenFile != "" {
			return errors.New("select either a delivery relay or platform credentials")
		}
		relay := cfg.Relay
		origin, err := p.Origin(relay.Origin)
		if err != nil {
			return err
		}
		relay.Origin = origin
		relay.key, err = readRelayKey(resolve(relay.TokenFile))
		if err != nil {
			return err
		}
		if !relay.IOS && relay.Firebase == nil {
			return errors.New("enable a platform for the delivery relay")
		}
		if relay.Firebase != nil && !validFirebase(*relay.Firebase) {
			return errors.New("FCM requires the Android app Firebase options")
		}
		d.relay, d.firebase = relay, relay.Firebase
		h.push = d
		return nil
	}
	if cfg.RelayTokenFile != "" {
		d.relayKey, err = readRelayKey(resolve(cfg.RelayTokenFile))
		if err != nil {
			return err
		}
	}
	if a := cfg.APNs; a != nil {
		if a.KeyID == "" || a.TeamID == "" || a.Topic == "" || a.KeyFile == "" {
			return errors.New("APNs requires keyFile, keyId, teamId and topic")
		}
		key, err := token.AuthKeyFromFile(resolve(a.KeyFile))
		if err != nil {
			return err
		}
		d.apple = apns2.NewTokenClient(&token.Token{AuthKey: key, KeyID: a.KeyID, TeamID: a.TeamID})
		d.topic = a.Topic
		switch a.Environment {
		case "production":
			d.apple.Production()
		case "development":
			d.apple.Development()
		default:
			return errors.New("APNs environment must be development or production")
		}
	}
	if f := cfg.FCM; f != nil {
		client := f.Firebase
		if !validFirebase(client) {
			return errors.New("FCM requires the Android app Firebase options")
		}
		raw, err := os.ReadFile(resolve(f.ServiceAccountFile))
		if err != nil {
			return err
		}
		var key struct {
			Type      string `json:"type"`
			Email     string `json:"client_email"`
			Key       string `json:"private_key"`
			KeyID     string `json:"private_key_id"`
			ProjectID string `json:"project_id"`
		}
		if err = json.Unmarshal(raw, &key); err != nil || key.Type != "service_account" || key.Email == "" || key.Key == "" || key.ProjectID != client.ProjectID {
			return errors.New("invalid FCM service account or project mismatch")
		}
		auth := jwt.Config{Email: key.Email, PrivateKey: []byte(key.Key), PrivateKeyID: key.KeyID, TokenURL: "https://oauth2.googleapis.com/token", Scopes: []string{"https://www.googleapis.com/auth/firebase.messaging"}}
		authCtx := context.WithValue(ctx, oauth2.HTTPClient, &http.Client{Timeout: 10 * time.Second})
		d.android = auth.Client(authCtx)
		d.firebase = &client
		d.fcmURL = "https://fcm.googleapis.com/v1/projects/" + url.PathEscape(client.ProjectID) + "/messages:send"
	}
	if d.apple == nil && d.android == nil {
		return errors.New("push configuration must define APNs or FCM")
	}
	h.push = d
	return nil
}
func (d *pushProviders) available(platform string) bool {
	if d == nil {
		return false
	}
	if d.relay != nil {
		return platform == "ios" && d.relay.IOS || platform == "android" && d.firebase != nil
	}
	return platform == "ios" && d.apple != nil || platform == "android" && d.android != nil
}
func (d *pushProviders) send(ctx context.Context, platform, recipient string, n p.PushEnvelope) error {
	if !d.available(platform) {
		return errors.New("push platform is not configured")
	}
	if d.relay != nil {
		return d.relay.forward(ctx, relayDelivery{Platform: platform, Token: recipient, Notice: n})
	}
	body := "有新的执行结果"
	switch n.Kind {
	case "request":
		body = "有请求等待你处理"
	case "failure":
		body = "有执行需要你查看"
	}
	if platform == "ios" {
		msg := &apns2.Notification{DeviceToken: recipient, Topic: d.topic, CollapseID: n.Tag, PushType: apns2.PushTypeAlert, Priority: apns2.PriorityHigh, Expiration: time.Now().Add(24 * time.Hour),
			Payload: map[string]any{"aps": map[string]any{"alert": map[string]string{"title": "Lever", "body": body}, "sound": "default"}, "lever": n.Payload}}
		return d.sendApple(ctx, msg)
	}
	payload, err := json.Marshal(map[string]any{"message": map[string]any{
		"token": recipient, "notification": map[string]string{"title": "Lever", "body": body},
		"data":    map[string]string{"lever": n.Payload},
		"android": map[string]any{"priority": "HIGH", "ttl": "86400s", "notification": map[string]string{"tag": n.Tag}},
	}})
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, "POST", d.fcmURL, bytes.NewReader(payload))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := d.android.Do(req)
	if err != nil {
		return errors.New("FCM connection or authentication failed")
	}
	defer resp.Body.Close()
	if resp.StatusCode/100 == 2 {
		_, err = io.Copy(io.Discard, resp.Body)
		return err
	}
	var result struct {
		Error struct {
			Details []struct {
				Code string `json:"errorCode"`
			}
		}
	}
	_ = json.NewDecoder(io.LimitReader(resp.Body, 8192)).Decode(&result)
	for _, v := range result.Error.Details {
		if v.Code == "UNREGISTERED" {
			return errInvalidPushToken
		}
	}
	return fmt.Errorf("FCM HTTP %d", resp.StatusCode)
}

func (d *pushProviders) sendApple(ctx context.Context, msg *apns2.Notification) error {
	resp, err := d.apple.PushWithContext(ctx, msg)
	if err != nil {
		return errors.New("APNs connection failed")
	}
	if resp.Sent() {
		return nil
	}
	switch resp.Reason {
	case "Unregistered", "BadDeviceToken":
		return errInvalidPushToken
	}
	return fmt.Errorf("APNs HTTP %d (%s)", resp.StatusCode, resp.Reason)
}
