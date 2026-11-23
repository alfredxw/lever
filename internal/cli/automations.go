package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"lever/internal/app"
	"lever/internal/model"
)

func runAutomations(args []string, dataDir string, in io.Reader, out, errOut io.Writer) error {
	if len(args) == 0 || args[0] == "--help" || args[0] == "-h" {
		fmt.Fprintln(out, "Usage: lever automations list [--full] [flags]")
		fmt.Fprintln(out, "       lever automations get --id <id> [flags]")
		fmt.Fprintln(out, "       lever automations create (--json <json|-> | --name <name> --prompt <text> --agent <id> [schedule/event/model/permission flags])")
		fmt.Fprintln(out, "       lever automations update --id <id> [--json <json|->] [field flags]")
		fmt.Fprintln(out, "       lever automations enable|disable|archive --id <id> [flags]")
		fmt.Fprintln(out, "       lever automations run --id <id> [--target <id>] [--command-id <id>] [flags]")
		fmt.Fprintln(out, "       lever automations history [--id <id>] [--limit <n>] [flags]")
		fmt.Fprintln(out, "       lever automations emit --id <id> [--data <json>] [--key <idempotency-key>] [flags]")
		fmt.Fprintln(out, "       lever automations import-codex [--dir <path>] [--id <codex-id>...] [--agent <id>] [--permission <policy>] [--create-missing-agents] [--dry-run] [flags]")
		return nil
	}
	token := strings.TrimSpace(os.Getenv(executionTokenEnv))
	switch args[0] {
	case "list":
		flags := flag.NewFlagSet("lever automations list", flag.ContinueOnError)
		flags.SetOutput(errOut)
		flags.StringVar(&dataDir, "data-dir", dataDir, "Lever data directory (or LEVER_DATA_DIR)")
		var full bool
		flags.BoolVar(&full, "full", false, "Return full Automation definitions")
		if err := parseFlags(flags, args[1:]); err != nil {
			if errors.Is(err, flag.ErrHelp) {
				return nil
			}
			return err
		}
		path := "/automations"
		if full {
			path += "?full=true"
		}
		return request(dataDir, http.MethodGet, path, token, nil, out)
	case "get":
		flags := flag.NewFlagSet("lever automations get", flag.ContinueOnError)
		flags.SetOutput(errOut)
		flags.StringVar(&dataDir, "data-dir", dataDir, "Lever data directory (or LEVER_DATA_DIR)")
		var id string
		flags.StringVar(&id, "id", "", "Automation ID (required)")
		if err := parseFlags(flags, args[1:]); err != nil {
			if errors.Is(err, flag.ErrHelp) {
				return nil
			}
			return err
		}
		if id = strings.TrimSpace(id); id == "" {
			return errors.New("--id is required")
		}
		return request(dataDir, http.MethodGet, "/automations/"+url.PathEscape(id), token, nil, out)
	case "create":
		return runAutomationSave("", args[1:], dataDir, in, out, errOut, token)
	case "update":
		return runAutomationSave("update", args[1:], dataDir, in, out, errOut, token)
	case "enable", "disable":
		enabled := args[0] == "enable"
		flags := flag.NewFlagSet("lever automations "+args[0], flag.ContinueOnError)
		flags.SetOutput(errOut)
		flags.StringVar(&dataDir, "data-dir", dataDir, "Lever data directory (or LEVER_DATA_DIR)")
		var id string
		flags.StringVar(&id, "id", "", "Automation ID (required)")
		if err := parseFlags(flags, args[1:]); err != nil {
			if errors.Is(err, flag.ErrHelp) {
				return nil
			}
			return err
		}
		if id = strings.TrimSpace(id); id == "" {
			return errors.New("--id is required")
		}
		return request(dataDir, http.MethodPatch, "/automations/"+url.PathEscape(id), token, map[string]bool{"enabled": enabled}, out)
	case "archive":
		flags := flag.NewFlagSet("lever automations archive", flag.ContinueOnError)
		flags.SetOutput(errOut)
		flags.StringVar(&dataDir, "data-dir", dataDir, "Lever data directory (or LEVER_DATA_DIR)")
		var id string
		flags.StringVar(&id, "id", "", "Automation ID (required)")
		if err := parseFlags(flags, args[1:]); err != nil {
			if errors.Is(err, flag.ErrHelp) {
				return nil
			}
			return err
		}
		if id = strings.TrimSpace(id); id == "" {
			return errors.New("--id is required")
		}
		return request(dataDir, http.MethodDelete, "/automations/"+url.PathEscape(id), token, nil, out)
	case "run":
		flags := flag.NewFlagSet("lever automations run", flag.ContinueOnError)
		flags.SetOutput(errOut)
		flags.StringVar(&dataDir, "data-dir", dataDir, "Lever data directory (or LEVER_DATA_DIR)")
		var id, targetID, commandID string
		flags.StringVar(&id, "id", "", "Automation ID (required)")
		flags.StringVar(&targetID, "target", "", "Optional target ID for multi-target automations")
		flags.StringVar(&commandID, "command-id", "", "Optional idempotency command ID")
		if err := parseFlags(flags, args[1:]); err != nil {
			if errors.Is(err, flag.ErrHelp) {
				return nil
			}
			return err
		}
		if id = strings.TrimSpace(id); id == "" {
			return errors.New("--id is required")
		}
		if strings.TrimSpace(commandID) == "" {
			commandID = app.ID()
		}
		return request(dataDir, http.MethodPost, "/automations/"+url.PathEscape(id)+"/run", token, map[string]string{
			"commandId": strings.TrimSpace(commandID),
			"targetId":  strings.TrimSpace(targetID),
		}, out)
	case "history":
		flags := flag.NewFlagSet("lever automations history", flag.ContinueOnError)
		flags.SetOutput(errOut)
		flags.StringVar(&dataDir, "data-dir", dataDir, "Lever data directory (or LEVER_DATA_DIR)")
		var id string
		var limit int
		flags.StringVar(&id, "id", "", "Optional Automation ID (omit for global recent runs)")
		flags.IntVar(&limit, "limit", 50, "Maximum global runs to return (1-300, ignored when --id is set)")
		if err := parseFlags(flags, args[1:]); err != nil {
			if errors.Is(err, flag.ErrHelp) {
				return nil
			}
			return err
		}
		if id = strings.TrimSpace(id); id != "" {
			return request(dataDir, http.MethodGet, "/automations/"+url.PathEscape(id)+"/history", token, nil, out)
		}
		path := "/automation-runs"
		if limit != 50 {
			path += "?limit=" + strconv.Itoa(limit)
		}
		return request(dataDir, http.MethodGet, path, token, nil, out)
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
	case "import-codex":
		return runImportCodexAutomations(args[1:], dataDir, out, errOut, token)
	default:
		return fmt.Errorf("unknown automations command %q", args[0])
	}
}

func runAutomationSave(mode string, args []string, dataDir string, in io.Reader, out, errOut io.Writer, token string) error {
	updating := mode == "update"
	cmdName := "lever automations create"
	if updating {
		cmdName = "lever automations update"
	}
	flags := flag.NewFlagSet(cmdName, flag.ContinueOnError)
	flags.SetOutput(errOut)
	flags.StringVar(&dataDir, "data-dir", dataDir, "Lever data directory (or LEVER_DATA_DIR)")
	var id, jsonRaw, name, prompt, promptFile, agentID, chatID, destMode, workingCopyID string
	var scheduleTime, timezone, weekdaysRaw, dateStr, notifyPolicy, deliveryMode string
	var dayOfMonth, intervalMinutes, batchSize int
	var eventTrigger, paused, clearSelection bool
	var workItem optionalBool
	var sel selectionFlags
	if updating {
		flags.StringVar(&id, "id", "", "Automation ID (required)")
		flags.BoolVar(&clearSelection, "clear-selection", false, "Clear task-level model/permission override")
	} else {
		flags.BoolVar(&paused, "paused", false, "Create automation in paused state")
	}
	flags.StringVar(&jsonRaw, "json", "", "Full model.AutomationInput JSON payload, or '-' to read stdin")
	flags.StringVar(&name, "name", "", "Automation name (up to 80 chars)")
	flags.StringVar(&prompt, "prompt", "", "Automation prompt text")
	flags.StringVar(&promptFile, "prompt-file", "", "Read prompt text from a file")
	flags.StringVar(&agentID, "agent", "", "Target Agent ID")
	flags.StringVar(&chatID, "chat", "", "Optional existing Chat ID")
	flags.StringVar(&destMode, "mode", "topic", "Destination mode: topic, chat, or newChat")
	flags.StringVar(&workingCopyID, "working-copy", "", "Optional working copy ID")
	flags.StringVar(&scheduleTime, "time", "", "Schedule wall-clock time in HH:MM format")
	flags.StringVar(&timezone, "timezone", "", "IANA timezone (defaults to local timezone)")
	flags.StringVar(&weekdaysRaw, "weekdays", "", "Comma-separated weekdays (0-6 or sun,mon,tue,wed,thu,fri,sat)")
	flags.IntVar(&dayOfMonth, "day-of-month", 0, "Day of month (1-31) for monthly schedule")
	flags.StringVar(&dateStr, "date", "", "One-time date YYYY-MM-DD")
	flags.IntVar(&intervalMinutes, "interval", 0, "Fixed interval in minutes")
	flags.BoolVar(&eventTrigger, "event", false, "Create as webhook/CLI event-triggered automation")
	flags.IntVar(&batchSize, "batch-size", 1, "Event batch size (1-50)")
	flags.StringVar(&notifyPolicy, "notify", "", "Notification policy: always, actionable, or silent")
	flags.StringVar(&deliveryMode, "delivery", "", "Delivery mode: deliver, audit, propose, or curate")
	flags.Var(&workItem, "work-item", "Track run as a Board work item (true/false)")
	sel.register(flags)
	if err := parseFlags(flags, args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return nil
		}
		return err
	}
	if updating {
		if id = strings.TrimSpace(id); id == "" {
			return errors.New("--id is required")
		}
	}

	var input model.AutomationInput
	if strings.TrimSpace(jsonRaw) != "" {
		if err := readJSONArg(jsonRaw, in, 2<<20, &input); err != nil {
			return err
		}
	} else {
		setFlags := map[string]bool{}
		flags.Visit(func(f *flag.Flag) { setFlags[f.Name] = true })
		if updating {
			var current model.Automation
			if err := requestDecode(context.Background(), dataDir, http.MethodGet, "/automations/"+url.PathEscape(id), token, nil, nil, 10*time.Second, &current); err != nil {
				return err
			}
			input = current.AutomationInput
		} else {
			input.Destination.Mode = "topic"
		}
		if setFlags["name"] {
			input.Name = name
		}
		if setFlags["prompt-file"] {
			data, err := os.ReadFile(strings.TrimSpace(promptFile))
			if err != nil {
				return err
			}
			input.Prompt = string(data)
		} else if setFlags["prompt"] {
			input.Prompt = prompt
		}
		if setFlags["agent"] {
			input.Destination.AgentID = strings.TrimSpace(agentID)
		}
		if setFlags["chat"] {
			input.Destination.ChatID = strings.TrimSpace(chatID)
		}
		if setFlags["mode"] {
			input.Destination.Mode = strings.TrimSpace(destMode)
		}
		if setFlags["working-copy"] {
			input.Destination.WorkingCopyID = strings.TrimSpace(workingCopyID)
		}
		if setFlags["notify"] {
			input.NotifyPolicy = strings.TrimSpace(notifyPolicy)
			input.Quiet = input.NotifyPolicy == "silent"
		}
		if setFlags["delivery"] {
			input.DeliveryMode = strings.TrimSpace(deliveryMode)
		}
		if workItem.set {
			v := workItem.value
			input.WorkItem = &v
		}
		if clearSelection {
			input.Selection = nil
		} else if s := sel.toSelection(); s != nil {
			if input.Selection == nil {
				input.Selection = s
			} else {
				merged := *input.Selection
				if setFlags["provider"] {
					merged.Provider = s.Provider
				}
				if setFlags["model"] {
					merged.Model = s.Model
				}
				if setFlags["effort"] {
					merged.Effort = s.Effort
				}
				if setFlags["permission"] {
					merged.Permission = s.Permission
				}
				if sel.fast.set {
					merged.Fast = sel.fast.value
				}
				input.Selection = &merged
			}
		}

		scheduleFlagSet := setFlags["time"] || setFlags["timezone"] || setFlags["weekdays"] || setFlags["day-of-month"] || setFlags["date"] || setFlags["interval"]
		if setFlags["event"] && eventTrigger {
			input.Trigger = model.AutomationTrigger{Kind: "event", BatchSize: batchSize}
		} else if !updating || scheduleFlagSet {
			sched := &model.AutomationSchedule{}
			if updating && input.Trigger.Kind == "schedule" && input.Trigger.Schedule != nil {
				copied := *input.Trigger.Schedule
				sched = &copied
			}
			if setFlags["interval"] && intervalMinutes > 0 {
				sched = &model.AutomationSchedule{IntervalMinutes: intervalMinutes}
			} else {
				if setFlags["time"] {
					sched.Time = strings.TrimSpace(scheduleTime)
				}
				if setFlags["timezone"] {
					sched.Timezone = strings.TrimSpace(timezone)
				} else if sched.Timezone == "" && sched.IntervalMinutes == 0 {
					sched.Timezone = detectLocalTimezone()
				}
				if setFlags["weekdays"] {
					days, err := parseWeekdaysFlag(weekdaysRaw)
					if err != nil {
						return err
					}
					sched.Weekdays = days
				}
				if setFlags["day-of-month"] {
					sched.DayOfMonth = dayOfMonth
				}
				if setFlags["date"] {
					sched.Date = strings.TrimSpace(dateStr)
				}
			}
			input.Trigger = model.AutomationTrigger{Kind: "schedule", Schedule: sched}
		} else if setFlags["batch-size"] && input.Trigger.Kind == "event" {
			input.Trigger.BatchSize = batchSize
		}
	}

	method, path := http.MethodPost, "/automations"
	if updating {
		method, path = http.MethodPut, "/automations/"+url.PathEscape(id)
	}
	var saved model.Automation
	if err := requestDecode(context.Background(), dataDir, method, path, token, nil, input, 10*time.Second, &saved); err != nil {
		return err
	}
	if !updating && paused {
		if err := requestDecode(context.Background(), dataDir, http.MethodPatch, "/automations/"+url.PathEscape(saved.ID), token, nil, map[string]bool{"enabled": false}, 10*time.Second, nil); err != nil {
			return err
		}
		saved.Enabled = false
		saved.NextAt = 0
	}
	return json.NewEncoder(out).Encode(saved)
}

func parseWeekdaysFlag(raw string) ([]int, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil, nil
	}
	names := map[string]int{
		"0": 0, "su": 0, "sun": 0, "sunday": 0,
		"1": 1, "mo": 1, "mon": 1, "monday": 1,
		"2": 2, "tu": 2, "tue": 2, "tuesday": 2,
		"3": 3, "we": 3, "wed": 3, "wednesday": 3,
		"4": 4, "th": 4, "thu": 4, "thursday": 4,
		"5": 5, "fr": 5, "fri": 5, "friday": 5,
		"6": 6, "sa": 6, "sat": 6, "saturday": 6,
	}
	var out []int
	for _, part := range strings.Split(raw, ",") {
		k := strings.ToLower(strings.TrimSpace(part))
		if k == "" {
			continue
		}
		day, ok := names[k]
		if !ok {
			return nil, fmt.Errorf("invalid weekday %q", part)
		}
		out = append(out, day)
	}
	return out, nil
}

func detectLocalTimezone() string {
	if tz := strings.TrimSpace(os.Getenv("TZ")); tz != "" && tz != "Local" {
		if _, err := time.LoadLocation(tz); err == nil {
			return tz
		}
	}
	if target, err := filepath.EvalSymlinks("/etc/localtime"); err == nil {
		if _, after, ok := strings.Cut(filepath.ToSlash(target), "zoneinfo/"); ok && after != "" {
			if _, err := time.LoadLocation(after); err == nil {
				return after
			}
		}
	}
	return "UTC"
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

type codexAutomationFile struct {
	ID                 string   `json:"id"`
	Kind               string   `json:"kind"`
	Name               string   `json:"name"`
	Prompt             string   `json:"prompt"`
	Status             string   `json:"status"`
	RRule              string   `json:"rrule"`
	Model              string   `json:"model"`
	ReasoningEffort    string   `json:"reasoningEffort"`
	NotificationPolicy string   `json:"notificationPolicy"`
	TargetThreadID     string   `json:"targetThreadId"`
	CWDs               []string `json:"cwds"`
	Dir                string   `json:"dir"`
	HasMemory          bool     `json:"hasMemory"`
}

func parseCodexAutomationTOML(path string) (codexAutomationFile, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return codexAutomationFile{}, err
	}
	rec := codexAutomationFile{
		Dir: filepath.Dir(path),
		ID:  filepath.Base(filepath.Dir(path)),
	}
	if _, err := os.Stat(filepath.Join(rec.Dir, "memory.md")); err == nil {
		rec.HasMemory = true
	}
	lines := strings.Split(string(raw), "\n")
	for i := 0; i < len(lines); i++ {
		line := strings.TrimSpace(lines[i])
		if line == "" || strings.HasPrefix(line, "#") || strings.HasPrefix(line, "[") {
			continue
		}
		key, val, ok := strings.Cut(line, "=")
		if !ok {
			continue
		}
		key = strings.TrimSpace(key)
		val = strings.TrimSpace(val)
		if strings.HasPrefix(val, `"""`) {
			rest := strings.TrimPrefix(val, `"""`)
			var buf strings.Builder
			if before, closed := strings.CutSuffix(rest, `"""`); closed && len(rest) >= 3 {
				buf.WriteString(before)
			} else {
				if rest != "" {
					buf.WriteString(rest)
					buf.WriteByte('\n')
				}
				for i+1 < len(lines) {
					i++
					if before, _, found := strings.Cut(lines[i], `"""`); found {
						buf.WriteString(before)
						break
					}
					buf.WriteString(lines[i])
					buf.WriteByte('\n')
				}
			}
			val = buf.String()
			assignCodexField(&rec, key, val)
			continue
		}
		if strings.HasPrefix(val, "[") {
			for !strings.Contains(val, "]") && i+1 < len(lines) {
				i++
				val += " " + strings.TrimSpace(lines[i])
			}
			if key == "cwds" {
				var cwds []string
				if err := json.Unmarshal([]byte(val), &cwds); err == nil {
					rec.CWDs = cwds
				}
			}
			continue
		}
		if strings.HasPrefix(val, `"`) {
			var decoded string
			if err := json.Unmarshal([]byte(val), &decoded); err == nil {
				assignCodexField(&rec, key, decoded)
			}
			continue
		}
		if strings.HasPrefix(val, "'") && strings.HasSuffix(val, "'") && len(val) >= 2 {
			assignCodexField(&rec, key, val[1:len(val)-1])
		}
	}
	return rec, nil
}

func assignCodexField(rec *codexAutomationFile, key, val string) {
	switch key {
	case "id":
		rec.ID = val
	case "kind":
		rec.Kind = val
	case "name":
		rec.Name = val
	case "prompt":
		rec.Prompt = val
	case "status":
		rec.Status = val
	case "rrule":
		rec.RRule = val
	case "model":
		rec.Model = val
	case "reasoning_effort":
		rec.ReasoningEffort = val
	case "notification_policy":
		rec.NotificationPolicy = val
	case "target_thread_id":
		rec.TargetThreadID = val
	}
}

func parseCodexRRule(rrule, timezone string) (*model.AutomationSchedule, error) {
	rule := strings.TrimSpace(rrule)
	rule = strings.TrimPrefix(rule, "RRULE:")
	if rule == "" {
		return nil, errors.New("missing rrule")
	}
	parts := map[string]string{}
	for _, token := range strings.Split(rule, ";") {
		k, v, ok := strings.Cut(strings.TrimSpace(token), "=")
		if ok {
			parts[strings.ToUpper(strings.TrimSpace(k))] = strings.TrimSpace(v)
		}
	}
	freq := strings.ToUpper(parts["FREQ"])
	interval := 1
	if raw := parts["INTERVAL"]; raw != "" {
		if n, err := strconv.Atoi(raw); err == nil && n > 0 {
			interval = n
		}
	}
	switch freq {
	case "MINUTELY":
		return &model.AutomationSchedule{IntervalMinutes: interval}, nil
	case "HOURLY":
		return &model.AutomationSchedule{IntervalMinutes: interval * 60}, nil
	case "DAILY", "WEEKLY", "MONTHLY":
		hour := 9
		minute := 0
		if raw := parts["BYHOUR"]; raw != "" {
			if h, err := strconv.Atoi(strings.Split(raw, ",")[0]); err == nil && h >= 0 && h <= 23 {
				hour = h
			}
		}
		if raw := parts["BYMINUTE"]; raw != "" {
			if m, err := strconv.Atoi(strings.Split(raw, ",")[0]); err == nil && m >= 0 && m <= 59 {
				minute = m
			}
		}
		sched := &model.AutomationSchedule{
			Time:     fmt.Sprintf("%02d:%02d", hour, minute),
			Timezone: timezone,
		}
		if freq == "WEEKLY" && parts["BYDAY"] != "" {
			days, err := parseWeekdaysFlag(parts["BYDAY"])
			if err != nil {
				return nil, err
			}
			slices.Sort(days)
			days = slices.Compact(days)
			if len(days) > 0 && len(days) < 7 {
				sched.Weekdays = days
			}
		}
		if freq == "MONTHLY" && parts["BYMONTHDAY"] != "" {
			if d, err := strconv.Atoi(strings.Split(parts["BYMONTHDAY"], ",")[0]); err == nil && d >= 1 && d <= 31 {
				sched.DayOfMonth = d
			}
		}
		return sched, nil
	default:
		return nil, fmt.Errorf("unsupported RRULE frequency %q", freq)
	}
}

func truncateRunes(s string, maxRunes int) (string, bool) {
	s = strings.TrimSpace(s)
	if utf8.RuneCountInString(s) <= maxRunes {
		return s, false
	}
	runes := []rune(s)
	return strings.TrimSpace(string(runes[:maxRunes])), true
}

func resolveCanonicalPath(p string) string {
	p = filepath.Clean(p)
	if resolved, err := filepath.EvalSymlinks(p); err == nil {
		return resolved
	}
	dir := filepath.Dir(p)
	if dir != p {
		if resolved, err := filepath.EvalSymlinks(dir); err == nil {
			return filepath.Join(resolved, filepath.Base(p))
		}
	}
	return p
}

func cleanPathList(paths []string) []string {
	out := make([]string, 0, len(paths))
	for _, p := range paths {
		p = strings.TrimSpace(p)
		if p == "" {
			continue
		}
		p = resolveCanonicalPath(p)
		if !slices.Contains(out, p) {
			out = append(out, p)
		}
	}
	return out
}

func matchLeverAgentForCWDs(agents []model.Agent, cwds []string, preferredProvider string) (*model.Agent, string) {
	want := cleanPathList(cwds)
	if len(want) == 0 {
		return nil, ""
	}
	type candidate struct {
		agent model.Agent
		score int
		note  string
	}
	var best *candidate
	for _, ag := range agents {
		if ag.Archived {
			continue
		}
		roots := make([]string, 0, len(ag.Profile.Roots))
		for _, r := range ag.Profile.Roots {
			roots = append(roots, r.Path)
		}
		have := cleanPathList(roots)
		covered := 0
		for _, w := range want {
			if slices.Contains(have, w) {
				covered++
			}
		}
		if covered == len(want) {
			extra := len(have) - len(want)
			score := 1000 - extra*10
			if ag.Profile.Provider == preferredProvider {
				score += 50
			}
			note := "exact_roots"
			if extra > 0 {
				note = "superset_roots"
			}
			if best == nil || score > best.score {
				c := candidate{agent: ag, score: score, note: note}
				best = &c
			}
			continue
		}
		// Fallback: every wanted cwd is inside at least one agent root.
		inside := 0
		for _, w := range want {
			for _, h := range have {
				if w == h || strings.HasPrefix(w, h+string(filepath.Separator)) {
					inside++
					break
				}
			}
		}
		if inside == len(want) {
			score := 400 - len(have)*5
			if ag.Profile.Provider == preferredProvider {
				score += 50
			}
			if best == nil || score > best.score {
				c := candidate{agent: ag, score: score, note: "parent_root"}
				best = &c
			}
		}
	}
	if best == nil {
		return nil, ""
	}
	return &best.agent, best.note
}

type codexImportItem struct {
	CodexID      string                 `json:"codexId"`
	Name         string                 `json:"name"`
	Action       string                 `json:"action"` // imported, planned, skipped, needs_agent, error
	AutomationID string                 `json:"automationId,omitempty"`
	AgentID      string                 `json:"agentId,omitempty"`
	AgentName    string                 `json:"agentName,omitempty"`
	AgentMatch   string                 `json:"agentMatch,omitempty"`
	CreatedAgent bool                   `json:"createdAgent,omitempty"`
	Paused       bool                   `json:"paused,omitempty"`
	Input        *model.AutomationInput `json:"input,omitempty"`
	Warnings     []string               `json:"warnings,omitempty"`
	Error        string                 `json:"error,omitempty"`
}

func runImportCodexAutomations(args []string, dataDir string, out, errOut io.Writer, token string) error {
	flags := flag.NewFlagSet("lever automations import-codex", flag.ContinueOnError)
	flags.SetOutput(errOut)
	flags.StringVar(&dataDir, "data-dir", dataDir, "Lever data directory (or LEVER_DATA_DIR)")
	var dir, agentOverride, providerID, permission, timezone, destMode string
	var ids stringList
	var dryRun, createMissingAgents, includePaused, force bool
	flags.StringVar(&dir, "dir", "", "Codex automations directory (default ~/.codex/automations)")
	flags.Var(&ids, "id", "Import only the specified Codex automation ID (repeatable)")
	flags.StringVar(&agentOverride, "agent", "", "Override or fallback Lever Agent ID")
	flags.StringVar(&providerID, "provider", "codex", "Lever Provider ID for imported automations")
	flags.StringVar(&permission, "permission", "", "Optional task-level permission override (e.g. auto_review, full_access)")
	flags.StringVar(&timezone, "timezone", "", "IANA timezone for calendar schedules (default local timezone)")
	flags.StringVar(&destMode, "mode", "topic", "Destination mode: topic, chat, or newChat")
	flags.BoolVar(&createMissingAgents, "create-missing-agents", false, "Create new Lever Agents for unmatched non-empty cwds")
	flags.BoolVar(&includePaused, "include-paused", true, "Also import PAUSED Codex automations (kept paused in Lever)")
	flags.BoolVar(&dryRun, "dry-run", false, "Preview migration plan without creating Agents or Automations")
	flags.BoolVar(&force, "force", false, "Import even if a Lever automation with the same name already exists")
	if err := parseFlags(flags, args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return nil
		}
		return err
	}
	if strings.TrimSpace(dir) == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return err
		}
		dir = filepath.Join(home, ".codex", "automations")
	}
	if strings.TrimSpace(timezone) == "" {
		timezone = detectLocalTimezone()
	}
	providerID = strings.TrimSpace(providerID)
	permission = strings.TrimSpace(permission)
	agentOverride = strings.TrimSpace(agentOverride)

	entries, err := os.ReadDir(dir)
	if err != nil {
		return fmt.Errorf("read Codex automations directory %q: %w", dir, err)
	}
	var records []codexAutomationFile
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		tomlPath := filepath.Join(dir, entry.Name(), "automation.toml")
		if _, err := os.Stat(tomlPath); err != nil {
			continue
		}
		rec, err := parseCodexAutomationTOML(tomlPath)
		if err != nil {
			return fmt.Errorf("parse %s: %w", tomlPath, err)
		}
		if len(ids) > 0 && !slices.Contains(ids, rec.ID) && !slices.Contains(ids, entry.Name()) {
			continue
		}
		records = append(records, rec)
	}
	if len(records) == 0 {
		return errors.New("no matching Codex automation.toml files found")
	}

	var agents []model.Agent
	if err := requestDecode(context.Background(), dataDir, http.MethodGet, "/agents?full=true", token, nil, nil, 10*time.Second, &agents); err != nil {
		return err
	}
	var existingPlans []model.Automation
	if err := requestDecode(context.Background(), dataDir, http.MethodGet, "/automations?full=true", token, nil, nil, 10*time.Second, &existingPlans); err != nil {
		return err
	}
	existingNames := map[string]string{}
	for _, p := range existingPlans {
		existingNames[strings.ToLower(strings.TrimSpace(p.Name))] = p.ID
	}

	var overrideAgent *model.Agent
	if agentOverride != "" {
		for i := range agents {
			if agents[i].ID == agentOverride {
				overrideAgent = &agents[i]
				break
			}
		}
		if overrideAgent == nil {
			return fmt.Errorf("agent %q not found in Lever", agentOverride)
		}
	}

	results := make([]codexImportItem, 0, len(records))
	for _, rec := range records {
		item := codexImportItem{CodexID: rec.ID, Paused: strings.EqualFold(rec.Status, "PAUSED")}
		name, truncated := truncateRunes(rec.Name, 80)
		if name == "" {
			name = rec.ID
		}
		item.Name = name
		if truncated {
			item.Warnings = append(item.Warnings, "Codex name exceeded 80 characters and was truncated")
		}
		if rec.HasMemory {
			item.Warnings = append(item.Warnings, fmt.Sprintf("Codex memory.md exists at %s; reference it in the prompt if you want cross-run memory", filepath.Join(rec.Dir, "memory.md")))
		}
		if rec.Kind == "heartbeat" || rec.TargetThreadID != "" {
			item.Warnings = append(item.Warnings, "Codex heartbeat/thread-bound automation will run as a scheduled Lever automation")
		}
		if item.Paused && !includePaused {
			item.Action = "skipped"
			item.Warnings = append(item.Warnings, "Skipped because status is PAUSED (--include-paused=false)")
			results = append(results, item)
			continue
		}
		if existingID, dup := existingNames[strings.ToLower(name)]; dup && !force {
			item.Action = "skipped"
			item.AutomationID = existingID
			item.Warnings = append(item.Warnings, "Skipped because a Lever automation with the same name already exists (pass --force to import anyway)")
			results = append(results, item)
			continue
		}
		sched, err := parseCodexRRule(rec.RRule, timezone)
		if err != nil {
			item.Action = "error"
			item.Error = err.Error()
			results = append(results, item)
			continue
		}

		var targetAgent *model.Agent
		matchReason := ""
		if len(ids) > 0 && overrideAgent != nil {
			targetAgent = overrideAgent
			matchReason = "override"
		} else if len(rec.CWDs) > 0 {
			targetAgent, matchReason = matchLeverAgentForCWDs(agents, rec.CWDs, providerID)
			if targetAgent == nil && overrideAgent != nil {
				targetAgent = overrideAgent
				matchReason = "fallback_override"
			}
		} else if overrideAgent != nil {
			targetAgent = overrideAgent
			matchReason = "override"
		}

		if targetAgent == nil {
			if len(rec.CWDs) == 0 {
				item.Action = "needs_agent"
				item.Warnings = append(item.Warnings, "Codex task has no cwds; pass --agent <id> to select a Lever Agent")
				results = append(results, item)
				continue
			}
			if !createMissingAgents {
				item.Action = "needs_agent"
				item.Warnings = append(item.Warnings, fmt.Sprintf("No existing Lever Agent covers cwds %v; pass --create-missing-agents or --agent <id>", rec.CWDs))
				results = append(results, item)
				continue
			}
			agentPerm := permission
			if agentPerm == "" {
				agentPerm = "auto_review"
			}
			roots := make([]model.Root, 0, len(rec.CWDs))
			for _, cwd := range rec.CWDs {
				roots = append(roots, model.Root{Path: cwd})
			}
			agentName := filepath.Base(rec.CWDs[0])
			if agentName == "" || agentName == "." || agentName == "/" {
				agentName = name
			}
			newAgent := model.Agent{
				Name: agentName,
				Profile: model.Profile{
					Scope:       model.Scope{Roots: roots},
					Provider:    providerID,
					Model:       rec.Model,
					Permission:  agentPerm,
					Skills:      []string{},
					Delegations: []model.DelegationRule{},
				},
			}
			if dryRun {
				item.AgentName = agentName + " (will create)"
				item.AgentMatch = "create_missing"
				item.CreatedAgent = true
			} else {
				var created model.Agent
				if err := requestDecode(context.Background(), dataDir, http.MethodPost, "/agents", token, nil, newAgent, 10*time.Second, &created); err != nil {
					item.Action = "error"
					item.Error = "create agent: " + err.Error()
					results = append(results, item)
					continue
				}
				agents = append(agents, created)
				targetAgent = &agents[len(agents)-1]
				matchReason = "created"
				item.CreatedAgent = true
			}
		}

		var sel *model.Selection
		if rec.Model != "" || rec.ReasoningEffort != "" || permission != "" || (targetAgent != nil && targetAgent.Profile.Provider != providerID) {
			sel = &model.Selection{
				Provider:   providerID,
				Model:      rec.Model,
				Effort:     rec.ReasoningEffort,
				Permission: permission,
			}
		}
		if targetAgent != nil {
			item.AgentID = targetAgent.ID
			item.AgentName = targetAgent.Name
			item.AgentMatch = matchReason
			effectivePerm := permission
			if effectivePerm == "" && (sel == nil || sel.Provider == "" || sel.Provider == targetAgent.Profile.Provider) {
				effectivePerm = targetAgent.Profile.Permission
			}
			if effectivePerm == "ask" {
				item.Warnings = append(item.Warnings, "Effective permission is ask (unattended runs will pause for approval); pass --permission auto_review or --permission full_access, or switch in Lever UI")
			}
		}

		notify := "always"
		quiet := false
		if strings.EqualFold(rec.NotificationPolicy, "failed_runs_only") {
			notify = "silent"
			quiet = true
		}
		workItemFalse := false
		autoInput := model.AutomationInput{
			Name:   name,
			Prompt: rec.Prompt,
			Trigger: model.AutomationTrigger{
				Kind:     "schedule",
				Schedule: sched,
			},
			Destination: model.AutomationDestination{
				Mode:    destMode,
				AgentID: item.AgentID,
			},
			Selection:    sel,
			NotifyPolicy: notify,
			DeliveryMode: "deliver",
			WorkItem:     &workItemFalse,
			Quiet:        quiet,
		}
		item.Input = &autoInput
		if dryRun {
			item.Action = "planned"
			results = append(results, item)
			continue
		}
		var saved model.Automation
		if err := requestDecode(context.Background(), dataDir, http.MethodPost, "/automations", token, nil, autoInput, 10*time.Second, &saved); err != nil {
			item.Action = "error"
			item.Error = err.Error()
			results = append(results, item)
			continue
		}
		if item.Paused {
			if err := requestDecode(context.Background(), dataDir, http.MethodPatch, "/automations/"+url.PathEscape(saved.ID), token, nil, map[string]bool{"enabled": false}, 10*time.Second, nil); err != nil {
				item.Warnings = append(item.Warnings, "created but failed to pause: "+err.Error())
			}
		}
		item.Action = "imported"
		item.AutomationID = saved.ID
		existingNames[strings.ToLower(name)] = saved.ID
		results = append(results, item)
	}
	return json.NewEncoder(out).Encode(map[string]any{
		"dryRun": dryRun,
		"dir":    dir,
		"items":  results,
	})
}
