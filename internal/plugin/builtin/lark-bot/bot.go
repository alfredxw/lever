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
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode"

	larkcore "github.com/larksuite/oapi-sdk-go/v3/core"
	"github.com/larksuite/oapi-sdk-go/v3/event/dispatcher"
	larkim "github.com/larksuite/oapi-sdk-go/v3/service/im/v1"
	larkws "github.com/larksuite/oapi-sdk-go/v3/ws"

	"lever/internal/model"
	"lever/internal/plugin"
)

const (
	PluginID  = "lever.feishu"
	ChannelID = "feishu"
	Feishu    = "feishu"
	Lark      = "lark"
)

const (
	feishuMessageBeingSent = 230049
	feishuScopeMissingCode = 99991672
)

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
		if m == nil || s == nil || s.SenderId == nil {
			return nil
		}
		chatType := value(m.ChatType)
		if chatType != "p2p" && chatType != "group" {
			return nil
		}
		senderType := value(s.SenderType)
		if senderType != "user" && senderType != "app" && senderType != "bot" {
			return nil
		}
		userID := value(s.SenderId.OpenId)
		if userID == "" {
			userID = value(s.SenderId.UserId)
		}
		msg := plugin.ChannelMessage{
			ID:         value(m.MessageId),
			ChatID:     value(m.ChatId),
			ChatType:   chatType,
			UserID:     userID,
			SenderType: senderType,
			Tenant:     e.TenantKey(),
			RootID:     value(m.RootId),
			ParentID:   value(m.ParentId),
			ThreadID:   value(m.ThreadId),
		}
		if msg.ID == "" || msg.ChatID == "" || msg.UserID == "" || msg.Tenant == "" {
			return nil
		}
		msg.Text = extractMessageText(value(m.MessageType), value(m.Content))
		if msg.Text == "" {
			return nil
		}
		for _, mention := range m.Mentions {
			if mention == nil {
				continue
			}
			openID := ""
			if mention.Id != nil {
				openID = value(mention.Id.OpenId)
			}
			msg.Mentions = append(msg.Mentions, plugin.ChannelMention{
				Key:    value(mention.Key),
				Name:   value(mention.Name),
				OpenID: openID,
			})
		}
		ctx, cancel := context.WithTimeout(ctx, 2500*time.Millisecond)
		defer cancel()
		return receive(ctx, msg)
	})
	handler.Config.Logger = quietFeishuLogger{}
	client := larkws.NewClient(b.appID, b.secret, larkws.WithDomain(b.base), larkws.WithHttpClient(b.client),
		larkws.WithLogger(quietFeishuLogger{}), larkws.WithEventHandler(handler),
		larkws.WithOnReady(func() { state("online") }),
		larkws.WithOnReconnected(func() { state("online") }),
		larkws.WithOnDisconnected(func() { state("connecting") }),
		larkws.WithOnError(func(error) { state("error") }),
	)
	return client.Start(ctx)
}

func extractMessageText(msgType, raw string) string {
	switch msgType {
	case "text":
		var content struct {
			Text string `json:"text"`
		}
		if json.Unmarshal([]byte(raw), &content) != nil {
			return ""
		}
		return strings.TrimSpace(content.Text)
	case "post":
		var content struct {
			Title   string `json:"title"`
			Content [][]struct {
				Tag  string `json:"tag"`
				Text string `json:"text"`
			} `json:"content"`
		}
		if json.Unmarshal([]byte(raw), &content) != nil {
			return ""
		}
		var parts []string
		if title := strings.TrimSpace(content.Title); title != "" {
			parts = append(parts, title)
		}
		for _, line := range content.Content {
			var lineBuf strings.Builder
			for _, elem := range line {
				if elem.Text != "" {
					lineBuf.WriteString(elem.Text)
				}
			}
			if s := strings.TrimSpace(lineBuf.String()); s != "" {
				parts = append(parts, s)
			}
		}
		return strings.TrimSpace(strings.Join(parts, "\n"))
	default:
		return ""
	}
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
	name, _, err := b.VerifyInfo(ctx)
	return name, err
}

func (b *Bot) VerifyInfo(ctx context.Context) (string, string, error) {
	token, err := b.accessToken(ctx)
	if err != nil {
		return "", "", err
	}
	var out struct {
		Bot struct {
			Name   string `json:"app_name"`
			OpenID string `json:"open_id"`
		} `json:"bot"`
	}
	if err := b.request(ctx, http.MethodGet, "/open-apis/bot/v3/info", token, nil, &out); err != nil {
		return "", "", err
	}
	if out.Bot.OpenID == "" {
		return "", "", errors.New("enable the Feishu app's bot capability first")
	}
	return out.Bot.Name, out.Bot.OpenID, nil
}

func (b *Bot) Reply(ctx context.Context, messageID, deliveryID, text string) error {
	return b.Deliver(ctx, plugin.ChannelSendOptions{
		MessageID:  messageID,
		DeliveryID: deliveryID,
		Text:       text,
	})
}

func (b *Bot) Send(ctx context.Context, chatID, deliveryID, text string) error {
	return b.Deliver(ctx, plugin.ChannelSendOptions{
		ChatID:     chatID,
		DeliveryID: deliveryID,
		Text:       text,
	})
}

func (b *Bot) Deliver(ctx context.Context, opts plugin.ChannelSendOptions) error {
	token, err := b.accessToken(ctx)
	if err != nil {
		return err
	}
	path := ""
	receiveID := ""
	switch {
	case opts.OpenID != "":
		path = "/open-apis/im/v1/messages?receive_id_type=open_id"
		receiveID = opts.OpenID
	case opts.MessageID != "":
		path = "/open-apis/im/v1/messages/" + url.PathEscape(opts.MessageID) + "/reply"
	case opts.ChatID != "":
		path = "/open-apis/im/v1/messages?receive_id_type=chat_id"
		receiveID = opts.ChatID
	default:
		return errors.New("missing Feishu delivery target")
	}

	msgType := "text"
	contentStr := encodeMessageContent(opts.Text, opts.Card)
	if opts.Card {
		msgType = "interactive"
	}

	body := map[string]any{
		"msg_type": msgType,
		"content":  contentStr,
		"uuid":     opts.DeliveryID,
	}
	if receiveID != "" {
		body["receive_id"] = receiveID
	}
	if opts.MessageID != "" && opts.ReplyInThread {
		body["reply_in_thread"] = true
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

func encodeMessageContent(text string, card bool) string {
	clipped := clipForFeishu(text)
	if card {
		payload := map[string]any{
			"schema": "2.0",
			"config": map[string]any{"wide_screen_mode": true},
			"body": map[string]any{
				"elements": []map[string]any{
					{"tag": "markdown", "content": clipped},
				},
			},
		}
		raw, _ := json.Marshal(payload)
		return string(raw)
	}
	raw, _ := json.Marshal(map[string]string{"text": clipped})
	return string(raw)
}

func clipForFeishu(text string) string {
	// Feishu's text limit applies to the encoded content. Leave room for the
	// suffix and enclosing JSON when clipping a long answer.
	content, _ := json.Marshal(map[string]string{"text": text})
	if len(content) <= 24<<10 {
		return text
	}
	const previewRunes = 3500
	count := 0
	for i := range text {
		if count == previewRunes {
			return strings.TrimRightFunc(text[:i], unicode.IsSpace) + "\n\n[完整答复见 Lever · Full reply in Lever]"
		}
		count++
	}
	return text
}

func (b *Bot) AddReaction(ctx context.Context, messageID, emojiType string) (string, error) {
	if messageID == "" || emojiType == "" {
		return "", nil
	}
	token, err := b.accessToken(ctx)
	if err != nil {
		return "", err
	}
	body := map[string]any{
		"reaction_type": map[string]string{"emoji_type": emojiType},
	}
	var out struct {
		Data struct {
			ReactionID string `json:"reaction_id"`
		} `json:"data"`
	}
	path := "/open-apis/im/v1/messages/" + url.PathEscape(messageID) + "/reactions"
	if err := b.request(ctx, http.MethodPost, path, token, body, &out); err != nil {
		return "", err
	}
	return out.Data.ReactionID, nil
}

func (b *Bot) DeleteReaction(ctx context.Context, messageID, reactionID string) error {
	if messageID == "" || reactionID == "" {
		return nil
	}
	token, err := b.accessToken(ctx)
	if err != nil {
		return err
	}
	path := "/open-apis/im/v1/messages/" + url.PathEscape(messageID) + "/reactions/" + url.PathEscape(reactionID)
	var out struct{}
	return b.request(ctx, http.MethodDelete, path, token, nil, &out)
}

func (b *Bot) ListChats(ctx context.Context) ([]model.FeishuKnownChat, error) {
	token, err := b.accessToken(ctx)
	if err != nil {
		return nil, err
	}
	var out struct {
		Data struct {
			Items []struct {
				ChatID string `json:"chat_id"`
				Name   string `json:"name"`
			} `json:"items"`
		} `json:"data"`
	}
	if err := b.request(ctx, http.MethodGet, "/open-apis/im/v1/chats?page_size=50", token, nil, &out); err != nil {
		return nil, err
	}
	chats := make([]model.FeishuKnownChat, 0, len(out.Data.Items))
	for _, item := range out.Data.Items {
		if item.ChatID == "" {
			continue
		}
		name := strings.TrimSpace(item.Name)
		if name == "" {
			name = item.ChatID
		}
		chats = append(chats, model.FeishuKnownChat{ChatID: item.ChatID, Name: name})
	}
	return chats, nil
}

func (b *Bot) FetchHistory(ctx context.Context, chatID string, limit int) (string, error) {
	if chatID == "" || limit <= 0 {
		return "", nil
	}
	if limit > 50 {
		limit = 50
	}
	token, err := b.accessToken(ctx)
	if err != nil {
		return "", err
	}
	path := fmt.Sprintf("/open-apis/im/v1/messages?container_id_type=chat&container_id=%s&sort_type=ByCreateTimeDesc&page_size=%s",
		url.QueryEscape(chatID), strconv.Itoa(limit))
	var out struct {
		Data struct {
			Items []struct {
				MsgType string `json:"msg_type"`
				Sender  struct {
					ID         string `json:"id"`
					SenderType string `json:"sender_type"`
				} `json:"sender"`
				Body struct {
					Content string `json:"content"`
				} `json:"body"`
			} `json:"items"`
		} `json:"data"`
	}
	if err := b.request(ctx, http.MethodGet, path, token, nil, &out); err != nil {
		return "", err
	}
	items := out.Data.Items
	if len(items) == 0 {
		return "", nil
	}
	lines := make([]string, 0, len(items))
	// Reverse from newest-first to chronological order.
	for i := len(items) - 1; i >= 0; i-- {
		text := extractMessageText(items[i].MsgType, items[i].Body.Content)
		if text == "" {
			continue
		}
		sender := items[i].Sender.ID
		if sender == "" {
			sender = items[i].Sender.SenderType
		}
		if sender != "" {
			lines = append(lines, "["+sender+"]: "+text)
		} else {
			lines = append(lines, text)
		}
	}
	return strings.Join(lines, "\n"), nil
}

// CheckScopes probes lightweight read endpoints to report missing scopes.
func (b *Bot) CheckScopes(ctx context.Context, probeChatID string, needsGroupMsg bool) []string {
	var missing []string
	token, err := b.accessToken(ctx)
	if err != nil {
		return nil
	}
	var chatsOut struct {
		Data struct {
			Items []struct {
				ChatID string `json:"chat_id"`
			} `json:"items"`
		} `json:"data"`
	}
	err = b.request(ctx, http.MethodGet, "/open-apis/im/v1/chats?page_size=1", token, nil, &chatsOut)
	if isScopeError(err) {
		missing = append(missing, "im:chat:readonly")
	} else if err == nil && probeChatID == "" && len(chatsOut.Data.Items) > 0 {
		probeChatID = chatsOut.Data.Items[0].ChatID
	}
	if needsGroupMsg && probeChatID != "" {
		path := "/open-apis/im/v1/messages?container_id_type=chat&container_id=" + url.QueryEscape(probeChatID) + "&page_size=1"
		var msgOut struct{}
		if isScopeError(b.request(ctx, http.MethodGet, path, token, nil, &msgOut)) {
			missing = append(missing, "im:message.group_msg")
		}
	}
	return missing
}

func isScopeError(err error) bool {
	var fe *feishuError
	return errors.As(err, &fe) && (fe.code == feishuScopeMissingCode || fe.status == http.StatusForbidden)
}

type feishuError struct {
	code, status int
}

func (e *feishuError) Error() string {
	return fmt.Sprintf("Feishu API rejected the request (HTTP %d, code %d)", e.status, e.code)
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

func (b *Bot) request(ctx context.Context, method, path, token string, body any, out any) error {
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
	if out != nil && json.Unmarshal(raw, out) != nil {
		return errors.New("invalid response from Feishu API")
	}
	return nil
}

var _ plugin.ChannelAdapter = (*Bot)(nil)
var _ larkcore.Logger = quietFeishuLogger{}
