package model

// TokenTotals tracks disjoint input/cache buckets and total output tokens.
// Reasoning tokens are already included in Output and surfaced separately for reference.
type TokenTotals struct {
	UncachedInput int64 `json:"uncachedInput"`
	CachedInput   int64 `json:"cachedInput"`
	CacheWrite    int64 `json:"cacheWrite"`
	Output        int64 `json:"output"`
	Reasoning     int64 `json:"reasoning"`
	Total         int64 `json:"total"`
}

type LocalStatsCategoryCost struct {
	Input      float64 `json:"input"`
	CacheRead  float64 `json:"cacheRead"`
	CacheWrite float64 `json:"cacheWrite"`
	Output     float64 `json:"output"`
}

type LocalStatsQuickPeriod struct {
	Tokens       int64   `json:"tokens"`
	CostUsd      float64 `json:"costUsd"`
	CacheHitRate float64 `json:"cacheHitRate"`
	Sessions     int     `json:"sessions"`
	Runs         int     `json:"runs"`
}

type LocalStatsQuickSummary struct {
	Today  LocalStatsQuickPeriod `json:"today"`
	Last7d LocalStatsQuickPeriod `json:"last7d"`
	ReadAt string                `json:"readAt"`
}

type LocalStatsSeries struct {
	ID              string                 `json:"id"`
	Name            string                 `json:"name"`
	Tokens          int64                  `json:"tokens"`
	Totals          TokenTotals            `json:"totals"`
	CostUsd         float64                `json:"costUsd"`
	CacheSavingsUsd float64                `json:"cacheSavingsUsd"`
	CategoryCost    LocalStatsCategoryCost `json:"categoryCost"`
	LeverTokens     int64                  `json:"leverTokens"`
	LeverCostUsd    float64                `json:"leverCostUsd"`
	Sessions        int                    `json:"sessions"`
	Runs            int                    `json:"runs"`
	SeriesTokens    []int64                `json:"seriesTokens"`
	SeriesCost      []float64              `json:"seriesCost"`
}

type LocalStatsModel struct {
	ID              string                 `json:"id"`
	Model           string                 `json:"model"`
	Provider        string                 `json:"provider"`
	ProviderName    string                 `json:"providerName"`
	Tokens          int64                  `json:"tokens"`
	Totals          TokenTotals            `json:"totals"`
	CostUsd         float64                `json:"costUsd"`
	CacheSavingsUsd float64                `json:"cacheSavingsUsd"`
	CategoryCost    LocalStatsCategoryCost `json:"categoryCost"`
	LeverTokens     int64                  `json:"leverTokens"`
	LeverCostUsd    float64                `json:"leverCostUsd"`
	Priced          bool                   `json:"priced"`
	PriceInput      float64                `json:"priceInput,omitempty"`  // USD per million input tokens
	PriceOutput     float64                `json:"priceOutput,omitempty"` // USD per million output tokens
	CacheHitRate    float64                `json:"cacheHitRate"`
	Sessions        int                    `json:"sessions"`
	Runs            int                    `json:"runs"`
	SeriesTokens    []int64                `json:"seriesTokens"`
	SeriesCost      []float64              `json:"seriesCost"`
}

type LocalStatsAgent struct {
	ID           string      `json:"id"`
	Name         string      `json:"name"`
	Avatar       *Avatar     `json:"avatar,omitempty"`
	Provider     string      `json:"provider"`
	Model        string      `json:"model"`
	Project      string      `json:"project,omitempty"`
	Sessions     int         `json:"sessions"`
	Runs         int         `json:"runs"`
	Additions    int         `json:"additions"`
	Deletions    int         `json:"deletions"`
	Tokens       int64       `json:"tokens"`
	Totals       TokenTotals `json:"totals"`
	CostUsd      float64     `json:"costUsd"`
	CacheHitRate float64     `json:"cacheHitRate"`
}

type LocalStatsProject struct {
	ID           string      `json:"id"`
	Name         string      `json:"name"`
	Path         string      `json:"path,omitempty"`
	Kind         string      `json:"kind" tstype:"'git' | 'folder' | 'chat'"`
	TopAgent     string      `json:"topAgent,omitempty"`
	TopModel     string      `json:"topModel,omitempty"`
	Sessions     int         `json:"sessions"`
	Runs         int         `json:"runs"`
	Additions    int         `json:"additions"`
	Deletions    int         `json:"deletions"`
	Tokens       int64       `json:"tokens"`
	Totals       TokenTotals `json:"totals"`
	CostUsd      float64     `json:"costUsd"`
	CacheHitRate float64     `json:"cacheHitRate"`
}

type LocalStatsSession struct {
	ID           string      `json:"id"`
	ChatID       string      `json:"chatId,omitempty"`
	SessionID    string      `json:"sessionId,omitempty"`
	AgentID      string      `json:"agentId,omitempty"`
	Title        string      `json:"title"`
	Source       string      `json:"source" tstype:"'lever' | 'cli'"`
	AgentName    string      `json:"agentName,omitempty"`
	AgentAvatar  *Avatar     `json:"agentAvatar,omitempty"`
	Project      string      `json:"project,omitempty"`
	Provider     string      `json:"provider"`
	ProviderName string      `json:"providerName"`
	Model        string      `json:"model"`
	Runs         int         `json:"runs"`
	Additions    int         `json:"additions"`
	Deletions    int         `json:"deletions"`
	Tokens       int64       `json:"tokens"`
	Totals       TokenTotals `json:"totals"`
	CostUsd      float64     `json:"costUsd"`
	CacheHitRate float64     `json:"cacheHitRate"`
	UpdatedAt    string      `json:"updatedAt"`
}

type LocalStatsHourCell struct {
	Day            string             `json:"day"`
	Hour           int                `json:"hour"`
	Future         bool               `json:"future,omitempty"`
	Tokens         int64              `json:"tokens"`
	CostUsd        float64            `json:"costUsd"`
	TopModel       string             `json:"topModel,omitempty"`
	TopProvider    string             `json:"topProvider,omitempty"`
	ByProvider     map[string]int64   `json:"byProvider,omitempty"`
	ByProviderCost map[string]float64 `json:"byProviderCost,omitempty"`
	ByModel        map[string]int64   `json:"byModel,omitempty"`
	ByModelCost    map[string]float64 `json:"byModelCost,omitempty"`
}

type LocalStatsSource struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Path     string `json:"path,omitempty"`
	Status   string `json:"status" tstype:"'ok' | 'missing' | 'partial'"`
	Files    int    `json:"files"`
	Sessions int    `json:"sessions"`
	Records  int    `json:"records"`
	Message  string `json:"message,omitempty"`
}

type LocalStats struct {
	Period          string                 `json:"period" tstype:"'24h' | '7d' | '30d' | '90d'"`
	Scope           string                 `json:"scope" tstype:"'all' | 'lever'"`
	TimeZone        string                 `json:"timeZone"`
	Since           string                 `json:"since"`
	Until           string                 `json:"until"`
	Resolution      string                 `json:"resolution" tstype:"'hour' | 'day'"`
	ReadAt          string                 `json:"readAt"`
	ScanMs          int64                  `json:"scanMs"`
	Totals          TokenTotals            `json:"totals"`
	CostUsd         float64                `json:"costUsd"`
	CacheSavingsUsd float64                `json:"cacheSavingsUsd"`
	CategoryCost    LocalStatsCategoryCost `json:"categoryCost"`
	CacheHitRate    float64                `json:"cacheHitRate"`
	SessionsCount   int                    `json:"sessionsCount"`
	RunsCount       int                    `json:"runsCount"`
	LeverTokens     int64                  `json:"leverTokens"`
	LeverCostUsd    float64                `json:"leverCostUsd"`
	ExternalTokens  int64                  `json:"externalTokens"`
	ExternalCostUsd float64                `json:"externalCostUsd"`
	TimeSlots       []string               `json:"timeSlots"`
	Providers       []LocalStatsSeries     `json:"providers"`
	Models          []LocalStatsModel      `json:"models"`
	Agents          []LocalStatsAgent      `json:"agents"`
	Projects        []LocalStatsProject    `json:"projects"`
	Sessions        []LocalStatsSession    `json:"sessions"`
	Hourly          []LocalStatsHourCell   `json:"hourly"`
	Sources         []LocalStatsSource     `json:"sources"`
}
