// Package cli handles commands shared by the desktop and server binaries.
package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"

	"lever/internal/app"
	"lever/internal/localipc"
	"lever/internal/model"
)

const executionTokenEnv = "LEVER_EXECUTION_TOKEN"

func Run(args []string, dataDir string, out, errOut io.Writer) (bool, error) {
	return RunWithInput(args, dataDir, os.Stdin, out, errOut)
}

func RunWithInput(args []string, dataDir string, in io.Reader, out, errOut io.Writer) (bool, error) {
	if len(args) == 0 {
		return false, nil
	}
	switch args[0] {
	case "agent":
		return true, runAgent(args[1:], dataDir, out, errOut)
	case "automations":
		return true, runAutomations(args[1:], dataDir, in, out, errOut)
	case "chat":
		return true, runChat(args[1:], dataDir, out, errOut)
	case "context":
		return true, runContext(args[1:], dataDir, out, errOut)
	case "work-items":
		return true, runWorkItems(args[1:], dataDir, out, errOut)
	default:
		return false, nil
	}
}

func runAgent(args []string, dataDir string, out, errOut io.Writer) error {
	if len(args) == 0 || args[0] == "--help" || args[0] == "-h" {
		fmt.Fprintln(out, "Usage: lever agent list [flags]")
		return nil
	}
	if args[0] != "list" {
		return fmt.Errorf("unknown agent command %q", args[0])
	}
	flags := flag.NewFlagSet("lever agent list", flag.ContinueOnError)
	flags.SetOutput(errOut)
	flags.StringVar(&dataDir, "data-dir", dataDir, "Lever data directory (or LEVER_DATA_DIR)")
	if err := parseFlags(flags, args[1:]); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return nil
		}
		return err
	}
	return request(dataDir, http.MethodGet, "/agents", "", nil, out)
}

func runChat(args []string, dataDir string, out, errOut io.Writer) error {
	if len(args) == 0 || args[0] == "--help" || args[0] == "-h" {
		fmt.Fprintln(out, "Usage: lever chat list [--agent <id>] [--limit <n>] [flags]")
		return nil
	}
	if args[0] != "list" {
		return fmt.Errorf("unknown chat command %q", args[0])
	}
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
	return request(dataDir, http.MethodGet, path, strings.TrimSpace(os.Getenv(executionTokenEnv)), nil, out)
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

func runWorkItems(args []string, dataDir string, out, errOut io.Writer) error {
	if len(args) == 0 || args[0] == "--help" || args[0] == "-h" {
		fmt.Fprintln(out, "Usage: lever work-items create [flags]")
		return nil
	}
	if args[0] != "create" {
		return fmt.Errorf("unknown work-items command %q", args[0])
	}
	flags := flag.NewFlagSet("lever work-items create", flag.ContinueOnError)
	flags.SetOutput(errOut)
	flags.StringVar(&dataDir, "data-dir", dataDir, "Lever data directory (or LEVER_DATA_DIR)")
	var item model.WorkItemInput
	var agentID string
	flags.StringVar(&agentID, "agent", "", "Agent ID from lever agent list (required)")
	flags.StringVar(&item.Title, "title", "", "Work item title (required)")
	flags.StringVar(&item.Body, "body", "", "Description for the Agent")
	flags.StringVar(&item.RequestKey, "request-key", "", "Stable key to reuse when retrying a creation")
	if err := parseFlags(flags, args[1:]); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return nil
		}
		return err
	}
	agentID = strings.TrimSpace(agentID)
	if agentID == "" || strings.TrimSpace(item.Title) == "" {
		return errors.New("--agent and --title are required")
	}
	return request(dataDir, http.MethodPost, "/agents/"+url.PathEscape(agentID)+"/work-items", "", item, out)
}

func runAutomations(args []string, dataDir string, in io.Reader, out, errOut io.Writer) error {
	if len(args) == 0 || args[0] == "--help" || args[0] == "-h" {
		fmt.Fprintln(out, "Usage: lever automations list [flags]")
		fmt.Fprintln(out, "       lever automations emit --id <id> [--data <json>] [--key <idempotency-key>] [flags]")
		return nil
	}
	token := strings.TrimSpace(os.Getenv(executionTokenEnv))
	switch args[0] {
	case "list":
		flags := flag.NewFlagSet("lever automations list", flag.ContinueOnError)
		flags.SetOutput(errOut)
		flags.StringVar(&dataDir, "data-dir", dataDir, "Lever data directory (or LEVER_DATA_DIR)")
		if err := parseFlags(flags, args[1:]); err != nil {
			if errors.Is(err, flag.ErrHelp) {
				return nil
			}
			return err
		}
		return request(dataDir, http.MethodGet, "/automations", token, nil, out)
	case "emit":
		flags := flag.NewFlagSet("lever automations emit", flag.ContinueOnError)
		flags.SetOutput(errOut)
		flags.StringVar(&dataDir, "data-dir", dataDir, "Lever data directory (or LEVER_DATA_DIR)")
		var id, data, key string
		flags.StringVar(&id, "id", "", "Automation ID from lever automations list (required)")
		flags.StringVar(&data, "data", "", "JSON event payload up to 16 KiB, or '-' to read stdin")
		flags.StringVar(&key, "key", "", "Optional idempotency key (up to 200 bytes)")
		if err := parseFlags(flags, args[1:]); err != nil {
			if errors.Is(err, flag.ErrHelp) {
				return nil
			}
			return err
		}
		id = strings.TrimSpace(id)
		if id == "" {
			return errors.New("--id is required")
		}
		if len(key) > 200 {
			return errors.New("Idempotency-Key can have up to 200 bytes")
		}
		payload, err := readEventPayload(data, in)
		if err != nil {
			return err
		}
		var headers map[string]string
		if key != "" {
			headers = map[string]string{"Idempotency-Key": key}
		}
		return requestWithHeaders(dataDir, http.MethodPost, "/automations/"+url.PathEscape(id)+"/events", token, headers, payload, out)
	default:
		return fmt.Errorf("unknown automations command %q", args[0])
	}
}

func readEventPayload(data string, in io.Reader) (json.RawMessage, error) {
	var raw []byte
	if data != "" && data != "-" {
		raw = []byte(data)
	} else {
		if in == nil {
			return nil, errors.New("pass --data <json> or pipe JSON to stdin")
		}
		if data == "" {
			if file, ok := in.(*os.File); ok {
				if info, err := file.Stat(); err == nil && info.Mode()&os.ModeCharDevice != 0 {
					return nil, errors.New("pass --data <json> or pipe JSON to stdin")
				}
			}
		}
		var err error
		raw, err = io.ReadAll(io.LimitReader(in, app.MaxAutomationEventBytes+1))
		if err != nil {
			return nil, err
		}
	}
	raw = bytes.TrimSpace(raw)
	if len(raw) == 0 {
		return nil, errors.New("pass --data <json> or pipe JSON to stdin")
	}
	if len(raw) > app.MaxAutomationEventBytes {
		return nil, errors.New("Send a JSON event up to 16 KiB")
	}
	if !json.Valid(raw) {
		return nil, errors.New("Event payload must be valid JSON")
	}
	return json.RawMessage(raw), nil
}

func parseFlags(flags *flag.FlagSet, args []string) error {
	if err := flags.Parse(args); err != nil {
		return err
	}
	if flags.NArg() != 0 {
		return errors.New("expected flags after the command")
	}
	return nil
}

func request(dataDir, method, path, token string, input any, out io.Writer) error {
	return requestWithHeaders(dataDir, method, path, token, nil, input, out)
}

func requestWithHeaders(dataDir, method, path, token string, headers map[string]string, input any, out io.Writer) error {
	var body io.Reader
	if input != nil {
		data, err := json.Marshal(input)
		if err != nil {
			return err
		}
		body = bytes.NewReader(data)
	}
	req, err := http.NewRequest(method, "http://lever"+path, body)
	if err != nil {
		return err
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	client := http.Client{
		Timeout:       10 * time.Second,
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
		Transport: &http.Transport{
			DisableKeepAlives: true,
			DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
				return localipc.Dial(ctx, dataDir)
			},
		},
	}
	res, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("connect to the running Lever instance for %q: %w", dataDir, err)
	}
	defer res.Body.Close()
	decoder := json.NewDecoder(res.Body)
	if res.StatusCode != http.StatusOK {
		var payload struct{ Error string }
		if decoder.Decode(&payload) == nil && payload.Error != "" {
			return fmt.Errorf("Lever: %s", payload.Error)
		}
		return fmt.Errorf("Lever: %s", res.Status)
	}
	var result json.RawMessage
	if err := decoder.Decode(&result); err != nil {
		return err
	}
	return json.NewEncoder(out).Encode(result)
}
