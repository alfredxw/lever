package httpapi_test

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
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
	parent, uuid, text, host string
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

type feishuFixture struct {
	t       *testing.T
	sockets chan *websocket.Conn
	posts   chan feishuPost
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
	f := &feishuFixture{t: t, sockets: make(chan *websocket.Conn, 4), posts: make(chan feishuPost, 16)}
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
		default:
			if !strings.HasPrefix(r.URL.Path, "/open-apis/im/v1/messages") {
				http.NotFound(w, r)
				return
			}
			var body map[string]string
			if json.NewDecoder(r.Body).Decode(&body) != nil || r.Header.Get("Authorization") != "Bearer tenant-fixture" {
				http.Error(w, "invalid Feishu request", http.StatusBadRequest)
				return
			}
			var content map[string]string
			_ = json.Unmarshal([]byte(body["content"]), &content)
			parent := body["receive_id"]
			if parent == "" {
				parent = strings.TrimSuffix(strings.TrimPrefix(r.URL.Path, "/open-apis/im/v1/messages/"), "/reply")
			}
			f.posts <- feishuPost{parent: parent, uuid: body["uuid"], text: content["text"], host: r.Header.Get("X-Fixture-Host")}
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
