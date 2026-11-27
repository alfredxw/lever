package httpapi_test

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	larkws "github.com/larksuite/oapi-sdk-go/v3/ws"
	"lever/internal/app"
	"lever/internal/model"
)

type feishuPost struct {
	parent, uuid, text, host, msgType, receiveType string
	inThread                                       bool
}

func TestFeishuChannelPrivateChatDelivery(t *testing.T) {
	const appID = "cli_test"
	const secret = "fixture-app-secret"
	feishu := newFeishuFixture(t, nil)
	f := newFixture(t)
	agent := f.agent("codex")
	nextAgent := f.agent("codex")

	var channel model.ChannelView
	f.request("GET", "/channels/feishu", nil, 200, &channel)
	if !channel.Enabled || channel.Configured {
		t.Fatal(channel)
	}
	f.request("PUT", "/channels/feishu/bot", map[string]string{"appId": appID, "appSecret": secret}, 200, &channel)
	socket := feishu.nextSocket()
	feishu.waitChannel(f, func(c model.ChannelView) bool { return c.Connection == "online" })
	f.request("POST", "/channels/feishu/pair", nil, 200, &channel)
	command := "/pair " + channel.PairCode
	feishu.event(socket, appID, "pair-group", "oc_group", "ou_owner", "group", "user", command)
	f.request("GET", "/channels/feishu", nil, 200, &channel)
	if channel.PairCandidate != "" {
		t.Fatal("group message entered pairing")
	}
	feishu.event(socket, appID, "pair-dm", "oc_owner", "ou_owner", "p2p", "user", command)
	channel = feishu.waitChannel(f, func(c model.ChannelView) bool { return c.PairCandidate == "ou_owner" })
	f.request("POST", "/channels/feishu/binding", map[string]string{"agentId": agent.ID, "candidate": "ou_other"}, 409, nil)
	f.request("POST", "/channels/feishu/binding", map[string]string{"agentId": agent.ID, "candidate": channel.PairCandidate, "name": "Owner"}, 200, nil)
	channel = feishu.waitChannel(f, func(c model.ChannelView) bool { return c.ChatID != "" })
	chatID := channel.ChatID
	if chatID == "" || channel.OwnerName != "Owner" || channel.PairCandidate != "" {
		t.Fatal(channel)
	}
	var raw json.RawMessage
	f.request("GET", "/channels/feishu", nil, 200, &raw)
	if bytes.Contains(raw, []byte(secret)) || bytes.Contains(raw, []byte("oc_owner")) {
		t.Fatal("channel view exposed secret or routing data")
	}
	f.request("POST", "/messages", model.SendInput{ChatID: chatID, CommandID: app.ID(), Operation: "main", Text: "desktop input"}, 409, nil)
	f.request("POST", "/channels/feishu/test", nil, 200, nil)
	if test := feishu.nextPost(); test.parent != "oc_owner" {
		t.Fatal("test message was not sent to the paired chat", test)
	}

	feishu.event(socket, appID, "ignored", "oc_owner", "ou_other", "p2p", "user", "not the owner")
	denied := feishu.nextPost()
	if denied.parent != "ignored" || !strings.Contains(denied.text, "ou_other") || !strings.Contains(denied.text, "permission") {
		t.Fatal("unauthorized DM did not receive a permission-denied reply", denied)
	}
	feishu.event(socket, appID, "bot", "oc_owner", "ou_owner", "p2p", "bot", "bot output")
	feishu.event(socket, appID, "approval", "oc_owner", "ou_owner", "p2p", "user", "[approval]")
	feishu.event(socket, appID, "approval", "oc_owner", "ou_owner", "p2p", "user", "[approval]")
	waiting := feishu.nextPost()
	if waiting.parent != "approval" || !strings.Contains(waiting.text, "Open Lever") {
		t.Fatal("approval did not point back to Lever", waiting)
	}
	var overview model.Overview
	f.request("GET", "/overview", nil, 200, &overview)
	if len(overview.Requests) != 1 {
		t.Fatal("unexpected approval count", overview.Requests)
	}
	feishu.event(socket, appID, "followup", "oc_owner", "ou_owner", "p2p", "user", "channel follow-up")
	f.request("GET", "/overview", nil, 200, &overview)
	if len(overview.Runs) != 2 || overview.Runs[1].Status != "queued" {
		t.Fatal("second message did not wait for approval", overview.Runs)
	}
	f.request("POST", "/requests/"+overview.Requests[0].ID+"/answer", model.Answer{Allow: true}, 200, nil)
	if answer := feishu.nextPost(); answer.parent != "approval" || answer.uuid == waiting.uuid {
		t.Fatal("wrong approval turn reply", answer)
	}
	if answer := feishu.nextPost(); answer.parent != "followup" || !strings.Contains(answer.text, "channel follow-up") {
		t.Fatal("wrong follow-up reply", answer)
	}

	feishu.event(socket, appID, "reject-once", "oc_owner", "ou_owner", "p2p", "user", "retry the delivery")
	rejected := feishu.nextPost()
	run := feishu.waitReply(f, chatID, "retry the delivery", "failed")
	f.request("POST", "/runs/"+run.ID+"/channel-reply/retry", nil, 200, nil)
	if retried := feishu.nextPost(); retried != rejected {
		t.Fatal("retry changed recipient, reply, or delivery key", rejected, retried)
	}
	feishu.waitReply(f, chatID, "retry the delivery", "sent")
	feishu.event(socket, appID, "ambiguous", "oc_owner", "ou_owner", "p2p", "user", "unconfirmed delivery")
	feishu.nextPost()
	run = feishu.waitReply(f, chatID, "unconfirmed delivery", "unknown")
	f.request("POST", "/runs/"+run.ID+"/channel-reply/retry", nil, 409, nil)

	f.request("PUT", "/channels/feishu/pause", map[string]bool{"paused": true}, 200, nil)
	feishu.event(socket, appID, "paused", "oc_owner", "ou_owner", "p2p", "user", "paused input")
	f.request("PUT", "/channels/feishu/agent", map[string]string{"agentId": nextAgent.ID}, 200, &channel)
	if channel.ChatID == chatID || !channel.Paused {
		t.Fatal("changing Agent failed to isolate the Chat", channel)
	}
	f.request("PUT", "/channels/feishu/pause", map[string]bool{"paused": false}, 200, nil)
	feishu.event(socket, appID, "followup", "oc_owner", "ou_owner", "p2p", "user", "channel follow-up")
	feishu.event(socket, appID, "new-chat", "oc_owner", "ou_owner", "p2p", "user", "new Agent chat")
	if post := feishu.nextPost(); post.parent != "new-chat" {
		t.Fatal("redelivery was rerouted to the new Agent", post)
	}
	feishu.waitReply(f, channel.ChatID, "new Agent chat", "sent")
	var old model.ChatView
	f.request("GET", "/chats/"+chatID, nil, 200, &old)
	if len(old.Runs) != 4 {
		t.Fatal("duplicate, paused, or unauthorized input was accepted", old.Runs)
	}

	if err := socket.Close(); err != nil {
		t.Fatal(err)
	}
	socket = feishu.nextSocket()
	feishu.waitChannel(f, func(c model.ChannelView) bool { return c.Connection == "online" })
	currentChat := channel.ChatID
	restartProviderFixture(t, f)
	socket = feishu.nextSocket()
	channel = feishu.waitChannel(f, func(c model.ChannelView) bool { return c.Connection == "online" })
	if channel.ChatID != currentChat || channel.AgentID != nextAgent.ID || channel.LastMessageAt == "" {
		t.Fatal("binding was not restored on restart", channel)
	}
	feishu.event(socket, appID, "new-chat", "oc_owner", "ou_owner", "p2p", "user", "new Agent chat")
	feishu.event(socket, appID, "after-restart", "oc_owner", "ou_owner", "p2p", "user", "same chat after restart")
	if post := feishu.nextPost(); post.parent != "after-restart" {
		t.Fatal("restart repeated an old delivery", post)
	}
	feishu.waitReply(f, currentChat, "same chat after restart", "sent")

	f.request("DELETE", "/channels/feishu/binding", nil, 200, nil)
	channel = feishu.waitChannel(f, func(c model.ChannelView) bool { return c.ChatID == "" })
	if channel.ChatID != "" || channel.OwnerName != "" {
		t.Fatal("binding still active", channel)
	}
	f.request("GET", "/chats/"+chatID, nil, 200, nil)
}

func TestFeishuRegistrationCreatesAgentAtPairing(t *testing.T) {
	const appID, secret = "cli_registered", "fixture-registered-secret"
	const basePath = "/channels/feishu"
	approved := make(chan struct{})
	var starts atomic.Int32
	feishu := newFeishuFixture(t, func(w http.ResponseWriter, r *http.Request) {
		switch r.FormValue("action") {
		case "begin":
			if r.FormValue("archetype") != "PersonalAgent" {
				http.Error(w, "missing app template", http.StatusBadRequest)
				return
			}
			starts.Add(1)
			fmt.Fprint(w, `{"device_code":"device-fixture","verification_uri_complete":"https://accounts.feishu.cn/create?user_code=fixture","interval":1,"expire_in":60}`)
		case "poll":
			if r.Header.Get("X-Fixture-Host") == "accounts.feishu.cn" {
				fmt.Fprint(w, `{"error":"authorization_pending","user_info":{"tenant_brand":"lark"}}`)
				return
			}
			select {
			case <-approved:
				fmt.Fprintf(w, `{"client_id":%q,"client_secret":%q}`, appID, secret)
			case <-r.Context().Done():
			}
		default:
			http.Error(w, "unknown registration action", http.StatusBadRequest)
		}
	})
	f := newFixture(t)
	waitPhase := func(phase string) model.ChannelView {
		return feishu.waitChannel(f, func(c model.ChannelView) bool {
			return c.Registration != nil && c.Registration.Phase == phase
		})
	}
	f.request("POST", basePath+"/registration", nil, 200, nil)
	channel := waitPhase("waiting")
	link, err := url.Parse(channel.Registration.URL)
	if err != nil {
		t.Fatal(err)
	}
	options := link.Query()
	if options.Has("createOnly") || options.Has("clientID") {
		t.Fatal("setup link must allow creating a bot or choosing an existing one")
	}
	if options.Get("addons") == "" {
		t.Fatal("setup link omitted the bot's permissions and events")
	}
	f.request("POST", basePath+"/registration", nil, 200, nil)
	if starts.Load() != 1 {
		t.Fatal("a second registration started")
	}
	f.request("DELETE", basePath+"/registration", nil, 200, nil)
	channel = waitPhase("cancelled")
	if channel.Configured || channel.Registration.URL != "" {
		t.Fatal("cancelled registration still active", channel)
	}
	f.request("POST", basePath+"/registration", nil, 200, nil)
	waitPhase("waiting")
	close(approved)
	socket := feishu.nextSocket()
	channel = feishu.waitChannel(f, func(c model.ChannelView) bool { return c.Connection == "online" })
	if !channel.Configured || channel.AppID != appID || channel.Brand != "lark" || channel.BotName != "Fixture Bot" || channel.PairCode == "" || channel.Registration != nil {
		t.Fatal("registered bot not ready for pairing", channel)
	}
	f.request("POST", basePath+"/registration", nil, 409, nil)
	var raw json.RawMessage
	f.request("GET", basePath, nil, 200, &raw)
	if bytes.Contains(raw, []byte(secret)) {
		t.Fatal("channel view exposed registration secret")
	}

	feishu.event(socket, appID, "pair-new", "oc_owner", "ou_owner", "p2p", "user", "/pair "+channel.PairCode)
	channel = feishu.waitChannel(f, func(c model.ChannelView) bool { return c.PairCandidate == "ou_owner" })
	input := model.ChannelPairInput{Candidate: channel.PairCandidate, NewAgent: &model.ChannelAgentDraft{Provider: "codex", Directory: f.root}}
	if _, err := f.a.Store.DB.Exec(`CREATE TRIGGER reject_channel_chat BEFORE INSERT ON chats BEGIN SELECT RAISE(ABORT, 'fixture write failure'); END`); err != nil {
		t.Fatal(err)
	}
	f.request("POST", basePath+"/binding", input, 500, nil)
	var overview model.Overview
	f.request("GET", "/overview", nil, 200, &overview)
	if len(overview.Agents) != 0 || len(overview.Chats) != 0 {
		t.Fatal("pairing left an Agent or Chat after rollback")
	}
	if _, err := f.a.Store.DB.Exec("DROP TRIGGER reject_channel_chat"); err != nil {
		t.Fatal(err)
	}
	f.request("POST", basePath+"/binding", input, 200, &channel)
	f.request("POST", basePath+"/binding", input, 409, nil)
	f.request("GET", "/overview", nil, 200, &overview)
	if len(overview.Agents) != 1 || len(overview.Chats) != 1 || channel.ChatID != overview.Chats[0].ID {
		t.Fatal("pairing did not create one Agent and Chat", channel)
	}
	agent := overview.Agents[0]
	dir, err := filepath.EvalSymlinks(f.root)
	if err != nil || agent.ID != channel.AgentID || agent.Name != "Fixture Bot" || agent.Profile.Provider != "codex" || len(agent.Profile.Roots) != 1 || agent.Profile.Roots[0].Path != dir {
		t.Fatal("unexpected paired Agent", agent, err)
	}
	feishu.event(socket, appID, "registered-dm", "oc_owner", "ou_owner", "p2p", "user", "hello new agent")
	if reply := feishu.nextPost(); reply.parent != "registered-dm" || reply.host != "open.larksuite.com" || !strings.Contains(reply.text, "hello new agent") {
		t.Fatal("wrong registered bot reply", reply)
	}
}

type feishuReactionCall struct {
	method, messageID, emoji, reactionID string
}

type feishuFixture struct {
	t                *testing.T
	sockets          chan *websocket.Conn
	posts            chan feishuPost
	reactions        chan feishuReactionCall
	denyContactScope atomic.Bool
}

// Route the Feishu and Lark origins to a local test platform. The SDK
// still performs its HTTP bootstrap, WebSocket handshake and protobuf ACKs.
type feishuTestTransport struct {
	server *httptest.Server
	base   http.RoundTripper
}

func (tr feishuTestTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	switch r.URL.Host {
	case "open.feishu.cn", "open.larksuite.com", "accounts.feishu.cn", "accounts.larksuite.com":
	default:
		return tr.base.RoundTrip(r)
	}
	r = r.Clone(r.Context())
	r.Header.Set("X-Fixture-Host", r.URL.Host)
	r.URL.Scheme = "http"
	r.URL.Host = strings.TrimPrefix(tr.server.URL, "http://")
	r.Host = r.URL.Host
	return tr.server.Client().Transport.RoundTrip(r)
}

func newFeishuFixture(t *testing.T, register http.HandlerFunc) *feishuFixture {
	t.Helper()
	f := &feishuFixture{
		t:         t,
		sockets:   make(chan *websocket.Conn, 4),
		posts:     make(chan feishuPost, 16),
		reactions: make(chan feishuReactionCall, 32),
	}
	var rejected sync.Map
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		write := func(body string) { _, _ = fmt.Fprint(w, body) }
		switch r.URL.Path {
		case "/oauth/v1/app/registration":
			if register == nil {
				http.NotFound(w, r)
				return
			}
			register(w, r)
		case "/open-apis/auth/v3/tenant_access_token/internal":
			write(`{"code":0,"tenant_access_token":"tenant-fixture","expire":7200}`)
		case "/open-apis/bot/v3/info":
			write(`{"code":0,"bot":{"app_name":"Fixture Bot","open_id":"ou_bot"}}`)
		case "/callback/ws/endpoint":
			write(fmt.Sprintf(`{"code":0,"data":{"URL":"ws://%s/events?device_id=test&service_id=17","ClientConfig":{"PingInterval":30,"ReconnectCount":3,"ReconnectNonce":0,"ReconnectInterval":1}}}`, r.Host))
		case "/events":
			upgrader := websocket.Upgrader{}
			conn, err := upgrader.Upgrade(w, r, nil)
			if err == nil {
				f.sockets <- conn
			}
		case "/open-apis/im/v1/chats":
			write(`{"code":0,"data":{"items":[{"chat_id":"oc_dev_group","name":"Lever 研发群"},{"chat_id":"oc_oncall","name":"Oncall 值班群"}]}}`)
		case "/open-apis/contact/v3/scopes":
			if f.denyContactScope.Load() {
				w.WriteHeader(http.StatusForbidden)
				write(`{"code":99991672,"msg":"Access denied. One of the following scopes is required: [contact:contact.base:readonly]"}`)
				return
			}
			write(`{"code":0,"data":{"department_ids":["od_eng"],"user_ids":["ou_direct"]}}`)
		case "/open-apis/contact/v3/users/batch":
			if f.denyContactScope.Load() {
				w.WriteHeader(http.StatusForbidden)
				write(`{"code":99991672,"msg":"scope missing"}`)
				return
			}
			write(`{"code":0,"data":{"items":[{"open_id":"ou_direct","name":"王直属","en_name":"Direct Wang","email":"direct@example.com","avatar":{"avatar_72":"https://cdn.example.com/direct.png"}}]}}`)
		case "/open-apis/contact/v3/users/find_by_department":
			if f.denyContactScope.Load() {
				w.WriteHeader(http.StatusForbidden)
				write(`{"code":99991672,"msg":"scope missing"}`)
				return
			}
			write(`{"code":0,"data":{"items":[{"open_id":"ou_alice","name":"张爱丽","en_name":"Alice Zhang","enterprise_email":"alice@example.com","avatar":{"avatar_72":"https://cdn.example.com/alice.png"}}],"has_more":false}}`)
		case "/open-apis/contact/v3/users/batch_get_id":
			if f.denyContactScope.Load() {
				w.WriteHeader(http.StatusForbidden)
				write(`{"code":99991672,"msg":"scope missing"}`)
				return
			}
			var qbody struct {
				Emails  []string `json:"emails"`
				Mobiles []string `json:"mobiles"`
			}
			_ = json.NewDecoder(r.Body).Decode(&qbody)
			list := make([]map[string]string, 0)
			for _, e := range qbody.Emails {
				if strings.EqualFold(e, "bob@example.com") {
					list = append(list, map[string]string{"email": e, "user_id": "ou_bob"})
				}
			}
			for _, m := range qbody.Mobiles {
				if m == "13800138000" {
					list = append(list, map[string]string{"mobile": m, "user_id": "ou_mobile"})
				}
			}
			rawList, _ := json.Marshal(map[string]any{"code": 0, "data": map[string]any{"user_list": list}})
			write(string(rawList))
		default:
			if strings.HasPrefix(r.URL.Path, "/open-apis/contact/v3/departments/") && strings.HasSuffix(r.URL.Path, "/children") {
				write(`{"code":0,"data":{"items":[],"has_more":false}}`)
				return
			}
			if strings.HasPrefix(r.URL.Path, "/open-apis/contact/v3/users/") {
				if f.denyContactScope.Load() {
					w.WriteHeader(http.StatusForbidden)
					write(`{"code":99991672,"msg":"scope missing"}`)
					return
				}
				uid := strings.TrimPrefix(r.URL.Path, "/open-apis/contact/v3/users/")
				switch uid {
				case "ou_foreign":
					w.WriteHeader(http.StatusBadRequest)
					write(`{"code":99992361,"msg":"open_id cross app"}`)
				case "ou_bob", "on_bob":
					write(`{"code":0,"data":{"user":{"open_id":"ou_bob","name":"李鲍勃","en_name":"Bob Li","email":"bob@example.com","avatar":{"avatar_72":"https://cdn.example.com/bob.png"}}}}`)
				case "ou_mobile":
					write(`{"code":0,"data":{"user":{"open_id":"ou_mobile","name":"陈手机","en_name":"Mobile Chen"}}}`)
				case "ou_first":
					write(`{"code":0,"data":{"user":{"open_id":"ou_first","name":"首条管理员","en_name":"First Admin","avatar":{"avatar_72":"https://cdn.example.com/first.png"}}}}`)
				case "ou_requester":
					write(`{"code":0,"data":{"user":{"open_id":"ou_requester","name":"赵访客","en_name":"Guest Zhao","avatar":{"avatar_72":"https://cdn.example.com/guest.png"}}}}`)
				default:
					write(`{"code":41012,"msg":"no such user"}`)
				}
				return
			}
			if strings.HasPrefix(r.URL.Path, "/open-apis/im/v1/chats/") && strings.HasSuffix(r.URL.Path, "/members") {
				write(`{"code":0,"data":{"items":[{"member_id":"ou_chat_member","name":"群成员小周"},{"member_id":"ou_alice","name":"张爱丽"}],"has_more":false}}`)
				return
			}
			if strings.Contains(r.URL.Path, "/reactions") {
				rest := strings.TrimPrefix(r.URL.Path, "/open-apis/im/v1/messages/")
				parts := strings.Split(rest, "/")
				msgID := ""
				if len(parts) > 0 {
					msgID = parts[0]
				}
				call := feishuReactionCall{method: r.Method, messageID: msgID}
				if r.Method == http.MethodPost {
					var rbody struct {
						ReactionType struct {
							EmojiType string `json:"emoji_type"`
						} `json:"reaction_type"`
					}
					_ = json.NewDecoder(r.Body).Decode(&rbody)
					call.emoji = rbody.ReactionType.EmojiType
				} else if r.Method == http.MethodDelete && len(parts) >= 3 {
					call.reactionID = parts[2]
				}
				select {
				case f.reactions <- call:
				default:
				}
				write(`{"code":0,"data":{"reaction_id":"react_1"}}`)
				return
			}
			if !strings.HasPrefix(r.URL.Path, "/open-apis/im/v1/messages") {
				http.NotFound(w, r)
				return
			}
			if r.Method == http.MethodGet {
				write(`{"code":0,"data":{"items":[]}}`)
				return
			}
			var body map[string]any
			if json.NewDecoder(r.Body).Decode(&body) != nil || r.Header.Get("Authorization") != "Bearer tenant-fixture" {
				http.Error(w, "invalid Feishu request", http.StatusBadRequest)
				return
			}
			str := func(k string) string { s, _ := body[k].(string); return s }
			inThread, _ := body["reply_in_thread"].(bool)
			msgType := str("msg_type")
			rawContent := str("content")
			text := ""
			if msgType == "interactive" {
				var card struct {
					Body struct {
						Elements []struct {
							Content string `json:"content"`
						} `json:"elements"`
					} `json:"body"`
				}
				_ = json.Unmarshal([]byte(rawContent), &card)
				if len(card.Body.Elements) > 0 {
					text = card.Body.Elements[0].Content
				}
			} else {
				var content map[string]string
				_ = json.Unmarshal([]byte(rawContent), &content)
				text = content["text"]
			}
			parent := str("receive_id")
			if parent == "" {
				parent = strings.TrimSuffix(strings.TrimPrefix(r.URL.Path, "/open-apis/im/v1/messages/"), "/reply")
			}
			f.posts <- feishuPost{
				parent:      parent,
				uuid:        str("uuid"),
				text:        text,
				host:        r.Header.Get("X-Fixture-Host"),
				msgType:     msgType,
				receiveType: r.URL.Query().Get("receive_id_type"),
				inThread:    inThread,
			}
			switch parent {
			case "reject-once":
				if _, retry := rejected.LoadOrStore(parent, true); !retry {
					write(`{"code":230027,"msg":"permission denied"}`)
					return
				}
			case "ambiguous":
				w.WriteHeader(http.StatusBadRequest)
				write(`{"code":230049,"msg":"The message is being sent."}`)
				return
			case "no-thread-fallback":
				if inThread {
					w.WriteHeader(http.StatusBadRequest)
					write(`{"code":230071,"msg":"The group to which the message belongs does not support reply in thread."}`)
					return
				}
			}
			write(`{"code":0,"data":{"message_id":"om_sent"}}`)
		}
	}))
	previous := http.DefaultTransport
	http.DefaultTransport = feishuTestTransport{server: server, base: previous}
	t.Cleanup(func() {
		http.DefaultTransport = previous
		server.Close()
	})
	return f
}

func (f *feishuFixture) nextSocket() *websocket.Conn {
	f.t.Helper()
	select {
	case conn := <-f.sockets:
		f.t.Cleanup(func() { _ = conn.Close() })
		return conn
	case <-time.After(5 * time.Second):
		f.t.Fatal("Feishu WebSocket not connected")
		return nil
	}
}

func (f *feishuFixture) event(conn *websocket.Conn, appID, id, chat, user, kind, sender, text string) {
	f.t.Helper()
	content, _ := json.Marshal(map[string]string{"text": text})
	payload, _ := json.Marshal(map[string]any{
		"schema": "2.0",
		"header": map[string]string{"event_id": id, "event_type": "im.message.receive_v1", "app_id": appID, "tenant_key": "tenant"},
		"event": map[string]any{
			"message": map[string]string{"message_id": id, "chat_id": chat, "chat_type": kind, "message_type": "text", "content": string(content)},
			"sender":  map[string]any{"sender_type": sender, "sender_id": map[string]string{"open_id": user}},
		},
	})
	frame := larkws.Frame{Method: 1, Service: 17, Payload: payload, Headers: []larkws.Header{
		{Key: "type", Value: "event"}, {Key: "message_id", Value: id}, {Key: "sum", Value: "1"}, {Key: "seq", Value: "0"},
	}}
	raw, _ := frame.Marshal()
	if err := conn.WriteMessage(websocket.BinaryMessage, raw); err != nil {
		f.t.Fatal(err)
	}
	_ = conn.SetReadDeadline(time.Now().Add(3 * time.Second))
	for {
		_, raw, err := conn.ReadMessage()
		if err != nil {
			f.t.Fatal(err)
		}
		var ack larkws.Frame
		if err := ack.Unmarshal(raw); err != nil {
			f.t.Fatal(err)
		}
		if ack.Method == 0 {
			continue
		}
		var response struct{ Code int }
		if json.Unmarshal(ack.Payload, &response) != nil || response.Code != http.StatusOK {
			f.t.Fatalf("Feishu ACK: %s", ack.Payload)
		}
		return
	}
}

func (f *feishuFixture) nextPost() feishuPost {
	f.t.Helper()
	select {
	case post := <-f.posts:
		return post
	case <-time.After(8 * time.Second):
		f.t.Fatal("no outbound Feishu message")
		return feishuPost{}
	}
}

func (f *feishuFixture) waitChannel(lever *fixture, ready func(model.ChannelView) bool) model.ChannelView {
	f.t.Helper()
	var c model.ChannelView
	for deadline := time.Now().Add(5 * time.Second); time.Now().Before(deadline); time.Sleep(20 * time.Millisecond) {
		c = model.ChannelView{}
		lever.request("GET", "/channels/feishu", nil, 200, &c)
		if ready(c) {
			return c
		}
	}
	f.t.Fatal("channel did not reach expected state", c)
	return c
}

func (f *feishuFixture) waitReply(lever *fixture, chat, input, state string) model.Run {
	f.t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 6*time.Second)
	defer cancel()
	var view model.ChatView
	for ctx.Err() == nil {
		lever.request("GET", "/chats/"+chat, nil, 200, &view)
		for _, run := range view.Runs {
			if run.Input == input && run.Channel != nil && run.Channel.Status == state {
				return run
			}
		}
		time.Sleep(20 * time.Millisecond)
	}
	f.t.Fatalf("channel reply for %q did not reach %s", input, state)
	return model.Run{}
}

func (f *feishuFixture) groupEvent(conn *websocket.Conn, appID, id, chat, user, rootID, text string, mentions []map[string]any) {
	f.t.Helper()
	content, _ := json.Marshal(map[string]string{"text": text})
	msg := map[string]any{
		"message_id":   id,
		"chat_id":      chat,
		"chat_type":    "group",
		"message_type": "text",
		"content":      string(content),
	}
	if rootID != "" {
		msg["root_id"] = rootID
	}
	if len(mentions) > 0 {
		msg["mentions"] = mentions
	}
	payload, _ := json.Marshal(map[string]any{
		"schema": "2.0",
		"header": map[string]string{"event_id": id, "event_type": "im.message.receive_v1", "app_id": appID, "tenant_key": "tenant"},
		"event": map[string]any{
			"message": msg,
			"sender":  map[string]any{"sender_type": "user", "sender_id": map[string]string{"open_id": user}},
		},
	})
	frame := larkws.Frame{Method: 1, Service: 17, Payload: payload, Headers: []larkws.Header{
		{Key: "type", Value: "event"}, {Key: "message_id", Value: id}, {Key: "sum", Value: "1"}, {Key: "seq", Value: "0"},
	}}
	raw, _ := frame.Marshal()
	if err := conn.WriteMessage(websocket.BinaryMessage, raw); err != nil {
		f.t.Fatal(err)
	}
	_ = conn.SetReadDeadline(time.Now().Add(3 * time.Second))
	for {
		_, raw, err := conn.ReadMessage()
		if err != nil {
			f.t.Fatal(err)
		}
		var ack larkws.Frame
		if err := ack.Unmarshal(raw); err != nil {
			f.t.Fatal(err)
		}
		if ack.Method == 0 {
			continue
		}
		return
	}
}

func TestFeishuMultiBotConfigAndGroupOverrides(t *testing.T) {
	feishu := newFeishuFixture(t, nil)
	f := newFixture(t)
	agentDev := f.agent("codex")
	agentOps := f.agent("codex")

	// 1. Bind two independent bots to two different Agents using presets.
	var view model.ChannelView
	f.request("POST", "/channels/feishu/bots", model.FeishuBotCreateInput{
		AppID:       "cli_dev_bot",
		AppSecret:   "secret-dev-bot",
		Brand:       "feishu",
		DisplayName: "代码评审助手",
		AgentID:     agentDev.ID,
		Preset:      "dev",
	}, 200, &view)
	sockDev := feishu.nextSocket()

	f.request("POST", "/channels/feishu/bots", model.FeishuBotCreateInput{
		AppID:       "cli_ops_bot",
		AppSecret:   "secret-ops-bot",
		Brand:       "lark",
		DisplayName: "Oncall 助手",
		AgentID:     agentOps.ID,
		Preset:      "oncall",
	}, 200, &view)
	sockOps := feishu.nextSocket()

	// Duplicate AppID+Brand must be rejected.
	f.request("POST", "/channels/feishu/bots", model.FeishuBotCreateInput{
		AppID:     "cli_dev_bot",
		AppSecret: "secret-dev-bot",
		Brand:     "feishu",
	}, 409, nil)

	view = feishu.waitChannel(f, func(c model.ChannelView) bool {
		return len(c.Bots) == 2 && c.Bots[0].Connection == "online" && c.Bots[1].Connection == "online"
	})
	botDev, botOps := view.Bots[0], view.Bots[1]
	if botDev.Settings.AgentID != agentDev.ID || botOps.Settings.AgentID != agentOps.ID {
		t.Fatalf("unexpected agent bindings: %+v %+v", botDev.Settings, botOps.Settings)
	}

	// Ensure secrets are never exposed in GET /channels/feishu.
	var rawView json.RawMessage
	f.request("GET", "/channels/feishu", nil, 200, &rawView)
	if bytes.Contains(rawView, []byte("secret-dev-bot")) || bytes.Contains(rawView, []byte("secret-ops-bot")) {
		t.Fatal("channel view exposed bot secrets")
	}

	// 2. Fetch joined chats list for group rule picker.
	var chats []model.FeishuKnownChat
	f.request("GET", "/channels/feishu/bots/"+botDev.ID+"/chats", nil, 200, &chats)
	if len(chats) != 2 || chats[0].ChatID != "oc_dev_group" {
		t.Fatalf("unexpected joined chats: %+v", chats)
	}

	// 3. Configure per-group override (identity prompt + model override + dm_first + text + hideLocalAddresses).
	devSettings := botDev.Settings
	devSettings.DefaultPrompt = "默认飞书助手提示"
	devSettings.Admins = []string{"ou_admin"}
	devSettings.Advanced.BlockedUsers = []string{"ou_blocked"}
	devSettings.Advanced.HideLocalAddresses = true
	devSettings.ChatOverrides = []model.FeishuChatOverride{
		{
			ID:               "rule-dev",
			ChatID:           "oc_dev_group",
			ChatName:         "Lever 研发群",
			Enabled:          true,
			PromptMode:       "append",
			Prompt:           "专注 PR 审查",
			Selection:        &model.Selection{Provider: "codex", Model: "override-model"},
			GroupMention:     "at_only",
			GroupReplyTarget: "topic",
			ReplyStyle:       "card",
		},
		{
			ID:               "rule-dmfirst",
			ChatID:           "oc_quiet_group",
			ChatName:         "静默群",
			Enabled:          true,
			PromptMode:       "replace",
			Prompt:           "只私聊回复",
			GroupMention:     "yield",
			GroupReplyTarget: "dm_first",
			ReplyStyle:       "text",
		},
	}
	f.request("PUT", "/channels/feishu/bots/"+botDev.ID+"/settings", devSettings, 200, &view)

	// Blocked user is ignored in DM even when dmAccess == "all".
	feishu.event(sockDev, "cli_dev_bot", "blocked-dm", "oc_dm_blocked", "ou_blocked", "p2p", "user", "should ignore")

	// Unlisted group @mention gets an explicit permission-denied reply (while unmentioned chatter stays silent).
	feishu.groupEvent(sockDev, "cli_dev_bot", "unlisted-chatter", "oc_unknown", "ou_alice", "", "just chatting", nil)
	feishu.groupEvent(sockDev, "cli_dev_bot", "unlisted-grp", "oc_unknown", "ou_alice", "", "@_user_1 hello", []map[string]any{
		{"key": "@_user_1", "name": "Fixture Bot", "id": map[string]string{"open_id": "ou_bot"}},
	})
	groupDenied := feishu.nextPost()
	if groupDenied.parent != "unlisted-grp" || !strings.Contains(groupDenied.text, "oc_unknown") {
		t.Fatalf("expected group allowlist denied notice, got %+v", groupDenied)
	}

	// Mentioning dev bot in oc_dev_group triggers card reply in thread with model override and prompt.
	fixtureHome := path.Join("/Users", "fixture-user")
	feishu.groupEvent(sockDev, "cli_dev_bot", "grp-at-1", "oc_dev_group", "ou_alice", "", "@_user_1 review "+fixtureHome+"/app http://127.0.0.1:8080", []map[string]any{
		{"key": "@_user_1", "name": "Fixture Bot", "id": map[string]string{"open_id": "ou_bot"}},
	})
	post := feishu.nextPost()
	if post.parent != "grp-at-1" || !post.inThread || post.msgType != "interactive" {
		t.Fatalf("expected interactive thread reply, got %+v", post)
	}
	if strings.Contains(post.text, fixtureHome) || strings.Contains(post.text, "127.0.0.1") {
		t.Fatalf("expected local paths and addresses redacted, got %q", post.text)
	}
	if !strings.Contains(post.text, "<at id=ou_alice></at>") {
		t.Fatalf("expected requester mention in group card reply, got %q", post.text)
	}

	// Verify run persisted model override + composed identity prompt.
	var storedModel, storedPrompt string
	if err := f.a.Store.DB.QueryRow(`SELECT json_extract(r.data,'$.selection.model'), COALESCE(json_extract(r.data,'$.channelPrompt'),'')
FROM runs r JOIN channel_deliveries d ON d.run_id=r.id WHERE d.message_id='grp-at-1' AND d.part='answer'`).Scan(&storedModel, &storedPrompt); err != nil {
		t.Fatal(err)
	}
	if storedModel != "override-model" || !strings.Contains(storedPrompt, "默认飞书助手提示") || !strings.Contains(storedPrompt, "专注 PR 审查") {
		t.Fatalf("unexpected model/prompt: model=%q prompt=%q", storedModel, storedPrompt)
	}

	// Yield mode in oc_quiet_group: message @mentioning someone else is ignored; unmentioned message replies via dm_first!
	feishu.groupEvent(sockDev, "cli_dev_bot", "grp-yield-skip", "oc_quiet_group", "ou_alice", "", "@_user_1 ask bob", []map[string]any{
		{"key": "@_user_1", "name": "Bob", "id": map[string]string{"open_id": "ou_bob"}},
	})
	feishu.groupEvent(sockDev, "cli_dev_bot", "grp-yield-hit", "oc_quiet_group", "ou_alice", "", "quiet check", nil)
	dmPost := feishu.nextPost()
	if dmPost.receiveType != "open_id" || dmPost.parent != "ou_alice" || dmPost.msgType != "text" {
		t.Fatalf("expected dm_first text reply to ou_alice, got %+v", dmPost)
	}

	// Second bot routes independently to agentOps over Lark domain!
	opsSettings := botOps.Settings
	opsSettings.DMAccess = "whitelist"
	opsSettings.DMWhitelist = []string{"ou_sre"}
	f.request("PUT", "/channels/feishu/bots/"+botOps.ID+"/settings", opsSettings, 200, &view)
	feishu.event(sockOps, "cli_ops_bot", "ops-denied", "oc_ops_dm", "ou_stranger", "p2p", "user", "denied dm")
	opsDenied := feishu.nextPost()
	if opsDenied.parent != "ops-denied" || !strings.Contains(opsDenied.text, "ou_stranger") {
		t.Fatalf("expected DM permission-denied reply for ou_stranger, got %+v", opsDenied)
	}
	feishu.event(sockOps, "cli_ops_bot", "ops-ok", "oc_ops_dm", "ou_sre", "p2p", "user", "check alert")
	opsPost := feishu.nextPost()
	if opsPost.parent != "ops-ok" || opsPost.host != "open.larksuite.com" || !strings.Contains(opsPost.text, "check alert") {
		t.Fatalf("unexpected second bot reply: %+v", opsPost)
	}

	// 4. Pause / enable, check-scopes, update credentials, persist across restart, and delete bot.
	f.request("PUT", "/channels/feishu/bots/"+botOps.ID+"/enabled", map[string]bool{"enabled": false}, 200, &view)
	if view.Bots[1].Enabled {
		t.Fatal("expected botOps to be paused")
	}
	f.request("POST", "/channels/feishu/bots/"+botDev.ID+"/check-scopes", nil, 200, &view)
	f.request("PUT", "/channels/feishu/bots/"+botDev.ID+"/credentials", model.FeishuBotCredentialsInput{
		DisplayName: "研发审查 Bot",
		AppID:       "cli_dev_bot",
		Brand:       "feishu",
	}, 200, &view)
	if view.Bots[0].Settings.DisplayName != "研发审查 Bot" {
		t.Fatalf("displayName not updated: %+v", view.Bots[0].Settings)
	}

	// Persistence across backend restart!
	restartProviderFixture(t, f)
	_ = feishu.nextSocket()
	_ = feishu.nextSocket()
	view = feishu.waitChannel(f, func(c model.ChannelView) bool {
		return len(c.Bots) == 2 && c.Bots[0].Connection == "online" && c.Bots[1].Connection == "online"
	})
	if view.Bots[0].Settings.DisplayName != "研发审查 Bot" || len(view.Bots[0].Settings.ChatOverrides) != 2 || view.Bots[1].Enabled {
		t.Fatalf("multi-bot config did not survive restart: %+v", view.Bots)
	}

	// Delete second bot cleanly.
	f.request("DELETE", "/channels/feishu/bots/"+botOps.ID, nil, 200, &view)
	if len(view.Bots) != 1 || view.Bots[0].ID != botDev.ID {
		t.Fatalf("expected 1 remaining bot after delete, got %+v", view.Bots)
	}
}

func TestFeishuMultiBotRegistrationWithDirectSettings(t *testing.T) {
	const appID, secret = "cli_qr_direct", "secret-qr-direct"
	approved := make(chan struct{})
	var starts atomic.Int32
	feishu := newFeishuFixture(t, func(w http.ResponseWriter, r *http.Request) {
		switch r.FormValue("action") {
		case "begin":
			starts.Add(1)
			fmt.Fprint(w, `{"device_code":"device-multi","verification_uri_complete":"https://accounts.feishu.cn/create?user_code=multi","interval":1,"expire_in":60}`)
		case "poll":
			select {
			case <-approved:
				fmt.Fprintf(w, `{"client_id":%q,"client_secret":%q}`, appID, secret)
			case <-r.Context().Done():
			}
		default:
			http.Error(w, "unknown registration action", http.StatusBadRequest)
		}
	})
	f := newFixture(t)
	agentA := f.agent("codex")
	agentB := f.agent("codex")

	// Start QR registration with direct settings (no preset).
	var view model.ChannelView
	f.request("POST", "/channels/feishu/bots/registration", model.FeishuRegistrationInput{
		AgentID: agentA.ID,
		Settings: &model.FeishuBotSettings{
			DMAccess:     "admin",
			DMMode:       "continuous",
			ReplyStyle:   "card",
			GroupEnabled: false,
		},
	}, 200, &view)
	view = feishu.waitChannel(f, func(c model.ChannelView) bool {
		return c.Registration != nil && c.Registration.Phase == "waiting" && c.Registration.URL != ""
	})
	if starts.Load() != 1 {
		t.Fatalf("expected 1 registration start, got %d", starts.Load())
	}

	// Update the pending registration draft while QR is waiting (must not start a second registration).
	f.request("PUT", "/channels/feishu/bots/registration", model.FeishuRegistrationInput{
		DisplayName: "我的群聊助手",
		AgentID:     agentB.ID,
		Settings: &model.FeishuBotSettings{
			DMAccess:         "whitelist",
			DMWhitelist:      []string{"ou_alice"},
			DMMode:           "topic",
			ReplyStyle:       "text",
			GroupEnabled:     true,
			GroupAccess:      "any",
			GroupMention:     "at_only",
			GroupReplyTarget: "quote",
		},
	}, 200, &view)
	if starts.Load() != 1 {
		t.Fatalf("updating draft started a second registration: %d", starts.Load())
	}

	// Cancel and immediately restart must not get stuck in cancelling state.
	f.request("DELETE", "/channels/feishu/registration", nil, 200, &view)
	f.request("POST", "/channels/feishu/bots/registration", model.FeishuRegistrationInput{
		DisplayName: "我的群聊助手",
		AgentID:     agentB.ID,
		Settings: &model.FeishuBotSettings{
			DMAccess:         "whitelist",
			DMWhitelist:      []string{"ou_alice"},
			DMMode:           "topic",
			ReplyStyle:       "text",
			GroupEnabled:     true,
			GroupAccess:      "any",
			GroupMention:     "at_only",
			GroupReplyTarget: "quote",
		},
	}, 200, &view)
	view = feishu.waitChannel(f, func(c model.ChannelView) bool {
		return c.Registration != nil && c.Registration.Phase == "waiting" && c.Registration.URL != ""
	})
	if starts.Load() != 2 {
		t.Fatalf("expected restart after cancel to start registration #2, got %d", starts.Load())
	}

	// Complete QR authorization and verify the bot uses the direct settings + default advanced safety flags.
	close(approved)
	_ = feishu.nextSocket()
	view = feishu.waitChannel(f, func(c model.ChannelView) bool {
		return c.Registration == nil && len(c.Bots) == 1 && c.Bots[0].Connection == "online"
	})
	got := view.Bots[0].Settings
	if got.DisplayName != "我的群聊助手" || got.AgentID != agentB.ID ||
		got.DMAccess != "whitelist" || len(got.DMWhitelist) != 1 || got.DMWhitelist[0] != "ou_alice" ||
		got.DMMode != "topic" || got.ReplyStyle != "text" ||
		!got.GroupEnabled || got.GroupAccess != "any" || got.GroupMention != "at_only" || got.GroupReplyTarget != "quote" {
		t.Fatalf("unexpected bot settings after QR registration: %+v", got)
	}
	if !got.Advanced.ReactionAck || !got.Advanced.SenderTag || !got.Advanced.HideLocalAddresses || got.Advanced.HistoryLimit != 20 {
		t.Fatalf("default advanced settings were not preserved: %+v", got.Advanced)
	}

	// Creating a second bot manually with direct settings (no preset) also preserves advanced defaults.
	f.request("POST", "/channels/feishu/bots", model.FeishuBotCreateInput{
		AppID:       "cli_manual_direct",
		AppSecret:   "secret-manual-direct",
		Brand:       "feishu",
		DisplayName: "手动直配机器人",
		AgentID:     agentA.ID,
		Settings: &model.FeishuBotSettings{
			DMAccess:     "all",
			DMMode:       "continuous",
			ReplyStyle:   "card",
			GroupEnabled: false,
		},
	}, 200, &view)
	_ = feishu.nextSocket()
	if len(view.Bots) != 2 {
		t.Fatalf("expected 2 bots, got %d", len(view.Bots))
	}
	manual := view.Bots[1].Settings
	if manual.DMAccess != "all" || manual.GroupEnabled || !manual.Advanced.HideLocalAddresses || manual.Advanced.HistoryLimit != 20 {
		t.Fatalf("unexpected manual bot settings: %+v", manual)
	}
}

func TestFeishuQRAdminReactionsAndContinuousDM(t *testing.T) {
	const appID, secret = "cli_qr_admin", "secret-qr-admin"
	feishu := newFeishuFixture(t, func(w http.ResponseWriter, r *http.Request) {
		switch r.FormValue("action") {
		case "begin":
			fmt.Fprint(w, `{"device_code":"device-admin","verification_uri_complete":"https://accounts.feishu.cn/create?user_code=admin","interval":1,"expire_in":60}`)
		case "poll":
			fmt.Fprintf(w, `{"client_id":%q,"client_secret":%q,"user_info":{"open_id":"ou_scanner","tenant_brand":"feishu"}}`, appID, secret)
		default:
			http.Error(w, "unknown action", http.StatusBadRequest)
		}
	})
	f := newFixture(t)
	agent := f.agent("codex")

	// 1. QR registration with default dmAccess:"admin" automatically grants admin to the scanning user.
	var view model.ChannelView
	f.request("POST", "/channels/feishu/bots/registration", model.FeishuRegistrationInput{
		AgentID: agent.ID,
		Settings: &model.FeishuBotSettings{
			DMAccess:     "admin",
			DMMode:       "continuous",
			ReplyStyle:   "card",
			GroupEnabled: false,
		},
	}, 200, &view)
	sock := feishu.nextSocket()
	view = feishu.waitChannel(f, func(c model.ChannelView) bool {
		return c.Registration == nil && len(c.Bots) == 1 && c.Bots[0].Connection == "online"
	})
	bot := view.Bots[0]
	if len(bot.Settings.Admins) != 1 || bot.Settings.Admins[0] != "ou_scanner" {
		t.Fatalf("expected QR scanner open_id auto-added to admins, got %+v", bot.Settings.Admins)
	}
	if bot.Settings.Reaction != "OnIt" || bot.Settings.ReactionDone != "DONE" {
		t.Fatalf("expected default OnIt -> DONE reactions, got %q -> %q", bot.Settings.Reaction, bot.Settings.ReactionDone)
	}

	// 2. Customize reactions to THINKING -> PARTY and reject invalid emoji keys.
	badSettings := bot.Settings
	badSettings.Reaction = "not valid!"
	f.request("PUT", "/channels/feishu/bots/"+bot.ID+"/settings", badSettings, 400, nil)

	customSettings := bot.Settings
	customSettings.Reaction = "THINKING"
	customSettings.ReactionDone = "PARTY"
	f.request("PUT", "/channels/feishu/bots/"+bot.ID+"/settings", customSettings, 200, &view)

	// Scanner can immediately DM, and two consecutive messages stay in the SAME session.
	feishu.event(sock, appID, "dm-1", "oc_scanner_dm", "ou_scanner", "p2p", "user", "first continuous dm")
	firstPost := feishu.nextPost()
	if firstPost.parent != "dm-1" || !strings.Contains(firstPost.text, "first continuous dm") {
		t.Fatalf("unexpected first DM reply: %+v", firstPost)
	}

	// Verify THINKING was added and swapped to PARTY.
	var addedEmojis []string
	deadline := time.After(3 * time.Second)
	for len(addedEmojis) < 2 {
		select {
		case rc := <-feishu.reactions:
			if rc.messageID == "dm-1" && rc.method == http.MethodPost {
				addedEmojis = append(addedEmojis, rc.emoji)
			}
		case <-deadline:
			t.Fatalf("expected THINKING and PARTY reactions, got %v", addedEmojis)
		}
	}
	if addedEmojis[0] != "THINKING" || addedEmojis[1] != "PARTY" {
		t.Fatalf("unexpected reaction sequence: %v", addedEmojis)
	}

	// Keep-original reaction mode (Reaction: "Get", ReactionDone: "") should only add Get.
	keepSettings := view.Bots[0].Settings
	keepSettings.Reaction = "Get"
	keepSettings.ReactionDone = ""
	view = model.ChannelView{}
	f.request("PUT", "/channels/feishu/bots/"+bot.ID+"/settings", keepSettings, 200, &view)
	if view.Bots[0].Settings.Reaction != "Get" || view.Bots[0].Settings.ReactionDone != "" {
		t.Fatalf("keep-original reaction settings not preserved: %+v", view.Bots[0].Settings)
	}

	feishu.event(sock, appID, "dm-2", "oc_scanner_dm", "ou_scanner", "p2p", "user", "second continuous dm")
	secondPost := feishu.nextPost()
	if secondPost.parent != "dm-2" || !strings.Contains(secondPost.text, "second continuous dm") {
		t.Fatalf("unexpected second DM reply: %+v", secondPost)
	}
	gotGet := false
	getDeadline := time.After(2 * time.Second)
	for !gotGet {
		select {
		case rc := <-feishu.reactions:
			if rc.messageID == "dm-2" && rc.method == http.MethodPost && rc.emoji == "Get" {
				gotGet = true
			} else if rc.messageID == "dm-2" {
				t.Fatalf("unexpected reaction on keep-original turn: %+v", rc)
			}
		case <-getDeadline:
			t.Fatal("expected Get reaction on dm-2")
		}
	}

	// Both continuous DM runs must share the exact same Lever chat_id and session_id, and bot.ChatID must be populated.
	var chat1, sess1, chat2, sess2 string
	if err := f.a.Store.DB.QueryRow(`SELECT r.chat_id, r.session_id FROM runs r JOIN channel_deliveries d ON d.run_id=r.id WHERE d.message_id='dm-1' AND d.part='answer'`).Scan(&chat1, &sess1); err != nil {
		t.Fatal(err)
	}
	if err := f.a.Store.DB.QueryRow(`SELECT r.chat_id, r.session_id FROM runs r JOIN channel_deliveries d ON d.run_id=r.id WHERE d.message_id='dm-2' AND d.part='answer'`).Scan(&chat2, &sess2); err != nil {
		t.Fatal(err)
	}
	if chat1 == "" || chat1 != chat2 || sess1 == "" || sess1 != sess2 {
		t.Fatalf("continuous DM split across sessions: msg1=(%s,%s) msg2=(%s,%s)", chat1, sess1, chat2, sess2)
	}
	f.request("GET", "/channels/feishu", nil, 200, &view)
	if view.Bots[0].ChatID != chat1 {
		t.Fatalf("expected bot.ChatID=%q from ChatMap, got %q", chat1, view.Bots[0].ChatID)
	}

	// Group @mention when groupEnabled=false replies with group-disabled notice.
	feishu.groupEvent(sock, appID, "grp-disabled", "oc_some_grp", "ou_scanner", "", "@_user_1 ping", []map[string]any{
		{"key": "@_user_1", "name": "Fixture Bot", "id": map[string]string{"open_id": "ou_bot"}},
	})
	grpNotice := feishu.nextPost()
	if grpNotice.parent != "grp-disabled" || !strings.Contains(grpNotice.text, "Group chat is disabled") {
		t.Fatalf("expected group-disabled notice, got %+v", grpNotice)
	}

	// DM topic mode reply_in_thread falls back cleanly to quote reply on Feishu code 230071.
	topicSettings := view.Bots[0].Settings
	topicSettings.DMMode = "topic"
	f.request("PUT", "/channels/feishu/bots/"+bot.ID+"/settings", topicSettings, 200, &view)
	feishu.event(sock, appID, "no-thread-fallback", "oc_scanner_dm", "ou_scanner", "p2p", "user", "fallback test")
	attempt1 := feishu.nextPost()
	attempt2 := feishu.nextPost()
	if !attempt1.inThread || attempt2.inThread || attempt2.parent != "no-thread-fallback" {
		t.Fatalf("expected thread fallback retry, got attempt1=%+v attempt2=%+v", attempt1, attempt2)
	}
}

func TestFeishuDirectMessageBindAndContactSearch(t *testing.T) {
	const appID, secret = "cli_direct_bind", "secret-direct-bind"
	feishu := newFeishuFixture(t, nil)
	f := newFixture(t)
	agent := f.agent("codex")

	// 1. Create a manual bot with default admin-only DM policy and NO admins configured yet.
	var view model.ChannelView
	f.request("POST", "/channels/feishu/bots", model.FeishuBotCreateInput{
		AppID:       appID,
		AppSecret:   secret,
		Brand:       "feishu",
		DisplayName: "直连助手",
		AgentID:     agent.ID,
		Settings: &model.FeishuBotSettings{
			DMAccess:     "admin",
			DMMode:       "continuous",
			ReplyStyle:   "card",
			Reaction:     "OnIt",
			ReactionDone: "DONE",
		},
	}, 200, &view)
	sock := feishu.nextSocket()
	view = feishu.waitChannel(f, func(c model.ChannelView) bool {
		return len(c.Bots) == 1 && c.Bots[0].Connection == "online"
	})
	botID := view.Bots[0].ID

	// 2. First normal DM message directly binds the sender as admin & paired owner (no /pair needed!)
	// and immediately gets an Agent reply.
	feishu.event(sock, appID, "direct-dm-1", "oc_first_dm", "ou_first", "p2p", "user", "hello without pair")
	firstReply := feishu.nextPost()
	if firstReply.parent != "direct-dm-1" || !strings.Contains(firstReply.text, "hello without pair") {
		t.Fatalf("expected immediate reply after direct DM bind, got %+v", firstReply)
	}
	view = feishu.waitChannel(f, func(c model.ChannelView) bool {
		return len(c.Bots) == 1 && c.Bots[0].Paired && len(c.Bots[0].Settings.Admins) == 1 && c.Bots[0].OwnerName == "首条管理员"
	})
	if view.Bots[0].Settings.Admins[0] != "ou_first" || view.Bots[0].ChatID == "" {
		t.Fatalf("expected auto-bound admin and chatId, got %+v", view.Bots[0])
	}

	// 3. Another unauthorized user DMs the now-bound bot -> gets permission-denied reply
	// and appears in PendingRequests with hydrated name/avatar (and NO oc_ chat ID exposed in JSON).
	feishu.event(sock, appID, "guest-dm-1", "oc_guest_dm", "ou_requester", "p2p", "user", "请问可以帮我看看吗")
	denied := feishu.nextPost()
	if denied.parent != "guest-dm-1" || !strings.Contains(denied.text, "ou_requester") {
		t.Fatalf("expected permission-denied reply for guest, got %+v", denied)
	}
	view = feishu.waitChannel(f, func(c model.ChannelView) bool {
		return len(c.Bots) == 1 && len(c.Bots[0].PendingRequests) == 1 && c.Bots[0].PendingRequests[0].Name == "赵访客"
	})
	var rawChannel json.RawMessage
	f.request("GET", "/channels/feishu", nil, 200, &rawChannel)
	if bytes.Contains(rawChannel, []byte("oc_guest_dm")) || bytes.Contains(rawChannel, []byte("oc_first_dm")) {
		t.Fatal("channel view leaked Feishu chat routing ID")
	}

	// 4. Approve the pending requester with 1-click allow_dm -> switches dmAccess to whitelist,
	// adds ou_requester, clears pending request, sends confirmation DM, and subsequent DM succeeds!
	view = model.ChannelView{}
	f.request("POST", "/channels/feishu/bots/"+botID+"/access-requests", model.FeishuAccessRequestInput{
		OpenID: "ou_requester",
		Action: "allow_dm",
	}, 200, &view)
	if view.Bots[0].Settings.DMAccess != "whitelist" || !slices.Contains(view.Bots[0].Settings.DMWhitelist, "ou_requester") || len(view.Bots[0].PendingRequests) != 0 {
		t.Fatalf("unexpected bot state after approving access request: %+v", view.Bots[0])
	}
	grantNotice := feishu.nextPost()
	if grantNotice.parent != "oc_guest_dm" || !strings.Contains(grantNotice.text, "私聊权限") {
		t.Fatalf("expected confirmation DM to approved user, got %+v", grantNotice)
	}
	feishu.event(sock, appID, "guest-dm-2", "oc_guest_dm", "ou_requester", "p2p", "user", "approved hello")
	guestReply := feishu.nextPost()
	if guestReply.parent != "guest-dm-2" || !strings.Contains(guestReply.text, "approved hello") {
		t.Fatalf("expected reply for newly approved guest, got %+v", guestReply)
	}

	// 5. Contact search: directory + chat members, name filter, email/mobile/union_id resolution,
	// cross-app open_id warning, and missing-scope graceful fallback.
	var searchRes model.FeishuContactSearchResult
	f.request("GET", "/channels/feishu/bots/"+botID+"/contacts", nil, 200, &searchRes)
	foundIDs := map[string]bool{}
	for _, c := range searchRes.Contacts {
		foundIDs[c.OpenID] = true
	}
	for _, want := range []string{"ou_direct", "ou_alice", "ou_chat_member", "ou_first"} {
		if !foundIDs[want] {
			t.Fatalf("expected contact %s in empty-query list, got %+v", want, searchRes.Contacts)
		}
	}

	// Name search
	searchRes = model.FeishuContactSearchResult{}
	f.request("GET", "/channels/feishu/bots/"+botID+"/contacts?q="+url.QueryEscape("小周"), nil, 200, &searchRes)
	if len(searchRes.Contacts) != 1 || searchRes.Contacts[0].OpenID != "ou_chat_member" {
		t.Fatalf("expected chat member match for 小周, got %+v", searchRes.Contacts)
	}

	// Email exact lookup via batch_get_id
	searchRes = model.FeishuContactSearchResult{}
	f.request("GET", "/channels/feishu/bots/"+botID+"/contacts?q="+url.QueryEscape("bob@example.com"), nil, 200, &searchRes)
	if len(searchRes.Contacts) == 0 || searchRes.Contacts[0].OpenID != "ou_bob" || searchRes.Contacts[0].Name != "李鲍勃" {
		t.Fatalf("expected email lookup to resolve ou_bob, got %+v", searchRes)
	}

	// Mobile exact lookup via batch_get_id
	searchRes = model.FeishuContactSearchResult{}
	f.request("GET", "/channels/feishu/bots/"+botID+"/contacts?q=13800138000", nil, 200, &searchRes)
	if len(searchRes.Contacts) == 0 || searchRes.Contacts[0].OpenID != "ou_mobile" || searchRes.Contacts[0].Name != "陈手机" {
		t.Fatalf("expected mobile lookup to resolve ou_mobile, got %+v", searchRes)
	}

	// Union ID resolution
	searchRes = model.FeishuContactSearchResult{}
	f.request("GET", "/channels/feishu/bots/"+botID+"/contacts?q=on_bob", nil, 200, &searchRes)
	if len(searchRes.Contacts) == 0 || searchRes.Contacts[0].OpenID != "ou_bob" {
		t.Fatalf("expected union_id lookup to resolve ou_bob, got %+v", searchRes)
	}

	// Cross-app Open ID warning
	searchRes = model.FeishuContactSearchResult{}
	f.request("GET", "/channels/feishu/bots/"+botID+"/contacts?q=ou_foreign", nil, 200, &searchRes)
	if searchRes.Warning != "cross_app_open_id" {
		t.Fatalf("expected cross_app_open_id warning, got %+v", searchRes)
	}

	// Missing contact scopes gracefully reports missingScopes while still returning chat members.
	feishu.denyContactScope.Store(true)
	searchRes = model.FeishuContactSearchResult{}
	f.request("GET", "/channels/feishu/bots/"+botID+"/contacts?refresh=1&q="+url.QueryEscape("小周"), nil, 200, &searchRes)
	if len(searchRes.MissingScopes) == 0 || len(searchRes.Contacts) != 1 || searchRes.Contacts[0].OpenID != "ou_chat_member" {
		t.Fatalf("expected missingScopes + chat member fallback, got %+v", searchRes)
	}
}
