import { queryOptions, useQuery } from "@tanstack/react-query";
import { api } from "@/api/client";
import type { Scope, Skill, SkillSource } from "@/api/types.gen";
import { skillEntry, type SkillFileSource } from "@/features/files/fileSource";

export type SkillGroup = {
  key: string;
  label: string;
  path: string;
  entries: Skill[];
};

export const skillsQuery = queryOptions({
  queryKey: ["skills"],
  queryFn: ({ signal }) => api<Skill[]>("/skills", undefined, "GET", signal),
  refetchOnWindowFocus: true,
});

export function skillEntryTarget(
  skill: Skill,
  scope?: SkillFileSource["scope"],
) {
  const source: SkillFileSource = {
    kind: "skill",
    id: skill.id,
    readOnly: !skill.managed,
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
  if (skill.origin?.scopePath) return "skills.scopeSources";
  return skill.origin ? "skills.userSources" : "skills.external";
}

export function matchesSkill(skill: Skill, search: string) {
  const text = [
    skill.name,
    skill.description,
    skill.path,
    skill.origin?.directory,
    skill.origin?.scopePath,
  ]
    .join("\n")
    .toLocaleLowerCase();
  return search
    .trim()
    .toLocaleLowerCase()
    .split(/\s+/)
    .every((word) => text.includes(word));
}
