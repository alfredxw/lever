import { queryOptions, useQuery } from "@tanstack/react-query";
import { api } from "@/api/client";
import type {
  Scope,
  Skill,
  SkillSource,
  SkillSubscription,
  UpdateSettings,
} from "@/api/types.gen";
import { skillEntry, type SkillFileSource } from "@/features/files/fileSource";
import { directoryName } from "@/lib/paths";

export const skillOrigins = [
  "managed",
  "subscribed",
  "user",
  "scope",
  "external",
] as const;

export type SkillGroup = {
  key: string;
  label: string;
  path: string;
  kind: (typeof skillOrigins)[number];
  subscriptionId?: string;
  availableCommit?: string;
  entries: Skill[];
};

export const skillsQuery = queryOptions({
  queryKey: ["skills"],
  queryFn: ({ signal }) => api<Skill[]>("/skills", undefined, "GET", signal),
  refetchOnWindowFocus: true,
});

export const skillSubscriptionsQuery = queryOptions({
  queryKey: ["skill-subscriptions"],
  queryFn: ({ signal }) =>
    api<SkillSubscription[]>("/skill-subscriptions", undefined, "GET", signal),
  refetchOnWindowFocus: true,
});

export const skillUpdateSettingsQuery = queryOptions({
  queryKey: ["skill-update-settings"],
  queryFn: ({ signal }) =>
    api<UpdateSettings>("/skill-update-settings", undefined, "GET", signal),
});

export function skillEntryTarget(
  skill: Skill,
  scope?: SkillFileSource["scope"],
) {
  const source: SkillFileSource = {
    kind: "skill",
    id: skill.id,
    readOnly: !skill.managed && !skill.subscriptionId,
    scope,
  };
  return {
    source,
    root: { id: skill.id, path: skill.path },
    path: skillEntry,
  };
}

export function useSkillSources(
  provider: string,
  scope: Scope,
  enabled: boolean,
) {
  return useQuery({
    queryKey: ["skills", "scope", provider, scope],
    queryFn: ({ signal }) =>
      api<SkillSource[]>("/skills/scope", { provider, scope }, "POST", signal),
    enabled,
  });
}

export function skillGroup(skill: Skill) {
  if (skill.managed) return "skills.managed";
  if (skill.subscriptionId) return "skills.subscribedGroup";
  if (skill.origin?.scopePath) return "skills.scopeSources";
  return skill.origin ? "skills.userSources" : "skills.external";
}

export function matchesSkill(skill: Skill, search: string) {
  const trimmed = search.trim();
  if (!trimmed) return true;
  const text = [
    `/${skill.name}`,
    skill.title,
    skill.description,
    skill.path,
    skill.subscriptionName,
    skill.origin?.directory,
    skill.origin?.scopePath,
  ]
    .join("\n")
    .toLocaleLowerCase();
  return trimmed
    .toLocaleLowerCase()
    .split(/\s+/)
    .every((word) => text.includes(word));
}

export function skillNameTokens(skill: Skill) {
  return [skill.name, directoryName(skill.path)].flatMap((name) => {
    const lower = name.toLowerCase();
    return [lower, lower.slice(lower.lastIndexOf(":") + 1)];
  });
}
