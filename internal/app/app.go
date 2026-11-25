// Package app owns agent configuration, conversation identity and execution
// lifecycle. External runtimes retain their own reasoning and tool loops.
package app

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"log/slog"
	"math"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"

	"lever/internal/model"
	"lever/internal/plugin"
	"lever/internal/plugin/builtin"
	larkbot "lever/internal/plugin/builtin/lark-bot"
	"lever/internal/provider"
	"lever/internal/runhost"
	"lever/internal/store"
	"lever/internal/terminal"
	"lever/internal/workspace"
)

type Error struct {
	Status  int
	Message string
}

func (e *Error) Error() string { return e.Message }
func invalid(s string) error   { return &Error{400, s} }
func notFound(s string) error  { return &Error{404, s} }
func conflict(s string) error  { return &Error{409, s} }
func ID() string               { return uuid.NewString() }
func now() string              { return time.Now().UTC().Format(time.RFC3339Nano) }
func hash(v any) string        { s := sha256.Sum256([]byte(store.JSON(v))); return hex.EncodeToString(s[:]) }

type App struct {
	Store                *store.Store
	Terminals            terminal.Manager
	URL                  string
	ctx                  context.Context
	cancel               context.CancelFunc
	mu                   sync.Mutex
	active               map[string]*execution
	restarts             []store.RestartRun
	independentProviders bool
	hostLease            *runhost.BackendLease
	closed               bool
	wg                   sync.WaitGroup
	worktreeMu           sync.Mutex
	removingCheckout     string
	scopeUsers           map[string]int
	initializing         map[string]bool // Physical checkouts leased for setup.
	catalogs             map[catalogKey]*catalogEntry
	setups               map[string]*providerSetup
	agyLogin             terminal.Key
	sharedSending        sync.Map
	notesMu              sync.Mutex
	notesDir             string
	noteFiles            map[string]parsedNote
	taskAdapters         map[[2]string]plugin.TaskSourceAdapter
	eventAdapters        map[[2]string]plugin.EventSourceAdapter
	taskSyncWake         chan struct{}
	taskQueueWake        chan struct{}
	taskReminderWake     chan struct{}
	taskSync             *taskSourceSync
	eventPoll            *activeEventPoll
	automationStarted    bool
	feishu               feishuChannel
	personal             map[string]*personalWorker
	pluginPreviews       map[string]*packagePreview
}

// Open embeds provider execution in the caller. The standalone hosts use
// OpenServer so their provider processes can outlive the server executable.
func Open(dir string) (*App, error)       { return open(dir, false) }
func OpenServer(dir string) (*App, error) { return open(dir, true) }
func open(dir string, independent bool) (*App, error) {
	s, err := store.Open(dir)
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithCancel(context.Background())
	ctx = provider.WithStateDir(ctx, dir)
	a := &App{
		Store: s, ctx: ctx, cancel: cancel, independentProviders: independent, active: map[string]*execution{},
		taskAdapters: builtin.TaskSourceAdapters(), taskSyncWake: make(chan struct{}, 1), taskQueueWake: make(chan struct{}, 1), taskReminderWake: make(chan struct{}, 1),
		eventAdapters: builtin.EventSourceAdapters(), personal: make(map[string]*personalWorker), pluginPreviews: make(map[string]*packagePreview),
	}
	if err = a.migrateWorkingCopies(ctx); err != nil {
		cancel()
		s.Close()
		return nil, err
	}
	if err = a.initNotes(ctx); err != nil {
		cancel()
		s.Close()
		return nil, err
	}
	if err = a.initPlugins(ctx); err != nil {
		cancel()
		s.Close()
		return nil, err
	}
	if err = a.recoverPluginPackages(ctx); err != nil {
		cancel()
		s.Close()
		return nil, err
	}
	if a.restarts, err = s.Recover(ctx); err != nil {
		cancel()
		s.Close()
		return nil, err
	}
	if a.feishu.bots, err = a.loadFeishuBots(ctx); err != nil {
		cancel()
		s.Close()
		return nil, err
	}
	if independent {
		lease, err := runhost.AcquireBackendLock(dir)
		if err != nil {
			cancel()
			s.Close()
			return nil, err
		}
		a.hostLease = lease
	}
	if err = a.restoreRunHosts(); err != nil {
		a.Close()
		return nil, err
	}
	a.advanceReadyDependentRuns()
	a.wg.Add(4)
	go a.runTaskSourceSync()
	go a.runTaskQueue()
	go a.runTaskReminders()
	go a.runSubscriptionUpdates()
	return a, nil
}

// Context is cancelled before the Host releases its database.
func (a *App) Context() context.Context { return a.ctx }

func (a *App) Close() error {
	a.Shutdown()
	return a.Store.Close()
}

// Shutdown stops managed work while leaving the database available to drain requests.
func (a *App) Shutdown() {
	a.mu.Lock()
	a.closed = true
	a.cancel()
	for id := range a.pluginPreviews {
		a.discardPluginPreviewLocked(id)
	}
	lease := a.hostLease
	a.hostLease = nil
	a.mu.Unlock()
	a.Terminals.Close()
	a.wg.Wait()
	if a.independentProviders {
		lease.Release()
		runhost.StopIdleSessions(a.Store.Dir)
		runhost.WaitIdleSessions(a.Store.Dir, a.Store.DB, 2*time.Second)
	} else {
		provider.CloseClaudeSessions(a.Store.Dir)
	}
}

func (a *App) stopIdleClaudeSessions() {
	if a.independentProviders {
		runhost.StopIdleSessions(a.Store.Dir)
	} else {
		provider.CloseClaudeSessions(a.Store.Dir)
	}
}

func (a *App) closeIdleClaudeSessions() {
	a.stopIdleClaudeSessions()
	if a.independentProviders {
		runhost.WaitIdleSessions(a.Store.Dir, a.Store.DB, 2*time.Second)
	}
}

func (a *App) RunningCount() int {
	a.mu.Lock()
	defer a.mu.Unlock()
	return len(a.active)
}

// BeginIdleShutdown checks for active executions and closes admission together.
func (a *App) BeginIdleShutdown() bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	if len(a.active) != 0 {
		return false
	}
	a.closed = true
	return true
}

// BeginDesktopRestart closes admission only after every active provider has
// durable ownership. Ordinary window closes still keep the backend available.
func (a *App) BeginDesktopRestart() bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	for _, e := range a.active {
		e.mu.Lock()
		hosted := e.hosted
		e.mu.Unlock()
		if !hosted {
			return false
		}
	}
	a.closed = true
	return true
}

func (a *App) Overview(ctx context.Context) (model.Overview, error) {
	o := model.Overview{DataDir: a.Store.Dir, DeviceID: a.Store.DeviceID, Platform: runtime.GOOS}
	o.HomeDir, _ = os.UserHomeDir()
	o.DeviceName, _ = os.Hostname()
	tx, err := a.Store.DB.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return o, err
	}
	defer tx.Rollback()
	o.Agents, err = store.List[model.Agent](ctx, tx, "SELECT data FROM agents ORDER BY json_extract(data,'$.createdAt')")
	if err != nil {
		return o, err
	}
	o.Projects, err = store.List[model.Project](ctx, tx, "SELECT data FROM projects ORDER BY json_extract(data,'$.createdAt')")
	if err != nil {
		return o, err
	}
	o.Chats, err = store.List[model.Chat](ctx, tx, "SELECT "+store.ChatDisplayData+" FROM chats ORDER BY json_extract(data,'$.updatedAt') DESC")
	if err != nil {
		return o, err
	}
	o.Conversations, err = store.List[model.Conversation](ctx, tx, store.ConversationQuery+" WHERE s.activity IS NOT NULL")
	if err != nil {
		return o, err
	}
	o.Runs, err = store.List[model.Run](ctx, tx, `SELECT `+store.RunWithOverviewFields+` FROM runs r
LEFT JOIN channel_deliveries d ON d.run_id=r.id AND d.part='answer'
WHERE r.status IN ('starting','running','waiting_user','cancelling','unknown','queued') OR r.status='paused' ORDER BY r.sequence`)
	if err != nil {
		return o, err
	}
	o.Requests, err = store.List[model.Request](ctx, tx, "SELECT data FROM requests WHERE status='pending'")
	if err != nil {
		return o, err
	}
	if err := tx.QueryRowContext(ctx, "SELECT COALESCE(MAX(sequence),0) FROM events").Scan(&o.Cursor); err != nil {
		return o, err
	}
	return o, tx.Commit()
}

func (a *App) SaveAgent(ctx context.Context, agent model.Agent) (model.Agent, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.saveAgentLocked(ctx, agent, nil)
}

func (a *App) saveAgentLocked(ctx context.Context, agent model.Agent, afterSave func(*sql.Tx, model.Agent) error) (model.Agent, error) {
	agent.Name = strings.TrimSpace(agent.Name)
	if agent.Name == "" || len(agent.Name) > 100 {
		return agent, invalid("Agent name is required (up to 100 characters)")
	}
	creating := agent.ID == ""
	if creating {
		agent.ID = ID()
		agent.CreatedAt = now()
		if agent.Avatar == nil {
			agent.Avatar = &model.Avatar{Kind: "emoji", Value: model.DefaultAvatarEmoji}
		}
		if agent.Avatar.Color == "" && avatarUsesColor(agent.Avatar.Kind) {
			agent.Avatar.Color = model.DefaultAvatarColor
		}
	}
	if avatar := agent.Avatar; avatar != nil {
		avatar.Value = strings.TrimSpace(avatar.Value)
		switch avatar.Kind {
		case "monogram":
			if len([]rune(avatar.Value)) > 2 {
				return agent, invalid("Monogram must contain at most two characters")
			}
		case "lucide", "emoji":
			if avatar.Value == "" || len(avatar.Value) > 128 {
				return agent, invalid("Select a valid avatar")
			}
		case "preset":
			if avatar.Value != model.StarterAvatarPreset {
				return agent, invalid("Select a valid avatar")
			}
			avatar.Color = ""
		case "image":
			if !isAvatarImageID(avatar.Value) {
				return agent, invalid("Select a valid avatar")
			}
			avatar.Color = ""
		default:
			return agent, invalid("Select a valid avatar")
		}
		if !slices.Contains([]string{
			"", "gradient-prism", "gradient-coral", "gradient-citrus", "gradient-coast",
			"gradient-sunset", "gradient-jade", "gradient-glacier", "gradient-orchid",
			"gradient-pearl", "gradient-rose", "gradient-ember", "gradient-dune",
			"gradient-meadow", "gradient-lagoon", "gradient-twilight", "gradient-iris",
			"white", "gray", "black", "red", "orange", "amber", "yellow", "lime",
			"green", "teal", "cyan", "blue", "indigo", "violet", "magenta", "pink",
		}, avatar.Color) {
			return agent, invalid("Select a valid avatar color")
		}
	}
	p := &agent.Profile
	p.Description = strings.TrimSpace(p.Description)
	if len([]rune(p.Description)) > 240 {
		return agent, invalid("Agent description must be at most 240 characters")
	}
	if p.TaskConcurrency < 0 || p.TaskStartIntervalMinutes < 0 ||
		int64(p.TaskStartIntervalMinutes) > math.MaxInt64/int64(time.Minute) {
		return agent, invalid("Choose a positive task concurrency and a valid start interval")
	}
	config, err := store.Get[model.Provider](ctx, a.Store.DB, "SELECT data FROM providers WHERE id=?", p.Provider)
	if err != nil {
		return agent, err
	}
	selection, err := provider.ResolveSelection(model.Selection{Provider: p.Provider, Permission: p.Permission}, model.Selection{}, config)
	if err != nil {
		return agent, invalid(err.Error())
	}
	_, available, err := runtimeProvider(ctx, a.Store.DB, config)
	if err != nil {
		return agent, err
	}
	if creating && !available {
		return agent, invalid("Runtime is disabled")
	}
	p.Permission = selection.Permission
	p.DisabledSkills, err = normalizeDisabledSkills(p.DisabledSkills)
	if err != nil {
		return agent, err
	}
	if len(p.Skills) > 0 && !provider.ConfiguredCapabilities(config).Skills {
		return agent, invalid("This runtime does not support Agent skill directories")
	}
	if p.ProjectID != "" {
		project, err := store.Get[model.Project](ctx, a.Store.DB, "SELECT data FROM projects WHERE id=?", p.ProjectID)
		if err != nil {
			if errors.Is(err, sql.ErrNoRows) {
				return agent, invalid("Selected project does not exist")
			}
			return agent, err
		}
		p.Scope = cloneScope(project.Scope)
		p.WorktreeSetup = cloneSetup(project.WorktreeSetup)
	} else {
		if err := a.normalizeScopeAndSetup(&p.Scope, p.WorktreeSetup); err != nil {
			return agent, err
		}
	}
	skills := map[string]bool{}
	for i, path := range p.Skills {
		canonical, err := workspace.Canonical(path)
		if err != nil {
			return agent, invalid(err.Error())
		}
		if _, err = os.Stat(filepath.Join(canonical, "SKILL.md")); err != nil {
			return agent, invalid("Each skill directory must contain SKILL.md")
		}
		name := filepath.Base(canonical)
		if skills[name] {
			return agent, invalid("Skill directory names must be unique")
		}
		skills[name] = true
		p.Skills[i] = canonical
	}
	err = a.Store.Write(ctx, func(tx *sql.Tx) error {
		checkAvatarImage := agent.Avatar != nil && agent.Avatar.Kind == "image"
		if !creating {
			old, err := store.Get[model.Agent](ctx, tx, "SELECT data FROM agents WHERE id=?", agent.ID)
			if err != nil {
				return err
			}
			if agent.UpdatedAt != old.UpdatedAt {
				return conflict("Profile changed elsewhere. Reload before saving.")
			}
			if !available && old.Profile.Provider != p.Provider {
				return invalid("Runtime is disabled")
			}
			if checkAvatarImage && old.Avatar != nil && old.Avatar.Kind == "image" && old.Avatar.Value == agent.Avatar.Value {
				checkAvatarImage = false
			}
			agent.CreatedAt = old.CreatedAt
			if agent.Archived {
				var count int
				if err := tx.QueryRowContext(ctx, "SELECT COUNT(*) FROM runs WHERE agent_id=? AND status IN ('starting','running','waiting_user','cancelling','unknown')", agent.ID).Scan(&count); err != nil {
					return err
				}
				if count > 0 {
					return conflict("Stop or resolve active executions before archiving")
				}
			}
		}
		if checkAvatarImage && !a.hasAvatarImage(agent.Avatar.Value) {
			return invalid("Select a valid avatar")
		}
		seen := map[string]bool{}
		for _, rule := range p.Delegations {
			if rule.AgentID == agent.ID || seen[rule.AgentID] {
				return invalid("Delegation targets must be distinct other agents")
			}
			seen[rule.AgentID] = true
			target, err := store.Get[model.Agent](ctx, tx, "SELECT data FROM agents WHERE id=?", rule.AgentID)
			if err != nil {
				return invalid("Delegation target does not exist")
			}
			if target.Archived {
				return invalid("Delegation target is archived")
			}
		}
		agent.UpdatedAt = now()
		if len(p.Skills) > 0 {
			if _, err := tx.ExecContext(ctx, "DELETE FROM removed_skill_directories WHERE path IN (SELECT value FROM json_each(?))", store.JSON(p.Skills)); err != nil {
				return err
			}
		}
		_, err := tx.Exec("INSERT INTO agents(id,data) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data", agent.ID, store.JSON(agent))
		if err != nil {
			return err
		}
		if err := store.Event(tx, model.Event{Type: "agents"}); err != nil {
			return err
		}
		if afterSave != nil {
			return afterSave(tx, agent)
		}
		return nil
	})
	if err == nil {
		a.wakeTaskQueue()
	}
	return agent, err
}

func (a *App) CreateChat(ctx context.Context, agentID, title string) (model.Chat, error) {
	title = strings.TrimSpace(title)
	chat := model.Chat{ID: ID(), AgentID: agentID, Title: title, Source: "user", CreatedAt: now(), UpdatedAt: now()}
	if chat.Title == "" {
		chat.Title = "New chat"
	}
	err := a.Store.Write(ctx, func(tx *sql.Tx) error {
		agent, err := store.Get[model.Agent](ctx, tx, "SELECT data FROM agents WHERE id=?", agentID)
		if err != nil {
			return err
		}
		if agent.Archived {
			return conflict("Agent is archived")
		}
		// An empty owner reserves an explicit name, including the literal "New chat".
		if _, err = tx.Exec("INSERT INTO chats(id,agent_id,data,title_run_id) VALUES(?,?,?,CASE WHEN ?<>'' THEN '' END)", chat.ID, agentID, store.JSON(chat), title); err != nil {
			return err
		}
		return store.Event(tx, model.Event{Type: "chats", ChatID: chat.ID})
	})
	chat.TitleIsCustom = title != ""
	return chat, err
}

func (a *App) RenameConversation(ctx context.Context, chatID, topicID, title string) error {
	title = strings.TrimSpace(title)
	if title == "" || utf8.RuneCountInString(title) > 120 || strings.ContainsAny(title, "\r\n\x00") {
		return invalid("Choose a single-line title of up to 120 characters")
	}
	return a.Store.Write(ctx, func(tx *sql.Tx) error {
		// Release the generator's ownership in the same write as the new title.
		// An edit or a delayed naming response can then only change its own placeholders.
		var result sql.Result
		var err error
		if topicID == "" {
			result, err = tx.Exec("UPDATE chats SET data=json_set(data,'$.title',?),title_run_id='' WHERE id=?", title, chatID)
		} else {
			result, err = tx.Exec(`UPDATE sessions SET data=json_set(data,'$.title',?),activity=json_set(activity,'$.title',?),title_run_id=''
WHERE id=? AND chat_id=? AND kind='topic'`, title, title, topicID, chatID)
		}
		if err != nil {
			return err
		}
		if n, err := result.RowsAffected(); err != nil {
			return err
		} else if n == 0 {
			return sql.ErrNoRows
		}
		return store.Event(tx, model.Event{Type: "conversation-title", ChatID: chatID, SessionID: topicID})
	})
}

func (a *App) Send(ctx context.Context, input model.SendInput) (model.Run, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.sendLocked(ctx, input, sendOrigin{})
}

type sendOrigin struct {
	remote          *remoteOrigin
	idleCompaction  bool
	parentRunID     string
	delegationScope *delegationWorkspace
	delegationWake  *delegationReceiptWake
	task            *model.TaskDispatch
	taskRecord      model.TaskRecord
	taskQueue       *queuedTask
	retry           *model.Run
	channel         *channelInput
	feishu          *feishuTurn
	personal        *personalTurn
	automation      *automationFire
}

var errCommandConflict = conflict("commandId already belongs to a different message")

type taskCommand struct {
	TaskID string
	model.ExternalTaskDispatch
}

// sendLocked makes command acceptance, Chat/session creation and ordering atomic.
// Runtime I/O starts only after the durable acceptance transaction commits.
func (a *App) sendLocked(ctx context.Context, input model.SendInput, origin sendOrigin) (model.Run, error) {
	var run model.Run
	var session model.Session
	var launchProfile model.Profile
	var launchProvider model.Provider
	fresh := false
	if a.closed {
		return run, conflict("Backend is shutting down")
	}
	if input.Delivery != "" && input.Delivery != "queue" && input.Delivery != "steer" {
		return run, invalid("delivery must be queue or steer")
	}
	afterRunIDs, err := normalizeAfterRunIDs(input.AfterRunIDs)
	if err != nil {
		return run, err
	}
	input.AfterRunIDs = afterRunIDs
	if len(afterRunIDs) > 0 && (input.Delivery == "steer" || input.SteerRunID != "") {
		return run, invalid("A message waiting on other tasks cannot steer the current turn")
	}
	if err := validateMessage(input.CommandID, input.Text, input.AttachmentIDs, input.References, input.Quote); err != nil {
		return run, err
	}
	if input.AgentID != "" && (input.ChatID != "" || input.SessionID != "" || input.EditRunID != "" || (input.Operation != "main" && input.Operation != "topic")) {
		return run, invalid("A new Chat must start with a main message or topic")
	}
	if input.ReplaceRunID != "" && (input.AgentID != "" || input.EditRunID != "" || input.WorkingCopyID != "" || input.Delivery != "" || len(afterRunIDs) > 0) {
		return run, invalid("An edited sent message must run in its original conversation")
	}
	if err := validateSelection(input.Selection); err != nil {
		return run, err
	}
	digest := hash(input)
	if origin.remote != nil {
		digest = origin.remote.digest
	} else if origin.channel != nil {
		// Redelivery keeps its identity even when the channel's Agent changes.
		digest = hash(*origin.channel)
	} else if origin.retry != nil {
		digest = hash("retry:" + origin.retry.ID)
	} else if origin.task != nil && origin.taskRecord != model.TaskRecordNote {
		// A retry has the same intent even if the source was synced again.
		digest = hash(taskCommand{origin.task.TaskID, model.ExternalTaskDispatch{
			CommandID: input.CommandID, AgentID: input.AgentID, WorkingCopyID: input.WorkingCopyID,
			Selection: origin.task.Selection, Note: origin.task.Note,
		}})
	} else if origin.task != nil {
		digest = hash(origin.task)
	}
	var taskFiles []model.Attachment
	noteErr := a.validateNoteReferences(ctx, input.References)
	err = a.Store.Write(ctx, func(tx *sql.Tx) error {
		existing, lookupErr := store.Get[model.Run](ctx, tx, `SELECT `+store.RunWithOverviewFields+` FROM runs r
LEFT JOIN channel_deliveries d ON d.run_id=r.id AND d.part='answer' WHERE r.command_id=?`, input.CommandID)
		if lookupErr == nil {
			var h string
			if err := tx.QueryRowContext(ctx, "SELECT input_hash FROM runs WHERE command_id=?", input.CommandID).Scan(&h); err != nil {
				return err
			}
			if h != digest {
				return errCommandConflict
			}
			run = existing
			return nil
		}
		if !errors.Is(lookupErr, sql.ErrNoRows) {
			return lookupErr
		}
		if noteErr != nil {
			return noteErr
		}
		if origin.retry != nil && origin.retry.Superseded {
			return conflict("This message has already been replaced")
		}
		var chat model.Chat
		var delivery taskDelivery
		var err error
		task := origin.task
		if task != nil {
			delivery, err = a.acceptTask(ctx, tx, origin.taskRecord, *task, origin.taskQueue)
			if err != nil {
				return err
			}
		}
		var destination taskDestination
		var personalDest personalDestination
		newChat := input.AgentID != ""
		if origin.personal != nil {
			personalDest, err = origin.personal.resolve(ctx, tx, input.AgentID)
			chat = personalDest.chat
			input.Operation = personalDest.operation
			input.SessionID = personalDest.sessionID
			newChat = chat.ID == ""
		} else if task != nil {
			settings, settingsErr := taskDispatchSettings(ctx, tx)
			if settingsErr != nil {
				return settingsErr
			}
			destination, err = resolveTaskDestination(ctx, tx, settings.ChatMode, origin.taskRecord, *task, delivery, origin.taskQueue)
			chat = destination.chat
			input.Operation = destination.operation
			newChat = chat.ID == ""
		} else if !newChat {
			chat, err = store.Get[model.Chat](ctx, tx, "SELECT data FROM chats WHERE id=?", input.ChatID)
			if errors.Is(err, sql.ErrNoRows) && origin.feishu != nil {
				err = nil
				newChat = true
				input.AgentID = origin.feishu.agentID
				input.ChatID = ""
				if input.Operation == "reply" {
					input.Operation = "topic"
					input.SessionID = ""
				}
			}
		}
		if err != nil {
			return err
		}
		if newChat {
			chat = model.Chat{ID: ID(), AgentID: input.AgentID, Title: "New chat", Source: "user", CreatedAt: now(), UpdatedAt: now()}
			if turn := origin.personal; turn != nil {
				chat.Source, chat.Channel, chat.Title = "channel", turn.install, personalDest.title
			} else if turn := origin.feishu; turn != nil {
				title := turn.chatTitle
				if title == "" {
					title = "Feishu"
				}
				chat.Source, chat.Channel, chat.Title = "channel", larkbot.ChannelID, title
			}
			if task != nil {
				chat.Title, chat.Source = destination.title, destination.source
				chat.NoteID, chat.TaskSourceID, chat.TaskID = destination.noteID, destination.taskSourceID, destination.taskID
			}
			if fire := origin.automation; fire != nil {
				chat.Title, chat.Source = fire.plan.Name, "automation"
				if fire.plan.Destination.Mode == "newChat" && fire.plan.CreatesWorkItem() {
					chat.Source, chat.TaskID = "task", fire.id
				}
			}
		}
		if input.SharedScope != nil {
			if !newChat {
				return invalid("Sharing can only be selected when creating a Chat")
			}
			if err := checkExposed(tx, *input.SharedScope, chat.AgentID); err != nil {
				return err
			}
			chat.SharedScope = input.SharedScope
		}
		if origin.remote != nil {
			if err := origin.remote.authorize(tx, chat); err != nil {
				return err
			}
			if newChat && origin.remote.intent.TaskID != "" {
				chat.SharedTaskRef = &model.SharedTaskRef{SharedScope: origin.remote.scope, TaskID: origin.remote.intent.TaskID, DispatchID: origin.remote.intent.ID}
			}
		}
		if origin.channel == nil {
			if err := checkDesktopChat(chat); err != nil {
				return err
			}
		}
		agent, err := store.Get[model.Agent](ctx, tx, "SELECT data FROM agents WHERE id=?", chat.AgentID)
		if err != nil {
			return err
		}
		if agent.Archived {
			return conflict("Agent is archived")
		}
		if newChat {
			if _, err = tx.Exec("INSERT INTO chats(id,agent_id,data) VALUES(?,?,?)", chat.ID, agent.ID, store.JSON(chat)); err != nil {
				return err
			}
			if origin.personal != nil && personalDest.registerScope != "" {
				if _, err = tx.ExecContext(ctx, "INSERT INTO personal_channel_chats(binding,agent_id,scope,chat_id) VALUES(?,?,?,?)",
					origin.personal.binding, agent.ID, personalDest.registerScope, chat.ID); err != nil {
					return err
				}
			}
		}
		var editing model.Run
		if input.EditRunID != "" {
			editing, err = store.Get[model.Run](ctx, tx, "SELECT data FROM runs WHERE id=?", input.EditRunID)
			if err != nil {
				return err
			}
			if editing.ComparisonID != "" {
				return conflict("A comparison's original message cannot be edited in an individual Topic")
			}
			if editing.ChatID != chat.ID || editing.Status != "queued" {
				return conflict("The message has left the queue. Your draft has been kept.")
			}
		}
		var replaced model.Run
		if input.ReplaceRunID != "" {
			replaced, err = store.Get[model.Run](ctx, tx, "SELECT data FROM runs WHERE id=? AND chat_id=?", input.ReplaceRunID, chat.ID)
			if err != nil {
				return err
			}
			if replaced.Superseded {
				return conflict("This message has already been replaced")
			}
			if replaced.ComparisonID != "" {
				return conflict("A comparison's original message cannot be edited in an individual Topic")
			}
			if replaced.Status != "completed" && replaced.Status != "failed" && replaced.Status != "interrupted" && replaced.Status != "paused" {
				return conflict("Only sent messages from finished or paused turns can be edited")
			}
			if input.SessionID != "" && input.SessionID != replaced.SessionID {
				return invalid("An edited sent message must run in its original conversation")
			}
		}
		sourceRun := origin.retry
		if replaced.ID != "" {
			sourceRun = &replaced
		} else if editing.ID != "" {
			sourceRun = &editing
		}
		if sourceRun != nil {
			if err := requireLocalTurn(ctx, tx, sourceRun.ID, "Channel messages cannot be edited or rerun in Lever"); err != nil {
				return err
			}
		}
		var quote *model.MessageQuote
		if origin.retry != nil {
			quote = origin.retry.Quote
		} else if replaced.Quote != nil && input.Quote != nil && replaced.Quote.RunID == input.Quote.RunID && replaced.Quote.Role == input.Quote.Role {
			quote = replaced.Quote
		} else if editing.Quote != nil && input.Quote != nil && editing.Quote.RunID == input.Quote.RunID && editing.Quote.Role == input.Quote.Role {
			quote = editing.Quote
		} else {
			quote, err = resolveQuote(ctx, tx, input.Quote)
		}
		if err != nil {
			return err
		}
		if quote != nil && len(input.Text)+len(quote.Text) > 1<<20 {
			return invalid("Reply and quoted message must total at most 1 MiB")
		}
		create := false
		switch {
		case replaced.ID != "":
			session, err = store.Get[model.Session](ctx, tx, "SELECT data FROM sessions WHERE id=?", replaced.SessionID)
			if err != nil {
				return err
			}
			input.Operation = replaced.Operation
			if input.Operation == "" {
				input.Operation = "main"
				if session.Kind == "topic" {
					input.Operation = "reply"
				}
			}
		case origin.retry != nil:
			session, err = store.Get[model.Session](ctx, tx, "SELECT data FROM sessions WHERE id=?", origin.retry.SessionID)
			if err != nil {
				return err
			}
			input.Operation = "main"
			if session.Kind == "topic" {
				input.Operation = "reply"
			}
		case input.Operation == "main":
			session, err = store.Get[model.Session](ctx, tx, "SELECT data FROM sessions WHERE chat_id=? AND kind='main'", chat.ID)
			if errors.Is(err, sql.ErrNoRows) {
				create = true
			} else if err != nil {
				return err
			}
		case input.Operation == "topic":
			create = true
			if editing.Operation == "topic" {
				session, err = store.Get[model.Session](ctx, tx, "SELECT data FROM sessions WHERE id=?", editing.SessionID)
				if err != nil {
					return err
				}
				create = false
			}
		case input.Operation == "reply":
			session, err = store.Get[model.Session](ctx, tx, "SELECT data FROM sessions WHERE id=?", input.SessionID)
			if errors.Is(err, sql.ErrNoRows) && origin.feishu != nil {
				err = nil
				input.Operation = "topic"
				input.SessionID = ""
				create = true
			} else if err != nil {
				return err
			} else if session.ChatID != chat.ID || session.Kind != "topic" {
				return invalid("Reply must target a topic in this Chat")
			}
		default:
			return invalid("operation must be main, topic or reply")
		}
		if create {
			kind := input.Operation
			session = model.Session{ID: ID(), ChatID: chat.ID, AgentID: agent.ID, Kind: kind, ParentRunID: origin.parentRunID, ProjectID: agent.Profile.ProjectID, Scope: agent.Profile.Scope, Selection: model.Selection{Provider: agent.Profile.Provider, Model: agent.Profile.Model, Permission: agent.Profile.Permission}, CreatedAt: now()}
			if origin.delegationScope != nil {
				session.ProjectID = origin.delegationScope.projectID
				session.Scope = cloneScope(origin.delegationScope.scope)
				session.WorkingCopyID = origin.delegationScope.workingCopyID
				session.WorkingCopyName = origin.delegationScope.workingCopyName
			}
			if origin.personal != nil {
				session.Channel = origin.personal.channelOrigin()
				if kind == "topic" && personalDest.sessionTitle != "" {
					session.Title = personalDest.sessionTitle
				}
			} else if origin.feishu != nil {
				session.Channel = origin.feishu.origin
				if kind == "topic" && origin.feishu.sessionTitle != "" {
					session.Title = origin.feishu.sessionTitle
				}
			} else if task != nil && kind == "topic" {
				session.Title, session.TaskID = task.Title, task.TaskID
			} else if origin.automation != nil && kind == "topic" {
				session.Title = origin.automation.plan.Name
			}
		}
		if input.WorkingCopyID != "" {
			if !create || origin.parentRunID != "" || (!newChat && input.Operation != "topic" && origin.task == nil && origin.automation == nil) {
				return invalid("A directory group can only be selected for a new Chat, Topic or task")
			}
			copy, err := a.selectGroupForTarget(ctx, tx, agent, session.ProjectID, input.WorkingCopyID)
			if err != nil {
				return err
			}
			session.WorkingCopyID = copy.ID
			session.WorkingCopyName = copy.Name
			session.Scope = copy.Scope
		}
		if queued := origin.taskQueue; queued != nil &&
			(session.PrimaryRootID != queued.Scope.PrimaryRootID || !slices.Equal(session.Roots, queued.Scope.Roots)) {
			return conflict("The task's working directory changed. Withdraw it and select a directory again.")
		}
		// An explicit retry or replacement can establish a binding after an unbound stop.
		if origin.retry == nil && replaced.ID == "" && !create && session.NativeID == "" && input.EditRunID == "" {
			var status string
			if err := tx.QueryRowContext(ctx, "SELECT status FROM runs WHERE session_id=? AND position IS NOT NULL AND status NOT IN ('queued','cancelled','steering','steered') ORDER BY position DESC LIMIT 1", session.ID).Scan(&status); err != nil && !errors.Is(err, sql.ErrNoRows) {
				return err
			}
			if status == "unknown" || status == "interrupted" {
				return conflict("This session stopped before its native identity was confirmed. Retry the stopped message or start a new Chat or topic.")
			}
		}
		if err := a.checkSessionScope(session); err != nil {
			return err
		}
		if replaced.ID != "" && a.hasActiveSessionLocked(session.ID) {
			return conflict("This conversation still owns an execution")
		}
		var current *model.Run
		running, err := store.Get[model.Run](ctx, tx, "SELECT data FROM runs WHERE session_id=? AND status IN ('starting','running','waiting_user','cancelling','unknown')", session.ID)
		if err == nil {
			if input.EditRunID == "" && (input.Delivery == "" || running.Status == "unknown") {
				return conflict("This conversation already has an active or unresolved execution")
			}
			current = &running
		} else if !errors.Is(err, sql.ErrNoRows) {
			return err
		}
		selection := session.Selection
		if input.Selection != nil {
			selection = *input.Selection
		} else if replaced.ID != "" {
			selection = replaced.Selection
		}
		selection, config, err := resolveSelection(ctx, tx, selection, session.Selection)
		if err != nil {
			return err
		}
		if delivery.origin != nil && a.supportsMCP(session, config) {
			originRef, err := originConversationReference(ctx, tx, delivery.origin)
			if err != nil {
				return err
			}
			if originRef != nil && !slices.ContainsFunc(input.References, func(ref model.Reference) bool {
				return ref.Kind == originRef.Kind && ref.ID == originRef.ID
			}) {
				input.References = append(slices.Clone(input.References), *originRef)
			}
		}
		retryComparison := origin.retry != nil && origin.retry.ComparisonID != ""
		if err := a.validateReferences(ctx, tx, input.References, session, agent, config); err != nil {
			return err
		}
		input.References, err = a.prepareSkillReferences(ctx, tx, input.References, agent.Profile, session.Scope, config, retryComparison)
		if err != nil {
			return err
		}
		disabledSkills := agent.Profile.DisabledSkills
		steering := current != nil && input.Delivery == "steer" && input.EditRunID == ""
		if input.SteerRunID != "" && (!steering || input.SteerRunID != current.ID) {
			return conflict("The target turn has ended. Queue this message or choose another turn.")
		}
		if steering {
			active := a.active[current.ID]
			if err := active.checkSteer(ctx, tx, *current, selection, input.References); err != nil {
				return err
			}
			disabledSkills = active.profile.DisabledSkills
		}
		if err := validateSkillReferences(input.References, disabledSkills); err != nil {
			return err
		}
		attachmentChat := chat.ID
		if retryComparison {
			// Only a retry of an accepted comparison can reuse its source attachments.
			if err := tx.QueryRowContext(ctx, "SELECT chat_id FROM comparisons WHERE id=?", origin.retry.ComparisonID).Scan(&attachmentChat); err != nil {
				return err
			}
		}
		attachmentIDs := input.AttachmentIDs
		if len(delivery.Images) > 0 {
			taskFiles, err = a.addTaskImages(ctx, tx, chat.ID, delivery.Images)
			if err != nil {
				return err
			}
			for _, file := range taskFiles {
				attachmentIDs = append(attachmentIDs, file.ID)
			}
		}
		files, err := a.messageAttachments(ctx, tx, attachmentChat, agent.ID, attachmentIDs)
		if err != nil {
			return err
		}
		startAfterPause := false
		if session.QueuePaused && origin.retry == nil && replaced.ID == "" && current == nil && input.EditRunID == "" {
			var paused, queued bool
			if err := tx.QueryRow(`SELECT EXISTS(SELECT 1 FROM runs WHERE session_id=? AND status='paused'),
EXISTS(SELECT 1 FROM runs WHERE session_id=? AND status='queued')`, session.ID, session.ID).Scan(&paused, &queued); err != nil {
				return err
			}
			// Explicit sends can start a new turn while a stored queue hold
			// still protects existing queued work.
			startAfterPause = queued && paused && input.Delivery == "" && origin == (sendOrigin{}) && len(afterRunIDs) == 0
			if !queued {
				if _, err := tx.Exec("UPDATE sessions SET data=json_set(data,'$.queuePaused',json('false')) WHERE id=?", session.ID); err != nil {
					return err
				}
				session.QueuePaused = false
			}
		}
		if len(afterRunIDs) > 0 {
			if err := validateAfterRuns(ctx, tx, afterRunIDs, editing, session.ID); err != nil {
				return err
			}
		}
		if create {
			if _, err = tx.Exec("INSERT INTO sessions(id,chat_id,kind,data) VALUES(?,?,?,?)", session.ID, chat.ID, session.Kind, store.JSON(session)); err != nil {
				return err
			}
		}
		run = model.Run{ID: ID(), SessionID: session.ID, ChatID: chat.ID, AgentID: agent.ID, Input: input.Text, Selection: selection, Attachments: files, References: input.References, Quote: quote, Status: "queued", Items: []model.Item{}, CreatedAt: now(), Delivery: input.Delivery, Operation: input.Operation, AfterRunIDs: afterRunIDs}
		run.Quiet = origin.idleCompaction
		if origin.delegationWake != nil {
			run.DelegationReceipts = origin.delegationWake.receipts
		}
		if turn := origin.personal; turn != nil {
			run.ChannelPrompt = turn.prompt
		} else if turn := origin.feishu; turn != nil {
			run.ChannelPrompt = turn.prompt
			run.ChannelContext = turn.context
		}
		if origin.retry != nil {
			run.ComparisonID = origin.retry.ComparisonID
		}
		switch {
		case sourceRun != nil:
			run.AutomationID, run.Quiet = sourceRun.AutomationID, sourceRun.Quiet
			run.Task, err = taskForReplay(ctx, tx, sourceRun, chat.TaskID, session.Kind)
			if err != nil {
				return err
			}
		case origin.automation != nil:
			fire := origin.automation
			run.AutomationID, run.Quiet = fire.plan.ID, fire.plan.Quiet
			if fire.plan.CreatesWorkItem() {
				run.Task = &model.RunTask{ID: fire.id, Record: model.TaskRecordAutomation}
			}
		case origin.task != nil:
			run.Task = delivery.Task
		case session.TaskID != "":
			run.Task = &model.RunTask{ID: session.TaskID}
		case session.Kind == "main" && chat.TaskID != "":
			// A follow-up in a task Chat resolves the current local source at execution.
			run.Task = &model.RunTask{ID: chat.TaskID}
		}
		if input.EditRunID != "" {
			run.ID, run.Sequence, run.CreatedAt = editing.ID, editing.Sequence, editing.CreatedAt
			if editing.Operation == "topic" && input.Operation == "reply" && editing.SessionID == session.ID {
				run.Operation = "topic"
			}
			if _, err := tx.Exec("UPDATE runs SET session_id=? WHERE id=?", session.ID, run.ID); err != nil {
				return err
			}
			if editing.SessionID != session.ID {
				if _, err := tx.Exec("DELETE FROM sessions WHERE id=? AND kind='topic' AND NOT EXISTS (SELECT 1 FROM runs WHERE session_id=?)", editing.SessionID, editing.SessionID); err != nil {
					return err
				}
			}
			run.Delivery = "queue"
			if _, err = tx.Exec("DELETE FROM run_attachments WHERE run_id=?", run.ID); err != nil {
				return err
			}
			if err = saveRunDependencies(ctx, tx, run.ID, afterRunIDs); err != nil {
				return err
			}
			if err = store.SaveRun(tx, run); err != nil {
				return err
			}
		} else {
			if replaced.ID != "" {
				if err := store.SupersedeRuns(tx, replaced, &session); err != nil {
					return err
				}
				// Resume from the retained Lever history in a fresh native session.
				session.NativeID = ""
				session.Runtime = nil
				run.Sequence = replaced.Sequence
			} else if origin.retry != nil {
				// Start the chosen input while leaving the session's queue paused.
				session.QueuePaused = true
			}
			if origin.retry != nil || replaced.ID != "" || origin.taskQueue != nil || startAfterPause {
				if err = reserveRun(tx, &run, &session, config); err != nil {
					return err
				}
				launchProfile, launchProvider = agent.Profile, config
			} else if steering {
				run.SteerRunID = current.ID
				if err := saveSteerSelection(tx, run); err != nil {
					return err
				}
			}
			if err = store.InsertRun(tx, &run, input.CommandID, digest); err != nil {
				return err
			}
			if origin.remote != nil {
				if err := origin.remote.record(tx, run); err != nil {
					return err
				}
			}
			if len(afterRunIDs) > 0 {
				if err = saveRunDependencies(ctx, tx, run.ID, afterRunIDs); err != nil {
					return err
				}
			}
			if queued := origin.taskQueue; queued != nil {
				result, err := tx.ExecContext(ctx, `UPDATE task_queue SET state='started',data='{}',run_id=?,started_at=?
WHERE id=? AND state='queued' AND error=''`, run.ID, time.Now().UnixMilli(), queued.CommandID)
				if err != nil {
					return err
				}
				if n, err := result.RowsAffected(); err != nil || n == 0 {
					if err != nil {
						return err
					}
					return conflict("This task has already left the queue")
				}
				if err := store.Event(tx, model.Event{Type: "task-workflow"}); err != nil {
					return err
				}
			}
			if origin.automation != nil {
				if err := recordAutomationFire(ctx, tx, *origin.automation, run, "", ""); err != nil {
					return err
				}
			} else if sourceRun != nil && run.AutomationID != "" {
				if _, err := tx.ExecContext(ctx, "UPDATE automation_runs SET run_id=? WHERE run_id=?", run.ID, sourceRun.ID); err != nil {
					return err
				}
				if err := store.Event(tx, model.Event{Type: "automation-runs"}); err != nil {
					return err
				}
			}
			if origin.channel != nil {
				parts := []string{"answer", "request"}
				if origin.personal != nil {
					parts = parts[:1]
				}
				for _, part := range parts {
					if _, err = tx.ExecContext(ctx, "INSERT INTO channel_deliveries(run_id,binding_id,message_id,part) VALUES(?,?,?,?)", run.ID, origin.channel.BindingID, origin.channel.MessageID, part); err != nil {
						return err
					}
				}
				if origin.personal != nil {
					err = origin.personal.record(ctx, tx, run.ID)
				} else {
					err = recordFeishuMessage(ctx, tx, origin.channel.BindingID, run.CreatedAt, origin.feishu, run)
				}
				if err != nil {
					return err
				}
			}
		}
		if err := linkRunAttachments(tx, run); err != nil {
			return err
		}
		previous := replaced
		if editing.ID != "" {
			previous = editing
		}
		if err := store.SeedChatTitle(tx, &chat, run, previous); err != nil {
			return err
		}
		if !run.Quiet {
			chat.UpdatedAt = now()
		}
		if _, err = tx.Exec("UPDATE chats SET data=json_set(data,'$.title',?,'$.updatedAt',?) WHERE id=?", chat.Title, chat.UpdatedAt, chat.ID); err != nil {
			return err
		}
		fresh = true
		return store.Event(tx, model.Event{Type: "chats", ChatID: chat.ID})
	})
	if err != nil {
		for _, file := range taskFiles {
			if cleanupErr := a.removeAttachmentFile(file); cleanupErr != nil {
				slog.Warn("remove rejected task image", "attachmentId", file.ID, "error", cleanupErr)
			}
		}
		return model.Run{}, err
	}
	if !fresh {
		return run, nil
	}
	if origin.personal != nil && origin.personal.needsContext {
		return run, nil
	}
	if origin.channel != nil || origin.automation != nil {
		// Acknowledge a durably accepted background message before launching its runtime.
		a.wg.Add(1)
		go func() {
			defer a.wg.Done()
			a.mu.Lock()
			defer a.mu.Unlock()
			if err := a.advanceQueueLocked(run.SessionID); err != nil {
				if a.ctx.Err() == nil {
					slog.Error("start accepted background message", "run", run.ID, "error", err)
				}
			}
		}()
		return run, nil
	}
	if launchProvider.ID != "" {
		a.launchLocked(run, session, launchProfile, launchProvider, nil)
		return run, nil
	}
	if run.SteerRunID != "" {
		if e := a.active[run.SteerRunID]; e != nil {
			e.wakeSteer()
		}
	}
	if err := a.advanceQueueLocked(run.SessionID); err != nil {
		return run, err
	}
	saved, err := store.Get[model.Run](ctx, a.Store.DB, `SELECT `+store.RunWithOverviewFields+` FROM runs r
LEFT JOIN channel_deliveries d ON d.run_id=r.id AND d.part='answer' WHERE r.id=?`, run.ID)
	if err != nil {
		return run, err
	}
	return saved, nil
}

// launchLocked is the only place that gives a run ownership of a native process.
func (a *App) launchLocked(run model.Run, session model.Session, profile model.Profile, config model.Provider, recovery *provider.Recovery) {
	e := a.newExecution(run, session, profile, config, recovery)
	if recovery == nil && session.NativeID == "" && (config.Type == "codex" || config.Type == "claude") {
		a.wg.Go(func() { a.nameConversation(run, session, config) })
	}
	a.trackLocked(e, e.execute)
}

func (a *App) newExecution(run model.Run, session model.Session, profile model.Profile, config model.Provider, recovery *provider.Recovery) *execution {
	runCtx, cancel := context.WithCancel(a.ctx)
	runtimeCtx, interrupt := context.WithCancelCause(runCtx)
	execution := &execution{app: a, ctx: runCtx, cancel: cancel, runtimeCtx: runtimeCtx, interrupt: interrupt, run: run, session: session, profile: profile, provider: config, recovery: recovery, requests: map[string]chan model.Answer{}, token: ID() + ID(), done: make(chan struct{}), steers: make(chan struct{}, 1)}
	if config.Type == "pi" {
		execution.contextToken = ID() + ID()
	}
	return execution
}
func (a *App) trackLocked(e *execution, run func() error) {
	id, sessionID := e.run.ID, e.session.ID
	a.active[id] = e
	a.wg.Add(1)
	go func() {
		defer a.wg.Done()
		defer close(e.done)
		err := run()
		a.mu.Lock()
		defer a.mu.Unlock()
		if !errors.Is(err, errHostDetached) && !(a.closed && e.hosted) {
			e.finish(err)
		}
		e.cancel()
		delete(a.active, id)
		a.wakeTaskQueue()
		if err := a.advanceQueueLocked(sessionID); err != nil {
			slog.Error("advance message queue", "session", sessionID, "error", err)
		}
		a.advanceDependentRunsLocked(id)
		if !errors.Is(err, errHostDetached) && !(a.closed && e.hosted) {
			if e.session.ParentRunID != "" {
				a.onDelegatedChildFinishedLocked(e.run)
			} else if e.run.Status == "completed" {
				a.deliverPendingDelegationReceiptsLocked(sessionID)
			}
		}
	}()
}

func (a *App) Stop(ctx context.Context, runID string) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.stopLocked(ctx, runID, false)
}

func (a *App) Pause(ctx context.Context, runID string) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.stopLocked(ctx, runID, true)
}

func (a *App) stopLocked(ctx context.Context, runID string, pause bool) error {
	e := a.active[runID]
	if e == nil {
		run, err := store.Get[model.Run](ctx, a.Store.DB, "SELECT data FROM runs WHERE id=?", runID)
		if err != nil {
			return err
		}
		if run.Status == "unknown" {
			return conflict("Execution status is unknown; confirm the external runtime has stopped first")
		}
		if !pause && run.Status == "paused" {
			return a.Store.Write(ctx, func(tx *sql.Tx) error {
				if err := pauseQueue(tx, run.SessionID); err != nil {
					return err
				}
				return finishPausedRun(tx, run)
			})
		}
		if pause && run.Status != "paused" {
			return conflict("This reply is no longer running")
		}
		return nil
	}
	if err := e.stop(ctx, pause); err != nil {
		return err
	}
	if !pause {
		a.cancelParentDelegationWakesLocked(ctx, runID)
	}
	childRunIDs := a.delegationChildRunsForParent(ctx, runID)
	for id, child := range a.active {
		if child.session.ParentRunID == runID || childRunIDs[id] {
			if err := a.stopLocked(ctx, id, false); err != nil {
				return err
			}
		}
	}
	return nil
}

func (a *App) Resolve(ctx context.Context, runID string) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.active[runID] != nil {
		return conflict("Execution is still owned by this backend")
	}
	return a.Store.Write(ctx, func(tx *sql.Tx) error {
		r, err := store.Get[model.Run](ctx, tx, "SELECT data FROM runs WHERE id=?", runID)
		if err != nil {
			return err
		}
		if r.Status != "unknown" {
			return conflict("Only unknown executions need reconciliation")
		}
		r.Status = "interrupted"
		r.ResumeAfterShutdown = false
		r.FinishedAt = now()
		r.Error = "User confirmed the previous execution has stopped. Its outcome remains unconfirmed."
		return store.SaveRun(tx, r)
	})
}

func (a *App) Answer(ctx context.Context, id string, answer model.Answer) error {
	return a.answer(ctx, id, answer, nil)
}
func (a *App) answer(ctx context.Context, id string, answer model.Answer, origin *remoteOrigin) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	request, err := store.Get[model.Request](ctx, a.Store.DB, "SELECT data FROM requests WHERE id=?", id)
	if err != nil {
		return err
	}
	if request.Status == "answered" {
		if origin != nil {
			if _, err := a.RemoteReceipt(ctx, origin.scope, origin.intent); !errors.Is(err, sql.ErrNoRows) {
				return err
			}
			return conflict("Request has already been answered")
		}
		if hash(request.Answer) == hash(answer) {
			return nil
		}
		return conflict("This request was answered differently")
	}
	e := a.active[request.RunID]
	if e == nil {
		return conflict("The runtime is no longer waiting for this request")
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	ch := e.requests[id]
	if e.run.Status == "cancelling" || (ch == nil && !e.hosted) || request.Status != "pending" {
		return conflict("Request is no longer pending")
	}
	if request.Kind == "question" && answer.Allow {
		for _, q := range request.Questions {
			if len(answer.Answers[q.ID]) == 0 {
				return invalid("Answer every question")
			}
		}
	}
	if len(request.Options) > 0 {
		if answer.OptionID == "" && answer.Allow {
			return invalid("Choose a native permission option")
		}
		if answer.OptionID != "" {
			index := slices.IndexFunc(request.Options, func(option model.RequestOption) bool { return option.ID == answer.OptionID })
			if index < 0 || request.Options[index].Allow != answer.Allow {
				return invalid("Invalid native permission option")
			}
		}
	}
	request.Status = "answered"
	request.Answer = &answer
	if origin != nil {
		request.AnsweredByUserID = origin.intent.ActorUserID
	}
	if err = a.Store.Write(ctx, func(tx *sql.Tx) error {
		if err := store.SaveRequest(tx, request); err != nil {
			return err
		}
		if origin != nil {
			return origin.record(tx, model.Run{ID: request.RunID, ChatID: request.ChatID, SessionID: request.SessionID})
		}
		return nil
	}); err != nil {
		return err
	}
	if ch != nil {
		ch <- answer
		delete(e.requests, id)
	}
	return nil
}
