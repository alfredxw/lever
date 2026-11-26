import type {
  ProviderInfo,
  ProviderUsage,
  UsageWindow,
} from "@/api/types.gen";

export type UsageResponse = ProviderUsage | UsageWindow[] | null;

export type UsageSampleState = {
  data?: UsageResponse;
  isPending: boolean;
  isError: boolean;
};

export type Subscription = {
  provider: ProviderInfo;
  windows: UsageWindow[];
  sampledAt?: string;
  stale?: boolean;
  notice?: string;
};

export function usageSources(providers: ProviderInfo[]) {
  const seen = new Set<string>();
  return providers.filter((provider) => {
    const localAgy = provider.type === "antigravity" && provider.auth === "cli";
    if (
      !provider.available ||
      !provider.installed ||
      !(
        provider.reportsUsage ||
        (localAgy && provider.reportsUsage === undefined)
      )
    )
      return false;
    // Multiple runtime entries can launch exactly the same native profile.
    const profile = JSON.stringify([
      provider.type,
      provider.path,
      provider.configPath ||
        (provider.type === "antigravity" && provider.auth === "cli"
          ? "local"
          : provider.id),
    ]);
    if (seen.has(profile)) return false;
    seen.add(profile);
    return true;
  });
}

export function normalizeUsageResponse(
  data: UsageResponse | undefined,
): ProviderUsage | undefined {
  if (data === undefined) return undefined;
  if (data === null) return { windows: [] };
  if (Array.isArray(data)) return { windows: data };
  return {
    windows: data.windows ?? [],
    sampledAt: data.sampledAt,
    stale: data.stale,
  };
}

export function liveUsageWindows(
  windows: UsageWindow[],
  now = Date.now(),
): UsageWindow[] {
  return windows.filter((window) => {
    if (!window.resetsAt) return true;
    const reset = Date.parse(window.resetsAt);
    return Number.isNaN(reset) || reset > now;
  });
}

export function resolveSubscriptions(
  sources: ProviderInfo[],
  samples: UsageSampleState[],
  now = Date.now(),
): Subscription[] {
  return sources.flatMap<Subscription>((provider, i) => {
    const sample = samples[i];
    const usage = normalizeUsageResponse(sample?.data);
    const windows = liveUsageWindows(usage?.windows ?? [], now);
    if (windows.length) {
      const stale = !!usage?.stale || !!sample?.isError;
      return [
        {
          provider,
          windows,
          sampledAt: usage?.sampledAt,
          stale,
          notice: stale ? "usage.lastReading" : undefined,
        },
      ];
    }
    if (!provider.reportsUsage) {
      return provider.type === "antigravity"
        ? [{ provider, windows, notice: "usage.backendUpdate" }]
        : [];
    }
    if (sample?.isPending) {
      return [{ provider, windows, notice: "usage.loading" }];
    }
    if (sample?.isError) {
      return [
        {
          provider,
          windows,
          notice:
            provider.type === "antigravity"
              ? "usage.readFailedAgy"
              : "usage.readFailed",
        },
      ];
    }
    if (provider.type === "antigravity") {
      return [{ provider, windows, notice: "usage.noAllowance" }];
    }
    return [];
  });
}
