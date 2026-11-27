import { useMemo, useSyncExternalStore } from "react";
import type { Agent, Selection } from "@/api/types.gen";
import {
  isMeaningfulEffortSource,
  type EffortSource,
} from "./effortMapping.ts";

export type RuntimePreferences = {
  provider?: string;
  models: Record<string, Pick<Selection, "model" | "effort" | "fast">>;
  favoriteSelections?: Record<string, string>;
  permissions?: Record<string, string>;
  effortHabit?: EffortSource;
};

const changes = new EventTarget();
// Keep the existing key so previously saved model choices still load.
const storageKey = (agentId: string) => `lever:model-preferences:${agentId}`;
const starredModelsKey = (provider: string) =>
  `lever:starred-models:${provider}`;

function parse(raw: string | null): RuntimePreferences | undefined {
  try {
    const saved = raw === null ? undefined : JSON.parse(raw);
    return saved?.models ? saved : undefined;
  } catch {
    return undefined;
  }
}

function subscribe(notify: () => void) {
  changes.addEventListener("change", notify);
  window.addEventListener("storage", notify);
  return () => {
    changes.removeEventListener("change", notify);
    window.removeEventListener("storage", notify);
  };
}

function useStoredPreference(key: string) {
  return useSyncExternalStore(subscribe, () => localStorage.getItem(key));
}

function savePreference(key: string, value: unknown) {
  localStorage.setItem(key, JSON.stringify(value));
  changes.dispatchEvent(new Event("change"));
}

export function readRuntimePreferences(agentId: string) {
  if (!agentId || typeof localStorage === "undefined") return undefined;
  return parse(localStorage.getItem(storageKey(agentId)));
}

export function agentProfileSelection(
  profile: Pick<Agent["profile"], "provider" | "model" | "effort" | "fast">,
): Selection {
  return {
    provider: profile.provider,
    model: profile.model,
    effort: profile.effort ?? "",
    fast: Boolean(profile.fast),
  };
}

export function selectionForAgentProvider(
  profile: Pick<Agent["profile"], "provider" | "model" | "effort" | "fast">,
  provider: string,
  preferences?: RuntimePreferences,
  previous?: Selection,
): Selection {
  if (previous) {
    return {
      provider: previous.provider,
      model: previous.model,
      effort: previous.effort,
      fast: previous.fast,
    };
  }
  const fallback: Selection =
    provider === profile.provider
      ? agentProfileSelection(profile)
      : { provider, model: "", effort: "", fast: false };
  const remembered = preferences?.models[provider];
  return {
    provider,
    model: remembered?.model ?? fallback.model,
    effort: remembered?.effort ?? fallback.effort,
    fast: remembered?.fast ?? fallback.fast,
  };
}

export function recentAgentSelection(
  profile: Pick<Agent["profile"], "provider" | "model" | "effort" | "fast">,
  preferences?: RuntimePreferences,
): Selection | undefined {
  if (!preferences?.provider) return undefined;
  return selectionForAgentProvider(profile, preferences.provider, preferences);
}

export function useRuntimePreferences(agentId: string) {
  const raw = useStoredPreference(storageKey(agentId));
  return useMemo(() => parse(raw), [raw]);
}

export function useAgentRuntimePreferences(agentIds: string[]) {
  const raw = useSyncExternalStore(subscribe, () =>
    JSON.stringify(agentIds.map((id) => localStorage.getItem(storageKey(id)))),
  );
  return useMemo(
    () => (JSON.parse(raw) as (string | null)[]).map(parse),
    [raw],
  );
}

function updatePreferences(
  agentId: string,
  update: (previous: RuntimePreferences) => RuntimePreferences,
) {
  const key = storageKey(agentId);
  const previous = parse(localStorage.getItem(key)) ?? { models: {} };
  savePreference(key, update(previous));
}

function parseStarredModels(raw: string | null): Set<string> {
  try {
    const ids: unknown = JSON.parse(raw ?? "[]");
    return new Set(
      Array.isArray(ids) ? ids.filter((id) => typeof id === "string") : [],
    );
  } catch {
    return new Set();
  }
}

export function useStarredModels(provider: string) {
  const raw = useStoredPreference(starredModelsKey(provider));
  const starred = useMemo(() => parseStarredModels(raw), [raw]);
  return {
    starred,
    toggleStar: (model: string) => toggleModelStar(provider, model),
  };
}

export function useStarredModelsByProvider(providers: string[]) {
  const raw = useSyncExternalStore(subscribe, () =>
    JSON.stringify(
      providers.map((id) => [id, localStorage.getItem(starredModelsKey(id))]),
    ),
  );
  return useMemo(() => {
    const entries: [string, string | null][] = JSON.parse(raw);
    return new Map(
      entries.map(([id, saved]) => [id, parseStarredModels(saved)]),
    );
  }, [raw]);
}

export function toggleModelStar(provider: string, model: string) {
  const key = starredModelsKey(provider);
  const next = parseStarredModels(localStorage.getItem(key));
  if (next.has(model)) next.delete(model);
  else next.add(model);
  savePreference(key, [...next]);
}

export function rememberModel(
  agentId: string,
  { provider, model, effort, fast }: Selection,
  fromFavorites?: boolean,
  modelEfforts?: readonly string[],
) {
  updatePreferences(agentId, (previous) => {
    const favoriteSelections = { ...previous.favoriteSelections };
    if (fromFavorites) favoriteSelections[provider] = model;
    else if (fromFavorites === false) delete favoriteSelections[provider];
    const effortHabit =
      effort && isMeaningfulEffortSource(effort, modelEfforts)
        ? {
            effort,
            ...(modelEfforts?.length ? { efforts: [...modelEfforts] } : {}),
          }
        : previous.effortHabit;
    return {
      ...previous,
      provider,
      models: { ...previous.models, [provider]: { model, effort, fast } },
      favoriteSelections,
      effortHabit,
    };
  });
}

export function rememberPermission(
  agentId: string,
  provider: string,
  permission: string,
) {
  updatePreferences(agentId, (previous) => ({
    ...previous,
    permissions: { ...previous.permissions, [provider]: permission },
  }));
}

export function resetModelPreferences(agentId: string) {
  updatePreferences(agentId, (previous) => ({
    ...previous,
    provider: undefined,
    models: {},
    favoriteSelections: undefined,
    effortHabit: undefined,
  }));
}

export function resetPermissionPreference(agentId: string, provider: string) {
  updatePreferences(agentId, (previous) => {
    const permissions = { ...previous.permissions };
    delete permissions[provider];
    return { ...previous, permissions };
  });
}
