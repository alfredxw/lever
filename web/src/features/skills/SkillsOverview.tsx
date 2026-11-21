import { useId, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { FileText, Folder, Plus, Search, Sparkles } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { api, queryClient } from "@/api/client";
import type { Agent, Overview, ProviderInfo, Skill } from "@/api/types.gen";
import { ErrorNotice } from "@/components/common";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Empty,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { AgentAvatar } from "@/features/agents/AgentAvatar";
import { directoryName, displayPath } from "@/lib/paths";
import { matchesSkill, useSkillSources, type SkillGroup } from "./skillsQuery";

const statuses = ["allStatuses", "enabledStatus", "disabledStatus"] as const;
type StatusFilter = (typeof statuses)[number];

// The runtime accepts a manifest name or a directory name, including the
// unqualified suffix of a runtime-scoped name.
function skillNames(skill: Skill) {
  return [skill.name, directoryName(skill.path)].flatMap((name) => {
    const lower = name.toLowerCase();
    return [lower, lower.slice(lower.lastIndexOf(":") + 1)];
  });
}

function skillPathLabel(skill: Skill, homeDir: string) {
  if (skill.managed) return `skills/${directoryName(skill.path)}`;
  const root = skill.origin?.scopePath?.replaceAll("\\", "/");
  const path = skill.path.replaceAll("\\", "/");
  return root && path.startsWith(`${root}/`)
    ? path.slice(root.length + 1)
    : displayPath(skill.path, homeDir);
}

export function SkillsOverview({
  groups,
  agents,
  selectedAgentId,
  providers,
  homeDir,
  onOpen,
  onCreate,
  visible,
}: {
  groups: SkillGroup[];
  agents: Agent[];
  selectedAgentId: string;
  providers: ProviderInfo[];
  homeDir: string;
  onOpen: (skill: Skill) => void;
  onCreate: () => void;
  visible: boolean;
}) {
  const { t } = useTranslation();
  const hint = useId();
  const title = useId();
  const [agentChoice, setAgentChoice] = useState<string>();
  const [search, setSearch] = useState("");
  const [source, setSource] = useState("all");
  const [status, setStatus] = useState<StatusFilter>("allStatuses");
  const activeAgents = agents.filter((agent) => !agent.archived);
  const agent = agentChoice
    ? activeAgents.find((item) => item.id === agentChoice)
    : (activeAgents.find((item) => item.id === selectedAgentId) ??
      activeAgents[0]);
  const runtime = providers.find(
    (provider) => provider.id === agent?.profile.provider,
  );
  const supported = runtime?.available && runtime.capabilities.skills;
  const sources = useSkillSources(
    agent?.profile.provider ?? "",
    {
      roots: agent?.profile.roots ?? [],
      primaryRootId: agent?.profile.primaryRootId ?? "",
    },
    visible && !!supported,
  );
  const managing = !!agent && supported && sources.isSuccess;
  const agentSkills = (sources.data ?? []).flatMap((item) => item.skills);
  const available = new Map(agentSkills.map((skill) => [skill.id, skill]));
  for (const skill of groups.flatMap((group) => group.entries)) {
    if (skill.available && agent?.profile.skills?.includes(skill.path))
      available.set(skill.id, skill);
  }
  const savedNames = agent?.profile.disabledSkills ?? [];
  const disabledNames = new Set(savedNames.map((name) => name.toLowerCase()));
  const blocked = [...available.values()]
    .map(skillNames)
    .filter((names) => names.some((name) => disabledNames.has(name)));
  const effectiveDisabled = new Set([...disabledNames, ...blocked.flat()]);
  const skillStatus = (skill: Skill) => {
    if (!skill.available || !managing || !available.has(skill.id))
      return undefined;
    return skillNames(skill).some((name) => effectiveDisabled.has(name))
      ? "disabledStatus"
      : "enabledStatus";
  };
  const selectedSource = groups.some((group) => group.key === source)
    ? source
    : "all";
  const selectedStatus = managing ? status : "allStatuses";
  const filtered = groups
    .filter((group) => selectedSource === "all" || group.key === selectedSource)
    .map((group) => ({
      ...group,
      entries: group.entries.filter(
        (skill) =>
          matchesSkill(skill, search) &&
          (selectedStatus === "allStatuses" ||
            skillStatus(skill) === selectedStatus),
      ),
    }))
    .filter((group) => group.entries.length > 0);
  const save = useMutation({
    mutationFn: ({ agent, names }: { agent: Agent; names: string[] }) =>
      api<Agent>(
        `/agents/${agent.id}/skills`,
        { updatedAt: agent.updatedAt, disabledSkills: names },
        "PATCH",
      ),
    onSuccess: async (saved, { agent }) => {
      await queryClient.cancelQueries({ queryKey: ["overview"] });
      queryClient.setQueryData<Overview>(
        ["overview"],
        (data) =>
          data && {
            ...data,
            agents: data.agents.map((current) =>
              current.id === saved.id && current.updatedAt === agent.updatedAt
                ? saved
                : current,
            ),
          },
      );
      void queryClient.invalidateQueries({ queryKey: ["overview"] });
    },
    onError: (error) => {
      toast.error(t("skills.preferenceFailed"), { description: error.message });
      void queryClient.invalidateQueries({ queryKey: ["overview"] });
    },
  });
  function toggle(skill: Skill, enabled: boolean) {
    if (!agent || !skillStatus(skill) || save.isPending) return;
    const selectors = skillNames(skill);
    const aliases = new Set([
      ...selectors,
      ...blocked
        .filter((names) => names.some((name) => selectors.includes(name)))
        .flat(),
    ]);
    const names = enabled
      ? savedNames.filter((name) => !aliases.has(name.toLowerCase()))
      : [...savedNames, skill.name];
    save.mutate({ agent, names });
  }

  return (
    <section
      hidden={!visible}
      className="skills-overview"
      aria-labelledby={title}
    >
      <div className="skills-overview-inner">
        <header className="skills-overview-header">
          <h2 id={title}>{t("common.overview")}</h2>
          {activeAgents.length > 0 && (
            <Select
              value={agent?.id ?? "all"}
              onValueChange={(id) => {
                setAgentChoice(id);
                setStatus("allStatuses");
              }}
            >
              <SelectTrigger
                className="max-w-64 min-w-0"
                aria-label={t("skills.agentFilter")}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent position="popper">
                <SelectGroup>
                  <SelectItem value="all">{t("skills.allSkills")}</SelectItem>
                  {activeAgents.map((item) => (
                    <SelectItem key={item.id} value={item.id}>
                      <AgentAvatar agent={item} size="sm" />
                      <span className="truncate">{item.name}</span>
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          )}
        </header>
        <div className="skills-filters">
          <div className="skills-filter-search">
            <InputGroup>
              <InputGroupAddon>
                <Search />
              </InputGroupAddon>
              <InputGroupInput
                type="search"
                aria-label={t("skills.search")}
                placeholder={t("skills.search")}
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
            </InputGroup>
          </div>
          {groups.length > 1 && (
            <Select value={selectedSource} onValueChange={setSource}>
              <SelectTrigger
                className="max-w-56 min-w-0"
                aria-label={t("skills.sourceFilter")}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent position="popper">
                <SelectGroup>
                  <SelectItem value="all">{t("skills.allSources")}</SelectItem>
                  {groups.map((group) => (
                    <SelectItem key={group.key} value={group.key}>
                      {group.label}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          )}
          {agent && supported && (
            <ToggleGroup
              type="single"
              value={selectedStatus}
              onValueChange={(value) => {
                if (value) setStatus(value as StatusFilter);
              }}
              variant="outline"
              size="sm"
              spacing={0}
              disabled={!managing}
              aria-label={t("skills.statusFilter")}
            >
              {statuses.map((value) => (
                <ToggleGroupItem key={value} value={value}>
                  {t(`skills.${value}`)}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          )}
        </div>
        {agent &&
          (supported ? (
            sources.isError ? (
              <ErrorNotice
                error={sources.error}
                retry={() => void sources.refetch()}
              />
            ) : (
              <p id={hint} className="skills-overview-hint">
                {t("skills.overviewHint")}
              </p>
            )
          ) : (
            runtime && (
              <p className="skills-overview-hint">{t("skills.unsupported")}</p>
            )
          ))}
        {filtered.length ? (
          filtered.map((group) => (
            <section
              key={group.key}
              className="skills-collection"
              aria-label={group.label}
            >
              <h3
                title={
                  group.path ? displayPath(group.path, homeDir) : undefined
                }
              >
                {group.label}
              </h3>
              <div className="skills-grid">
                {group.entries.map((skill) => {
                  const status = skillStatus(skill);
                  const path = displayPath(skill.path, homeDir);
                  return (
                    <Card
                      key={skill.id}
                      size="sm"
                      className="skill-card"
                      role="group"
                      aria-label={skill.name}
                    >
                      <CardHeader>
                        <CardTitle className="min-w-0">
                          <Button
                            type="button"
                            variant="ghost"
                            className="skill-card-open"
                            onClick={() => onOpen(skill)}
                          >
                            <FileText data-icon="inline-start" />
                            <span className="truncate" title={skill.name}>
                              {skill.name}
                            </span>
                          </Button>
                        </CardTitle>
                        {status && agent && (
                          <CardAction className="skill-card-action">
                            <Switch
                              checked={status === "enabledStatus"}
                              disabled={save.isPending}
                              onCheckedChange={(enabled) =>
                                toggle(skill, enabled)
                              }
                              aria-label={t("skills.switchForAgent", {
                                agent: agent.name,
                                name: skill.name,
                              })}
                              aria-describedby={hint}
                            />
                          </CardAction>
                        )}
                        {skill.description && (
                          <CardDescription
                            className="line-clamp-2 break-words"
                            title={skill.description}
                          >
                            {skill.description}
                          </CardDescription>
                        )}
                      </CardHeader>
                      <CardFooter className="skill-card-footer">
                        <Folder />
                        <span
                          className="skill-card-path"
                          title={path}
                          dir="rtl"
                        >
                          <bdi dir="ltr">{skillPathLabel(skill, homeDir)}</bdi>
                        </span>
                        {!skill.available ? (
                          <span>{t("skills.unavailable")}</span>
                        ) : (
                          managing &&
                          !status && (
                            <span>{t("skills.outsideAgentScope")}</span>
                          )
                        )}
                      </CardFooter>
                    </Card>
                  );
                })}
              </div>
            </section>
          ))
        ) : (
          <Empty className="skills-overview-empty">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                {groups.length ? <Search /> : <Sparkles />}
              </EmptyMedia>
              <EmptyTitle>
                {t(groups.length ? "skills.noMatching" : "skills.empty")}
              </EmptyTitle>
            </EmptyHeader>
            {!groups.length && (
              <Button variant="outline" onClick={onCreate}>
                <Plus />
                {t("skills.create")}
              </Button>
            )}
          </Empty>
        )}
      </div>
    </section>
  );
}
