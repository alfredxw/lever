package app

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"lever/internal/device"
	"lever/internal/model"
	"lever/internal/plugin"
	"lever/internal/store"
)

type personalWorker struct {
	ctx           context.Context
	cancel        context.CancelFunc
	install, name string
	session       string
	state, qr     string
	started       int64
	requests      chan personalCall
	process       *device.Process
}

type personalCall struct {
	request personalRequest
	reply   chan personalResponse
}

type personalRequest struct {
	ID       string `json:"id"`
	Method   string `json:"method"`
	Message  string `json:"message,omitempty"`
	Chat     string `json:"chat,omitempty"`
	Thread   string `json:"thread,omitempty"`
	Reaction string `json:"reaction,omitempty"`
	Text     string `json:"text,omitempty"`
	Limit    int    `json:"limit,omitempty"`
}

type personalResponse struct {
	ID, Status, Text, RemoteID string
}

type personalEvent struct {
	personalResponse
	Event, Account, Region, QR, Phase string
	Message                           personalMessage
}

func (a *App) startPersonalLocked(p model.Plugin, config personalConfig, login bool) {
	ctx, cancel := context.WithCancel(a.ctx)
	worker := &personalWorker{ctx: ctx, cancel: cancel, install: p.ID, name: p.Manifest.Name,
		session: config.Session, state: "connecting", started: time.Now().Unix(), requests: make(chan personalCall)}
	a.personal[p.ID] = worker
	action := "listen"
	if login {
		action = "login"
	}
	path, err := plugin.PackageExecutable(p.Directory, p.Manifest.Contributes.Channels[0].Command)
	if err == nil {
		home := a.personalHome(p.ID, config.Session)
		if err = os.MkdirAll(home, 0700); err == nil {
			cmd := device.Command(path, action, config.Region)
			cmd.Dir, cmd.Stderr = p.Directory, io.Discard
			cmd.Env = append(cmd.Env, "LEVER_CHANNEL_HOME="+home, "LEVER_CHANNEL_CACHE="+filepath.Join(filepath.Dir(home), "runtime"))
			worker.process, err = device.StartFrames(cmd, 512<<10)
		}
	}
	if err != nil {
		worker.state = "error"
		cancel()
		slog.Warn("personal channel adapter could not start", "plugin", p.ID, "error", err)
		return
	}
	a.wg.Go(func() {
		err := a.personalProcess(worker, login)
		a.mu.Lock()
		defer a.mu.Unlock()
		if a.personal[p.ID] != worker {
			return
		}
		worker.qr = ""
		if worker.state != "expired" && worker.state != "dependency" && worker.state != "unsupported" && worker.state != "signedOut" {
			worker.state = "error"
			if err != nil {
				slog.Warn("personal channel adapter stopped", "plugin", p.ID, "error", err)
			}
		}
	})
}

func (worker *personalWorker) call(request personalRequest) personalResponse {
	ctx, cancel := context.WithTimeout(worker.ctx, 45*time.Second)
	defer cancel()
	request.ID = ID()
	call := personalCall{request, make(chan personalResponse, 1)}
	select {
	case <-ctx.Done():
		return personalResponse{Status: "failed"}
	case worker.requests <- call:
	}
	select {
	case <-ctx.Done():
		return personalResponse{Status: "unknown"}
	case reply := <-call.reply:
		return reply
	}
}

func (a *App) personalProcess(worker *personalWorker, login bool) error {
	ctx := worker.ctx
	stop := context.AfterFunc(ctx, worker.process.Terminate)
	messages := make(chan personalMessage, 32)
	var group sync.WaitGroup
	defer func() {
		stop()
		worker.cancel()
		worker.process.Terminate()
		group.Wait()
	}()
	group.Add(2)
	go func() {
		defer group.Done()
		for {
			select {
			case <-ctx.Done():
				return
			case message := <-messages:
				a.receivePersonal(worker, message)
			}
		}
	}()
	go func() {
		defer group.Done()
		a.personalDeliveries(worker)
	}()
	pending := map[string]chan personalResponse{}
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case call := <-worker.requests:
			if len(pending) >= 64 {
				return errors.New("channel stopped answering")
			}
			if err := worker.process.Send(call.request); err != nil {
				return err
			}
			pending[call.request.ID] = call.reply
		case frame, ok := <-worker.process.Frames:
			if !ok {
				return io.EOF
			}
			var event personalEvent
			if err := json.Unmarshal(frame, &event); err != nil {
				return errors.New("invalid channel frame")
			}
			if reply := pending[event.ID]; reply != nil && event.Event == "" {
				reply <- event.personalResponse
				delete(pending, event.ID)
			} else if event.Event == "message" {
				select {
				case messages <- event.Message:
				default:
					return errors.New("channel inbox is full")
				}
			} else if !a.personalState(worker, event, login) {
				return errors.New("channel identity or state rejected")
			}
		}
	}
}

func (a *App) personalState(worker *personalWorker, event personalEvent, login bool) bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.personal[worker.install] != worker {
		return false
	}
	switch event.Event {
	case "qr":
		if !login || worker.state == "online" || len(event.QR) > 4096 {
			return false
		}
		worker.state, worker.qr = "pairing", event.QR
	case "online":
		_, config, err := a.personalConfig(worker.ctx, worker.install)
		if err != nil || !personalID.MatchString(event.Account) || event.Region != config.Region || config.Session != worker.session ||
			(config.Account == "" && !login) || (config.Account != "" && config.Account != event.Account) {
			return false
		}
		if config.Account == "" {
			config.Account, config.Listening = event.Account, true
			if a.savePersonal(worker.ctx, worker.install, config, "") != nil {
				return false
			}
		}
		worker.state, worker.qr = "online", ""
	case "connecting", "expired", "dependency", "signedOut", "error":
		worker.state, worker.qr = event.Event, ""
		if event.Event == "connecting" && event.Phase == "preparing" {
			worker.state = "preparing"
		}
		if event.Event == "dependency" && event.Phase == "unsupported" {
			worker.state = "unsupported"
		}
	default:
		return false
	}
	return true
}

func (a *App) receivePersonal(worker *personalWorker, message personalMessage) {
	if message.Created < worker.started || message.Created > time.Now().Add(time.Minute).Unix() {
		return
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.personal[worker.install] != worker || worker.state != "online" {
		return
	}
	_, config, err := a.personalConfig(worker.ctx, worker.install)
	route, command, body, matched := config.match(message)
	if err != nil || !matched {
		return
	}
	binding := personalBinding(worker.install, config)
	commandID := "personal:" + hash([3]string{binding, message.Chat, message.ID})
	var seen bool
	err = a.Store.DB.QueryRowContext(worker.ctx, "SELECT EXISTS(SELECT 1 FROM runs WHERE command_id=?)", commandID).Scan(&seen)
	if err != nil || seen {
		return
	}
	agent, err := store.Get[model.Agent](worker.ctx, a.Store.DB, "SELECT data FROM agents WHERE id=?", route.AgentID)
	if err != nil || agent.Archived {
		return
	}
	selection, err := a.personalSelection(worker.ctx, route, agent.Profile)
	if err != nil {
		slog.Warn("personal channel model unavailable", "plugin", worker.install, "agent", agent.ID, "error", err)
		return
	}
	thread, conversation := message.Thread, message.Thread
	switch {
	case thread != "":
	case message.Kind == "dm":
		conversation = "dm"
	default:
		conversation = message.ID
		if config.ThreadReply {
			thread = message.ID
		}
	}
	rawBody := body
	if body == "" {
		body = "请根据引用或当前上下文回答；意图不明确时请询问。"
	}
	turn := personalTurn{
		install:      worker.install,
		binding:      binding,
		channelName:  worker.name,
		remoteChat:   message.Chat,
		chatName:     sanitizePersonalChatName(message.ChatName),
		kind:         message.Kind,
		conversation: conversation,
		thread:       thread,
		parent:       message.Parent,
		command:      command,
		signature:    strings.ReplaceAll(config.Signature, "{agent}", agent.Name),
		prompt:       config.Prompt,
		reaction:     config.Reaction,
		rawBody:      rawBody,
		chatMode:     config.ChatMode,
		needsContext: config.ContextLimit > 0 || message.Parent != "" || message.Thread != "",
	}
	origin := channelInput{binding, message.ID, message.Text}
	run, err := a.sendLocked(worker.ctx, model.SendInput{CommandID: commandID, AgentID: agent.ID, Operation: "main", Text: body, Delivery: "queue", Selection: &selection},
		sendOrigin{channel: &origin, personal: &turn})
	if err != nil {
		slog.Warn("personal channel turn not accepted", "plugin", worker.install, "error", err)
		return
	}
	if config.Reaction != "" {
		a.wg.Go(func() {
			response := worker.call(personalRequest{Method: "react", Chat: message.Chat, Message: message.ID, Reaction: config.Reaction})
			status := response.Status
			if status != "ok" && status != "failed" {
				status = "unknown"
			}
			err := a.Store.Write(a.ctx, func(tx *sql.Tx) error {
				_, err := tx.Exec("UPDATE personal_channel_turns SET reaction_status=? WHERE run_id=? AND reaction_status='pending'", status, run.ID)
				return err
			})
			if err != nil && a.ctx.Err() == nil {
				slog.Warn("could not record personal channel reaction", "run", run.ID, "error", err)
			}
		})
	}
	if turn.needsContext {
		a.wg.Go(func() {
			response := worker.call(personalRequest{Method: "context", Message: message.ID, Chat: message.Chat, Limit: config.ContextLimit})
			extra := ""
			if response.Status == "ok" && len(response.Text) <= 128<<10 {
				extra = strings.TrimSpace(response.Text)
			}
			a.finishPersonalContext(run, extra)
		})
	}
}

func (a *App) finishPersonalContext(run model.Run, extra string) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.closed {
		return
	}
	err := a.Store.Write(a.ctx, func(tx *sql.Tx) error {
		if extra != "" {
			if _, err := tx.Exec("UPDATE runs SET data=json_set(data,'$.channelContext',?) WHERE id=? AND status='queued'", extra, run.ID); err != nil {
				return err
			}
		}
		_, err := tx.Exec("UPDATE personal_channel_turns SET context_ready=1 WHERE run_id=?", run.ID)
		return err
	})
	if err == nil {
		err = a.advanceQueueLocked(run.SessionID)
	}
	if err != nil {
		slog.Warn("could not prepare personal channel turn", "run", run.ID, "error", err)
	}
}

func (a *App) personalDeliveries(worker *personalWorker) {
	changed, unsubscribe := a.Store.Subscribe()
	defer unsubscribe()
	tick := time.NewTicker(time.Second)
	defer tick.Stop()
	for worker.ctx.Err() == nil {
		a.mu.Lock()
		var delivery channelDelivery
		var err error
		if a.personal[worker.install] == worker && worker.state == "online" {
			_, config, lookup := a.personalConfig(worker.ctx, worker.install)
			if lookup == nil {
				delivery, err = a.claimChannelDeliveryLocked(worker.ctx, personalBinding(worker.install, config))
			}
		}
		a.mu.Unlock()
		if err != nil && worker.ctx.Err() == nil {
			slog.Error("claim personal channel delivery", "error", err)
		}
		if delivery.run.ID != "" {
			a.deliverPersonal(worker, delivery)
			continue
		}
		select {
		case <-worker.ctx.Done():
			return
		case <-changed:
		case <-tick.C:
		}
	}
}

func (a *App) deliverPersonal(worker *personalWorker, delivery channelDelivery) {
	request := personalRequest{Method: "reply", Message: delivery.messageID, Text: channelReply(delivery)}
	var signature string
	err := a.Store.DB.QueryRowContext(worker.ctx, "SELECT chat,thread,signature FROM personal_channel_turns WHERE run_id=?", delivery.run.ID).Scan(&request.Chat, &request.Thread, &signature)
	status, answer := "failed", ""
	if err == nil {
		if signature != "" {
			request.Text += "\n\n—— " + signature
		}
		result := worker.call(request)
		switch {
		case result.Status == "ok" && personalID.MatchString(result.RemoteID):
			status, answer = "sent", result.RemoteID
		case result.Status != "failed":
			status = "unknown"
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	err = a.Store.Write(ctx, func(tx *sql.Tx) error {
		if answer != "" {
			if _, err := tx.ExecContext(ctx, "UPDATE personal_channel_turns SET answer_id=? WHERE run_id=?", answer, delivery.run.ID); err != nil {
				return err
			}
		}
		return setChannelDelivery(ctx, tx, delivery.run, delivery.part, status)
	})
	if err != nil {
		slog.Error("save personal channel receipt", "run", delivery.run.ID, "error", err)
	}
}
