package app

import (
	"context"

	"lever/internal/localstats"
	"lever/internal/model"
)

func (a *App) LocalStats(ctx context.Context, q localstats.Query) (*model.LocalStats, error) {
	return a.localStats.Stats(ctx, q)
}

func (a *App) LocalStatsSummary(ctx context.Context, tz string) (*model.LocalStatsQuickSummary, error) {
	return a.localStats.Summary(ctx, tz)
}

func (a *App) WarmLocalStats() {
	a.mu.Lock()
	if a.closed {
		a.mu.Unlock()
		return
	}
	a.wg.Add(1)
	a.mu.Unlock()
	go func() {
		defer a.wg.Done()
		a.localStats.Warm(a.ctx)
	}()
}
