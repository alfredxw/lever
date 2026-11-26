package provider

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"math"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	"lever/internal/device"
	"lever/internal/model"
)

const (
	nativeUsageTimeout        = 20 * time.Second
	antigravityVersionTimeout = 10 * time.Second
	antigravityUsageTimeout   = 45 * time.Second
	codexRolloutTailBytes     = 256 << 10
	codexRolloutScanLimit     = 16
)

// ErrUsageUnsupported reports that this runtime or CLI version does not expose subscription usage.
var ErrUsageUnsupported = errors.New("runtime does not report subscription usage")

func reportsProtocolUsage(kind string) bool { return kind == "codex" || kind == "claude" }

func SupportsUsage(config model.Provider) bool {
	return reportsProtocolUsage(config.Type) || config.Type == "antigravity"
}

func supportsAntigravityUsage(version string) bool {
	// Before 1.1.11, print-mode /usage could fall through to an agent turn.
	return versionAtLeast(runtimeVersion(version), "1.1.11")
}

// Usage asks the configured CLI for the signed-in account's allowance without
// inspecting credentials or sending a prompt. Empty windows with a nil error
// mean the account has no subscription allowance; errors report probe failures.
func Usage(ctx context.Context, config model.Provider) ([]model.UsageWindow, error) {
	if !SupportsUsage(config) {
		return nil, ErrUsageUnsupported
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return nil, err
	}
	if config.Type == "antigravity" {
		return readAntigravityUsage(ctx, config, home)
	}
	d, err := openNativeClient(ctx, config, home, nil, nativeUsageTimeout)
	if err != nil {
		return nil, err
	}
	defer d.close()
	if config.Type == "codex" {
		if acct, err := d.call("account/read", object{"refreshToken": false}); err == nil {
			kind := str(obj(acct["account"])["type"])
			if acct["requiresOpenaiAuth"] == false || (acct["account"] == nil && acct["requiresOpenaiAuth"] == true) || (kind != "" && kind != "chatgpt") {
				return nil, nil
			}
		}
		result, err := d.call("account/rateLimits/read", nil)
		if err != nil {
			return nil, err
		}
		return codexUsage(result), nil
	}
	result, err := d.call("get_usage", object{})
	if err != nil {
		return nil, err
	}
	if result["rate_limits_available"] == true && obj(result["rate_limits"]) == nil {
		return nil, errors.New("Claude did not return a usage report")
	}
	return claudeUsage(result), nil
}

func readAntigravityUsage(ctx context.Context, config model.Provider, home string) ([]model.UsageWindow, error) {
	path, err := Executable(ctx, config)
	if err != nil {
		return nil, err
	}
	if !IsAntigravityCLI(config, path) {
		return nil, ErrUsageUnsupported
	}
	verCtx, verCancel := context.WithTimeout(ctx, antigravityVersionTimeout)
	version, err := profileOutput(verCtx, config, path, "--version")
	verCancel()
	if err != nil {
		return nil, errors.New("Could not check the agy version")
	}
	if !supportsAntigravityUsage(string(version)) {
		return nil, ErrUsageUnsupported
	}
	usageCtx, usageCancel := context.WithTimeout(ctx, antigravityUsageTimeout)
	defer usageCancel()
	cmd := device.Command(path, "--print", "/usage", "--output-format", "json")
	cmd.Dir = home
	// Keep /usage strictly non-interactive: agy treats os.DevNull (ModeCharDevice)
	// or an inherited CONIN$//dev/tty as a controlling terminal and opens a browser
	// OAuth login page whenever silent auth fails or times out during token refresh.
	cmd.Stdin = strings.NewReader("")
	device.Detach(cmd)
	cmd.Env = append(cmd.Env, "AGY_CLI_DISABLE_AUTO_UPDATE=true")
	data, err := device.OutputCommand(usageCtx, cmd)
	if err != nil {
		return nil, errors.New("agy could not read subscription usage")
	}
	result, err := decode(data)
	command := obj(result["command"])
	groups := arr(obj(command["data"])["groups"])
	if err != nil || result["status"] != "SUCCESS" || command["name"] != "usage" || groups == nil {
		return nil, errors.New("agy did not return a usage report")
	}
	var windows []model.UsageWindow
	seen := make(map[string]bool)
	for _, entry := range groups {
		group := obj(entry)
		name := strings.TrimSpace(str(group["name"]))
		for _, entry := range arr(group["buckets"]) {
			bucket := obj(entry)
			id := str(bucket["id"])
			remaining, ok := bucket["remaining_fraction"].(float64)
			if id == "" || seen[id] || !ok || remaining < 0 || remaining > 1 {
				continue
			}
			var minutes int
			switch bucket["window"] {
			case "5h":
				minutes = 5 * 60
			case "weekly":
				minutes = 7 * 24 * 60
			}
			seen[id] = true
			windows = append(windows, model.UsageWindow{
				ID: id, Group: name, Minutes: minutes,
				UsedPercent: (1 - remaining) * 100,
				ResetsAt:    usageISOTime(bucket["reset_time"]),
			})
		}
	}
	return windows, nil
}

// LiveUsageWindows drops windows whose reset timestamp has already passed.
func LiveUsageWindows(windows []model.UsageWindow, now time.Time) []model.UsageWindow {
	var live []model.UsageWindow
	for _, window := range windows {
		if window.ResetsAt != "" {
			if reset, err := time.Parse(time.RFC3339, window.ResetsAt); err == nil && !reset.After(now) {
				continue
			}
		}
		live = append(live, window)
	}
	return live
}

func codexUsage(result object) []model.UsageWindow {
	main := obj(obj(result["rateLimitsByLimitId"])["codex"])
	if main == nil {
		main = obj(result["rateLimits"])
		if id := str(main["limitId"]); id != "" && id != "codex" {
			return nil
		}
	}
	if main == nil {
		return nil
	}
	var windows []model.UsageWindow
	for _, id := range []string{"primary", "secondary"} {
		w := obj(main[id])
		if w == nil {
			continue
		}
		minutes, _ := w["windowDurationMins"].(float64)
		windows = appendUsage(windows, id, int(minutes), w["usedPercent"], usageUnixTime(w["resetsAt"]))
	}
	if limit := obj(main["individualLimit"]); limit != nil {
		if remaining, ok := limit["remainingPercent"].(float64); ok {
			windows = appendUsage(windows, "individual", 0, 100-remaining, usageUnixTime(limit["resetsAt"]))
		}
	}
	return windows
}

func claudeUsage(result object) []model.UsageWindow {
	if result["rate_limits_available"] != true {
		return nil
	}
	limits := obj(result["rate_limits"])
	fiveHour, weekly := obj(limits["five_hour"]), obj(limits["seven_day"])
	windows := appendUsage(nil, "five_hour", 5*60, fiveHour["utilization"], usageISOTime(fiveHour["resets_at"]))
	return appendUsage(windows, "seven_day", 7*24*60, weekly["utilization"], usageISOTime(weekly["resets_at"]))
}

// claudeRateLimitEvent parses Claude Code's stream-json rate_limit_event.
// Stream utilization is a 0..1 fraction (unlike get_usage, which reports 0..100).
func claudeRateLimitEvent(frame object) []model.UsageWindow {
	if str(frame["type"]) != "rate_limit_event" {
		return nil
	}
	info := obj(frame["rate_limit_info"])
	if info == nil {
		return nil
	}
	if unified := obj(info["unifiedWindows"]); unified != nil {
		var windows []model.UsageWindow
		for _, spec := range []struct {
			id      string
			minutes int
		}{{"five_hour", 5 * 60}, {"seven_day", 7 * 24 * 60}} {
			w := obj(unified[spec.id])
			if w == nil {
				continue
			}
			if ratio, ok := w["utilization"].(float64); ok {
				windows = appendUsage(windows, spec.id, spec.minutes, usageFractionPercent(ratio), usageAnyTime(w["resetsAt"]))
			}
		}
		if len(windows) > 0 {
			return windows
		}
	}
	if ratio, ok := info["utilization"].(float64); ok {
		switch str(info["rateLimitType"]) {
		case "five_hour":
			return appendUsage(nil, "five_hour", 5*60, usageFractionPercent(ratio), usageAnyTime(info["resetsAt"]))
		case "seven_day":
			return appendUsage(nil, "seven_day", 7*24*60, usageFractionPercent(ratio), usageAnyTime(info["resetsAt"]))
		}
	}
	return nil
}

// CodexRolloutUsage reads the newest live rate_limits sample from Codex session
// rollouts without inspecting credentials or launching a subprocess. Callers
// must skip this when the sessions directory is shared with another account.
func CodexRolloutUsage(config model.Provider, now time.Time, maxAge time.Duration) ([]model.UsageWindow, time.Time, bool) {
	if config.Type != "codex" || config.ShadowHome != "" {
		return nil, time.Time{}, false
	}
	home := ConfigurationDirectory(config)
	if home == "" {
		return nil, time.Time{}, false
	}
	paths, _ := filepath.Glob(filepath.Join(home, "sessions", "*", "*", "*", "rollout-*.jsonl"))
	if len(paths) == 0 {
		return nil, time.Time{}, false
	}
	type candidate struct {
		path    string
		modTime time.Time
	}
	files := make([]candidate, 0, len(paths))
	for _, path := range paths {
		info, err := os.Stat(path)
		if err != nil || info.IsDir() || now.Sub(info.ModTime()) > maxAge {
			continue
		}
		files = append(files, candidate{path: path, modTime: info.ModTime()})
	}
	sort.Slice(files, func(i, j int) bool {
		if files[i].modTime.Equal(files[j].modTime) {
			return files[i].path > files[j].path
		}
		return files[i].modTime.After(files[j].modTime)
	})
	var best []model.UsageWindow
	var bestAt time.Time
	for i, file := range files {
		if i >= codexRolloutScanLimit {
			break
		}
		if !bestAt.IsZero() && !file.modTime.After(bestAt) {
			break
		}
		windows, at, ok := lastCodexRolloutUsage(file.path, now, maxAge)
		if ok && at.After(bestAt) {
			best, bestAt = windows, at
		}
	}
	return best, bestAt, len(best) > 0
}

func lastCodexRolloutUsage(path string, now time.Time, maxAge time.Duration) ([]model.UsageWindow, time.Time, bool) {
	f, err := os.Open(path)
	if err != nil {
		return nil, time.Time{}, false
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil || st.Size() == 0 {
		return nil, time.Time{}, false
	}
	offset := int64(0)
	if st.Size() > codexRolloutTailBytes {
		offset = st.Size() - codexRolloutTailBytes
	}
	buf := make([]byte, st.Size()-offset)
	n, err := f.ReadAt(buf, offset)
	if err != nil && !errors.Is(err, io.EOF) {
		return nil, time.Time{}, false
	}
	buf = buf[:n]
	if offset > 0 {
		i := bytes.IndexByte(buf, '\n')
		if i < 0 {
			return nil, time.Time{}, false
		}
		buf = buf[i+1:]
	}
	for end := len(buf); end > 0; {
		start := bytes.LastIndexByte(buf[:end], '\n') + 1
		if windows, at, ok := parseCodexRolloutRateLimits(buf[start:end], now, maxAge); ok {
			return windows, at, true
		}
		end = start - 1
	}
	return nil, time.Time{}, false
}

type codexRolloutWindow struct {
	UsedPercent   *float64 `json:"used_percent"`
	WindowMinutes *int     `json:"window_minutes"`
	ResetsAt      *float64 `json:"resets_at"`
}

func parseCodexRolloutRateLimits(line []byte, now time.Time, maxAge time.Duration) ([]model.UsageWindow, time.Time, bool) {
	if !bytes.Contains(line, []byte(`"rate_limits"`)) {
		return nil, time.Time{}, false
	}
	var entry struct {
		Timestamp string `json:"timestamp"`
		Payload   struct {
			Type       string `json:"type"`
			RateLimits *struct {
				LimitID         *string             `json:"limit_id"`
				Primary         *codexRolloutWindow `json:"primary"`
				Secondary       *codexRolloutWindow `json:"secondary"`
				IndividualLimit *struct {
					RemainingPercent *float64 `json:"remaining_percent"`
					ResetsAt         *float64 `json:"resets_at"`
				} `json:"individual_limit"`
			} `json:"rate_limits"`
		} `json:"payload"`
	}
	if json.Unmarshal(line, &entry) != nil || entry.Payload.Type != "token_count" || entry.Payload.RateLimits == nil {
		return nil, time.Time{}, false
	}
	rl := entry.Payload.RateLimits
	if rl.LimitID != nil && *rl.LimitID != "" && *rl.LimitID != "codex" {
		return nil, time.Time{}, false
	}
	at, err := time.Parse(time.RFC3339Nano, entry.Timestamp)
	if err != nil || now.Sub(at) > maxAge {
		return nil, time.Time{}, false
	}
	var windows []model.UsageWindow
	for _, item := range []struct {
		id string
		w  *codexRolloutWindow
	}{{"primary", rl.Primary}, {"secondary", rl.Secondary}} {
		if item.w == nil || item.w.UsedPercent == nil {
			continue
		}
		minutes := 0
		if item.w.WindowMinutes != nil {
			minutes = *item.w.WindowMinutes
		}
		var reset string
		if item.w.ResetsAt != nil {
			reset = usageUnixTime(*item.w.ResetsAt)
		}
		windows = appendUsage(windows, item.id, minutes, *item.w.UsedPercent, reset)
	}
	if limit := rl.IndividualLimit; limit != nil && limit.RemainingPercent != nil {
		var reset string
		if limit.ResetsAt != nil {
			reset = usageUnixTime(*limit.ResetsAt)
		}
		windows = appendUsage(windows, "individual", 0, 100-*limit.RemainingPercent, reset)
	}
	windows = LiveUsageWindows(windows, now)
	if len(windows) == 0 {
		return nil, time.Time{}, false
	}
	return windows, at.UTC(), true
}

func usageFractionPercent(ratio float64) float64 {
	if math.IsNaN(ratio) || math.IsInf(ratio, 0) {
		return ratio
	}
	return math.Round(ratio*100*1e9) / 1e9
}

func appendUsage(windows []model.UsageWindow, id string, minutes int, value any, reset string) []model.UsageWindow {
	used, ok := value.(float64)
	if !ok || math.IsNaN(used) || math.IsInf(used, 0) {
		return windows
	}
	return append(windows, model.UsageWindow{ID: id, Minutes: max(0, minutes), UsedPercent: min(100, max(0, used)), ResetsAt: reset})
}

func usageUnixTime(value any) string {
	if seconds, ok := value.(float64); ok && seconds > 0 && seconds < 253402300800 {
		return time.Unix(int64(seconds), 0).UTC().Format(time.RFC3339)
	}
	return ""
}

func usageISOTime(value any) string {
	if reset, err := time.Parse(time.RFC3339Nano, strings.TrimSpace(str(value))); err == nil {
		return reset.UTC().Format(time.RFC3339)
	}
	return ""
}

func usageAnyTime(value any) string {
	switch v := value.(type) {
	case float64:
		if math.IsNaN(v) || math.IsInf(v, 0) || v <= 0 {
			return ""
		}
		if v >= 1e12 {
			ms := int64(v)
			if ms/1000 < 253402300800 {
				return time.UnixMilli(ms).UTC().Format(time.RFC3339)
			}
			return ""
		}
		return usageUnixTime(v)
	case string:
		if iso := usageISOTime(v); iso != "" {
			return iso
		}
		if num, err := strconv.ParseFloat(strings.TrimSpace(v), 64); err == nil {
			return usageAnyTime(num)
		}
	}
	return ""
}
