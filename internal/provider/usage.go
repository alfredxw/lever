package provider

import (
	"context"
	"errors"
	"math"
	"os"
	"strings"
	"time"

	"lever/internal/device"
	"lever/internal/model"
)

func reportsProtocolUsage(kind string) bool { return kind == "codex" || kind == "claude" }

func supportsAntigravityUsage(version string) bool {
	// Before 1.1.11, print-mode /usage could fall through to an agent turn.
	return versionAtLeast(runtimeVersion(version), "1.1.11")
}

// Usage asks the configured CLI for the signed-in account's allowance without
// inspecting credentials or sending a prompt. No windows means no readable usage.
func Usage(ctx context.Context, config model.Provider) ([]model.UsageWindow, error) {
	if !reportsProtocolUsage(config.Type) && config.Type != "antigravity" {
		return nil, nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return nil, err
	}
	if config.Type == "antigravity" {
		return readAntigravityUsage(ctx, config, home)
	}
	d, err := openDiscovery(ctx, config, home, nil)
	if err != nil {
		return nil, nil
	}
	defer d.close()
	if config.Type == "codex" {
		result, err := d.call("account/rateLimits/read", nil)
		if err == nil {
			return codexUsage(result), nil
		}
	} else {
		result, err := d.call("get_usage", object{})
		if err == nil {
			return claudeUsage(result), nil
		}
	}
	return nil, nil
}

func readAntigravityUsage(ctx context.Context, config model.Provider, home string) ([]model.UsageWindow, error) {
	path, err := Executable(ctx, config)
	if err != nil {
		return nil, err
	}
	if !IsAntigravityCLI(config, path) {
		return nil, nil
	}
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	version, err := profileOutput(ctx, config, path, "--version")
	if err != nil {
		return nil, errors.New("Could not check the agy version")
	}
	if !supportsAntigravityUsage(string(version)) {
		return nil, nil
	}
	cmd := device.Command(path, "--print", "/usage", "--output-format", "json")
	cmd.Dir = home
	cmd.Env = append(cmd.Env, "AGY_CLI_DISABLE_AUTO_UPDATE=true")
	data, err := device.OutputCommand(ctx, cmd)
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

func codexUsage(result object) []model.UsageWindow {
	main := obj(obj(result["rateLimitsByLimitId"])["codex"])
	if main == nil {
		main = obj(result["rateLimits"])
		if id := str(main["limitId"]); id != "" && id != "codex" {
			return nil
		}
	}
	var windows []model.UsageWindow
	for _, id := range []string{"primary", "secondary"} {
		w := obj(main[id])
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
	if reset, err := time.Parse(time.RFC3339, str(value)); err == nil {
		return reset.UTC().Format(time.RFC3339)
	}
	return ""
}
