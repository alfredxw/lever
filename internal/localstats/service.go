package localstats

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"sort"
	"strings"
	"sync"
	"time"

	"lever/internal/model"
	"lever/internal/provider"
)

const (
	snapshotTTL   = 30 * time.Second
	maxRetainDays = 95
	maxSessionOut = 80
)

type Query struct {
	Period   string // 24h | 7d | 30d | 90d
	Scope    string // all | lever
	TimeZone string // IANA name, empty => local
	Refresh  bool
}

type cachedFile struct {
	fingerprint string
	parsed      parsedFile
}

type leverRunRecord struct {
	sessionID string
	createdAt time.Time
	additions int
	deletions int
}

type leverDBSnapshot struct {
	byNative      map[string]leverSessionMeta
	projectByRoot map[string]projectKey
	runs          []leverRunRecord
	totalRuns     int
}

func (l *leverDBSnapshot) windowIndex(since, until time.Time) leverIndex {
	idx := leverIndex{
		byNative:      make(map[string]leverSessionMeta, len(l.byNative)),
		projectByRoot: l.projectByRoot,
		totalRuns:     l.totalRuns,
	}
	type runStats struct {
		runs, additions, deletions int
	}
	sessRuns := make(map[string]*runStats)
	for _, r := range l.runs {
		if r.createdAt.Before(since) || r.createdAt.After(until) {
			continue
		}
		idx.windowRuns++
		st := sessRuns[r.sessionID]
		if st == nil {
			st = &runStats{}
			sessRuns[r.sessionID] = st
		}
		st.runs++
		st.additions += r.additions
		st.deletions += r.deletions
	}
	for nativeID, base := range l.byNative {
		m := base
		if st := sessRuns[m.sessionID]; st != nil {
			m.windowRuns = st.runs
			m.additions = st.additions
			m.deletions = st.deletions
		}
		idx.byNative[nativeID] = m
	}
	return idx
}

type scanSnapshot struct {
	records   []usageRecord
	sources   []model.LocalStatsSource
	leverDB   *leverDBSnapshot
	scannedAt time.Time
	scanMs    int64
}

type Service struct {
	db       *sql.DB
	stateDir string

	ctx    context.Context
	cancel context.CancelFunc
	bgWG   sync.WaitGroup

	cacheOnce sync.Once
	cache     *diskCache

	mu          sync.Mutex
	closed      bool
	fileCache   map[string]cachedFile
	runCache    map[string]cachedRun
	agySumCache map[string]cachedAgySummary
	projectMemo map[string]projectKey
	snapshot    *scanSnapshot
	scanning    *scanWaiter
}

type scanWaiter struct {
	done chan struct{}
	snap *scanSnapshot
}

type projectKey struct {
	id   string
	name string
	path string
	kind string // git | folder | chat
}

func NewService(db *sql.DB, stateDir string) *Service {
	ctx, cancel := context.WithCancel(context.Background())
	return &Service{
		db:          db,
		stateDir:    stateDir,
		ctx:         ctx,
		cancel:      cancel,
		fileCache:   make(map[string]cachedFile),
		runCache:    make(map[string]cachedRun),
		agySumCache: make(map[string]cachedAgySummary),
		projectMemo: make(map[string]projectKey),
	}
}

func (s *Service) ensureCacheLoaded() {
	s.cacheOnce.Do(func() {
		dc, err := openDiskCache(s.stateDir)
		if err != nil || dc == nil {
			return
		}
		files, runs, summaries := dc.loadAll()
		s.mu.Lock()
		if s.closed {
			s.mu.Unlock()
			dc.close()
			return
		}
		s.cache = dc
		for k, v := range files {
			if _, exists := s.fileCache[k]; !exists {
				s.fileCache[k] = v
			}
		}
		for k, v := range runs {
			if _, exists := s.runCache[k]; !exists {
				s.runCache[k] = v
			}
		}
		for k, v := range summaries {
			if _, exists := s.agySumCache[k]; !exists {
				s.agySumCache[k] = v
			}
		}
		s.mu.Unlock()
	})
}

// Warm primes the local stats cache and snapshot in the background.
func (s *Service) Warm(ctx context.Context) {
	_ = s.getSnapshot(ctx, false)
}

// Close stops background scans and releases the persistent cache database.
func (s *Service) Close() {
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return
	}
	s.closed = true
	s.cancel()
	s.mu.Unlock()

	s.bgWG.Wait()

	s.mu.Lock()
	dc := s.cache
	s.cache = nil
	s.mu.Unlock()
	if dc != nil {
		dc.close()
	}
}

func normalizePeriod(raw string) string {
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case "24h", "7d", "30d", "90d":
		return strings.ToLower(strings.TrimSpace(raw))
	default:
		return "7d"
	}
}

func normalizeScope(raw string) string {
	if strings.EqualFold(strings.TrimSpace(raw), "lever") {
		return "lever"
	}
	return "all"
}

func resolveLocation(tz string) (*time.Location, string) {
	tz = strings.TrimSpace(tz)
	if tz != "" {
		if loc, err := time.LoadLocation(tz); err == nil {
			return loc, loc.String()
		}
	}
	loc := time.Local
	name := loc.String()
	if name == "" || name == "Local" {
		_, offset := time.Now().Zone()
		sign := "+"
		if offset < 0 {
			sign = "-"
			offset = -offset
		}
		name = fmt.Sprintf("UTC%s%d", sign, offset/3600)
	}
	return loc, name
}

func (s *Service) getSnapshot(ctx context.Context, refresh bool) *scanSnapshot {
	now := time.Now()
	s.mu.Lock()
	if s.closed {
		snap := s.snapshot
		s.mu.Unlock()
		if snap != nil {
			return snap
		}
		return emptySnapshot()
	}
	if !refresh && s.snapshot != nil {
		snap := s.snapshot
		if now.Sub(snap.scannedAt) < snapshotTTL {
			s.mu.Unlock()
			return snap
		}
		// Stale-While-Revalidate: return the cached snapshot immediately and
		// trigger a singleflight background refresh so UI reads never stall.
		if s.scanning == nil {
			s.startScanLocked()
		}
		s.mu.Unlock()
		return snap
	}
	w := s.scanning
	if w == nil {
		w = s.startScanLocked()
	}
	s.mu.Unlock()

	select {
	case <-ctx.Done():
		return s.latestOrEmpty()
	case <-w.done:
		return w.snap
	}
}

func (s *Service) startScanLocked() *scanWaiter {
	w := &scanWaiter{done: make(chan struct{})}
	s.scanning = w
	s.bgWG.Add(1)
	go func() {
		defer s.bgWG.Done()
		snap := s.performScan(s.ctx)
		s.mu.Lock()
		// Preserve an existing snapshot if the service was cancelled mid-scan.
		if s.ctx.Err() == nil || s.snapshot == nil {
			s.snapshot = snap
			w.snap = snap
		} else {
			w.snap = s.snapshot
		}
		if s.scanning == w {
			s.scanning = nil
		}
		close(w.done)
		s.mu.Unlock()
	}()
	return w
}

func emptySnapshot() *scanSnapshot {
	return &scanSnapshot{
		leverDB:   &leverDBSnapshot{byNative: make(map[string]leverSessionMeta), projectByRoot: make(map[string]projectKey)},
		scannedAt: time.Now(),
	}
}

func (s *Service) latestOrEmpty() *scanSnapshot {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.snapshot != nil {
		return s.snapshot
	}
	return emptySnapshot()
}

func (s *Service) Summary(ctx context.Context, tz string) (*model.LocalStatsQuickSummary, error) {
	snap := s.getSnapshot(ctx, false)
	loc, _ := resolveLocation(tz)
	now := time.Now().In(loc)
	startToday := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, loc)
	start7d := startToday.AddDate(0, 0, -6)

	todayMeta := snap.leverDB.windowIndex(startToday, now)
	last7dMeta := snap.leverDB.windowIndex(start7d, now)
	today := summarizeWindow(snap.records, startToday, now, todayMeta)
	last7d := summarizeWindow(snap.records, start7d, now, last7dMeta)
	return &model.LocalStatsQuickSummary{
		Today:  today,
		Last7d: last7d,
		ReadAt: snap.scannedAt.UTC().Format(time.RFC3339),
	}, nil
}

func summarizeWindow(records []usageRecord, since, until time.Time, leverMeta leverIndex) model.LocalStatsQuickPeriod {
	var totals model.TokenTotals
	var cost float64
	sessions := make(map[string]struct{})
	leverSessCredited := make(map[string]bool)
	leverRuns := 0
	externalCalls := 0
	for _, r := range records {
		if r.Timestamp.Before(since) || r.Timestamp.After(until) {
			continue
		}
		totals.UncachedInput += r.Totals.UncachedInput
		totals.CachedInput += r.Totals.CachedInput
		totals.CacheWrite += r.Totals.CacheWrite
		totals.Output += r.Totals.Output
		totals.Reasoning += r.Totals.Reasoning
		totals.Total += r.Totals.Total
		c, _, _, _ := EstimateCost(r.Model, r.Totals, r.CacheWrite1h, r.ReportedCost)
		cost += c
		if m, ok := leverMeta.byNative[r.SessionID]; ok {
			key := "lever:" + m.sessionID
			sessions[key] = struct{}{}
			if !leverSessCredited[m.sessionID] {
				leverSessCredited[m.sessionID] = true
				if m.windowRuns > 0 {
					leverRuns += m.windowRuns
				} else {
					externalCalls++
				}
			}
		} else {
			key := r.Provider + ":" + r.SessionID
			sessions[key] = struct{}{}
			externalCalls++
		}
	}
	return model.LocalStatsQuickPeriod{
		Tokens:       totals.Total,
		CostUsd:      roundUsd(cost),
		CacheHitRate: cacheHitRate(totals),
		Sessions:     len(sessions),
		Runs:         leverRuns + externalCalls,
	}
}

func (s *Service) Stats(ctx context.Context, q Query) (*model.LocalStats, error) {
	period := normalizePeriod(q.Period)
	scope := normalizeScope(q.Scope)
	loc, tzName := resolveLocation(q.TimeZone)
	snap := s.getSnapshot(ctx, q.Refresh)

	now := time.Now().In(loc)
	var since time.Time
	resolution := "day"
	var slots []string
	slotIndex := make(map[string]int)

	if period == "24h" {
		resolution = "hour"
		endHour := time.Date(now.Year(), now.Month(), now.Day(), now.Hour(), 0, 0, 0, loc)
		since = endHour.Add(-23 * time.Hour)
		for i := 0; i < 24; i++ {
			t := since.Add(time.Duration(i) * time.Hour)
			key := t.Format("2006-01-02T15:00")
			slotIndex[key] = i
			slots = append(slots, key)
		}
	} else {
		days := 7
		if period == "30d" {
			days = 30
		} else if period == "90d" {
			days = 90
		}
		todayStart := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, loc)
		since = todayStart.AddDate(0, 0, -(days - 1))
		for i := 0; i < days; i++ {
			t := since.AddDate(0, 0, i)
			key := t.Format("2006-01-02")
			slotIndex[key] = i
			slots = append(slots, key)
		}
	}

	// Hourly matrix always covers the last 7 days ending today.
	todayStart := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, loc)
	hourlySince := todayStart.AddDate(0, 0, -6)
	hourlyCells := make([]model.LocalStatsHourCell, 7*24)
	hourDayIdx := make(map[string]int, 7)
	for d := 0; d < 7; d++ {
		dayStr := hourlySince.AddDate(0, 0, d).Format("2006-01-02")
		hourDayIdx[dayStr] = d
		for h := 0; h < 24; h++ {
			idx := d*24 + h
			hourlyCells[idx] = model.LocalStatsHourCell{
				Day:    dayStr,
				Hour:   h,
				Future: d == 6 && h > now.Hour(),
			}
		}
	}

	leverMeta := snap.leverDB.windowIndex(since, now)

	// Aggregation maps
	type provAgg struct {
		id, name        string
		tokens          int64
		totals          model.TokenTotals
		cost            float64
		cacheSavings    float64
		categoryCost    model.LocalStatsCategoryCost
		leverTokens     int64
		leverCost       float64
		runs            int
		sessions        map[string]struct{}
		seriesTokens    []int64
		seriesCost      []float64
		tpsOutput       int64
		tpsDurMs        int64
		tpsSamples      int
		seriesTpsOutput []int64
		seriesTpsDurMs  []int64
	}
	type modelAgg struct {
		id, model, provider, providerName string
		tokens                            int64
		totals                            model.TokenTotals
		cost                              float64
		cacheSavings                      float64
		categoryCost                      model.LocalStatsCategoryCost
		leverTokens                       int64
		leverCost                         float64
		priced                            bool
		runs                              int
		sessions                          map[string]struct{}
		seriesTokens                      []int64
		seriesCost                        []float64
		tpsOutput                         int64
		tpsDurMs                          int64
		tpsSamples                        int
		seriesTpsOutput                   []int64
		seriesTpsDurMs                    []int64
	}
	type agentAgg struct {
		id, name, provider, model, project string
		avatar                             *model.Avatar
		tokens                             int64
		totals                             model.TokenTotals
		cost                               float64
		recordRuns                         int
		leverRuns                          int
		additions, deletions               int
		sessions                           map[string]struct{}
		modelTok                           map[string]int64
		provTok                            map[string]int64
		projTok                            map[string]int64
	}
	type projAgg struct {
		key                  projectKey
		tokens               int64
		totals               model.TokenTotals
		cost                 float64
		recordRuns           int
		leverRuns            int
		additions, deletions int
		sessions             map[string]struct{}
		modelTok             map[string]int64
		agentTok             map[string]int64
	}
	type sessAgg struct {
		id, chatID, sessionID, agentID  string
		title, source, agentName        string
		agentAvatar                     *model.Avatar
		project, provider, provName     string
		tokens                          int64
		totals                          model.TokenTotals
		cost                            float64
		recordRuns, leverRuns           int
		additions, deletions            int
		updatedAt                       time.Time
		modelTok                        map[string]int64
	}

	provs := make(map[string]*provAgg)
	models := make(map[string]*modelAgg)
	agents := make(map[string]*agentAgg)
	projects := make(map[string]*projAgg)
	sessions := make(map[string]*sessAgg)
	globalSessions := make(map[string]struct{})
	hourlyModelNames := make([]map[string]int64, len(hourlyCells))

	var grandTotals model.TokenTotals
	var grandCost, grandSavings float64
	var grandCat model.LocalStatsCategoryCost
	var grandLeverRuns, grandExternalRuns int
	var leverTokens, extTokens int64
	var leverCost, extCost float64
	var grandTpsOutput, grandTpsDurMs int64
	var grandTpsSamples int
	grandSeriesTpsOutput := make([]int64, len(slots))
	grandSeriesTpsDurMs := make([]int64, len(slots))

	// Track which Lever sessions got diff/run credit so we add each session's git diff once.
	creditedLeverSession := make(map[string]bool)

	for _, r := range snap.records {
		localTS := r.Timestamp.In(loc)
		lm, isLever := leverMeta.byNative[r.SessionID]
		if scope == "lever" && !isLever {
			continue
		}

		mKey := r.Provider + ":" + r.Model

		// Populate 7x24 hourly matrix regardless of selected period (respecting scope).
		if !localTS.Before(hourlySince) && !localTS.After(now) {
			if dIdx, ok := hourDayIdx[localTS.Format("2006-01-02")]; ok {
				h := localTS.Hour()
				cIdx := dIdx*24 + h
				cell := &hourlyCells[cIdx]
				c, _, _, _ := EstimateCost(r.Model, r.Totals, r.CacheWrite1h, r.ReportedCost)
				cell.Tokens += r.Totals.Total
				cell.CostUsd += c
				if cell.ByProvider == nil {
					cell.ByProvider = make(map[string]int64)
					cell.ByProviderCost = make(map[string]float64)
				}
				if cell.ByModel == nil {
					cell.ByModel = make(map[string]int64)
					cell.ByModelCost = make(map[string]float64)
				}
				if hourlyModelNames[cIdx] == nil {
					hourlyModelNames[cIdx] = make(map[string]int64)
				}
				cell.ByProvider[r.Provider] += r.Totals.Total
				cell.ByProviderCost[r.Provider] += c
				cell.ByModel[mKey] += r.Totals.Total
				cell.ByModelCost[mKey] += c
				hourlyModelNames[cIdx][r.Model] += r.Totals.Total
			}
		}

		if localTS.Before(since) || localTS.After(now) {
			continue
		}

		slotKey := localTS.Format("2006-01-02")
		if resolution == "hour" {
			slotKey = localTS.Format("2006-01-02T15:00")
		}
		sIdx, hasSlot := slotIndex[slotKey]

		cost, cat, savings, priced := EstimateCost(r.Model, r.Totals, r.CacheWrite1h, r.ReportedCost)
		validTps := isValidTpsSample(r.Totals.Output, r.DurationMs)

		grandTotals = addTotals(grandTotals, r.Totals)
		grandCost += cost
		grandSavings += savings
		grandCat.Input += cat.Input
		grandCat.CacheRead += cat.CacheRead
		grandCat.CacheWrite += cat.CacheWrite
		grandCat.Output += cat.Output
		if validTps {
			grandTpsOutput += r.Totals.Output
			grandTpsDurMs += r.DurationMs
			grandTpsSamples++
			if hasSlot {
				grandSeriesTpsOutput[sIdx] += r.Totals.Output
				grandSeriesTpsDurMs[sIdx] += r.DurationMs
			}
		}

		if isLever {
			leverTokens += r.Totals.Total
			leverCost += cost
		} else {
			extTokens += r.Totals.Total
			extCost += cost
			grandExternalRuns++
		}

		sessKey := r.Provider + ":" + r.SessionID
		if isLever {
			sessKey = "lever:" + lm.sessionID
		}
		globalSessions[sessKey] = struct{}{}

		// Provider agg
		pa := provs[r.Provider]
		if pa == nil {
			pa = &provAgg{
				id:              r.Provider,
				name:            providerDisplayName(r.Provider),
				sessions:        make(map[string]struct{}),
				seriesTokens:    make([]int64, len(slots)),
				seriesCost:      make([]float64, len(slots)),
				seriesTpsOutput: make([]int64, len(slots)),
				seriesTpsDurMs:  make([]int64, len(slots)),
			}
			provs[r.Provider] = pa
		}
		pa.tokens += r.Totals.Total
		pa.totals = addTotals(pa.totals, r.Totals)
		pa.cost += cost
		pa.cacheSavings += savings
		pa.categoryCost.Input += cat.Input
		pa.categoryCost.CacheRead += cat.CacheRead
		pa.categoryCost.CacheWrite += cat.CacheWrite
		pa.categoryCost.Output += cat.Output
		if isLever {
			pa.leverTokens += r.Totals.Total
			pa.leverCost += cost
		}
		pa.runs++
		pa.sessions[sessKey] = struct{}{}
		if hasSlot {
			pa.seriesTokens[sIdx] += r.Totals.Total
			pa.seriesCost[sIdx] += cost
		}
		if validTps {
			pa.tpsOutput += r.Totals.Output
			pa.tpsDurMs += r.DurationMs
			pa.tpsSamples++
			if hasSlot {
				pa.seriesTpsOutput[sIdx] += r.Totals.Output
				pa.seriesTpsDurMs[sIdx] += r.DurationMs
			}
		}

		// Model agg
		ma := models[mKey]
		if ma == nil {
			ma = &modelAgg{
				id:              mKey,
				model:           r.Model,
				provider:        r.Provider,
				providerName:    providerDisplayName(r.Provider),
				sessions:        make(map[string]struct{}),
				seriesTokens:    make([]int64, len(slots)),
				seriesCost:      make([]float64, len(slots)),
				seriesTpsOutput: make([]int64, len(slots)),
				seriesTpsDurMs:  make([]int64, len(slots)),
			}
			models[mKey] = ma
		}
		ma.tokens += r.Totals.Total
		ma.totals = addTotals(ma.totals, r.Totals)
		ma.cost += cost
		ma.cacheSavings += savings
		ma.categoryCost.Input += cat.Input
		ma.categoryCost.CacheRead += cat.CacheRead
		ma.categoryCost.CacheWrite += cat.CacheWrite
		ma.categoryCost.Output += cat.Output
		if isLever {
			ma.leverTokens += r.Totals.Total
			ma.leverCost += cost
		}
		if priced {
			ma.priced = true
		}
		ma.runs++
		ma.sessions[sessKey] = struct{}{}
		if hasSlot {
			ma.seriesTokens[sIdx] += r.Totals.Total
			ma.seriesCost[sIdx] += cost
		}
		if validTps {
			ma.tpsOutput += r.Totals.Output
			ma.tpsDurMs += r.DurationMs
			ma.tpsSamples++
			if hasSlot {
				ma.seriesTpsOutput[sIdx] += r.Totals.Output
				ma.seriesTpsDurMs[sIdx] += r.DurationMs
			}
		}

		// Project resolution (unifying Lever projects and external CLI paths sharing the same root)
		var pk projectKey
		if isLever && lm.projectName != "" {
			pk = projectKey{id: lm.projectID, name: lm.projectName, path: lm.projectPath, kind: lm.projectKind}
		} else if isLever && lm.primaryRoot != "" {
			pk = s.resolveProjectWithLever(lm.primaryRoot, leverMeta)
		} else {
			pk = s.resolveProjectWithLever(r.CWD, leverMeta)
		}

		pr := projects[pk.id]
		if pr == nil {
			pr = &projAgg{
				key:      pk,
				sessions: make(map[string]struct{}),
				modelTok: make(map[string]int64),
				agentTok: make(map[string]int64),
			}
			projects[pk.id] = pr
		}
		pr.tokens += r.Totals.Total
		pr.totals = addTotals(pr.totals, r.Totals)
		pr.cost += cost
		if !isLever || lm.windowRuns == 0 {
			pr.recordRuns++
		}
		pr.sessions[sessKey] = struct{}{}
		pr.modelTok[r.Model] += r.Totals.Total
		if isLever && lm.agentName != "" {
			pr.agentTok[lm.agentName] += r.Totals.Total
		} else {
			pr.agentTok[providerDisplayName(r.Provider)+" CLI"] += r.Totals.Total
		}

		// Agent agg (Lever agents)
		if isLever && lm.agentID != "" {
			ag := agents[lm.agentID]
			if ag == nil {
				ag = &agentAgg{
					id:       lm.agentID,
					name:     lm.agentName,
					avatar:   lm.agentAvatar,
					provider: r.Provider,
					model:    r.Model,
					sessions: make(map[string]struct{}),
					modelTok: make(map[string]int64),
					provTok:  make(map[string]int64),
					projTok:  make(map[string]int64),
				}
				agents[lm.agentID] = ag
			}
			ag.tokens += r.Totals.Total
			ag.totals = addTotals(ag.totals, r.Totals)
			ag.cost += cost
			if lm.windowRuns == 0 {
				ag.recordRuns++
			}
			ag.sessions[sessKey] = struct{}{}
			ag.modelTok[r.Model] += r.Totals.Total
			ag.provTok[r.Provider] += r.Totals.Total
			if pk.name != "" {
				ag.projTok[pk.name] += r.Totals.Total
			}
		}

		// Session agg
		sa := sessions[sessKey]
		if sa == nil {
			title := r.Title
			source := "cli"
			agentName := ""
			var agentAvatar *model.Avatar
			var chatID, leverSessID, agentID string
			if isLever {
				source = "lever"
				chatID = lm.chatID
				leverSessID = lm.sessionID
				agentID = lm.agentID
				agentName = lm.agentName
				agentAvatar = lm.agentAvatar
				if lm.title != "" {
					title = lm.title
				}
			}
			if title == "" {
				if r.SessionID != "" {
					short := r.SessionID
					if len(short) > 12 {
						short = short[:12]
					}
					title = providerDisplayName(r.Provider) + " · " + short
				} else {
					title = providerDisplayName(r.Provider) + " session"
				}
			}
			sa = &sessAgg{
				id:          sessKey,
				chatID:      chatID,
				sessionID:   leverSessID,
				agentID:     agentID,
				title:       title,
				source:      source,
				agentName:   agentName,
				agentAvatar: agentAvatar,
				project:     pk.name,
				provider:    r.Provider,
				provName:    providerDisplayName(r.Provider),
				modelTok:    make(map[string]int64),
			}
			sessions[sessKey] = sa
		}
		sa.tokens += r.Totals.Total
		sa.totals = addTotals(sa.totals, r.Totals)
		sa.cost += cost
		sa.recordRuns++
		sa.modelTok[r.Model] += r.Totals.Total
		if r.Timestamp.After(sa.updatedAt) {
			sa.updatedAt = r.Timestamp
		}

		// Credit git diff lines & Lever run counts once per matched Lever session
		if isLever && !creditedLeverSession[lm.sessionID] {
			creditedLeverSession[lm.sessionID] = true
			sa.additions = lm.additions
			sa.deletions = lm.deletions
			sa.leverRuns = lm.windowRuns
			if lm.windowRuns > 0 {
				grandLeverRuns += lm.windowRuns
			} else {
				grandExternalRuns++
			}
			pr.additions += lm.additions
			pr.deletions += lm.deletions
			pr.leverRuns += lm.windowRuns
			if ag := agents[lm.agentID]; ag != nil {
				ag.additions += lm.additions
				ag.deletions += lm.deletions
				ag.leverRuns += lm.windowRuns
			}
		}
	}

	// Finalize hourly cells topProvider/topModel and round cost maps
	for i := range hourlyCells {
		c := &hourlyCells[i]
		c.CostUsd = roundUsd(c.CostUsd)
		c.TopProvider = topMapKey(c.ByProvider)
		c.TopModel = topMapKey(hourlyModelNames[i])
		for k, v := range c.ByProviderCost {
			c.ByProviderCost[k] = roundUsd(v)
		}
		for k, v := range c.ByModelCost {
			c.ByModelCost[k] = roundUsd(v)
		}
	}

	// Build sorted outputs
	outProviders := make([]model.LocalStatsSeries, 0, len(provs))
	for _, p := range provs {
		sc := make([]float64, len(p.seriesCost))
		for i, v := range p.seriesCost {
			sc[i] = roundUsd(v)
		}
		stps := make([]float64, len(p.seriesTpsOutput))
		for i := range p.seriesTpsOutput {
			stps[i] = calcTps(p.seriesTpsOutput[i], p.seriesTpsDurMs[i])
		}
		outProviders = append(outProviders, model.LocalStatsSeries{
			ID:              p.id,
			Name:            p.name,
			Tokens:          p.tokens,
			Totals:          p.totals,
			CostUsd:         roundUsd(p.cost),
			CacheSavingsUsd: roundUsd(p.cacheSavings),
			CategoryCost: model.LocalStatsCategoryCost{
				Input:      roundUsd(p.categoryCost.Input),
				CacheRead:  roundUsd(p.categoryCost.CacheRead),
				CacheWrite: roundUsd(p.categoryCost.CacheWrite),
				Output:     roundUsd(p.categoryCost.Output),
			},
			LeverTokens:  p.leverTokens,
			LeverCostUsd: roundUsd(p.leverCost),
			Sessions:     len(p.sessions),
			Runs:         p.runs,
			AvgTps:       calcTps(p.tpsOutput, p.tpsDurMs),
			TpsSamples:   p.tpsSamples,
			SeriesTokens: p.seriesTokens,
			SeriesCost:   sc,
			SeriesTps:    stps,
		})
	}
	sort.Slice(outProviders, func(i, j int) bool {
		return outProviders[i].Tokens > outProviders[j].Tokens
	})

	outModels := make([]model.LocalStatsModel, 0, len(models))
	for _, m := range models {
		rate, hasRate := LookupRate(m.model)
		sc := make([]float64, len(m.seriesCost))
		for i, v := range m.seriesCost {
			sc[i] = roundUsd(v)
		}
		stps := make([]float64, len(m.seriesTpsOutput))
		for i := range m.seriesTpsOutput {
			stps[i] = calcTps(m.seriesTpsOutput[i], m.seriesTpsDurMs[i])
		}
		outModels = append(outModels, model.LocalStatsModel{
			ID:              m.id,
			Model:           m.model,
			Provider:        m.provider,
			ProviderName:    m.providerName,
			Tokens:          m.tokens,
			Totals:          m.totals,
			CostUsd:         roundUsd(m.cost),
			CacheSavingsUsd: roundUsd(m.cacheSavings),
			CategoryCost: model.LocalStatsCategoryCost{
				Input:      roundUsd(m.categoryCost.Input),
				CacheRead:  roundUsd(m.categoryCost.CacheRead),
				CacheWrite: roundUsd(m.categoryCost.CacheWrite),
				Output:     roundUsd(m.categoryCost.Output),
			},
			LeverTokens:  m.leverTokens,
			LeverCostUsd: roundUsd(m.leverCost),
			Priced:       m.priced || hasRate,
			PriceInput:   rate.Input,
			PriceOutput:  rate.Output,
			CacheHitRate: cacheHitRate(m.totals),
			Sessions:     len(m.sessions),
			Runs:         m.runs,
			AvgTps:       calcTps(m.tpsOutput, m.tpsDurMs),
			TpsSamples:   m.tpsSamples,
			SeriesTokens: m.seriesTokens,
			SeriesCost:   sc,
			SeriesTps:    stps,
		})
	}
	sort.Slice(outModels, func(i, j int) bool {
		return outModels[i].Tokens > outModels[j].Tokens
	})

	outAgents := make([]model.LocalStatsAgent, 0, len(agents))
	for _, a := range agents {
		outAgents = append(outAgents, model.LocalStatsAgent{
			ID:           a.id,
			Name:         a.name,
			Avatar:       a.avatar,
			Provider:     topMapKey(a.provTok),
			Model:        topMapKey(a.modelTok),
			Project:      topMapKey(a.projTok),
			Sessions:     len(a.sessions),
			Runs:         a.leverRuns + a.recordRuns,
			Additions:    a.additions,
			Deletions:    a.deletions,
			Tokens:       a.tokens,
			Totals:       a.totals,
			CostUsd:      roundUsd(a.cost),
			CacheHitRate: cacheHitRate(a.totals),
		})
	}
	sort.Slice(outAgents, func(i, j int) bool {
		return outAgents[i].Tokens > outAgents[j].Tokens
	})

	outProjects := make([]model.LocalStatsProject, 0, len(projects))
	for _, p := range projects {
		outProjects = append(outProjects, model.LocalStatsProject{
			ID:           p.key.id,
			Name:         p.key.name,
			Path:         tildePath(p.key.path),
			Kind:         p.key.kind,
			TopAgent:     topMapKey(p.agentTok),
			TopModel:     topMapKey(p.modelTok),
			Sessions:     len(p.sessions),
			Runs:         p.leverRuns + p.recordRuns,
			Additions:    p.additions,
			Deletions:    p.deletions,
			Tokens:       p.tokens,
			Totals:       p.totals,
			CostUsd:      roundUsd(p.cost),
			CacheHitRate: cacheHitRate(p.totals),
		})
	}
	sort.Slice(outProjects, func(i, j int) bool {
		return outProjects[i].Tokens > outProjects[j].Tokens
	})

	outSessions := make([]model.LocalStatsSession, 0, len(sessions))
	for _, sa := range sessions {
		runs := sa.recordRuns
		if sa.leverRuns > 0 {
			runs = sa.leverRuns
		}
		outSessions = append(outSessions, model.LocalStatsSession{
			ID:           sa.id,
			ChatID:       sa.chatID,
			SessionID:    sa.sessionID,
			AgentID:      sa.agentID,
			Title:        sa.title,
			Source:       sa.source,
			AgentName:    sa.agentName,
			AgentAvatar:  sa.agentAvatar,
			Project:      sa.project,
			Provider:     sa.provider,
			ProviderName: sa.provName,
			Model:        topMapKey(sa.modelTok),
			Runs:         runs,
			Additions:    sa.additions,
			Deletions:    sa.deletions,
			Tokens:       sa.tokens,
			Totals:       sa.totals,
			CostUsd:      roundUsd(sa.cost),
			CacheHitRate: cacheHitRate(sa.totals),
			UpdatedAt:    sa.updatedAt.UTC().Format(time.RFC3339),
		})
	}
	sort.Slice(outSessions, func(i, j int) bool {
		return outSessions[i].Tokens > outSessions[j].Tokens
	})
	if len(outSessions) > maxSessionOut {
		outSessions = outSessions[:maxSessionOut]
	}

	sources := slices.Clone(snap.sources)
	// Prepend Lever DB source status
	leverSrc := model.LocalStatsSource{
		ID:       "lever",
		Name:     "Lever DB",
		Path:     tildePath(filepath.Join(s.stateDir, "lever.db")),
		Status:   "ok",
		Files:    1,
		Sessions: len(leverMeta.byNative),
		Records:  leverMeta.totalRuns,
	}
	sources = append([]model.LocalStatsSource{leverSrc}, sources...)

	grandSeriesTps := make([]float64, len(slots))
	for i := range grandSeriesTpsOutput {
		grandSeriesTps[i] = calcTps(grandSeriesTpsOutput[i], grandSeriesTpsDurMs[i])
	}

	return &model.LocalStats{
		Period:          period,
		Scope:           scope,
		TimeZone:        tzName,
		Since:           since.UTC().Format(time.RFC3339),
		Until:           now.UTC().Format(time.RFC3339),
		Resolution:      resolution,
		ReadAt:          snap.scannedAt.UTC().Format(time.RFC3339),
		ScanMs:          snap.scanMs,
		Totals:          grandTotals,
		CostUsd:         roundUsd(grandCost),
		CacheSavingsUsd: roundUsd(grandSavings),
		CategoryCost: model.LocalStatsCategoryCost{
			Input:      roundUsd(grandCat.Input),
			CacheRead:  roundUsd(grandCat.CacheRead),
			CacheWrite: roundUsd(grandCat.CacheWrite),
			Output:     roundUsd(grandCat.Output),
		},
		CacheHitRate:    cacheHitRate(grandTotals),
		AvgTps:          calcTps(grandTpsOutput, grandTpsDurMs),
		TpsSamples:      grandTpsSamples,
		SessionsCount:   len(globalSessions),
		RunsCount:       grandLeverRuns + grandExternalRuns,
		LeverTokens:     leverTokens,
		LeverCostUsd:    roundUsd(leverCost),
		ExternalTokens:  extTokens,
		ExternalCostUsd: roundUsd(extCost),
		TimeSlots:       slots,
		SeriesTps:       grandSeriesTps,
		Providers:       outProviders,
		Models:          outModels,
		Agents:          outAgents,
		Projects:        outProjects,
		Sessions:        outSessions,
		Hourly:          hourlyCells,
		Sources:         sources,
	}, nil
}

// --- Scanning ---

type scanCacheBatch struct {
	mu             sync.Mutex
	seenFiles      map[string]struct{}
	dirtyFiles     map[string]cachedFile
	dirtySummaries map[string]cachedAgySummary
	dirtyRuns      map[string]cachedRun
	pruneRuns      []string
}

func newScanCacheBatch() *scanCacheBatch {
	return &scanCacheBatch{
		seenFiles:      make(map[string]struct{}),
		dirtyFiles:     make(map[string]cachedFile),
		dirtySummaries: make(map[string]cachedAgySummary),
		dirtyRuns:      make(map[string]cachedRun),
	}
}

func (b *scanCacheBatch) markSeenFile(path string) {
	b.mu.Lock()
	b.seenFiles[path] = struct{}{}
	b.mu.Unlock()
}

func (b *scanCacheBatch) markDirtyFile(path, fp string, pf parsedFile) {
	b.mu.Lock()
	b.seenFiles[path] = struct{}{}
	b.dirtyFiles[path] = cachedFile{fingerprint: fp, parsed: pf}
	b.mu.Unlock()
}

func (b *scanCacheBatch) markDirtySummary(path, fp string, summaries map[string]agySummaryMeta) {
	b.mu.Lock()
	b.dirtySummaries[path] = cachedAgySummary{Fingerprint: fp, Summaries: summaries}
	b.mu.Unlock()
}

func (b *scanCacheBatch) setRunChanges(dirty map[string]cachedRun, pruned []string) {
	b.mu.Lock()
	for id, r := range dirty {
		b.dirtyRuns[id] = r
	}
	b.pruneRuns = append(b.pruneRuns, pruned...)
	b.mu.Unlock()
}

func (s *Service) performScan(ctx context.Context) *scanSnapshot {
	started := time.Now()
	s.ensureCacheLoaded()
	cutoff := started.AddDate(0, 0, -maxRetainDays)

	dirs := s.discoverDirectories(ctx)
	batch := newScanCacheBatch()

	var (
		claudeSrc, codexSrc, agySrc, piSrc     model.LocalStatsSource
		claudeRecs, codexRecs, agyRecs, piRecs []usageRecord
		leverDB                                *leverDBSnapshot
	)

	var wg sync.WaitGroup
	wg.Add(5)
	go func() {
		defer wg.Done()
		claudeSrc, claudeRecs = s.scanJSONLDirs(ctx, "claude", "Claude Code", dirs.claude, ".jsonl", cutoff, parseClaudeFile, batch)
	}()
	go func() {
		defer wg.Done()
		codexSrc, codexRecs = s.scanJSONLDirs(ctx, "codex", "Codex", dirs.codex, ".jsonl", cutoff, parseCodexFile, batch)
	}()
	go func() {
		defer wg.Done()
		agySrc, agyRecs = s.scanAntigravityDirs(ctx, dirs.antigravity, cutoff, batch)
	}()
	go func() {
		defer wg.Done()
		piSrc, piRecs = s.scanJSONLDirs(ctx, "pi", "Pi", dirs.pi, ".jsonl", cutoff, parsePiFile, batch)
	}()
	go func() {
		defer wg.Done()
		leverDB = s.loadLeverDBSnapshot(ctx, batch)
	}()
	wg.Wait()

	var allRecords []usageRecord
	sources := []model.LocalStatsSource{claudeSrc, codexSrc, agySrc, piSrc}

	// Global dedupe across files/directories in deterministic provider order.
	dedupeIdx := make(map[string]int)
	addRecord := func(rec usageRecord) {
		if rec.Timestamp.Before(cutoff) {
			return
		}
		if rec.DedupeKey != "" {
			if idx, ok := dedupeIdx[rec.DedupeKey]; ok {
				prev := &allRecords[idx]
				prev.Totals.UncachedInput = max(prev.Totals.UncachedInput, rec.Totals.UncachedInput)
				prev.Totals.CachedInput = max(prev.Totals.CachedInput, rec.Totals.CachedInput)
				prev.Totals.CacheWrite = max(prev.Totals.CacheWrite, rec.Totals.CacheWrite)
				prev.Totals.Output = max(prev.Totals.Output, rec.Totals.Output)
				prev.Totals.Reasoning = max(prev.Totals.Reasoning, rec.Totals.Reasoning)
				prev.Totals = computeTotal(prev.Totals)
				if rec.DurationMs > prev.DurationMs {
					prev.DurationMs = rec.DurationMs
				}
				if prev.CWD == "" && rec.CWD != "" {
					prev.CWD = rec.CWD
				}
				if prev.Title == "" && rec.Title != "" {
					prev.Title = rec.Title
				}
				return
			}
			dedupeIdx[rec.DedupeKey] = len(allRecords)
		}
		allRecords = append(allRecords, rec)
	}

	for _, recs := range [][]usageRecord{claudeRecs, codexRecs, agyRecs, piRecs} {
		for _, r := range recs {
			addRecord(r)
		}
	}

	var pruneFiles []string
	if ctx.Err() == nil {
		s.mu.Lock()
		for path := range s.fileCache {
			if _, ok := batch.seenFiles[path]; !ok {
				delete(s.fileCache, path)
				pruneFiles = append(pruneFiles, path)
			}
		}
		dc := s.cache
		s.mu.Unlock()
		if dc != nil {
			dc.saveBatch(batch.dirtyFiles, batch.dirtyRuns, batch.dirtySummaries, pruneFiles, batch.pruneRuns)
		}
	}

	return &scanSnapshot{
		records:   allRecords,
		sources:   sources,
		leverDB:   leverDB,
		scannedAt: time.Now(),
		scanMs:    time.Since(started).Milliseconds(),
	}
}

type discoveredDirs struct {
	claude      []string
	codex       []string
	antigravity []string
	pi          []string
}

func (s *Service) discoverDirectories(ctx context.Context) discoveredDirs {
	home, _ := os.UserHomeDir()
	var d discoveredDirs
	addUnique := func(list *[]string, seen map[string]bool, p string) {
		if p == "" {
			return
		}
		if resolved, err := filepath.EvalSymlinks(p); err == nil {
			p = resolved
		}
		p = filepath.Clean(p)
		if !seen[p] {
			seen[p] = true
			*list = append(*list, p)
		}
	}
	seenC, seenX, seenA, seenP := map[string]bool{}, map[string]bool{}, map[string]bool{}, map[string]bool{}

	// Configured providers from Lever DB
	if s.db != nil {
		rows, err := s.db.QueryContext(ctx, "SELECT data FROM providers")
		if err == nil {
			defer rows.Close()
			for rows.Next() {
				var raw string
				if rows.Scan(&raw) != nil {
					continue
				}
				var p model.Provider
				if json.Unmarshal([]byte(raw), &p) != nil {
					continue
				}
				cfgDir := provider.ConfigurationDirectory(p)
				switch p.Type {
				case "claude":
					if cfgDir != "" {
						addUnique(&d.claude, seenC, filepath.Join(cfgDir, "projects"))
					}
				case "codex":
					if cfgDir != "" {
						addUnique(&d.codex, seenX, filepath.Join(cfgDir, "sessions"))
					}
				case "pi":
					if cfgDir != "" {
						addUnique(&d.pi, seenP, filepath.Join(cfgDir, "sessions"))
					}
				}
			}
		}
	}

	// Standard local CLI directories
	if dir := strings.TrimSpace(os.Getenv("CLAUDE_CONFIG_DIR")); dir != "" {
		addUnique(&d.claude, seenC, filepath.Join(dir, "projects"))
	} else if home != "" {
		addUnique(&d.claude, seenC, filepath.Join(home, ".claude", "projects"))
	}

	if dir := strings.TrimSpace(os.Getenv("CODEX_HOME")); dir != "" {
		addUnique(&d.codex, seenX, filepath.Join(dir, "sessions"))
	} else if home != "" {
		addUnique(&d.codex, seenX, filepath.Join(home, ".codex", "sessions"))
	}

	gemini := strings.TrimSpace(os.Getenv("GEMINI_HOME"))
	if gemini == "" && home != "" {
		gemini = filepath.Join(home, ".gemini")
	}
	if gemini != "" {
		addUnique(&d.antigravity, seenA, filepath.Join(gemini, "antigravity-cli", "conversations"))
	}
	if s.stateDir != "" {
		// Also include Lever-managed Antigravity profiles
		matches, _ := filepath.Glob(filepath.Join(s.stateDir, "providers", "antigravity", "*", "antigravity-cli", "conversations"))
		for _, m := range matches {
			addUnique(&d.antigravity, seenA, m)
		}
	}

	if dir := strings.TrimSpace(os.Getenv("PI_CODING_AGENT_SESSION_DIR")); dir != "" {
		addUnique(&d.pi, seenP, dir)
	} else if dir := strings.TrimSpace(os.Getenv("PI_CODING_AGENT_DIR")); dir != "" {
		addUnique(&d.pi, seenP, filepath.Join(dir, "sessions"))
	} else if home != "" {
		addUnique(&d.pi, seenP, filepath.Join(home, ".pi", "agent", "sessions"))
	}

	return d
}

func (s *Service) scanJSONLDirs(
	ctx context.Context,
	id, name string,
	dirs []string,
	ext string,
	cutoff time.Time,
	parser func(path string) (parsedFile, error),
	batch *scanCacheBatch,
) (model.LocalStatsSource, []usageRecord) {
	src := model.LocalStatsSource{ID: id, Name: name, Status: "missing"}
	if len(dirs) > 0 {
		src.Path = tildePath(dirs[0])
	}

	type fileEntry struct {
		path string
		fp   string
	}
	var candidates []fileEntry
	anyExists := false
	for _, dir := range dirs {
		info, err := os.Stat(dir)
		if err != nil || !info.IsDir() {
			continue
		}
		anyExists = true
		_ = filepath.WalkDir(dir, func(path string, d fs.DirEntry, err error) error {
			if err != nil || d.IsDir() || !strings.HasSuffix(d.Name(), ext) {
				return nil
			}
			fi, err := d.Info()
			if err != nil || fi.Size() == 0 || fi.ModTime().Before(cutoff) {
				return nil
			}
			fp := fmt.Sprintf("%d:%d", fi.Size(), fi.ModTime().UnixNano())
			candidates = append(candidates, fileEntry{path: path, fp: fp})
			return nil
		})
	}
	if !anyExists {
		return src, nil
	}
	src.Status = "ok"
	src.Files = len(candidates)

	results := make([]parsedFile, len(candidates))
	workers := min(max(4, runtime.NumCPU()), 8)
	if len(candidates) < workers {
		workers = max(1, len(candidates))
	}
	jobs := make(chan int, len(candidates))
	for i := range candidates {
		jobs <- i
	}
	close(jobs)

	var wg sync.WaitGroup
	for w := 0; w < workers; w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for idx := range jobs {
				if ctx.Err() != nil {
					return
				}
				c := candidates[idx]
				if pf, ok := s.getCachedFile(c.path, c.fp); ok {
					batch.markSeenFile(c.path)
					results[idx] = pf
					continue
				}
				pf, err := parser(c.path)
				if err != nil {
					continue
				}
				s.setCachedFile(c.path, c.fp, pf)
				batch.markDirtyFile(c.path, c.fp, pf)
				results[idx] = pf
			}
		}()
	}
	wg.Wait()
	if ctx.Err() != nil {
		src.Status = "partial"
	}

	var records []usageRecord
	sessSet := make(map[string]struct{})
	for _, pf := range results {
		for _, r := range pf.Records {
			records = append(records, r)
			sessSet[r.SessionID] = struct{}{}
		}
	}
	src.Sessions = len(sessSet)
	src.Records = len(records)
	return src, records
}

func (s *Service) scanAntigravityDirs(ctx context.Context, dirs []string, cutoff time.Time, batch *scanCacheBatch) (model.LocalStatsSource, []usageRecord) {
	src := model.LocalStatsSource{ID: "antigravity", Name: "Antigravity", Status: "missing"}
	if len(dirs) > 0 {
		src.Path = tildePath(dirs[0])
	}

	type dbEntry struct {
		path    string
		fp      string
		modTime time.Time
		root    string
	}
	var candidates []dbEntry
	anyExists := false
	summaries := make(map[string]agySummaryMeta)

	for _, dir := range dirs {
		info, err := os.Stat(dir)
		if err != nil || !info.IsDir() {
			continue
		}
		anyExists = true
		// Optional conversation_summaries.db sits next to conversations/
		sumPath := filepath.Join(filepath.Dir(dir), "conversation_summaries.db")
		if sfi, err := os.Stat(sumPath); err == nil {
			sumFP := sqliteFileFingerprint(sumPath, sfi)
			var sumMap map[string]agySummaryMeta
			if cached, ok := s.getCachedAgySummary(sumPath, sumFP); ok {
				sumMap = cached
			} else {
				sumMap = readAntigravitySummaries(ctx, sumPath)
				s.setCachedAgySummary(sumPath, sumFP, sumMap)
				batch.markDirtySummary(sumPath, sumFP, sumMap)
			}
			for k, v := range sumMap {
				summaries[k] = v
			}
		}
		entries, err := os.ReadDir(dir)
		if err != nil {
			continue
		}
		for _, e := range entries {
			if e.IsDir() || !strings.HasSuffix(e.Name(), ".db") {
				continue
			}
			p := filepath.Join(dir, e.Name())
			fi, err := e.Info()
			if err != nil || fi.Size() == 0 {
				continue
			}
			modTime := fi.ModTime()
			walPart := "-"
			if wfi, err := os.Stat(p + "-wal"); err == nil {
				walPart = fmt.Sprintf("%d:%d", wfi.Size(), wfi.ModTime().UnixNano())
				if wfi.ModTime().After(modTime) {
					modTime = wfi.ModTime()
				}
			}
			if modTime.Before(cutoff) {
				continue
			}
			fp := fmt.Sprintf("%d:%d/%s", fi.Size(), fi.ModTime().UnixNano(), walPart)
			candidates = append(candidates, dbEntry{path: p, fp: fp, modTime: modTime, root: dir})
		}
	}
	if !anyExists {
		return src, nil
	}
	src.Status = "ok"
	src.Files = len(candidates)

	results := make([]parsedFile, len(candidates))
	workers := min(max(4, runtime.NumCPU()), 8)
	if len(candidates) < workers {
		workers = max(1, len(candidates))
	}
	jobs := make(chan int, len(candidates))
	for i := range candidates {
		jobs <- i
	}
	close(jobs)

	var wg sync.WaitGroup
	for w := 0; w < workers; w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for idx := range jobs {
				if ctx.Err() != nil {
					return
				}
				c := candidates[idx]
				if pf, ok := s.getCachedFile(c.path, c.fp); ok {
					batch.markSeenFile(c.path)
					results[idx] = pf
					continue
				}
				pf, err := parseAntigravityDB(ctx, c.path, c.modTime)
				if err != nil {
					continue
				}
				s.setCachedFile(c.path, c.fp, pf)
				batch.markDirtyFile(c.path, c.fp, pf)
				results[idx] = pf
			}
		}()
	}
	wg.Wait()

	var records []usageRecord
	sessSet := make(map[string]struct{})
	for _, pf := range results {
		for _, r := range pf.Records {
			if sm, ok := summaries[r.SessionID]; ok {
				if r.Title == "" {
					r.Title = sm.Title
				}
				if r.CWD == "" {
					r.CWD = sm.CWD
				}
			}
			records = append(records, r)
			sessSet[r.SessionID] = struct{}{}
		}
	}
	src.Sessions = len(sessSet)
	src.Records = len(records)
	return src, records
}

func sqliteFileFingerprint(path string, fi fs.FileInfo) string {
	walPart := "-"
	if wfi, err := os.Stat(path + "-wal"); err == nil {
		walPart = fmt.Sprintf("%d:%d", wfi.Size(), wfi.ModTime().UnixNano())
	}
	return fmt.Sprintf("%d:%d/%s", fi.Size(), fi.ModTime().UnixNano(), walPart)
}

func (s *Service) getCachedFile(path, fp string) (parsedFile, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if c, ok := s.fileCache[path]; ok && c.fingerprint == fp {
		return c.parsed, true
	}
	return parsedFile{}, false
}

func (s *Service) setCachedFile(path, fp string, pf parsedFile) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.fileCache[path] = cachedFile{fingerprint: fp, parsed: pf}
}

func (s *Service) getCachedAgySummary(path, fp string) (map[string]agySummaryMeta, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if c, ok := s.agySumCache[path]; ok && c.Fingerprint == fp {
		return c.Summaries, true
	}
	return nil, false
}

func (s *Service) setCachedAgySummary(path, fp string, summaries map[string]agySummaryMeta) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.agySumCache[path] = cachedAgySummary{Fingerprint: fp, Summaries: summaries}
}

// --- Lever DB Correlation ---

type leverSessionMeta struct {
	sessionID   string
	chatID      string
	agentID     string
	agentName   string
	agentAvatar *model.Avatar
	projectID   string
	projectName string
	projectPath string
	projectKind string
	primaryRoot string
	title       string
	windowRuns  int
	additions   int
	deletions   int
}

type leverIndex struct {
	byNative      map[string]leverSessionMeta
	projectByRoot map[string]projectKey
	totalRuns     int
	windowRuns    int
}

func isTerminalRunStatus(status string) bool {
	switch status {
	case "completed", "failed", "interrupted", "cancelled", "steered", "done":
		return true
	default:
		return false
	}
}

func (s *Service) loadLeverDBSnapshot(ctx context.Context, batch *scanCacheBatch) *leverDBSnapshot {
	snap := &leverDBSnapshot{
		byNative:      make(map[string]leverSessionMeta),
		projectByRoot: make(map[string]projectKey),
	}
	if s.db == nil {
		return snap
	}

	agents := make(map[string]model.Agent)
	if rows, err := s.db.QueryContext(ctx, "SELECT data FROM agents"); err == nil {
		for rows.Next() {
			var raw string
			var a model.Agent
			if rows.Scan(&raw) == nil && json.Unmarshal([]byte(raw), &a) == nil {
				agents[a.ID] = a
			}
		}
		rows.Close()
	}

	projects := make(map[string]model.Project)
	if rows, err := s.db.QueryContext(ctx, "SELECT data FROM projects"); err == nil {
		for rows.Next() {
			var raw string
			var p model.Project
			if rows.Scan(&raw) == nil && json.Unmarshal([]byte(raw), &p) == nil {
				projects[p.ID] = p
				projPath := primaryRootPath(p.Scope)
				projKind := "folder"
				canonPath := ""
				if projPath != "" {
					resolved := s.resolveProject(projPath)
					projKind = resolved.kind
					canonPath = resolved.path
				}
				pk := projectKey{
					id:   "proj:" + p.ID,
					name: p.Name,
					path: projPath,
					kind: projKind,
				}
				if canonPath != "" {
					snap.projectByRoot[canonPath] = pk
				}
				if projPath != "" {
					snap.projectByRoot[filepath.Clean(projPath)] = pk
				}
			}
		}
		rows.Close()
	}

	chats := make(map[string]model.Chat)
	if rows, err := s.db.QueryContext(ctx, "SELECT data FROM chats"); err == nil {
		for rows.Next() {
			var raw string
			var c model.Chat
			if rows.Scan(&raw) == nil && json.Unmarshal([]byte(raw), &c) == nil {
				chats[c.ID] = c
			}
		}
		rows.Close()
	}

	// Fast metadata scan (avoids reading multi-MB runs.data JSON blobs for cached terminal runs).
	type runMetaRow struct {
		id        string
		sessionID string
		status    string
	}
	var metaRows []runMetaRow
	if rows, err := s.db.QueryContext(ctx, "SELECT id, session_id, status FROM runs"); err == nil {
		for rows.Next() {
			var m runMetaRow
			if rows.Scan(&m.id, &m.sessionID, &m.status) == nil {
				metaRows = append(metaRows, m)
			}
		}
		rows.Close()
	}

	snap.totalRuns = len(metaRows)
	seenRunIDs := make(map[string]struct{}, len(metaRows))
	statusByID := make(map[string]string, len(metaRows))
	resolvedRuns := make(map[string]cachedRun, len(metaRows))
	var fetchIDs []string

	s.mu.Lock()
	for _, m := range metaRows {
		seenRunIDs[m.id] = struct{}{}
		statusByID[m.id] = m.status
		if cr, ok := s.runCache[m.id]; ok && isTerminalRunStatus(m.status) && cr.Status == m.status {
			resolvedRuns[m.id] = cr
			continue
		}
		fetchIDs = append(fetchIDs, m.id)
	}
	var pruneRuns []string
	if ctx.Err() == nil {
		for id := range s.runCache {
			if _, ok := seenRunIDs[id]; !ok {
				delete(s.runCache, id)
				pruneRuns = append(pruneRuns, id)
			}
		}
	}
	s.mu.Unlock()

	dirtyRuns := make(map[string]cachedRun)
	const runFetchChunk = 50
	for start := 0; start < len(fetchIDs); start += runFetchChunk {
		if ctx.Err() != nil {
			break
		}
		end := min(len(fetchIDs), start+runFetchChunk)
		chunk := fetchIDs[start:end]
		placeholders := strings.Repeat("?,", len(chunk))
		placeholders = placeholders[:len(placeholders)-1]
		args := make([]any, len(chunk))
		for i, id := range chunk {
			args[i] = id
		}
		q := `SELECT id,
		       COALESCE(json_extract(data, '$.createdAt'), ''),
		       COALESCE(json_extract(data, '$.changes'), ''),
		       COALESCE(json_extract(data, '$.turnDiff'), '')
		FROM runs WHERE id IN (` + placeholders + `)`
		rows, err := s.db.QueryContext(ctx, q, args...)
		if err != nil {
			continue
		}
		for rows.Next() {
			var id, createdAt, changesRaw, turnDiffRaw string
			if rows.Scan(&id, &createdAt, &changesRaw, &turnDiffRaw) != nil {
				continue
			}
			ts, _ := parseTimestamp(createdAt)
			var changes []model.RunChanges
			var turnDiff *model.TurnPatch
			if changesRaw != "" && changesRaw != "null" {
				_ = json.Unmarshal([]byte(changesRaw), &changes)
			}
			if len(changes) == 0 && turnDiffRaw != "" && turnDiffRaw != "null" {
				var tp model.TurnPatch
				if json.Unmarshal([]byte(turnDiffRaw), &tp) == nil {
					turnDiff = &tp
				}
			}
			add, del := runDiffTotals(changes, turnDiff)
			cr := cachedRun{
				Status:    statusByID[id],
				CreatedAt: ts,
				Additions: add,
				Deletions: del,
			}
			resolvedRuns[id] = cr
			if isTerminalRunStatus(cr.Status) {
				dirtyRuns[id] = cr
			}
		}
		rows.Close()
	}

	if len(dirtyRuns) > 0 {
		s.mu.Lock()
		for id, cr := range dirtyRuns {
			s.runCache[id] = cr
		}
		s.mu.Unlock()
	}
	if batch != nil && (len(dirtyRuns) > 0 || len(pruneRuns) > 0) {
		batch.setRunChanges(dirtyRuns, pruneRuns)
	}

	snap.runs = make([]leverRunRecord, 0, len(metaRows))
	for _, m := range metaRows {
		cr, ok := resolvedRuns[m.id]
		if !ok || cr.CreatedAt.IsZero() {
			continue
		}
		snap.runs = append(snap.runs, leverRunRecord{
			sessionID: m.sessionID,
			createdAt: cr.CreatedAt,
			additions: cr.Additions,
			deletions: cr.Deletions,
		})
	}

	if rows, err := s.db.QueryContext(ctx, "SELECT data FROM sessions"); err == nil {
		for rows.Next() {
			var raw string
			var sess model.Session
			if rows.Scan(&raw) != nil || json.Unmarshal([]byte(raw), &sess) != nil {
				continue
			}
			if sess.NativeID == "" {
				continue
			}
			a := agents[sess.AgentID]
			c := chats[sess.ChatID]
			title := strings.TrimSpace(sess.Title)
			if title == "" {
				title = strings.TrimSpace(c.Title)
			}
			var projID, projName, projPath, projKind string
			pid := sess.ProjectID
			if pid == "" {
				pid = a.Profile.ProjectID
			}
			if p, ok := projects[pid]; ok {
				projID = "proj:" + p.ID
				projName = p.Name
				projPath = primaryRootPath(p.Scope)
				projKind = "folder"
				if projPath != "" {
					resolved := s.resolveProject(projPath)
					projKind = resolved.kind
				}
			}
			rootPath := primaryRootPath(sess.Scope)
			if rootPath == "" {
				rootPath = primaryRootPath(a.Profile.Scope)
			}
			snap.byNative[sess.NativeID] = leverSessionMeta{
				sessionID:   sess.ID,
				chatID:      sess.ChatID,
				agentID:     sess.AgentID,
				agentName:   a.Name,
				agentAvatar: a.Avatar,
				projectID:   projID,
				projectName: projName,
				projectPath: projPath,
				projectKind: projKind,
				primaryRoot: rootPath,
				title:       title,
			}
		}
		rows.Close()
	}

	return snap
}

func primaryRootPath(scope model.Scope) string {
	for _, r := range scope.Roots {
		if r.ID == scope.PrimaryRootID && r.Path != "" {
			return r.Path
		}
	}
	if len(scope.Roots) > 0 {
		return scope.Roots[0].Path
	}
	return ""
}

func runDiffTotals(changes []model.RunChanges, patch *model.TurnPatch) (add, del int) {
	if len(changes) > 0 {
		for _, ch := range changes {
			for _, f := range ch.Files {
				add += f.Additions
				del += f.Deletions
			}
		}
		return add, del
	}
	if patch != nil {
		for _, f := range patch.Files {
			add += f.Additions
			del += f.Deletions
		}
	}
	return add, del
}

// --- Project Path Resolution ---

func (s *Service) resolveProjectWithLever(rawPath string, leverMeta leverIndex) projectKey {
	pk := s.resolveProject(rawPath)
	if pk.path != "" {
		if matched, ok := leverMeta.projectByRoot[pk.path]; ok {
			return matched
		}
	}
	if raw := strings.TrimSpace(rawPath); raw != "" {
		if matched, ok := leverMeta.projectByRoot[filepath.Clean(raw)]; ok {
			return matched
		}
	}
	return pk
}

func (s *Service) resolveProject(rawPath string) projectKey {
	p := strings.TrimSpace(rawPath)
	if p == "" {
		return projectKey{id: "chat:general", name: "", path: "", kind: "chat"}
	}
	p = filepath.Clean(p)
	s.mu.Lock()
	if cached, ok := s.projectMemo[p]; ok {
		s.mu.Unlock()
		return cached
	}
	s.mu.Unlock()

	pk := detectProject(p)
	s.mu.Lock()
	s.projectMemo[p] = pk
	s.mu.Unlock()
	return pk
}

func detectProject(cleanPath string) projectKey {
	home, _ := os.UserHomeDir()
	if home != "" && cleanPath == filepath.Clean(home) {
		return projectKey{id: "folder:~", name: "~", path: cleanPath, kind: "folder"}
	}
	// Walk upward to locate a .git marker so subdirectories group under their repository.
	cur := cleanPath
	for i := 0; i < 8; i++ {
		if _, err := os.Stat(filepath.Join(cur, ".git")); err == nil {
			base := filepath.Base(cur)
			if base == "" || base == "/" {
				base = cur
			}
			return projectKey{id: "git:" + cur, name: base, path: cur, kind: "git"}
		}
		parent := filepath.Dir(cur)
		if parent == cur || (home != "" && parent == filepath.Clean(home)) {
			break
		}
		cur = parent
	}
	base := filepath.Base(cleanPath)
	if base == "" || base == "/" || base == "." {
		base = cleanPath
	}
	return projectKey{id: "folder:" + cleanPath, name: base, path: cleanPath, kind: "folder"}
}

func tildePath(p string) string {
	if p == "" {
		return ""
	}
	home, err := os.UserHomeDir()
	if err == nil && home != "" && strings.HasPrefix(p, home) {
		rest := strings.TrimPrefix(p, home)
		if rest == "" || strings.HasPrefix(rest, string(filepath.Separator)) {
			return "~" + rest
		}
	}
	return p
}

// --- Math Helpers ---

func addTotals(a, b model.TokenTotals) model.TokenTotals {
	return model.TokenTotals{
		UncachedInput: a.UncachedInput + b.UncachedInput,
		CachedInput:   a.CachedInput + b.CachedInput,
		CacheWrite:    a.CacheWrite + b.CacheWrite,
		Output:        a.Output + b.Output,
		Reasoning:     a.Reasoning + b.Reasoning,
		Total:         a.Total + b.Total,
	}
}

func cacheHitRate(t model.TokenTotals) float64 {
	denom := t.UncachedInput + t.CachedInput + t.CacheWrite
	if denom <= 0 {
		return 0
	}
	return float64(t.CachedInput) / float64(denom)
}

func roundUsd(v float64) float64 {
	return float64(int64(v*10000+0.5)) / 10000
}

func topMapKey(m map[string]int64) string {
	var best string
	var bestV int64
	for k, v := range m {
		if k == "" {
			continue
		}
		if v > bestV || (v == bestV && k < best) {
			best, bestV = k, v
		}
	}
	return best
}
