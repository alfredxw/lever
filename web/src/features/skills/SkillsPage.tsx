import { useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  AlertTriangle,
  ChevronRight,
  Download,
  LayoutGrid,
  Plus,
  Rss,
  Search,
  X,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { api, queryClient } from "@/api/client";
import type {
  Agent,
  ProviderInfo,
  Skill,
  SkillSubscription,
  UpdateSettings,
} from "@/api/types.gen";
import { ErrorNotice, Loading } from "@/components/common";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group";
import { OverviewNavigation } from "@/components/workbench/OverviewNavigation";
import {
  SecondarySidebar,
  useSecondarySidebarState,
} from "@/components/workbench/SecondarySidebar";
import { Files } from "@/features/files/Files";
import { directoryName, displayPath } from "@/lib/paths";
import { SkillAgentsPopover } from "./SkillAgentsPopover";
import { SkillConflictDialog } from "./SkillConflictDialog";
import { SkillDialog, type SkillDialogMode } from "./SkillDialog";
import { SkillOriginGlyph } from "./SkillOriginGlyph";
import { SkillsOverview, type SkillFilters } from "./SkillsOverview";
import { SkillSubscriptionsView } from "./SkillSubscriptionsView";
import {
  matchesSkill,
  skillEntryTarget,
  skillOrigins,
  skillsQuery,
  skillSubscriptionsQuery,
  skillUpdateSettingsQuery,
  type SkillGroup,
} from "./skillsQuery";
import "./skills.css";
import "@/components/workbench/catalog.css";

const SIDEBAR_GROUP_CAP = 8;
const SIDEBAR_SEARCH_CAP = 30;
const defaultUpdateSettings: UpdateSettings = {
  mode: "notify",
  interval: "6h",
};

function countNames(names: Iterable<string>) {
  const counts = new Map<string, number>();
  for (const name of names) {
    const key = name.toLowerCase();
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

export default function SkillsPage({
  agents,
  selectedAgentId,
  providers,
  homeDir,
  dark,
}: {
  agents: Agent[];
  selectedAgentId: string;
  providers: ProviderInfo[];
  homeDir: string;
  dark: boolean;
}) {
  const { t } = useTranslation();
  const library = useQuery(skillsQuery);
  const subscriptionsQuery = useQuery(skillSubscriptionsQuery);
  const updateSettingsQuery = useQuery(skillUpdateSettingsQuery);
  const updateSettings = updateSettingsQuery.data ?? defaultUpdateSettings;
  const subscriptions = subscriptionsQuery.data ?? [];

  const { compact, sidebar, setSidebar } = useSecondarySidebarState();
  const [selection, setSelection] = useState<{
    id: string;
    revision: number;
    edit: boolean;
  }>();
  const [subscriptionsActive, setSubscriptionsActive] = useState(false);
  const [openSource, setOpenSource] = useState<SkillGroup["kind"] | undefined>(
    "scope",
  );
  const [sidebarSearch, setSidebarSearch] = useState("");
  const [filters, setFilters] = useState<SkillFilters>({
    source: "all",
    search: "",
    status: "allStatuses",
  });
  const [dialog, setDialog] = useState<SkillDialogMode>();
  const [conflictSkill, setConflictSkill] = useState<Skill>();
  const frame = useRef<HTMLElement>(null);

  const skills = library.data ?? [];
  const selected = skills.find((skill) => skill.id === selection?.id);
  const file = useMemo(
    () => selected && skillEntryTarget(selected),
    [selected?.id, selected?.path, selected?.managed, selected?.subscriptionId],
  );

  const saveUpdateSettings = useMutation({
    mutationFn: (next: UpdateSettings) =>
      api<UpdateSettings>("/skill-update-settings", next, "PUT"),
    onSuccess: (saved) => {
      queryClient.setQueryData(skillUpdateSettingsQuery.queryKey, saved);
    },
    onError: (error) => toast.error(error.message),
  });

  const checkAllSubs = useMutation({
    mutationFn: async () => {
      for (const sub of subscriptions) {
        await api<SkillSubscription>(
          `/skill-subscriptions/${sub.id}/check`,
          {},
        );
      }
    },
    onSuccess: () => {
      void queryClient.invalidateQueries(skillSubscriptionsQuery);
      void queryClient.invalidateQueries(skillsQuery);
      toast.success(t("updates.checkAll"));
    },
    onError: (error) => toast.error(error.message),
  });

  const names = countNames(skills.map((skill) => skill.name));
  const managed: Skill[] = [];
  const user: Skill[] = [];
  const external: Skill[] = [];
  const scopes = new Map<string, Skill[]>();
  const subscribedByRepo = new Map<
    string,
    { name: string; entries: Skill[] }
  >();

  for (const skill of skills) {
    if (skill.managed) managed.push(skill);
    else if (skill.subscriptionId) {
      const existing = subscribedByRepo.get(skill.subscriptionId);
      if (existing) existing.entries.push(skill);
      else
        subscribedByRepo.set(skill.subscriptionId, {
          name: skill.subscriptionName || t("skills.subscribedGroup"),
          entries: [skill],
        });
    } else if (skill.origin?.scopePath) {
      const path = skill.origin.scopePath;
      const entries = scopes.get(path);
      if (entries) entries.push(skill);
      else scopes.set(path, [skill]);
    } else if (skill.origin) user.push(skill);
    else external.push(skill);
  }

  const scopeNames = countNames(Array.from(scopes.keys(), directoryName));
  const groups: SkillGroup[] = [
    {
      key: "managed",
      label: t("skills.managed"),
      path: "",
      kind: "managed" as const,
      entries: managed,
    },
    ...Array.from(subscribedByRepo, ([subId, data]) => ({
      key: `sub:${subId}`,
      label: data.name,
      path: "",
      kind: "subscribed" as const,
      subscriptionId: subId,
      availableCommit: subscriptions.find((sub) => sub.id === subId)
        ?.availableCommit,
      entries: data.entries,
    })).sort((a, b) => a.label.localeCompare(b.label)),
    {
      key: "user",
      label: t("skills.userSources"),
      path: "",
      kind: "user" as const,
      entries: user,
    },
    ...Array.from(scopes, ([path, entries]) => {
      const name = directoryName(path);
      return {
        key: path,
        label:
          (scopeNames.get(name.toLowerCase()) ?? 0) > 1
            ? displayPath(path, homeDir)
            : name,
        path,
        kind: "scope" as const,
        entries,
      };
    }).sort((a, b) => a.label.localeCompare(b.label)),
    {
      key: "external",
      label: t("skills.external"),
      path: "",
      kind: "external" as const,
      entries: external,
    },
  ].filter((group) => group.entries.length > 0);

  const sidebarTerm = sidebarSearch.trim();
  const entries = groups.flatMap((group) =>
    group.entries.map((skill) => ({ skill, group })),
  );
  const hits = sidebarTerm
    ? entries.filter(({ skill }) => matchesSkill(skill, sidebarTerm))
    : [];

  const updatesCount = subscriptions.filter((s) => s.available).length;

  function revealContent() {
    if (compact) {
      setSidebar(false);
      requestAnimationFrame(() =>
        frame.current
          ?.querySelector<HTMLButtonElement>(".sidebar-toggle")
          ?.focus(),
      );
    }
  }

  function select(skill: Skill, edit = false) {
    setSubscriptionsActive(false);
    setSelection((current) => ({
      id: skill.id,
      revision: (current?.revision ?? 0) + 1,
      edit,
    }));
    const group = groups.find(({ entries }) =>
      entries.some(({ id }) => id === skill.id),
    );
    setOpenSource(group?.kind ?? (skill.managed ? "managed" : "external"));
    revealContent();
  }

  function showOverview(source?: string, search = "", closeSidebar = true) {
    setSubscriptionsActive(false);
    setSelection(undefined);
    if (source) setFilters({ source, search, status: "allStatuses" });
    if (closeSidebar) revealContent();
  }

  function showSubscriptions() {
    setSelection(undefined);
    setSubscriptionsActive(true);
    revealContent();
  }

  const inOverview = !selection && !subscriptionsActive;

  function renderRow({ skill, group }: { skill: Skill; group: SkillGroup }) {
    const path = displayPath(skill.path, homeDir);
    const duplicate = (names.get(skill.name.toLowerCase()) ?? 0) > 1;
    return (
      <Button
        key={skill.id}
        variant="ghost"
        className="sidebar-nav-item skills-row"
        title={path}
        aria-current={selected?.id === skill.id ? "page" : undefined}
        onClick={() => select(skill)}
      >
        {sidebarTerm && <SkillOriginGlyph kind={group.kind} compact />}
        <span className="min-w-0 flex-1 truncate font-mono">
          {skill.name}
          {duplicate && (
            <small className="block truncate text-muted-foreground" dir="rtl">
              <bdi dir="ltr">
                {displayPath(skill.origin?.directory || skill.path, homeDir)}
              </bdi>
            </small>
          )}
        </span>
        {(skill.localModified || skill.updateAvailable) && (
          <span
            className="skills-status-dot"
            data-tone={skill.localModified ? "attention" : "running"}
            aria-hidden="true"
          />
        )}
      </Button>
    );
  }

  return (
    <section
      ref={frame}
      className="workspace-frame skills-page catalog-page"
      data-sidebar={sidebar}
      aria-label={t("nav.skills")}
    >
      <SecondarySidebar
        id="skills-sidebar"
        open={sidebar}
        onOpenChange={setSidebar}
        label={t(sidebar ? "nav.hideMenu" : "nav.showMenu")}
      >
        <div className="sidebar-heading">
          <h1>{t("nav.skills")}</h1>
          <Button
            size="xs"
            onClick={() => setDialog("create")}
            aria-label={t("skills.addToLibrary")}
          >
            <Plus />
            {t("skills.addAction")}
          </Button>
        </div>

        <OverviewNavigation
          label={t("nav.skills")}
          overviewLabel={t("skills.allSkills")}
          count={skills.length}
          groupLabel={
            sidebarTerm
              ? t("skills.searchHits", { count: hits.length })
              : t("skills.sidebarBrowse")
          }
          current={inOverview}
          onOverview={() => showOverview("all")}
          topItems={
            <Button
              variant="ghost"
              className="sidebar-nav-item"
              aria-current={subscriptionsActive ? "page" : undefined}
              onClick={showSubscriptions}
            >
              <Rss data-icon="inline-start" className="text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate text-start">
                {t("skills.subscriptions")}
              </span>
              {updatesCount > 0 ? (
                <span
                  className="skills-sidebar-badge tabular-nums"
                  aria-hidden="true"
                >
                  {updatesCount}
                </span>
              ) : (
                <span
                  className="text-[11px] text-muted-foreground tabular-nums"
                  aria-hidden="true"
                >
                  {subscriptions.length}
                </span>
              )}
            </Button>
          }
          search={
            <InputGroup className="sidebar-search-control mb-2 shrink-0">
              <InputGroupAddon>
                <Search />
              </InputGroupAddon>
              <InputGroupInput
                type="search"
                autoComplete="off"
                spellCheck={false}
                className="[&::-webkit-search-cancel-button]:hidden"
                aria-label={t("skills.quickSearch", { count: skills.length })}
                placeholder={t("skills.quickSearch", {
                  count: skills.length,
                })}
                value={sidebarSearch}
                onChange={(event) => setSidebarSearch(event.target.value)}
              />
              {sidebarSearch && (
                <InputGroupAddon align="inline-end">
                  <InputGroupButton
                    size="icon-xs"
                    aria-label={t("plugins.clearSearch")}
                    onClick={() => setSidebarSearch("")}
                  >
                    <X />
                  </InputGroupButton>
                </InputGroupAddon>
              )}
            </InputGroup>
          }
          footer={
            <div className="flex items-center justify-between gap-2 px-1 text-[11px] text-muted-foreground">
              <span className="flex min-w-0 items-center gap-1.5 truncate">
                <span
                  className="skills-status-dot"
                  data-tone={
                    updateSettings.mode === "auto"
                      ? "positive"
                      : updateSettings.mode === "notify"
                        ? "running"
                        : "muted"
                  }
                  aria-hidden="true"
                />
                <span className="truncate tabular-nums">
                  {t(`updates.policy.${updateSettings.mode}`)}
                  {updateSettings.mode !== "manual"
                    ? ` · ${updateSettings.interval}`
                    : ""}
                </span>
              </span>
              <Button
                variant="ghost"
                size="xs"
                className="h-6 px-1.5 text-[11px] text-muted-foreground hover:text-foreground"
                onClick={showSubscriptions}
              >
                {t("updates.policy")}
              </Button>
            </div>
          }
        >
          {sidebarTerm ? (
            <>
              {hits.slice(0, SIDEBAR_SEARCH_CAP).map(renderRow)}
              {hits.length === 0 && (
                <p className="px-2 py-2 text-xs text-muted-foreground">
                  {t("skills.noMatching")}
                </p>
              )}
              {hits.length > SIDEBAR_SEARCH_CAP && (
                <Button
                  variant="ghost"
                  size="xs"
                  className="sidebar-nav-item"
                  onClick={() => showOverview("all", sidebarTerm)}
                >
                  {t("skills.viewAllInMain", { count: hits.length })}
                </Button>
              )}
            </>
          ) : (
            skillOrigins.map((kind) => {
              const rows = entries.filter(({ group }) => group.kind === kind);
              const label = t(`skills.originName.${kind}`);
              return (
                <Collapsible
                  key={kind}
                  open={openSource === kind}
                  onOpenChange={(open) => {
                    setOpenSource(open ? kind : undefined);
                    if (open) showOverview(kind, "", false);
                  }}
                >
                  <CollapsibleTrigger asChild>
                    <Button
                      variant="ghost"
                      className="sidebar-nav-item skills-group"
                    >
                      <ChevronRight className="skills-folder-chevron" />
                      <SkillOriginGlyph kind={kind} compact />
                      <span className="min-w-0 flex-1 truncate">{label}</span>
                      <span
                        className="text-[11px] text-muted-foreground tabular-nums"
                        aria-hidden="true"
                      >
                        {rows.length}
                      </span>
                    </Button>
                  </CollapsibleTrigger>
                  <CollapsibleContent
                    role="group"
                    aria-label={label}
                    className="sidebar-nav-children"
                  >
                    {rows.slice(0, SIDEBAR_GROUP_CAP).map(renderRow)}
                    {rows.length > SIDEBAR_GROUP_CAP && (
                      <Button
                        variant="ghost"
                        size="xs"
                        className="sidebar-nav-item skills-show-more"
                        onClick={() => showOverview(kind)}
                      >
                        {t("skills.viewAllInMain", { count: rows.length })}
                      </Button>
                    )}
                  </CollapsibleContent>
                </Collapsible>
              );
            })
          )}
        </OverviewNavigation>
      </SecondarySidebar>

      <div className="skills-content" inert={compact && sidebar}>
        {library.isPending ? (
          <Loading />
        ) : library.error && !library.data ? (
          <ErrorNotice
            error={library.error}
            retry={() => void library.refetch()}
          />
        ) : (
          <SkillsOverview
            groups={groups}
            agents={agents}
            selectedAgentId={selectedAgentId}
            providers={providers}
            homeDir={homeDir}
            subscriptions={subscriptions}
            updateSettings={updateSettings}
            updateSettingsPending={saveUpdateSettings.isPending}
            checkingUpdates={checkAllSubs.isPending}
            filters={filters}
            onFilter={(change) =>
              setFilters((current) => ({ ...current, ...change }))
            }
            onSaveUpdateSettings={(next) => saveUpdateSettings.mutate(next)}
            onCheckAllUpdates={() => checkAllSubs.mutate()}
            onOpenSubscriptions={showSubscriptions}
            onResolveConflict={setConflictSkill}
            onOpen={select}
            onCreate={() => setDialog("create")}
            onSubscribe={() => setDialog("subscribe")}
            visible={inOverview}
          />
        )}

        {subscriptionsActive && (
          <SkillSubscriptionsView
            subscriptions={subscriptions}
            settings={updateSettings}
            settingsPending={saveUpdateSettings.isPending}
            onSaveSettings={(next) => saveUpdateSettings.mutate(next)}
            onAddSubscription={() => setDialog("subscribe")}
            onBack={() => showOverview()}
          />
        )}

        {selection &&
          (selected?.available && file ? (
            <div className="skills-files-shell">
              {selected.subscriptionId &&
                (selected.localModified || selected.updateAvailable) && (
                  <div
                    className="skills-files-banner"
                    data-tone={selected.localModified ? "warn" : "update"}
                  >
                    <div className="flex min-w-0 flex-1 items-center gap-2">
                      {selected.localModified ? (
                        <AlertTriangle className="size-3.5 shrink-0" />
                      ) : (
                        <Download className="size-3.5 shrink-0" />
                      )}
                      <span className="text-xs">
                        {selected.localModified
                          ? t("skills.localModifiedBanner")
                          : t("skills.updateAvailableBanner")}
                      </span>
                    </div>
                    <div className="flex shrink-0 items-center gap-1.5">
                      {selected.localModified ? (
                        <Button
                          size="xs"
                          variant="outline"
                          onClick={() => setConflictSkill(selected)}
                        >
                          {t("skills.resolveConflict")}
                        </Button>
                      ) : (
                        <Button
                          size="xs"
                          variant="outline"
                          onClick={showSubscriptions}
                        >
                          {t("skills.reviewAndSync")}
                        </Button>
                      )}
                    </div>
                  </div>
                )}
              <div className="min-h-0 flex-1">
                <Files
                  key={`${selected.id}:${selection.revision}`}
                  source={file.source}
                  scope={{ roots: [file.root], primaryRootId: file.root.id }}
                  initialFile={file}
                  initialPreview={!selection.edit}
                  dark={dark}
                  active={!compact || !sidebar}
                  actions={
                    <>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={t("common.overview")}
                        title={t("common.overview")}
                        onClick={() => showOverview()}
                      >
                        <LayoutGrid />
                      </Button>
                      <SkillAgentsPopover
                        skill={selected}
                        agents={agents}
                        providers={providers}
                        variant="toolbar"
                      />
                    </>
                  }
                />
              </div>
            </div>
          ) : (
            <div className="skills-empty">
              <ErrorNotice
                error={
                  selected
                    ? `${t("skills.unavailable")} · ${displayPath(selected.path, homeDir)}`
                    : t("skills.unavailable")
                }
                retry={() => void library.refetch()}
              />
              <Button variant="ghost" onClick={() => showOverview()}>
                <LayoutGrid />
                {t("common.overview")}
              </Button>
            </div>
          ))}
      </div>

      {dialog && (
        <SkillDialog
          mode={dialog}
          agents={agents}
          homeDir={homeDir}
          onClose={() => setDialog(undefined)}
          onSaved={(skill, edit) => {
            select(skill, edit);
            setDialog(undefined);
          }}
          onSubscribed={(sub) => {
            setSidebarSearch("");
            setOpenSource("subscribed");
            showOverview(`sub:${sub.id}`);
          }}
        />
      )}

      {conflictSkill && (
        <SkillConflictDialog
          skill={conflictSkill}
          onClose={() => setConflictSkill(undefined)}
          onForked={(forked) => select(forked, false)}
        />
      )}
    </section>
  );
}
