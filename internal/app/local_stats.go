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
