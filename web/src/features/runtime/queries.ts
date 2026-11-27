import { queryOptions, useQuery } from "@tanstack/react-query";
import { api, APIError, queryClient } from "@/api/client";
import type {
  Agent,
  Catalog,
  Overview,
  Provider,
  ProviderCandidate,
  ProviderInfo,
  Selection,
} from "@/api/types.gen";

export const providersQuery = queryOptions({
  queryKey: ["providers"],
  queryFn: ({ signal }) =>
    api<ProviderInfo[]>("/providers", undefined, "GET", signal),
  staleTime: 60_000,
  refetchOnWindowFocus: true,
});

export function useProviders() {
  return useQuery(providersQuery);
}

export const connectionsQuery = queryOptions({
  ...providersQuery,
  queryKey: ["providers", "connections"],
  queryFn: ({ signal }) =>
    api<ProviderInfo[]>("/providers?login=true", undefined, "GET", signal),
  placeholderData: () => queryClient.getQueryData(providersQuery.queryKey),
  refetchOnWindowFocus: "always" as const,
});

export const providerCandidatesQuery = queryOptions({
  queryKey: ["providers", "candidates"],
  queryFn: ({ signal }) =>
    discoveryRequest<ProviderCandidate[]>("/provider-candidates", signal),
  refetchOnWindowFocus: "always" as const,
});

// A desktop can reconnect to an older backend while that backend owns live runs.
// Only discovery's missing routes mean "unavailable on this backend".
async function discoveryRequest<T>(
  path: string,
  signal?: AbortSignal,
  body?: object,
) {
  try {
    return await api<T>(
      path,
      body,
      body === undefined ? "GET" : "POST",
      signal,
    );
  } catch (error) {
    if (
      error instanceof APIError &&
      error.status === 404 &&
      error.message.trim() === "404 page not found"
    )
      return null;
    throw error;
  }
}

export async function scanLocalProviders() {
  if ((await queryClient.fetchQuery(providerCandidatesQuery)) === null)
    return null;
  return discoveryRequest<{ connected: boolean }>(
    "/provider-candidates/scan",
    undefined,
    {},
  );
}

export async function setModelVisibility(
  provider: string,
  models: string[],
  visible: boolean,
) {
  const saved = await api<Provider>(
    `/providers/${encodeURIComponent(provider)}/models/visibility`,
    { models, visible },
    "PATCH",
  );
  const update = (current: ProviderInfo[] | undefined) =>
    current?.map((item) =>
      item.id === provider
        ? { ...item, hiddenModels: saved.hiddenModels }
        : item,
    );
  queryClient.setQueryData<ProviderInfo[]>(providersQuery.queryKey, update);
  queryClient.setQueryData<ProviderInfo[]>(connectionsQuery.queryKey, update);
}

const catalogRetryMs = 30_000;

export function isAntigravityCLIAuthRequired(error: unknown) {
  return (
    error instanceof APIError && error.code === "antigravity_cli_auth_required"
  );
}

export function modelsQuery(provider: string, cwd = "") {
  return queryOptions({
    queryKey: ["models", provider, cwd],
    queryFn: () =>
      api<Catalog | null>(
        `/providers/${provider}/models?cwd=${encodeURIComponent(cwd)}`,
      ),
    staleTime: (query) => {
      const catalog = query.state.data;
      return catalog === null
        ? 0
        : catalog?.provisional
          ? catalogRetryMs
          : 5 * 60_000;
    },
    refetchInterval: ({ state }) =>
      state.data && (state.data.provisional || state.status === "error")
        ? catalogRetryMs
        : false,
    refetchOnWindowFocus: true,
    retry: false,
  });
}

export function useModels(provider: string, cwd = "", enabled = true) {
  return useQuery({ ...modelsQuery(provider, cwd), enabled });
}

export function refreshModels(provider: string, cwd = "") {
  return queryClient.fetchQuery({
    ...modelsQuery(provider, cwd),
    queryFn: () =>
      api<Catalog | null>(
        `/providers/${provider}/models?refresh=true&cwd=${encodeURIComponent(cwd)}`,
      ),
    staleTime: 0,
  });
}

const agentSelectionSeq = new Map<string, number>();

export async function persistAgentSelection(
  agentId: string,
  selection: Pick<Selection, "provider" | "model" | "effort" | "fast">,
) {
  if (!agentId || !selection.provider) return;
  const clean: Selection = {
    provider: selection.provider,
    model: selection.model,
    effort: selection.effort,
    fast: Boolean(selection.fast),
  };
  const seq = (agentSelectionSeq.get(agentId) ?? 0) + 1;
  agentSelectionSeq.set(agentId, seq);
  queryClient.setQueryData<Overview>(["overview"], (current) => {
    if (!current) return current;
    return {
      ...current,
      lastSelection: clean,
      agents: current.agents.map((item) =>
        item.id === agentId
          ? {
              ...item,
              profile: {
                ...item.profile,
                provider: clean.provider,
                model: clean.model,
                effort: clean.effort || undefined,
                fast: clean.fast || undefined,
              },
            }
          : item,
      ),
    };
  });
  try {
    const saved = await api<Agent>(
      `/agents/${encodeURIComponent(agentId)}/selection`,
      clean,
      "PUT",
    );
    if (agentSelectionSeq.get(agentId) !== seq) return;
    queryClient.setQueryData<Overview>(["overview"], (current) => {
      if (!current) return current;
      return {
        ...current,
        lastSelection: clean,
        agents: current.agents.map((item) =>
          item.id === saved.id ? saved : item,
        ),
      };
    });
  } catch {
    if (agentSelectionSeq.get(agentId) === seq) {
      void queryClient.invalidateQueries({ queryKey: ["overview"] });
    }
  }
}
