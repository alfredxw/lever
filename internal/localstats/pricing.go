package localstats

import (
	"math"
	"regexp"
	"strings"

	"lever/internal/model"
)

// ModelRate defines USD cost per 1,000,000 tokens for each channel.
type ModelRate struct {
	Input      float64
	Output     float64
	CacheRead  float64
	CacheWrite float64
	Cache1h    float64
}

var (
	dateSuffixRe   = regexp.MustCompile(`-(?:20\d{6}|20\d{2}-\d{2}-\d{2}|v\d+:\d+)$`)
	effortSuffixRe = regexp.MustCompile(`-(?:extra-low|low|medium|high|xhigh|max|tiered|control|thinking|agent|orchestrator|trial|preview|latest)$`)
)

type rateRule struct {
	prefix string
	rate   ModelRate
}

// Built-in API-equivalent reference pricing (USD per 1M tokens).
// Order matters: more specific prefixes come first.
var rateRules = []rateRule{
	// Anthropic Claude 4.x / 3.x
	{"claude-opus-4-6", ModelRate{Input: 5.0, Output: 25.0, CacheRead: 0.5, CacheWrite: 6.25, Cache1h: 10.0}},
	{"claude-opus-4-5", ModelRate{Input: 5.0, Output: 25.0, CacheRead: 0.5, CacheWrite: 6.25, Cache1h: 10.0}},
	{"claude-opus-4", ModelRate{Input: 15.0, Output: 75.0, CacheRead: 1.5, CacheWrite: 18.75, Cache1h: 30.0}},
	{"claude-sonnet-4", ModelRate{Input: 3.0, Output: 15.0, CacheRead: 0.3, CacheWrite: 3.75, Cache1h: 6.0}},
	{"claude-3-7-sonnet", ModelRate{Input: 3.0, Output: 15.0, CacheRead: 0.3, CacheWrite: 3.75, Cache1h: 6.0}},
	{"claude-3-5-sonnet", ModelRate{Input: 3.0, Output: 15.0, CacheRead: 0.3, CacheWrite: 3.75, Cache1h: 6.0}},
	{"claude-haiku-4-5", ModelRate{Input: 1.0, Output: 5.0, CacheRead: 0.1, CacheWrite: 1.25, Cache1h: 2.0}},
	{"claude-haiku-4", ModelRate{Input: 1.0, Output: 5.0, CacheRead: 0.1, CacheWrite: 1.25, Cache1h: 2.0}},
	{"claude-3-5-haiku", ModelRate{Input: 0.8, Output: 4.0, CacheRead: 0.08, CacheWrite: 1.0, Cache1h: 1.6}},

	// OpenAI GPT-5 / Codex / o-series
	{"gpt-5.4-mini", ModelRate{Input: 0.75, Output: 4.5, CacheRead: 0.075, CacheWrite: 0.75, Cache1h: 0.75}},
	{"gpt-5.4-nano", ModelRate{Input: 0.2, Output: 1.25, CacheRead: 0.02, CacheWrite: 0.2, Cache1h: 0.2}},
	{"gpt-5.4-pro", ModelRate{Input: 30.0, Output: 180.0, CacheRead: 3.0, CacheWrite: 30.0, Cache1h: 30.0}},
	{"gpt-5.4", ModelRate{Input: 2.5, Output: 15.0, CacheRead: 0.25, CacheWrite: 2.5, Cache1h: 2.5}},
	{"gpt-5.3-codex-mini", ModelRate{Input: 0.6, Output: 2.4, CacheRead: 0.06, CacheWrite: 0.6, Cache1h: 0.6}},
	{"gpt-5.3-codex", ModelRate{Input: 1.75, Output: 14.0, CacheRead: 0.175, CacheWrite: 1.75, Cache1h: 1.75}},
	{"gpt-5.2-codex", ModelRate{Input: 1.75, Output: 14.0, CacheRead: 0.175, CacheWrite: 1.75, Cache1h: 1.75}},
	{"gpt-5.2", ModelRate{Input: 1.75, Output: 14.0, CacheRead: 0.175, CacheWrite: 1.75, Cache1h: 1.75}},
	{"gpt-5.1-codex-mini", ModelRate{Input: 0.25, Output: 2.0, CacheRead: 0.025, CacheWrite: 0.25, Cache1h: 0.25}},
	{"gpt-5.1", ModelRate{Input: 1.25, Output: 10.0, CacheRead: 0.125, CacheWrite: 1.25, Cache1h: 1.25}},
	{"gpt-5-codex-mini", ModelRate{Input: 0.25, Output: 2.0, CacheRead: 0.025, CacheWrite: 0.25, Cache1h: 0.25}},
	{"gpt-5-mini", ModelRate{Input: 0.25, Output: 2.0, CacheRead: 0.025, CacheWrite: 0.25, Cache1h: 0.25}},
	{"gpt-5-nano", ModelRate{Input: 0.05, Output: 0.4, CacheRead: 0.005, CacheWrite: 0.05, Cache1h: 0.05}},
	{"gpt-5-pro", ModelRate{Input: 15.0, Output: 120.0, CacheRead: 1.5, CacheWrite: 15.0, Cache1h: 15.0}},
	{"gpt-5", ModelRate{Input: 1.25, Output: 10.0, CacheRead: 0.125, CacheWrite: 1.25, Cache1h: 1.25}},
	{"gpt-4.1-mini", ModelRate{Input: 0.4, Output: 1.6, CacheRead: 0.1, CacheWrite: 0.4, Cache1h: 0.4}},
	{"gpt-4.1-nano", ModelRate{Input: 0.1, Output: 0.4, CacheRead: 0.025, CacheWrite: 0.1, Cache1h: 0.1}},
	{"gpt-4.1", ModelRate{Input: 2.0, Output: 8.0, CacheRead: 0.5, CacheWrite: 2.0, Cache1h: 2.0}},
	{"gpt-4o-mini", ModelRate{Input: 0.15, Output: 0.6, CacheRead: 0.075, CacheWrite: 0.15, Cache1h: 0.15}},
	{"gpt-4o", ModelRate{Input: 2.5, Output: 10.0, CacheRead: 1.25, CacheWrite: 2.5, Cache1h: 2.5}},
	{"o4-mini", ModelRate{Input: 1.1, Output: 4.4, CacheRead: 0.275, CacheWrite: 1.1, Cache1h: 1.1}},
	{"o3-mini", ModelRate{Input: 1.1, Output: 4.4, CacheRead: 0.55, CacheWrite: 1.1, Cache1h: 1.1}},
	{"o3-pro", ModelRate{Input: 20.0, Output: 80.0, CacheRead: 5.0, CacheWrite: 20.0, Cache1h: 20.0}},
	{"o3", ModelRate{Input: 2.0, Output: 8.0, CacheRead: 0.5, CacheWrite: 2.0, Cache1h: 2.0}},
	{"codex-mini", ModelRate{Input: 1.5, Output: 6.0, CacheRead: 0.375, CacheWrite: 1.5, Cache1h: 1.5}},

	// Google Gemini / Antigravity
	{"gemini-4-neon", ModelRate{Input: 2.0, Output: 12.0, CacheRead: 0.2, CacheWrite: 2.0, Cache1h: 2.0}},
	{"gemini-4-argon", ModelRate{Input: 2.0, Output: 12.0, CacheRead: 0.2, CacheWrite: 2.0, Cache1h: 2.0}},
	{"gemini-4-carbon", ModelRate{Input: 1.25, Output: 10.0, CacheRead: 0.125, CacheWrite: 1.25, Cache1h: 1.25}},
	{"gemini-4-hydrogen", ModelRate{Input: 0.5, Output: 3.0, CacheRead: 0.05, CacheWrite: 0.5, Cache1h: 0.5}},
	{"gemini-3.1-pro", ModelRate{Input: 2.0, Output: 12.0, CacheRead: 0.2, CacheWrite: 2.0, Cache1h: 2.0}},
	{"gemini-3-pro", ModelRate{Input: 2.0, Output: 12.0, CacheRead: 0.2, CacheWrite: 2.0, Cache1h: 2.0}},
	{"gemini-3.1-flash-lite", ModelRate{Input: 0.1, Output: 0.4, CacheRead: 0.025, CacheWrite: 0.1, Cache1h: 0.1}},
	{"gemini-3", ModelRate{Input: 0.5, Output: 3.0, CacheRead: 0.05, CacheWrite: 0.5, Cache1h: 0.5}},
	{"gemini-2.5-pro", ModelRate{Input: 1.25, Output: 10.0, CacheRead: 0.125, CacheWrite: 1.25, Cache1h: 1.25}},
	{"gemini-2.5-flash-lite", ModelRate{Input: 0.1, Output: 0.4, CacheRead: 0.025, CacheWrite: 0.1, Cache1h: 0.1}},
	{"gemini-2.5-flash", ModelRate{Input: 0.3, Output: 2.5, CacheRead: 0.03, CacheWrite: 0.3, Cache1h: 0.3}},

	// DeepSeek / GLM / Kimi / Qwen
	{"deepseek-r1", ModelRate{Input: 0.55, Output: 2.19, CacheRead: 0.14, CacheWrite: 0.55, Cache1h: 0.55}},
	{"deepseek-reasoner", ModelRate{Input: 0.55, Output: 2.19, CacheRead: 0.14, CacheWrite: 0.55, Cache1h: 0.55}},
	{"deepseek-chat", ModelRate{Input: 0.28, Output: 0.42, CacheRead: 0.028, CacheWrite: 0.28, Cache1h: 0.28}},
	{"deepseek-v3", ModelRate{Input: 0.28, Output: 0.42, CacheRead: 0.028, CacheWrite: 0.28, Cache1h: 0.28}},
	{"kimi-k2", ModelRate{Input: 0.6, Output: 2.5, CacheRead: 0.15, CacheWrite: 0.6, Cache1h: 0.6}},
	{"glm-4", ModelRate{Input: 0.6, Output: 2.2, CacheRead: 0.11, CacheWrite: 0.6, Cache1h: 0.6}},
	{"qwen", ModelRate{Input: 0.4, Output: 1.6, CacheRead: 0.08, CacheWrite: 0.4, Cache1h: 0.4}},
}

func normalizeModelForPricing(raw string) string {
	s := strings.ToLower(strings.TrimSpace(raw))
	if s == "" {
		return ""
	}
	if idx := strings.LastIndex(s, "/"); idx >= 0 {
		s = s[idx+1:]
	}
	// Strip AWS Bedrock region prefix such as us.anthropic.claude-...
	if idx := strings.Index(s, "anthropic."); idx >= 0 {
		s = s[idx+len("anthropic."):]
	}
	s = strings.TrimSpace(s)
	// Normalize dot notation in Claude names: claude-opus-4.6 -> claude-opus-4-6
	if strings.HasPrefix(s, "claude-") {
		s = strings.ReplaceAll(s, ".", "-")
	}
	for {
		next := dateSuffixRe.ReplaceAllString(s, "")
		next = effortSuffixRe.ReplaceAllString(next, "")
		if next == s {
			break
		}
		s = next
	}
	return s
}

// LookupRate resolves API-equivalent token rates for a model ID.
func LookupRate(modelID string) (ModelRate, bool) {
	key := normalizeModelForPricing(modelID)
	if key == "" {
		return ModelRate{}, false
	}
	for _, r := range rateRules {
		if key == r.prefix || strings.HasPrefix(key, r.prefix+"-") || strings.HasPrefix(key, r.prefix+".") {
			return r.rate, true
		}
	}
	// Fallback family matching for newer point releases
	switch {
	case strings.Contains(key, "claude") && strings.Contains(key, "opus"):
		return ModelRate{Input: 5.0, Output: 25.0, CacheRead: 0.5, CacheWrite: 6.25, Cache1h: 10.0}, true
	case strings.Contains(key, "claude") && strings.Contains(key, "sonnet"):
		return ModelRate{Input: 3.0, Output: 15.0, CacheRead: 0.3, CacheWrite: 3.75, Cache1h: 6.0}, true
	case strings.Contains(key, "claude") && strings.Contains(key, "haiku"):
		return ModelRate{Input: 1.0, Output: 5.0, CacheRead: 0.1, CacheWrite: 1.25, Cache1h: 2.0}, true
	case strings.Contains(key, "gpt-6") || strings.Contains(key, "gpt-5"):
		return ModelRate{Input: 2.5, Output: 15.0, CacheRead: 0.25, CacheWrite: 2.5, Cache1h: 2.5}, true
	case strings.HasPrefix(key, "codex"):
		return ModelRate{Input: 1.75, Output: 14.0, CacheRead: 0.175, CacheWrite: 1.75, Cache1h: 1.75}, true
	case strings.HasPrefix(key, "gemini-4") || strings.Contains(key, "gemini-pro"):
		return ModelRate{Input: 2.0, Output: 12.0, CacheRead: 0.2, CacheWrite: 2.0, Cache1h: 2.0}, true
	case strings.HasPrefix(key, "gemini-"):
		return ModelRate{Input: 0.5, Output: 3.0, CacheRead: 0.05, CacheWrite: 0.5, Cache1h: 0.5}, true
	}
	return ModelRate{}, false
}

// EstimateCost computes category cost breakdown and cache savings in USD.
func EstimateCost(modelID string, totals model.TokenTotals, cacheWrite1h int64, reportedCost *float64) (cost float64, cat model.LocalStatsCategoryCost, savings float64, priced bool) {
	rate, ok := LookupRate(modelID)
	if !ok {
		if reportedCost != nil && *reportedCost > 0 && !math.IsNaN(*reportedCost) && !math.IsInf(*reportedCost, 0) {
			return *reportedCost, model.LocalStatsCategoryCost{Output: *reportedCost}, 0, true
		}
		return 0, model.LocalStatsCategoryCost{}, 0, false
	}
	const perM = 1_000_000.0
	w1h := max(int64(0), min(cacheWrite1h, totals.CacheWrite))
	w5m := max(int64(0), totals.CacheWrite-w1h)
	cat.Input = float64(totals.UncachedInput) * rate.Input / perM
	cat.CacheRead = float64(totals.CachedInput) * rate.CacheRead / perM
	cat.CacheWrite = (float64(w5m)*rate.CacheWrite + float64(w1h)*rate.Cache1h) / perM
	cat.Output = float64(totals.Output) * rate.Output / perM
	estimated := cat.Input + cat.CacheRead + cat.CacheWrite + cat.Output
	if reportedCost != nil && *reportedCost > 0 && !math.IsNaN(*reportedCost) && !math.IsInf(*reportedCost, 0) {
		cost = *reportedCost
		if estimated > 0 {
			scale := cost / estimated
			cat.Input *= scale
			cat.CacheRead *= scale
			cat.CacheWrite *= scale
			cat.Output *= scale
		}
	} else {
		cost = estimated
	}
	if totals.CachedInput > 0 && rate.Input > rate.CacheRead {
		savings = float64(totals.CachedInput) * (rate.Input - rate.CacheRead) / perM
	}
	return cost, cat, savings, true
}
