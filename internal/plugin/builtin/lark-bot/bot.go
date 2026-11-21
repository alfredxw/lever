package larkbot

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
	"unicode"

	larkcore "github.com/larksuite/oapi-sdk-go/v3/core"
	"github.com/larksuite/oapi-sdk-go/v3/event/dispatcher"
	larkim "github.com/larksuite/oapi-sdk-go/v3/service/im/v1"
	larkws "github.com/larksuite/oapi-sdk-go/v3/ws"

	"lever/internal/plugin"
)

const (
	PluginID  = "lever.feishu"
	ChannelID = "feishu"
	Feishu    = "feishu"
	Lark      = "lark"
)

const feishuMessageBeingSent = 230049

type Bot struct {
	appID, secret string
	base          string
	client        *http.Client
	mu            sync.Mutex
	token         string
	expires       time.Time
}

func New(appID, secret, brand string) *Bot {
	base := "https://open.feishu.cn"
	if brand == Lark {
		base = "https://open.larksuite.com"
	}
	return &Bot{
		appID: appID, secret: secret, base: base,
		client: &http.Client{Timeout: 10 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error {
			return http.ErrUseLastResponse
		}},
	}
}

func (b *Bot) Listen(ctx context.Context, state func(string), receive func(context.Context, plugin.ChannelMessage) error) error {
	handler := dispatcher.NewEventDispatcher("", "").OnP2MessageReceiveV1(func(ctx context.Context, e *larkim.P2MessageReceiveV1) error {
		if e == nil || e.EventV2Base == nil || e.EventV2Base.Header == nil || e.EventV2Base.Header.AppID != b.appID || e.Event == nil {
			return nil
		}
		m, s := e.Event.Message, e.Event.Sender
		if m == nil || s == nil || s.SenderId == nil || value(m.ChatType) != "p2p" || value(s.SenderType) != "user" {
			return nil
		}
		msg := plugin.ChannelMessage{ID: value(m.MessageId), ChatID: value(m.ChatId), UserID: value(s.SenderId.OpenId), Tenant: e.TenantKey()}
		if msg.ID == "" || msg.ChatID == "" || msg.UserID == "" || msg.Tenant == "" || value(m.MessageType) != "text" {
			return nil
		}
		var content struct {
			Text string `json:"text"`
		}
		if json.Unmarshal([]byte(value(m.Content)), &content) != nil {
			return nil
		}
		msg.Text = strings.TrimSpace(content.Text)
		if msg.Text == "" {
			return nil
		}
		ctx, cancel := context.WithTimeout(ctx, 2500*time.Millisecond)
		defer cancel()
		return receive(ctx, msg)
	})
	client := larkws.NewClient(b.appID, b.secret, larkws.WithDomain(b.base), larkws.WithHttpClient(b.client),
		larkws.WithLogger(quietFeishuLogger{}), larkws.WithEventHandler(handler),
		larkws.WithOnReady(func() { state("online") }),
		larkws.WithOnReconnected(func() { state("online") }),
		larkws.WithOnDisconnected(func() { state("connecting") }),
		larkws.WithOnError(func(error) { state("error") }),
	)
	return client.Start(ctx)
}

// SDK errors can include the credential-bearing connection URL.
type quietFeishuLogger struct{}

func (quietFeishuLogger) Debug(context.Context, ...any) {}
func (quietFeishuLogger) Info(context.Context, ...any)  {}
func (quietFeishuLogger) Warn(context.Context, ...any)  {}
func (quietFeishuLogger) Error(context.Context, ...any) {}

func value(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}

func (b *Bot) Verify(ctx context.Context) (string, error) {
	token, err := b.accessToken(ctx)
	if err != nil {
		return "", err
	}
	var out struct {
		Bot struct {
			Name   string `json:"app_name"`
			OpenID string `json:"open_id"`
		} `json:"bot"`
	}
	if err := b.request(ctx, http.MethodGet, "/open-apis/bot/v3/info", token, nil, &out); err != nil {
		return "", err
	}
	if out.Bot.OpenID == "" {
		return "", errors.New("enable the Feishu app's bot capability first")
	}
	return out.Bot.Name, nil
}

func (b *Bot) Reply(ctx context.Context, messageID, deliveryID, text string) error {
	return b.post(ctx, "/open-apis/im/v1/messages/"+url.PathEscape(messageID)+"/reply", "", deliveryID, text)
}

func (b *Bot) Send(ctx context.Context, chatID, deliveryID, text string) error {
	return b.post(ctx, "/open-apis/im/v1/messages?receive_id_type=chat_id", chatID, deliveryID, text)
}

type feishuError struct {
	code, status int
}

func (e *feishuError) Error() string {
	return fmt.Sprintf("Feishu API rejected the request (HTTP %d, code %d)", e.status, e.code)
}

func (b *Bot) post(ctx context.Context, path, chatID, deliveryID, text string) error {
	token, err := b.accessToken(ctx)
	if err != nil {
		return err
	}
	content, _ := json.Marshal(map[string]string{"text": text})
	// Feishu's text limit applies to the encoded content. Leave room for the
	// suffix and the enclosing JSON when clipping a long answer.
	if len(content) > 24<<10 {
		const previewRunes = 3500
		count := 0
		for i := range text {
			if count == previewRunes {
				text = strings.TrimRightFunc(text[:i], unicode.IsSpace) + "\n\n[完整答复见 Lever · Full reply in Lever]"
				break
			}
			count++
		}
		content, _ = json.Marshal(map[string]string{"text": text})
	}
	body := map[string]string{"msg_type": "text", "content": string(content), "uuid": deliveryID}
	if chatID != "" {
		body["receive_id"] = chatID
	}
	var out struct {
		Data struct {
			MessageID string `json:"message_id"`
		} `json:"data"`
	}
	err = b.request(ctx, http.MethodPost, path, token, body, &out)
	var rejected *feishuError
	if errors.As(err, &rejected) && rejected.code != feishuMessageBeingSent {
		return err
	}
	if err != nil || out.Data.MessageID == "" {
		return plugin.ChannelDeliveryUnknown
	}
	return nil
}

func (b *Bot) accessToken(ctx context.Context) (string, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if time.Now().Before(b.expires) {
		return b.token, nil
	}
	var out struct {
		Token  string `json:"tenant_access_token"`
		Expire int    `json:"expire"`
	}
	in := map[string]string{"app_id": b.appID, "app_secret": b.secret}
	if err := b.request(ctx, http.MethodPost, "/open-apis/auth/v3/tenant_access_token/internal", "", in, &out); err != nil {
		return "", err
	}
	if out.Token == "" {
		return "", errors.New("Feishu returned no tenant access token")
	}
	b.token, b.expires = out.Token, time.Now().Add(time.Duration(out.Expire-60)*time.Second)
	return b.token, nil
}

func (b *Bot) request(ctx context.Context, method, path, token string, body map[string]string, out any) error {
	var raw []byte
	if body != nil {
		raw, _ = json.Marshal(body)
	}
	req, err := http.NewRequestWithContext(ctx, method, b.base+path, bytes.NewReader(raw))
	if err != nil {
		return errors.New("cannot build Feishu API request")
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json; charset=utf-8")
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	res, err := b.client.Do(req)
	if err != nil {
		return errors.New("cannot reach Feishu API")
	}
	defer res.Body.Close()
	if res.StatusCode >= 500 {
		return errors.New("Feishu API is temporarily unavailable")
	}
	if res.StatusCode == http.StatusRequestTimeout {
		return errors.New("Feishu API request timed out")
	}
	raw, err = io.ReadAll(io.LimitReader(res.Body, 1<<20))
	if err != nil {
		return errors.New("invalid response from Feishu API")
	}
	var result struct {
		Code *int `json:"code"`
	}
	_ = json.Unmarshal(raw, &result)
	if result.Code != nil && *result.Code != 0 {
		return &feishuError{code: *result.Code, status: res.StatusCode}
	}
	if res.StatusCode >= 400 {
		return &feishuError{status: res.StatusCode}
	}
	if res.StatusCode != http.StatusOK || result.Code == nil {
		return errors.New("invalid response from Feishu API")
	}
	if json.Unmarshal(raw, out) != nil {
		return errors.New("invalid response from Feishu API")
	}
	return nil
}

var _ plugin.ChannelAdapter = (*Bot)(nil)
var _ larkcore.Logger = quietFeishuLogger{}
