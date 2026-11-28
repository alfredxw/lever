import { useCallback, useState } from "react";
import { keepPreviousData, useQueries, useQuery } from "@tanstack/react-query";
import { api, queryClient } from "@/api/client";
import type {
  LocalStats,
  LocalStatsQuickSummary,
  ProviderInfo,
} from "@/api/types.gen";
import {
  resolveSubscriptions,
  usageSources,
  type Subscription,
  type UsageResponse,
} from "@/features/runtime/subscriptionUsageModel";

export type LocalStatsPeriod = "24h" | "7d" | "30d" | "90d";
export type LocalStatsScope = "all" | "lever";

const MINUTE_MS = 60_000;
const USAGE_STALE_MS = 30_000;

export function localStatsQueryKey(
  period: LocalStatsPeriod,
  scope: LocalStatsScope,
  timeZone: string,
) {
  return ["local-stats", period, scope, timeZone] as const;
}

export function localStatsSummaryQueryKey(timeZone: string) {
  return ["local-stats-summary", timeZone] as const;
}

function fetchLocalStats(
  period: LocalStatsPeriod,
  scope: LocalStatsScope,
  timeZone: string,
  signal?: AbortSignal,
) {
  const params = new URLSearchParams({ period, scope });
  if (timeZone) params.set("tz", timeZone);
  return api<LocalStats>(
    `/stats/local?${params.toString()}`,
    undefined,
    "GET",
    signal,
  );
}

function fetchLocalStatsSummary(timeZone: string, signal?: AbortSignal) {
  const params = new URLSearchParams();
  if (timeZone) params.set("tz", timeZone);
  const qs = params.toString();
  return api<LocalStatsQuickSummary>(
    `/stats/local/summary${qs ? `?${qs}` : ""}`,
    undefined,
    "GET",
    signal,
  );
}

export function prefetchLocalStatsSummary(timeZone: string) {
  return queryClient.prefetchQuery({
    queryKey: localStatsSummaryQueryKey(timeZone),
    staleTime: USAGE_STALE_MS,
    queryFn: ({ signal }) => fetchLocalStatsSummary(timeZone, signal),
  });
}

export function prefetchLocalStats(
  period: LocalStatsPeriod,
  scope: LocalStatsScope,
  timeZone: string,
) {
  return queryClient.prefetchQuery({
    queryKey: localStatsQueryKey(period, scope, timeZone),
    staleTime: USAGE_STALE_MS,
    queryFn: ({ signal }) => fetchLocalStats(period, scope, timeZone, signal),
  });
}

export function useLocalStats(
  period: LocalStatsPeriod,
  scope: LocalStatsScope,
  timeZone: string,
  enabled: boolean,
) {
  const [refreshing, setRefreshing] = useState(false);

  const query = useQuery<LocalStats>({
    queryKey: localStatsQueryKey(period, scope, timeZone),
    enabled,
    staleTime: USAGE_STALE_MS,
    placeholderData: keepPreviousData,
    queryFn: ({ signal }) => fetchLocalStats(period, scope, timeZone, signal),
  });

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const params = new URLSearchParams({ period, scope, refresh: "true" });
      if (timeZone) params.set("tz", timeZone);
      const fresh = await api<LocalStats>(
        `/stats/local?${params.toString()}`,
        undefined,
        "GET",
      );
      queryClient.setQueryData(localStatsQueryKey(period, scope, timeZone), fresh);
      void queryClient.invalidateQueries({ queryKey: ["local-stats-summary"] });
    } finally {
      setRefreshing(false);
    }
  }, [period, scope, timeZone]);

  return { ...query, refreshing, refresh };
}

export function useLocalStatsSummary(timeZone: string, enabled: boolean) {
  return useQuery({
    queryKey: localStatsSummaryQueryKey(timeZone),
    enabled,
    staleTime: USAGE_STALE_MS,
    placeholderData: keepPreviousData,
    retry: false,
    queryFn: ({ signal }) => fetchLocalStatsSummary(timeZone, signal),
  });
}

export function useSubscriptionUsage(providers: ProviderInfo[]): {
  subscriptions: Subscription[];
  refreshAll: () => Promise<void>;
} {
  const sources = usageSources(providers);
  const samples = useQueries({
    queries: sources.map(({ id, reportsUsage }) => ({
      queryKey: ["provider-usage", id],
      enabled: !!reportsUsage,
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        api<UsageResponse>(
          `/providers/${encodeURIComponent(id)}/usage`,
          undefined,
          "GET",
          signal,
        ),
      staleTime: USAGE_STALE_MS,
      refetchInterval: MINUTE_MS,
      refetchOnWindowFocus: true,
      retry: false,
    })),
  });

  const refreshAll = useCallback(async () => {
    await Promise.all(
      sources
        .filter((s) => s.reportsUsage)
        .map(async (s) => {
          try {
            const data = await api<UsageResponse>(
              `/providers/${encodeURIComponent(s.id)}/usage?refresh=true`,
              undefined,
              "GET",
            );
            queryClient.setQueryData(["provider-usage", s.id], data);
          } catch {
            void queryClient.invalidateQueries({
              queryKey: ["provider-usage", s.id],
            });
          }
        }),
    );
  }, [sources]);

  return {
    subscriptions: resolveSubscriptions(sources, samples),
    refreshAll,
  };
}
