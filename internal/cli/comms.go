package cli

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"

	"lever/internal/app"
	"lever/internal/model"
)

func runChat(args []string, dataDir string, in io.Reader, out, errOut io.Writer) error {
	if len(args) == 0 || args[0] == "--help" || args[0] == "-h" {
		fmt.Fprintln(out, "Usage: lever chat list [--agent <id>] [--limit <n>] [flags]")
		fmt.Fprintln(out, "       lever chat create --agent <id> [--title <title>] [flags]")
		fmt.Fprintln(out, "       lever chat send (--agent <id> | --chat <id>) [--operation <main|topic|reply>] [--session <id>] [--text <text|->] [--wait] [--timeout <dur>] [flags]")
		return nil
	}
	token := strings.TrimSpace(os.Getenv(executionTokenEnv))
	switch args[0] {
	case "list":
		flags := flag.NewFlagSet("lever chat list", flag.ContinueOnError)
		flags.SetOutput(errOut)
		flags.StringVar(&dataDir, "data-dir", dataDir, "Lever data directory (or LEVER_DATA_DIR)")
		var agentID string
		var limit int
		flags.StringVar(&agentID, "agent", "", "Filter chats by Agent ID")
		flags.IntVar(&limit, "limit", 20, "Maximum number of chats to return (1-100)")
		if err := parseFlags(flags, args[1:]); err != nil {
			if errors.Is(err, flag.ErrHelp) {
				return nil
			}
			return err
		}
		query := url.Values{}
		if agentID = strings.TrimSpace(agentID); agentID != "" {
			query.Set("agent", agentID)
		}
		if limit != 20 {
			query.Set("limit", strconv.Itoa(limit))
		}
		path := "/chats"
		if encoded := query.Encode(); encoded != "" {
			path += "?" + encoded
		}
		return request(dataDir, http.MethodGet, path, token, nil, out)
	case "create":
		flags := flag.NewFlagSet("lever chat create", flag.ContinueOnError)
		flags.SetOutput(errOut)
		flags.StringVar(&dataDir, "data-dir", dataDir, "Lever data directory (or LEVER_DATA_DIR)")
		var agentID, title string
		flags.StringVar(&agentID, "agent", "", "Agent ID (required)")
		flags.StringVar(&title, "title", "", "Optional chat title")
		if err := parseFlags(flags, args[1:]); err != nil {
			if errors.Is(err, flag.ErrHelp) {
				return nil
			}
			return err
		}
		agentID = strings.TrimSpace(agentID)
		if agentID == "" {
			return errors.New("--agent is required")
		}
		return request(dataDir, http.MethodPost, "/chats", token, map[string]string{
			"agentId": agentID,
			"title":   title,
		}, out)
	case "send":
		flags := flag.NewFlagSet("lever chat send", flag.ContinueOnError)
		flags.SetOutput(errOut)
		flags.StringVar(&dataDir, "data-dir", dataDir, "Lever data directory (or LEVER_DATA_DIR)")
		var agentID, chatID, sessionID, operation, text, delivery, workingCopyID, commandID, steerRunID string
		var afterRuns stringList
		var wait bool
		var timeout time.Duration
		var sel selectionFlags
		flags.StringVar(&agentID, "agent", "", "Agent ID to start a new Chat")
		flags.StringVar(&chatID, "chat", "", "Existing Chat ID")
		flags.StringVar(&operation, "operation", "main", "Operation: main, topic, or reply")
		flags.StringVar(&sessionID, "session", "", "Topic session ID (required when --operation reply)")
		flags.StringVar(&text, "text", "", "Message text, or '-' / piped stdin")
		flags.StringVar(&delivery, "delivery", "", "Delivery mode when busy: queue or steer")
		flags.StringVar(&steerRunID, "steer-run", "", "Specific active run ID to steer")
		flags.StringVar(&workingCopyID, "working-copy", "", "Optional working copy ID")
		flags.StringVar(&commandID, "command-id", "", "Optional idempotency command ID")
		flags.Var(&afterRuns, "after", "Wait for upstream run ID before starting (repeatable)")
		flags.BoolVar(&wait, "wait", false, "Wait until the run reaches a terminal or waiting_user state")
		flags.DurationVar(&timeout, "timeout", 10*time.Minute, "Maximum wait time when --wait is set (0 = no timeout)")
		sel.register(flags)
		if err := parseFlags(flags, args[1:]); err != nil {
			if errors.Is(err, flag.ErrHelp) {
				return nil
			}
			return err
		}
		agentID = strings.TrimSpace(agentID)
		chatID = strings.TrimSpace(chatID)
		if (agentID == "" && chatID == "") || (agentID != "" && chatID != "") {
			return errors.New("pass exactly one of --agent or --chat")
		}
		bodyText, err := readTextArg(text, in, 1<<20)
		if err != nil {
			return err
		}
		if strings.TrimSpace(bodyText) == "" {
			return errors.New("message text is required via --text or stdin")
		}
		if strings.TrimSpace(commandID) == "" {
			commandID = app.ID()
		}
		input := model.SendInput{
			CommandID:     strings.TrimSpace(commandID),
			AgentID:       agentID,
			ChatID:        chatID,
			Operation:     strings.TrimSpace(operation),
			SessionID:     strings.TrimSpace(sessionID),
			Text:          bodyText,
			Selection:     sel.toSelection(),
			Delivery:      strings.TrimSpace(delivery),
			SteerRunID:    strings.TrimSpace(steerRunID),
			WorkingCopyID: strings.TrimSpace(workingCopyID),
			AfterRunIDs:   []string(afterRuns),
		}
		if !wait {
			return request(dataDir, http.MethodPost, "/messages", token, input, out)
		}
		var started model.Run
		if err := requestDecode(context.Background(), dataDir, http.MethodPost, "/messages", token, nil, input, 15*time.Second, &started); err != nil {
			return err
		}
		return waitForRun(dataDir, started.ID, token, timeout, out)
	default:
		return fmt.Errorf("unknown chat command %q", args[0])
	}
}

func waitForRun(dataDir, runID, token string, timeout time.Duration, out io.Writer) error {
	query := url.Values{}
	if timeout > 0 {
		query.Set("timeout", timeout.String())
	}
	path := "/runs/" + url.PathEscape(runID) + "/wait"
	if encoded := query.Encode(); encoded != "" {
		path += "?" + encoded
	}
	ctx := context.Background()
	var cancel context.CancelFunc
	if timeout > 0 {
		ctx, cancel = context.WithTimeout(ctx, timeout+5*time.Second)
		defer cancel()
	}
	raw, err := requestRaw(ctx, dataDir, http.MethodGet, path, token, nil, nil, 0)
	if err != nil {
		return err
	}
	return json.NewEncoder(out).Encode(raw)
}

func runRun(args []string, dataDir string, out, errOut io.Writer) error {
	if len(args) == 0 || args[0] == "--help" || args[0] == "-h" {
		fmt.Fprintln(out, "Usage: lever run get --id <run-id> [flags]")
		fmt.Fprintln(out, "       lever run wait --id <run-id> [--timeout <dur>] [flags]")
		fmt.Fprintln(out, "       lever run stop --id <run-id> [flags]")
		fmt.Fprintln(out, "       lever run pause --id <run-id> [flags]")
		fmt.Fprintln(out, "       lever run resume --id <run-id> [--native-turn <id>] [flags]")
		fmt.Fprintln(out, "       lever run answer --request <req-id> [--allow=true|false] [--option <id>] [--answers <json>] [flags]")
		return nil
	}
	token := strings.TrimSpace(os.Getenv(executionTokenEnv))
	switch args[0] {
	case "get":
		flags := flag.NewFlagSet("lever run get", flag.ContinueOnError)
		flags.SetOutput(errOut)
		flags.StringVar(&dataDir, "data-dir", dataDir, "Lever data directory (or LEVER_DATA_DIR)")
		var id string
		flags.StringVar(&id, "id", "", "Run ID (required)")
		if err := parseFlags(flags, args[1:]); err != nil {
			if errors.Is(err, flag.ErrHelp) {
				return nil
			}
			return err
		}
		if id = strings.TrimSpace(id); id == "" {
			return errors.New("--id is required")
		}
		return request(dataDir, http.MethodGet, "/runs/"+url.PathEscape(id), token, nil, out)
	case "wait":
		flags := flag.NewFlagSet("lever run wait", flag.ContinueOnError)
		flags.SetOutput(errOut)
		flags.StringVar(&dataDir, "data-dir", dataDir, "Lever data directory (or LEVER_DATA_DIR)")
		var id string
		var timeout time.Duration
		flags.StringVar(&id, "id", "", "Run ID (required)")
		flags.DurationVar(&timeout, "timeout", 10*time.Minute, "Maximum wait time (0 = no timeout)")
		if err := parseFlags(flags, args[1:]); err != nil {
			if errors.Is(err, flag.ErrHelp) {
				return nil
			}
			return err
		}
		if id = strings.TrimSpace(id); id == "" {
			return errors.New("--id is required")
		}
		return waitForRun(dataDir, id, token, timeout, out)
	case "stop":
		flags := flag.NewFlagSet("lever run stop", flag.ContinueOnError)
		flags.SetOutput(errOut)
		flags.StringVar(&dataDir, "data-dir", dataDir, "Lever data directory (or LEVER_DATA_DIR)")
		var id string
		flags.StringVar(&id, "id", "", "Run ID (required)")
		if err := parseFlags(flags, args[1:]); err != nil {
			if errors.Is(err, flag.ErrHelp) {
				return nil
			}
			return err
		}
		if id = strings.TrimSpace(id); id == "" {
			return errors.New("--id is required")
		}
		return request(dataDir, http.MethodPost, "/runs/"+url.PathEscape(id)+"/stop", token, nil, out)
	case "pause":
		flags := flag.NewFlagSet("lever run pause", flag.ContinueOnError)
		flags.SetOutput(errOut)
		flags.StringVar(&dataDir, "data-dir", dataDir, "Lever data directory (or LEVER_DATA_DIR)")
		var id string
		flags.StringVar(&id, "id", "", "Run ID (required)")
		if err := parseFlags(flags, args[1:]); err != nil {
			if errors.Is(err, flag.ErrHelp) {
				return nil
			}
			return err
		}
		if id = strings.TrimSpace(id); id == "" {
			return errors.New("--id is required")
		}
		return request(dataDir, http.MethodPost, "/runs/"+url.PathEscape(id)+"/pause", token, nil, out)
	case "resume":
		flags := flag.NewFlagSet("lever run resume", flag.ContinueOnError)
		flags.SetOutput(errOut)
		flags.StringVar(&dataDir, "data-dir", dataDir, "Lever data directory (or LEVER_DATA_DIR)")
		var id, nativeTurnID string
		flags.StringVar(&id, "id", "", "Run ID (required)")
		flags.StringVar(&nativeTurnID, "native-turn", "", "Optional native turn ID")
		if err := parseFlags(flags, args[1:]); err != nil {
			if errors.Is(err, flag.ErrHelp) {
				return nil
			}
			return err
		}
		if id = strings.TrimSpace(id); id == "" {
			return errors.New("--id is required")
		}
		return request(dataDir, http.MethodPost, "/runs/"+url.PathEscape(id)+"/resume", token, map[string]string{
			"nativeTurnId": strings.TrimSpace(nativeTurnID),
		}, out)
	case "answer":
		flags := flag.NewFlagSet("lever run answer", flag.ContinueOnError)
		flags.SetOutput(errOut)
		flags.StringVar(&dataDir, "data-dir", dataDir, "Lever data directory (or LEVER_DATA_DIR)")
		var reqID, optionID, answersRaw string
		allow := optionalBool{set: true, value: true}
		flags.StringVar(&reqID, "request", "", "Pending Request ID (required)")
		flags.Var(&allow, "allow", "Allow or deny request (default true)")
		flags.StringVar(&optionID, "option", "", "Optional native permission option ID")
		flags.StringVar(&answersRaw, "answers", "", "Optional JSON map of question answers (questionId -> [values])")
		if err := parseFlags(flags, args[1:]); err != nil {
			if errors.Is(err, flag.ErrHelp) {
				return nil
			}
			return err
		}
		if reqID = strings.TrimSpace(reqID); reqID == "" {
			return errors.New("--request is required")
		}
		ans := model.Answer{
			Allow:    allow.value,
			OptionID: strings.TrimSpace(optionID),
			Answers:  map[string][]string{},
		}
		if strings.TrimSpace(answersRaw) != "" {
			if err := json.Unmarshal([]byte(answersRaw), &ans.Answers); err != nil {
				return fmt.Errorf("invalid --answers JSON: %w", err)
			}
		}
		return request(dataDir, http.MethodPost, "/requests/"+url.PathEscape(reqID)+"/answer", token, ans, out)
	default:
		return fmt.Errorf("unknown run command %q", args[0])
	}
}

func runEvents(args []string, dataDir string, out, errOut io.Writer) error {
	if len(args) == 0 || args[0] == "--help" || args[0] == "-h" {
		fmt.Fprintln(out, "Usage: lever events tail [--after <seq>] [--type <types>] [--chat <id>] [--limit <n>] [--timeout <dur>] [flags]")
		return nil
	}
	if args[0] != "tail" {
		return fmt.Errorf("unknown events command %q", args[0])
	}
	token := strings.TrimSpace(os.Getenv(executionTokenEnv))
	flags := flag.NewFlagSet("lever events tail", flag.ContinueOnError)
	flags.SetOutput(errOut)
	flags.StringVar(&dataDir, "data-dir", dataDir, "Lever data directory (or LEVER_DATA_DIR)")
	var after, eventType, chatID string
	var limit int
	var timeout time.Duration
	flags.StringVar(&after, "after", "", "Start streaming events strictly after this sequence (omit for live tail; 0 for all retained)")
	flags.StringVar(&eventType, "type", "", "Comma-separated event types to filter (e.g. runs,automations)")
	flags.StringVar(&chatID, "chat", "", "Filter events by Chat ID")
	flags.IntVar(&limit, "limit", 0, "Stop after emitting N matching events (0 = unlimited)")
	flags.DurationVar(&timeout, "timeout", 0, "Stop streaming after this duration (0 = unlimited)")
	if err := parseFlags(flags, args[1:]); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return nil
		}
		return err
	}
	query := url.Values{}
	if strings.TrimSpace(after) != "" {
		query.Set("after", strings.TrimSpace(after))
	}
	if strings.TrimSpace(eventType) != "" {
		query.Set("type", strings.TrimSpace(eventType))
	}
	if strings.TrimSpace(chatID) != "" {
		query.Set("chat", strings.TrimSpace(chatID))
	}
	if limit > 0 {
		query.Set("limit", strconv.Itoa(limit))
	}
	if timeout > 0 {
		query.Set("timeout", timeout.String())
	}
	path := "/events"
	if encoded := query.Encode(); encoded != "" {
		path += "?" + encoded
	}
	ctx := context.Background()
	var cancel context.CancelFunc
	if timeout > 0 {
		ctx, cancel = context.WithTimeout(ctx, timeout+5*time.Second)
		defer cancel()
	}
	return requestStream(ctx, dataDir, path, token, out)
}

func runContext(args []string, dataDir string, out, errOut io.Writer) error {
	if len(args) == 0 || args[0] == "--help" || args[0] == "-h" {
		fmt.Fprintln(out, "Usage: lever context find [--chat <id>] [--query <text>] [flags]")
		fmt.Fprintln(out, "       lever context read [--chat <id>] --target <main|sessionId> [flags]")
		return nil
	}
	token := strings.TrimSpace(os.Getenv(executionTokenEnv))
	switch args[0] {
	case "find":
		flags := flag.NewFlagSet("lever context find", flag.ContinueOnError)
		flags.SetOutput(errOut)
		flags.StringVar(&dataDir, "data-dir", dataDir, "Lever data directory (or LEVER_DATA_DIR)")
		var input app.FindContextCLIInput
		flags.StringVar(&input.ChatID, "chat", "", "Chat ID from lever chat list (optional inside an active Lever execution)")
		flags.StringVar(&input.Query, "query", "", "Keyword or phrase to search; omit to list recent Topics")
		if err := parseFlags(flags, args[1:]); err != nil {
			if errors.Is(err, flag.ErrHelp) {
				return nil
			}
			return err
		}
		input.ChatID = strings.TrimSpace(input.ChatID)
		if token == "" && input.ChatID == "" {
			return errors.New("--chat is required outside an active Lever execution")
		}
		return request(dataDir, http.MethodPost, "/context/find", token, input, out)
	case "read":
		flags := flag.NewFlagSet("lever context read", flag.ContinueOnError)
		flags.SetOutput(errOut)
		flags.StringVar(&dataDir, "data-dir", dataDir, "Lever data directory (or LEVER_DATA_DIR)")
		var input app.ReadContextCLIInput
		var runID, itemID, cursorRaw string
		var offset int
		flags.StringVar(&input.ChatID, "chat", "", "Chat ID (optional inside an active Lever execution or when --target is a sessionId)")
		flags.StringVar(&input.Target, "target", "", "main or a Topic/Chat sessionId (required)")
		flags.StringVar(&runID, "run", "", "Anchor runId to start reading from")
		flags.StringVar(&itemID, "item", "", "Anchor itemId within --run")
		flags.IntVar(&offset, "offset", 0, "UTF-8 byte offset within the anchored message")
		flags.StringVar(&input.Direction, "direction", "", "older (default) or newer; newer requires --run")
		flags.StringVar(&cursorRaw, "cursor", "", "JSON nextCursor returned by a previous lever context read")
		if err := parseFlags(flags, args[1:]); err != nil {
			if errors.Is(err, flag.ErrHelp) {
				return nil
			}
			return err
		}
		input.ChatID = strings.TrimSpace(input.ChatID)
		input.Target = strings.TrimSpace(input.Target)
		if input.Target == "" {
			return errors.New("--target is required")
		}
		if cursorRaw = strings.TrimSpace(cursorRaw); cursorRaw != "" {
			if runID != "" || itemID != "" || offset != 0 || input.Direction != "" {
				return errors.New("--cursor cannot be combined with --run, --item, --offset, or --direction")
			}
			var cursor app.ContextCursor
			if err := json.Unmarshal([]byte(cursorRaw), &cursor); err != nil {
				return fmt.Errorf("invalid --cursor JSON: %w", err)
			}
			input.Cursor = &cursor
		} else if runID != "" {
			if offset < 0 {
				return errors.New("--offset must be non-negative")
			}
			input.Anchor = &app.ContextAnchor{RunID: runID, ItemID: itemID, Offset: offset}
		} else if itemID != "" || offset != 0 {
			return errors.New("--item and --offset require --run")
		}
		if token == "" && input.ChatID == "" && input.Target == "main" {
			return errors.New("--chat is required when --target is main outside an active Lever execution")
		}
		return request(dataDir, http.MethodPost, "/context/read", token, input, out)
	default:
		return fmt.Errorf("unknown context command %q", args[0])
	}
}
