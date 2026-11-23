import { useId, useMemo, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Command } from "cmdk";
import {
  Check,
  ChevronDown,
  Download,
  GitBranch,
  LayoutGrid,
  List,
  Plus,
  Search,
  Sparkles,
  Users,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { api, queryClient } from "@/api/client";
import type {
  Agent,
  Overview,
  ProviderInfo,
  Skill,
  SkillSubscription,
  UpdateSettings,
} from "@/api/types.gen";
import { ErrorNotice } from "@/components/common";
import { Button } from "@/components/ui/button";
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
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
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
import { UpdatePolicyPopover } from "@/components/workbench/UpdatePolicyPopover";
import { AgentAvatar } from "@/features/agents/AgentAvatar";
import { directoryName } from "@/lib/paths";
import { SkillLibraryItem } from "./SkillLibraryItem";
import {
  matchesSkill,
  skillNameTokens,
  skillOrigins,
  skillsQuery,
  useSkillSources,
  type SkillGroup,
} from "./skillsQuery";

type StatusFilter =
  | "allStatuses"
  | "enabledStatus"
  | "disabledStatus"
  | "updatesOnly";
export type SkillFilters = {
  source: string;
  search: string;
  status: StatusFilter;
};
type ViewMode = "cards" | "list";

const PAGE_SIZE = 36;

function AgentCombobox({
  agents,
  providers,
  value,
  enabledCount,
  onChange,
}: {
  agents: Agent[];
  providers: ProviderInfo[];
  value: string;
  enabledCount?: number;
  onChange: (id: string) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const selected = agents.find((a) => a.id === value);
  const providerById = useMemo(
    () => new Map(providers.map((p) => [p.id, p])),
    [providers],
  );

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          role="combobox"
          aria-expanded={open}
          aria-label={t("skills.agentFilter")}
          variant="outline"
          size="sm"
          className="skills-agent-combo"
        >
          <span className="flex min-w-0 items-center gap-2">
            {selected ? (
              <>
                <AgentAvatar agent={selected} size="sm" />
                <span className="truncate">{selected.name}</span>
                {enabledCount !== undefined && (
                  <span className="skills-pill tabular-nums">
                    {t("skills.agentEnabledCount", { count: enabledCount })}
                  </span>
                )}
              </>
            ) : (
              <>
                <Users
                  className="size-3.5 shrink-0 text-muted-foreground"
                  aria-hidden="true"
                />
                <span className="truncate">
                  {t("skills.allAgentsCount", { count: agents.length })}
                </span>
              </>
            )}
          </span>
          <ChevronDown
            data-icon="inline-end"
            className="text-muted-foreground"
          />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        sideOffset={6}
        aria-label={t("skills.agentFilter")}
        className="flex max-h-[min(24rem,var(--radix-popover-content-available-height))] w-76 max-w-(--radix-popover-content-available-width) p-1.5"
      >
        <Command
          className="flex min-h-0 w-full flex-col gap-1.5"
          label={t("skills.searchAgents")}
          defaultValue={selected ? `agent:${selected.id}` : "agent:all"}
          filter={(_, search, keywords) =>
            Number(
              (keywords ?? [])
                .join(" ")
                .toLocaleLowerCase()
                .includes(search.trim().toLocaleLowerCase()),
            )
          }
          loop
        >
          <InputGroup className="shrink-0">
            <InputGroupAddon>
              <Search />
            </InputGroupAddon>
            <Command.Input asChild>
              <InputGroupInput
                aria-label={t("skills.searchAgents")}
                placeholder={t("skills.searchAgents")}
              />
            </Command.Input>
          </InputGroup>
          <Command.List className="min-h-0 overflow-y-auto overscroll-contain">
            <Command.Empty className="px-2 py-3 text-center text-xs text-muted-foreground">
              {t("skills.noAgentsFound")}
            </Command.Empty>
            <Command.Group>
              <Command.Item
                value="agent:all"
                keywords={[t("skills.allSkills"), "all"]}
                aria-label={t("skills.allSkills")}
                aria-selected={!selected}
                className="flex min-h-8 cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-control data-[selected=true]:bg-control-focus"
                onSelect={() => {
                  setOpen(false);
                  onChange("all");
                }}
              >
                <Users
                  className="size-3.5 shrink-0 text-muted-foreground"
                  aria-hidden="true"
                />
                <span className="min-w-0 flex-1 truncate">
                  {t("skills.allSkills")}
                </span>
                <span className="text-[11px] text-muted-foreground tabular-nums">
                  {agents.length}
                </span>
                {!selected && (
                  <Check className="size-3.5 shrink-0" aria-hidden="true" />
                )}
              </Command.Item>
              {agents.map((item) => {
                const provider = providerById.get(item.profile.provider);
                const root = item.profile.roots[0]
                  ? directoryName(item.profile.roots[0].path)
                  : "";
                return (
                  <Command.Item
                    key={item.id}
                    value={`agent:${item.id}`}
                    keywords={[
                      item.name,
                      provider?.name ?? item.profile.provider,
                      ...item.profile.roots.map((entry) => entry.path),
                    ].filter(Boolean)}
                    aria-label={item.name}
                    aria-selected={selected?.id === item.id}
                    className="flex min-h-8 cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-control data-[selected=true]:bg-control-focus"
                    onSelect={() => {
                      setOpen(false);
                      onChange(item.id);
                    }}
                  >
                    <AgentAvatar agent={item} size="sm" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate" title={item.name}>
                        {item.name}
                      </span>
                      {(provider?.name || root) && (
                        <span className="block truncate text-[11px] text-muted-foreground">
                          {[provider?.name ?? item.profile.provider, root]
                            .filter(Boolean)
                            .join(" · ")}
                        </span>
                      )}
                    </span>
                    {selected?.id === item.id && (
                      <Check className="size-3.5 shrink-0" aria-hidden="true" />
                    )}
                  </Command.Item>
                );
              })}
            </Command.Group>
          </Command.List>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

export function SkillsOverview({
  groups,
  agents,
  selectedAgentId,
  providers,
  homeDir,
  subscriptions,
  updateSettings,
  updateSettingsPending,
  checkingUpdates,
  filters: { source: sourceFilter, search, status },
  onFilter,
  onSaveUpdateSettings,
  onCheckAllUpdates,
  onOpenSubscriptions,
  onResolveConflict,
  onOpen,
  onSkillAction,
  onCreate,
  onSubscribe,
  visible,
}: {
  groups: SkillGroup[];
  agents: Agent[];
  selectedAgentId: string;
  providers: ProviderInfo[];
  homeDir: string;
  subscriptions: SkillSubscription[];
  updateSettings: UpdateSettings;
  updateSettingsPending: boolean;
  checkingUpdates: boolean;
  filters: SkillFilters;
  onFilter: (change: Partial<SkillFilters>) => void;
  onSaveUpdateSettings: (next: UpdateSettings) => void;
  onCheckAllUpdates: () => void;
  onOpenSubscriptions: () => void;
  onResolveConflict: (skill: Skill) => void;
  onOpen: (skill: Skill) => void;
  onSkillAction: (skill: Skill) => void;
  onCreate: () => void;
  onSubscribe: () => void;
  visible: boolean;
}) {
  const { t } = useTranslation();
  const hint = useId();
  const title = useId();
  const [agentChoice, setAgentChoice] = useState<string>();
  const [viewMode, setViewMode] = useState<ViewMode>("cards");
  const [pagination, setPagination] = useState<{
    key: string;
    limit: number;
  }>();

  const activeAgents = useMemo(
    () => agents.filter((agent) => !agent.archived),
    [agents],
  );
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
  const allSkills = useMemo(
    () => groups.flatMap((group) => group.entries),
    [groups],
  );
  for (const skill of allSkills) {
    if (skill.available && agent?.profile.skills?.includes(skill.path)) {
      available.set(skill.id, skill);
    }
  }
  const duplicateNames = useMemo(() => {
    const counts = new Map<string, number>();
    for (const s of allSkills) {
      const key = s.name.toLowerCase();
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return counts;
  }, [allSkills]);

  const savedNames = agent?.profile.disabledSkills ?? [];
  const disabledNames = new Set(savedNames.map((name) => name.toLowerCase()));
  const blocked = [...available.values()]
    .map(skillNameTokens)
    .filter((names) => names.some((name) => disabledNames.has(name)));
  const effectiveDisabled = new Set([...disabledNames, ...blocked.flat()]);

  const skillStatus = (skill: Skill) => {
    if (!skill.available || !managing || !available.has(skill.id))
      return undefined;
    return skillNameTokens(skill).some((name) => effectiveDisabled.has(name))
      ? "disabledStatus"
      : "enabledStatus";
  };

  const updatableSubs = subscriptions.filter((s) => s.available);

  const sourceGroup = groups.find((group) => group.key === sourceFilter);
  const selectedOrigin =
    sourceGroup?.kind ??
    skillOrigins.find((kind) => kind === sourceFilter) ??
    "all";
  const exactSource =
    selectedOrigin === "scope" || selectedOrigin === "subscribed"
      ? sourceGroup
      : undefined;
  const sourceOptions = groups.filter((group) => group.kind === selectedOrigin);
  const selectedStatus =
    status === "updatesOnly" || managing ? status : "allStatuses";
  const catalog = useMemo(
    () =>
      groups
        .flatMap((group) => group.entries.map((skill) => ({ skill, group })))
        .sort(
          (a, b) =>
            a.skill.name.localeCompare(b.skill.name) ||
            a.skill.path.localeCompare(b.skill.path),
        ),
    [groups],
  );
  const filtered = catalog.filter(
    ({ skill, group }) =>
      (selectedOrigin === "all" || selectedOrigin === group.kind) &&
      (!exactSource || exactSource.key === group.key) &&
      matchesSkill(skill, search) &&
      (selectedStatus === "allStatuses" ||
        (selectedStatus === "updatesOnly"
          ? skill.updateAvailable
          : skillStatus(skill) === selectedStatus)),
  );
  const totalFiltered = filtered.length;
  const pageKey = JSON.stringify([
    search,
    sourceFilter,
    selectedStatus,
    agent?.id,
  ]);
  const visibleLimit = pagination?.key === pageKey ? pagination.limit : 24;
  const shown = filtered.slice(0, visibleLimit);
  const updateCount = allSkills.filter((skill) => skill.updateAvailable).length;
  const enabledCount = managing
    ? allSkills.filter((skill) => skillStatus(skill) === "enabledStatus").length
    : undefined;

  const save = useMutation({
    mutationFn: ({
      agent: targetAgent,
      names,
      attach,
    }: {
      agent: Agent;
      names?: string[];
      attach?: string;
    }) =>
      api<Agent>(
        `/agents/${targetAgent.id}/skills`,
        {
          updatedAt: targetAgent.updatedAt,
          ...(names !== undefined ? { disabledSkills: names } : {}),
          ...(attach ? { attach } : {}),
        },
        "PATCH",
      ),
    onSuccess: async (saved, { agent: targetAgent, attach }) => {
      await queryClient.cancelQueries({ queryKey: ["overview"] });
      queryClient.setQueryData<Overview>(
        ["overview"],
        (data) =>
          data && {
            ...data,
            agents: data.agents.map((current) =>
              current.id === saved.id &&
              current.updatedAt === targetAgent.updatedAt
                ? saved
                : current,
            ),
          },
      );
      void queryClient.invalidateQueries({ queryKey: ["overview"] });
      if (attach) {
        void queryClient.invalidateQueries(skillsQuery);
        toast.success(
          t("skills.attachedSuccess", {
            name: directoryName(attach),
            agent: targetAgent.name,
          }),
        );
      }
    },
    onError: (error) => {
      toast.error(t("skills.preferenceFailed"), { description: error.message });
      void queryClient.invalidateQueries({ queryKey: ["overview"] });
    },
  });

  function toggle(skill: Skill, enabled: boolean) {
    if (!agent || !skillStatus(skill) || save.isPending) return;
    const selectors = skillNameTokens(skill);
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
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
              <h2 id={title}>{t("skills.libraryTitle")}</h2>
              {allSkills.length > 0 && (
                <span className="skills-result-count tabular-nums">
                  {totalFiltered} / {allSkills.length}
                </span>
              )}
            </div>
            <p className="skills-overview-subtitle">
              {t("skills.overviewSubtitle")}
            </p>
          </div>
          <div className="skills-header-actions">
            <UpdatePolicyPopover
              settings={updateSettings}
              hint={t("updates.skillAutoHint")}
              pending={updateSettingsPending}
              checking={checkingUpdates}
              hasSources={subscriptions.length > 0}
              onSave={onSaveUpdateSettings}
              onCheckAll={onCheckAllUpdates}
            />
            <Button size="sm" onClick={onCreate}>
              <Plus data-icon="inline-start" />
              <span>{t("profile.addSkill")}</span>
            </Button>
          </div>
        </header>

        {updatableSubs.length > 0 && (
          <div className="skills-info-banner" data-tone="update">
            <div className="skills-info-banner-copy">
              <Download className="size-3.5 shrink-0" />
              <span>
                {t("skills.updatesBanner", { count: updatableSubs.length })}
              </span>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <Button
                size="sm"
                variant="ghost"
                disabled={updateCount === 0}
                onClick={() =>
                  onFilter({ source: "all", search: "", status: "updatesOnly" })
                }
              >
                {t("skills.viewUpdatesOnly")}
              </Button>
              <Button size="sm" variant="outline" onClick={onOpenSubscriptions}>
                {t("skills.reviewAndSync")}
              </Button>
            </div>
          </div>
        )}

        <div className="skills-toolbar">
          <div className="skills-toolbar-row">
            <div className="skills-filter-search">
              <InputGroup className="bg-background">
                <InputGroupAddon>
                  <Search />
                </InputGroupAddon>
                <InputGroupInput
                  type="search"
                  aria-label={t("skills.search")}
                  placeholder={t("skills.librarySearch", {
                    count: allSkills.length,
                  })}
                  value={search}
                  onChange={(event) => onFilter({ search: event.target.value })}
                />
              </InputGroup>
            </div>

            {activeAgents.length > 0 && (
              <AgentCombobox
                agents={activeAgents}
                providers={providers}
                value={agent?.id ?? "all"}
                enabledCount={enabledCount}
                onChange={(id) => {
                  setAgentChoice(id);
                  onFilter({ status: "allStatuses" });
                }}
              />
            )}

            <ToggleGroup
              className="catalog-segments"
              type="single"
              size="sm"
              spacing={0}
              value={viewMode}
              onValueChange={(value) => {
                if (value === "cards" || value === "list") setViewMode(value);
              }}
              aria-label={t("skills.viewCards")}
            >
              <ToggleGroupItem
                value="cards"
                aria-label={t("skills.viewCards")}
                title={t("skills.viewCards")}
              >
                <LayoutGrid className="size-3.5" />
                <span className="hidden sm:inline">
                  {t("skills.viewCards")}
                </span>
              </ToggleGroupItem>
              <ToggleGroupItem
                value="list"
                aria-label={t("skills.viewList")}
                title={t("skills.viewList")}
              >
                <List className="size-3.5" />
                <span className="hidden sm:inline">{t("skills.viewList")}</span>
              </ToggleGroupItem>
            </ToggleGroup>
          </div>

          <div className="skills-toolbar-row skills-toolbar-filters">
            <div className="skills-toolbar-group">
              <span>{t("skills.sourceLabel")}</span>
              <ToggleGroup
                className="catalog-segments"
                type="single"
                size="sm"
                spacing={0}
                aria-label={t("skills.sourceFilter")}
                value={selectedOrigin}
                onValueChange={(source) => source && onFilter({ source })}
              >
                {(["all", ...skillOrigins] as const).map((kind) => (
                  <ToggleGroupItem key={kind} value={kind}>
                    {t(`skills.origin.${kind}`)}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
              {(selectedOrigin === "scope" ||
                selectedOrigin === "subscribed") &&
                sourceOptions.length > 1 && (
                  <Select
                    value={exactSource?.key ?? selectedOrigin}
                    onValueChange={(source) => onFilter({ source })}
                  >
                    <SelectTrigger
                      className="h-7 max-w-40 text-xs"
                      aria-label={t("skills.directories")}
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        <SelectItem value={selectedOrigin}>
                          {t("skills.allSources")}
                        </SelectItem>
                        {sourceOptions.map((group) => (
                          <SelectItem key={group.key} value={group.key}>
                            {group.label}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                )}
            </div>
            <div className="skills-toolbar-group">
              <span>{t("skills.statusLabel")}</span>
              <ToggleGroup
                className="catalog-segments"
                type="single"
                size="sm"
                spacing={0}
                aria-label={t("skills.statusFilter")}
                value={selectedStatus}
                onValueChange={(value) =>
                  value && onFilter({ status: value as StatusFilter })
                }
              >
                <ToggleGroupItem value="allStatuses">
                  {t("skills.origin.all")}
                </ToggleGroupItem>
                {agent &&
                  supported &&
                  (["enabledStatus", "disabledStatus"] as const).map(
                    (value) => (
                      <ToggleGroupItem
                        key={value}
                        value={value}
                        disabled={!managing}
                      >
                        {t(`skills.${value}`)}
                      </ToggleGroupItem>
                    ),
                  )}
                <ToggleGroupItem value="updatesOnly">
                  {t("skills.filterUpdates")} ({updateCount})
                </ToggleGroupItem>
              </ToggleGroup>
            </div>
          </div>
        </div>
        {agent &&
          (supported ? (
            sources.isError ? (
              <ErrorNotice
                error={sources.error}
                retry={() => void sources.refetch()}
              />
            ) : (
              <p
                id={hint}
                className={
                  runtime?.capabilities.skillContext
                    ? "skills-overview-hint"
                    : "sr-only"
                }
              >
                {t(
                  runtime?.capabilities.skillContext
                    ? "skills.contextHint"
                    : "skills.overviewHint",
                )}
              </p>
            )
          ) : (
            runtime && (
              <p className="skills-overview-hint">{t("skills.unsupported")}</p>
            )
          ))}

        {shown.length ? (
          <>
            <div
              className={viewMode === "cards" ? "skills-grid" : "skills-list"}
            >
              {shown.map(({ skill, group }) => {
                const current = skillStatus(skill);
                const control = !skill.available ? (
                  <span className="text-xs text-muted-foreground">
                    {t("skills.unavailable")}
                  </span>
                ) : current && agent ? (
                  <Switch
                    size="sm"
                    checked={current === "enabledStatus"}
                    disabled={save.isPending}
                    onCheckedChange={(enabled) => toggle(skill, enabled)}
                    aria-label={t("skills.switchForAgent", {
                      agent: agent.name,
                      name: skill.name,
                    })}
                    aria-describedby={hint}
                  />
                ) : managing && agent ? (
                  <Button
                    size="xs"
                    variant="outline"
                    title={t("skills.outsideAgentScope")}
                    aria-label={t("skills.attachToAgent", {
                      name: skill.name,
                      agent: agent.name,
                    })}
                    disabled={save.isPending}
                    onClick={() => save.mutate({ agent, attach: skill.path })}
                  >
                    <Plus />
                    {t("skills.attach")}
                  </Button>
                ) : undefined;
                return (
                  <SkillLibraryItem
                    key={skill.id}
                    skill={skill}
                    group={group}
                    homeDir={homeDir}
                    agents={activeAgents}
                    providers={providers}
                    list={viewMode === "list"}
                    dimmed={current === "disabledStatus"}
                    duplicate={
                      (duplicateNames.get(skill.name.toLowerCase()) ?? 0) > 1
                    }
                    onOpen={() => onOpen(skill)}
                    onAction={onSkillAction}
                    control={control}
                    onUpdate={() =>
                      skill.localModified
                        ? onResolveConflict(skill)
                        : onOpenSubscriptions()
                    }
                  />
                );
              })}
            </div>
            {shown.length < totalFiltered && (
              <div className="skills-pagination">
                <span className="text-xs text-muted-foreground tabular-nums">
                  {t("skills.showingCount", {
                    shown: shown.length,
                    total: totalFiltered,
                  })}
                </span>
                <div className="flex items-center gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      setPagination({
                        key: pageKey,
                        limit: visibleLimit + PAGE_SIZE,
                      })
                    }
                  >
                    {t("skills.loadMore")}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      setPagination({ key: pageKey, limit: totalFiltered })
                    }
                  >
                    {t("skills.showAll", { count: totalFiltered })}
                  </Button>
                </div>
              </div>
            )}
          </>
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
              <div className="flex flex-wrap items-center justify-center gap-2">
                <Button variant="outline" onClick={onCreate}>
                  <Plus />
                  {t("skills.create")}
                </Button>
                <Button variant="ghost" onClick={onSubscribe}>
                  <GitBranch />
                  {t("skills.subscribeRepo")}
                </Button>
              </div>
            )}
          </Empty>
        )}
      </div>
    </section>
  );
}
