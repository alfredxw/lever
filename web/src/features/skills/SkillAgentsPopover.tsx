import { useMemo, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Plus, Search, Users } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { api, queryClient } from "@/api/client";
import type { Agent, Overview, ProviderInfo, Skill } from "@/api/types.gen";
import { Button } from "@/components/ui/button";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Switch } from "@/components/ui/switch";
import { AgentAvatar } from "@/features/agents/AgentAvatar";
import { directoryName } from "@/lib/paths";
import { skillNameTokens } from "./skillsQuery";

export function agentHasSkillInScope(agent: Agent, skill: Skill) {
  if (skill.managed || skill.subscriptionId) return true;
  if (
    agent.profile.skills?.includes(skill.path) ||
    skill.agentIds.includes(agent.id)
  ) {
    return true;
  }
  if (skill.origin && !skill.origin.providers?.includes(agent.profile.provider))
    return false;
  if (skill.origin?.scopePath) {
    return agent.profile.roots.some(
      (root) => root.path === skill.origin?.scopePath,
    );
  }
  return !!skill.origin;
}

export function agentSkillEnabled(agent: Agent, skill: Skill) {
  if (!agentHasSkillInScope(agent, skill)) return false;
  const disabled = new Set(
    (agent.profile.disabledSkills ?? []).map((n) => n.toLowerCase()),
  );
  return !skillNameTokens(skill).some((tok) => disabled.has(tok));
}

export function SkillAgentsPopover({
  skill,
  agents,
  providers,
  variant = "toolbar",
}: {
  skill: Skill;
  agents: Agent[];
  providers: ProviderInfo[];
  variant?: "toolbar" | "card" | "list";
}) {
  const { t } = useTranslation();
  const [search, setSearch] = useState("");
  const activeAgents = useMemo(
    () => agents.filter((agent) => !agent.archived),
    [agents],
  );
  const providerById = useMemo(
    () => new Map(providers.map((p) => [p.id, p])),
    [providers],
  );

  const agentStates = useMemo(() => {
    return activeAgents
      .map((agent) => {
        const provider = providerById.get(agent.profile.provider);
        const supported = provider?.available && provider.capabilities.skills;
        const inScope = agentHasSkillInScope(agent, skill);
        const enabled = supported && inScope && agentSkillEnabled(agent, skill);
        return { agent, provider, supported, inScope, enabled };
      })
      .sort((a, b) => {
        if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
        if (a.inScope !== b.inScope) return a.inScope ? -1 : 1;
        return a.agent.name.localeCompare(b.agent.name);
      });
  }, [activeAgents, providerById, skill]);

  const enabledAgents = useMemo(
    () => agentStates.filter((s) => s.enabled).map((s) => s.agent),
    [agentStates],
  );

  const filteredStates = useMemo(() => {
    const q = search.trim().toLocaleLowerCase();
    if (!q) return agentStates;
    return agentStates.filter(({ agent, provider }) => {
      const hay = [
        agent.name,
        provider?.name,
        agent.profile.provider,
        ...agent.profile.roots.map((r) => r.path),
      ]
        .filter(Boolean)
        .join(" ")
        .toLocaleLowerCase();
      return q.split(/\s+/).every((word) => hay.includes(word));
    });
  }, [agentStates, search]);

  const mutateAgent = useMutation({
    mutationFn: ({
      agent,
      disabledSkills,
      attach,
    }: {
      agent: Agent;
      disabledSkills?: string[];
      attach?: string;
    }) =>
      api<Agent>(
        `/agents/${agent.id}/skills`,
        {
          updatedAt: agent.updatedAt,
          ...(disabledSkills !== undefined ? { disabledSkills } : {}),
          ...(attach ? { attach } : {}),
        },
        "PATCH",
      ),
    onSuccess: async (saved, { agent, attach }) => {
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
      if (attach) {
        void queryClient.invalidateQueries({ queryKey: ["skills"] });
        toast.success(
          t("skills.attachedSuccess", { name: skill.name, agent: agent.name }),
        );
      }
    },
    onError: (error) => {
      toast.error(t("skills.preferenceFailed"), { description: error.message });
      void queryClient.invalidateQueries({ queryKey: ["overview"] });
    },
  });

  function toggleForAgent(agent: Agent, nextEnabled: boolean) {
    const tokens = new Set(skillNameTokens(skill));
    const current = agent.profile.disabledSkills ?? [];
    const nextDisabled = nextEnabled
      ? current.filter((name) => !tokens.has(name.toLowerCase()))
      : [...current, skill.name];
    mutateAgent.mutate({ agent, disabledSkills: nextDisabled });
  }

  if (activeAgents.length === 0) return null;

  const label = t("skills.usedBy");
  const shownAvatars = enabledAgents.slice(0, 3);
  const overflow = Math.max(0, enabledAgents.length - shownAvatars.length);

  return (
    <Popover>
      <PopoverTrigger asChild>
        {variant !== "toolbar" ? (
          <button
            type="button"
            className="skills-agent-cluster"
            aria-label={label}
            title={t("skills.agentsActive", {
              enabled: enabledAgents.length,
              total: activeAgents.length,
            })}
            onClick={(event) => event.stopPropagation()}
          >
            {variant === "card" && shownAvatars.length > 0 ? (
              <>
                <span className="skills-agent-cluster-avatars">
                  {shownAvatars.map((agent) => (
                    <AgentAvatar key={agent.id} agent={agent} size="sm" />
                  ))}
                </span>
                <span className="tabular-nums">
                  {overflow > 0 ? `+${overflow}` : enabledAgents.length}
                </span>
              </>
            ) : (
              <>
                <Users className="size-3" aria-hidden="true" />
                <span className="tabular-nums">
                  {enabledAgents.length}/{activeAgents.length}
                </span>
              </>
            )}
          </button>
        ) : (
          <Button
            variant="ghost"
            size="sm"
            className="skills-agent-trigger"
            aria-label={label}
            title={label}
          >
            {shownAvatars.length > 0 ? (
              <span className="skills-agent-cluster-avatars">
                {shownAvatars.map((agent) => (
                  <AgentAvatar key={agent.id} agent={agent} size="sm" />
                ))}
              </span>
            ) : (
              <Users className="size-3.5 text-muted-foreground" />
            )}
            <span className="text-xs tabular-nums">
              {t("skills.agentsActive", {
                enabled: enabledAgents.length,
                total: activeAgents.length,
              })}
            </span>
          </Button>
        )}
      </PopoverTrigger>
      <PopoverContent
        align="end"
        sideOffset={6}
        aria-label={label}
        className="flex w-80 max-w-(--radix-popover-content-available-width) flex-col gap-2 p-2.5"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-2 px-0.5">
          <span className="text-xs font-semibold text-foreground">
            {t("skills.manageAgents")}
          </span>
          <span className="text-[11px] text-muted-foreground tabular-nums">
            {t("skills.agentsActive", {
              enabled: enabledAgents.length,
              total: activeAgents.length,
            })}
          </span>
        </div>

        <InputGroup className="shrink-0">
          <InputGroupAddon>
            <Search />
          </InputGroupAddon>
          <InputGroupInput
            type="search"
            aria-label={t("skills.searchAgents")}
            placeholder={t("skills.searchAgents")}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </InputGroup>

        <ul className="max-h-68 divide-y divide-border/40 overflow-y-auto overscroll-contain">
          {filteredStates.length === 0 ? (
            <li className="px-2 py-4 text-center text-xs text-muted-foreground">
              {t("skills.noAgentsFound")}
            </li>
          ) : (
            filteredStates.map(
              ({ agent, provider, supported, inScope, enabled }) => (
                <li
                  key={agent.id}
                  className="flex min-w-0 items-center justify-between gap-2 px-1.5 py-1.5"
                >
                  <div className="flex min-w-0 flex-1 items-center gap-2">
                    <AgentAvatar agent={agent} size="sm" />
                    <div className="min-w-0 flex-1">
                      <span
                        className="block truncate text-xs font-medium text-foreground"
                        title={agent.name}
                      >
                        {agent.name}
                      </span>
                      <span className="block truncate text-[11px] text-muted-foreground">
                        {provider?.name ?? agent.profile.provider}
                        {agent.profile.roots[0]
                          ? ` · ${directoryName(agent.profile.roots[0].path)}`
                          : ""}
                      </span>
                    </div>
                  </div>
                  {!supported ? (
                    <span
                      className="shrink-0 text-[11px] text-muted-foreground"
                      title={t(
                        provider?.available
                          ? "skills.unsupported"
                          : "composer.runtimeDisabled",
                      )}
                    >
                      {t(
                        provider?.available
                          ? "skills.referenceOnly"
                          : "skills.runtimeOff",
                      )}
                    </span>
                  ) : inScope ? (
                    <Switch
                      size="sm"
                      title={
                        provider?.capabilities.skillContext
                          ? t("skills.contextHint")
                          : undefined
                      }
                      checked={enabled}
                      disabled={mutateAgent.isPending}
                      aria-label={t("skills.switchForAgent", {
                        agent: agent.name,
                        name: skill.name,
                      })}
                      onCheckedChange={(next) => toggleForAgent(agent, next)}
                    />
                  ) : (
                    <Button
                      type="button"
                      size="xs"
                      variant="outline"
                      disabled={mutateAgent.isPending}
                      aria-label={t("skills.attachToAgent", {
                        name: skill.name,
                        agent: agent.name,
                      })}
                      onClick={() =>
                        mutateAgent.mutate({ agent, attach: skill.path })
                      }
                    >
                      <Plus data-icon="inline-start" />
                      {t("skills.attach")}
                    </Button>
                  )}
                </li>
              ),
            )
          )}
        </ul>
      </PopoverContent>
    </Popover>
  );
}
