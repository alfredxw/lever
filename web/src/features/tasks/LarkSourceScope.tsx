import { useId, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowUpRight, ChevronRight, RefreshCw, Repeat } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "cn";
import { api, APIError } from "@/api/client";
import type {
  LarkPreviewTask,
  LarkTaskDueWindow,
  LarkTaskFilters,
  LarkTaskPreview,
  LarkTaskScope,
  LarkTaskSection,
  TaskSource,
} from "@/api/types.gen";
import { ErrorNotice } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { DialogFooter } from "@/components/ui/dialog";
import { Empty, EmptyTitle } from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import {
  SettingsChoiceRow,
  SettingsGroup,
  SettingsRow,
} from "@/features/settings/SettingsControls";

type DueWindow = LarkTaskDueWindow | "any";
const dueWindows: DueWindow[] = ["any", "overdue", "week", "none"];
const weekMillis = 7 * 24 * 60 * 60 * 1000;

type ScopeDraft = {
  allAssigned: boolean;
  sectionIds: string[];
  dueWindow: DueWindow;
  titleIncludes: string;
  titleExcludes: string;
  skipRecurring: boolean;
  picks: ReadonlyMap<string, boolean>;
};

function savedDraft(source?: TaskSource): ScopeDraft {
  const scope = source?.larkScope;
  const sectionIds = scope?.sectionIds ?? [];
  return {
    allAssigned: !!source && sectionIds.length === 0,
    sectionIds,
    dueWindow: scope?.filters?.dueWindow ?? "any",
    titleIncludes: scope?.filters?.titleIncludes?.join(", ") ?? "",
    titleExcludes: scope?.filters?.titleExcludes?.join(", ") ?? "",
    skipRecurring: scope?.filters?.skipRecurring ?? false,
    picks: new Map(),
  };
}

function keywords(value: string) {
  const terms = new Map<string, string>();
  for (const input of value.split(/[,，\n]/)) {
    const term = input.trim();
    if (term && !terms.has(term.toLowerCase()))
      terms.set(term.toLowerCase(), term);
  }
  return [...terms.values()];
}

function signature(scope?: LarkTaskScope) {
  return JSON.stringify([
    [...(scope?.sectionIds ?? [])].sort(),
    [...(scope?.excludedTaskIds ?? [])].sort(),
    scope?.filters?.dueWindow ?? "any",
    scope?.filters?.titleIncludes ?? [],
    scope?.filters?.titleExcludes ?? [],
    scope?.filters?.skipRecurring ?? false,
  ]);
}

function matchesFilters(
  task: LarkPreviewTask,
  filters: LarkTaskFilters,
  now: number,
) {
  if (filters.skipRecurring && task.recurring) return false;
  const due = task.dueAt ?? 0;
  if (filters.dueWindow === "overdue" && (!due || due >= now)) return false;
  if (filters.dueWindow === "week" && (!due || due > now + weekMillis))
    return false;
  if (filters.dueWindow === "none" && due) return false;
  const title = task.title.toLowerCase();
  const contains = (term: string) => title.includes(term.toLowerCase());
  return (
    (!filters.titleIncludes?.length || filters.titleIncludes.some(contains)) &&
    !filters.titleExcludes?.some(contains)
  );
}

export function LarkSourceScope({
  source,
  visible = true,
  pending,
  onCancel,
  onSave,
}: {
  source?: TaskSource;
  visible?: boolean;
  pending: boolean;
  onCancel?: () => void;
  onSave: (target: string, scope: LarkTaskScope) => void;
}) {
  const { t } = useTranslation();
  const sourceId = source?.id;
  const saved = source?.larkScope;
  const [edit, setEdit] = useState<{
    saved?: LarkTaskScope;
    draft: ScopeDraft;
  }>();
  const edited = edit?.saved === saved ? edit?.draft : undefined;
  const draft = edited ?? savedDraft(source);
  const includeId = useId();
  const excludeId = useId();
  const recurringId = useId();
  const previewId = useId();

  const preview = useQuery({
    queryKey: ["lark-task-preview", sourceId ?? ""],
    queryFn: ({ signal }) =>
      api<LarkTaskPreview>(
        "/tasks/sources/lark-preview" +
          (sourceId ? "?sourceId=" + encodeURIComponent(sourceId) : ""),
        undefined,
        "GET",
        signal,
      ),
    enabled: visible && (source?.pluginEnabled ?? true),
    staleTime: source ? 60_000 : Infinity,
    gcTime: source ? 5 * 60_000 : 0,
    retry: false,
  });

  const filters: LarkTaskFilters = {
    dueWindow: draft.dueWindow === "any" ? undefined : draft.dueWindow,
    titleIncludes: keywords(draft.titleIncludes),
    titleExcludes: keywords(draft.titleExcludes),
    skipRecurring: draft.skipRecurring,
  };
  const data = preview.data;
  const allTasks = data?.tasks ?? [];
  const sections = data?.sections ?? [];
  const matching = new Set(
    allTasks
      .filter((task) => matchesFilters(task, filters, data?.asOf ?? 0))
      .map((task) => task.guid),
  );
  const sectionTaskIds = (ids: string[]) =>
    new Set(
      sections.flatMap((section) =>
        ids.includes(section.guid)
          ? section.tasks.map((task) => task.guid)
          : [],
      ),
    );
  const savedGroups = saved?.sectionIds ?? [];
  const savedTaskIds = sectionTaskIds(savedGroups);
  const draftTaskIds = sectionTaskIds(draft.sectionIds);
  const candidates = allTasks.filter(
    (task) =>
      matching.has(task.guid) &&
      (draft.allAssigned || draftTaskIds.has(task.guid)),
  );
  const skipped = new Set(saved?.excludedTaskIds);
  const included = (id: string) =>
    draft.picks.get(id) ??
    (!!source &&
      (savedGroups.length === 0 || savedTaskIds.has(id)) &&
      !skipped.has(id));
  let count = 0;
  const nextSkipped = new Set(skipped);
  for (const task of candidates) {
    if (included(task.guid)) {
      count += 1;
      nextSkipped.delete(task.guid);
    } else {
      nextSkipped.add(task.guid);
    }
  }
  const disabled = pending || source?.pluginEnabled === false;
  const unavailable = !draft.allAssigned && !!data?.sectionError;
  const missingGroups =
    data && !data.sectionError
      ? draft.sectionIds.filter(
          (id) => !sections.some((section) => section.guid === id),
        )
      : [];
  const nextScope: LarkTaskScope = {
    allAssigned: draft.allAssigned || undefined,
    sectionIds: draft.allAssigned ? [] : draft.sectionIds,
    excludedTaskIds: [...nextSkipped],
    filters,
  };
  const dirty = signature(saved) !== signature(nextScope);
  const canSave =
    !disabled &&
    !!data &&
    !preview.isFetching &&
    !unavailable &&
    (draft.allAssigned || draft.sectionIds.length > 0) &&
    (!source || dirty);
  const refresh = () => void preview.refetch();
  const previewError =
    preview.error instanceof APIError &&
    preview.error.code?.startsWith("task_source_")
      ? t(
          "tasks.sourceError." +
            preview.error.code.slice("task_source_".length),
        )
      : preview.error;

  function update(patch: Partial<ScopeDraft>) {
    setEdit({ saved, draft: { ...draft, ...patch } });
  }

  function pick(tasks: LarkPreviewTask[], checked: boolean) {
    const picks = new Map(draft.picks);
    for (const task of tasks) picks.set(task.guid, checked);
    update({ picks });
  }

  const footer = (
    <>
      <Button
        type="button"
        variant="ghost"
        disabled={pending || (!!source && !edited)}
        onClick={source ? () => setEdit(undefined) : onCancel}
      >
        {t(source ? "tasks.larkReset" : "common.cancel")}
      </Button>
      <Button
        type="button"
        disabled={!canSave}
        onClick={() => data && onSave(data.target, nextScope)}
      >
        {source
          ? t(source.enabled ? "tasks.larkSaveRules" : "common.save")
          : t("tasks.larkSaveSync", { count })}
      </Button>
    </>
  );

  return (
    <>
      <SettingsGroup title={t("tasks.sourceScope")}>
        <SettingsChoiceRow
          title={t("tasks.larkGroups")}
          description={t("tasks.larkAssignmentsOnly")}
          value={draft.allAssigned ? "all" : "selected"}
          options={[
            { value: "all", label: t("tasks.larkAllAssigned") },
            { value: "selected", label: t("tasks.larkSelectedGroups") },
          ]}
          disabled={disabled}
          onChange={(value) => update({ allAssigned: value === "all" })}
        />
        <SettingsChoiceRow
          title={t("tasks.larkDeadline")}
          value={draft.dueWindow}
          options={dueWindows.map((value) => ({
            value,
            label: t("tasks.larkDue." + value),
          }))}
          disabled={disabled}
          onChange={(value) => {
            const dueWindow = dueWindows.find((window) => window === value);
            if (dueWindow) update({ dueWindow });
          }}
        />
        <SettingsRow
          id={includeId}
          title={t("tasks.larkTitleIncludes")}
          description={t("tasks.larkKeywordHint")}
        >
          <Input
            className="w-56 max-w-full"
            id={includeId}
            value={draft.titleIncludes}
            disabled={disabled}
            onChange={(event) => update({ titleIncludes: event.target.value })}
            aria-describedby={includeId + "-description"}
          />
        </SettingsRow>
        <SettingsRow id={excludeId} title={t("tasks.larkTitleExcludes")}>
          <Input
            className="w-56 max-w-full"
            id={excludeId}
            value={draft.titleExcludes}
            disabled={disabled}
            onChange={(event) => update({ titleExcludes: event.target.value })}
          />
        </SettingsRow>
        <SettingsRow id={recurringId} title={t("tasks.larkSyncRecurring")}>
          <Switch
            id={recurringId}
            checked={!draft.skipRecurring}
            disabled={disabled}
            onCheckedChange={(checked) => update({ skipRecurring: !checked })}
          />
        </SettingsRow>
      </SettingsGroup>
      <section className="settings-section" aria-labelledby={previewId}>
        <header className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h3 id={previewId}>{t("tasks.larkExistingTasks")}</h3>
            {data && !unavailable && (
              <p className="text-xs text-muted-foreground">
                {t("tasks.larkSelectionCount", {
                  count,
                  total: candidates.length,
                })}
              </p>
            )}
          </div>
          <div className="flex items-center gap-1">
            <Button
              type="button"
              variant="ghost"
              size="xs"
              disabled={
                disabled || !candidates.length || count === candidates.length
              }
              onClick={() => pick(candidates, true)}
            >
              {t("tasks.larkSelectMatching")}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="xs"
              disabled={disabled || count === 0}
              onClick={() => pick(candidates, false)}
            >
              {t("tasks.larkClearSelection")}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label={t("tasks.larkRefreshPreview")}
              title={t("tasks.larkRefreshPreview")}
              disabled={disabled || preview.isFetching}
              onClick={refresh}
            >
              <RefreshCw
                className={cn(preview.isFetching && "motion-safe:animate-spin")}
              />
            </Button>
          </div>
        </header>
        {previewError && <ErrorNotice error={previewError} retry={refresh} />}
        {unavailable && (
          <ErrorNotice
            error={t("tasks.sourceError." + data?.sectionError)}
            retry={refresh}
          />
        )}
        {!data && preview.isFetching && (
          <Skeleton
            className="h-24"
            role="status"
            aria-label={t("common.loading")}
          />
        )}
        {data && !unavailable && (
          <>
            {!draft.allAssigned && missingGroups.length > 0 && (
              <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                {t("tasks.larkMissingGroups", { count: missingGroups.length })}
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  disabled={disabled}
                  onClick={() =>
                    update({
                      sectionIds: draft.sectionIds.filter(
                        (id) => !missingGroups.includes(id),
                      ),
                    })
                  }
                >
                  {t("tasks.larkClearMissingGroups")}
                </Button>
              </div>
            )}
            {draft.allAssigned ? (
              candidates.length > 0 ? (
                <div className="lark-task-preview panel-surface">
                  <LarkTaskRows
                    tasks={candidates}
                    disabled={disabled}
                    included={included}
                    pick={pick}
                  />
                </div>
              ) : (
                <Empty>
                  <EmptyTitle>{t("tasks.noMatches")}</EmptyTitle>
                </Empty>
              )
            ) : sections.length > 0 ? (
              <LarkSectionRows
                sections={sections}
                sectionIds={draft.sectionIds}
                matching={matching}
                disabled={disabled}
                included={included}
                pick={pick}
                onGroupsChange={(sectionIds) => update({ sectionIds })}
              />
            ) : (
              <Empty>
                <EmptyTitle>{t("tasks.larkNoGroups")}</EmptyTitle>
              </Empty>
            )}
            <p className="text-xs text-muted-foreground">
              {t("tasks.larkImportHint")}
            </p>
          </>
        )}
      </section>
      {source ? (
        <div className="flex flex-wrap justify-end gap-2">{footer}</div>
      ) : (
        <DialogFooter>{footer}</DialogFooter>
      )}
    </>
  );
}

function LarkSectionRows({
  sections,
  sectionIds,
  matching,
  disabled,
  included,
  pick,
  onGroupsChange,
}: {
  sections: LarkTaskSection[];
  sectionIds: string[];
  matching: ReadonlySet<string>;
  disabled: boolean;
  included: (id: string) => boolean;
  pick: (tasks: LarkPreviewTask[], checked: boolean) => void;
  onGroupsChange: (ids: string[]) => void;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState<string | null>();
  const openId =
    expanded === undefined
      ? sections.find((section) => sectionIds.includes(section.guid))?.guid
      : expanded;
  return (
    <>
      <div
        aria-hidden="true"
        className="lark-section-grid px-2 text-xs text-muted-foreground"
      >
        <span>{t("tasks.larkGroup")}</span>
        <span className="text-center">{t("tasks.larkImport")}</span>
        <span className="text-center">{t("tasks.larkFollow")}</span>
      </div>
      <div className="lark-task-preview panel-surface">
        {sections.map((section) => {
          const active = sectionIds.includes(section.guid);
          const open = openId === section.guid;
          const tasks = section.tasks.filter((task) => matching.has(task.guid));
          const picked = active
            ? tasks.filter((task) => included(task.guid)).length
            : 0;
          const label = section.name || section.guid;
          return (
            <div key={section.guid} className="border-b last:border-0">
              <div className="lark-section-grid px-2 py-1">
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="min-w-0 justify-start px-1"
                  aria-expanded={open}
                  title={label}
                  onClick={() => setExpanded(open ? null : section.guid)}
                >
                  <ChevronRight className={cn(open && "rotate-90")} />
                  <span className="truncate">{label}</span>
                </Button>
                <label className="flex min-h-8 items-center justify-center gap-1.5 text-xs tabular-nums">
                  <Checkbox
                    aria-label={t("tasks.larkPickGroup", { name: label })}
                    disabled={disabled || !active || !tasks.length}
                    checked={
                      picked === 0
                        ? false
                        : picked === tasks.length
                          ? true
                          : "indeterminate"
                    }
                    onCheckedChange={(value) => pick(tasks, value === true)}
                  />
                  {picked}/{tasks.length}
                </label>
                <Switch
                  className="justify-self-center"
                  aria-label={t("tasks.larkSubscribe", { name: label })}
                  disabled={disabled}
                  checked={active}
                  onCheckedChange={(checked) =>
                    onGroupsChange(
                      checked
                        ? [...sectionIds, section.guid]
                        : sectionIds.filter((id) => id !== section.guid),
                    )
                  }
                />
              </div>
              {open && (
                <div className="border-t bg-muted/30 py-1">
                  {tasks.length ? (
                    <LarkTaskRows
                      tasks={tasks}
                      disabled={disabled || !active}
                      included={(id) => active && included(id)}
                      pick={pick}
                    />
                  ) : (
                    <p className="px-3 py-1 text-xs text-muted-foreground">
                      {t("tasks.noMatches")}
                    </p>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </>
  );
}

function LarkTaskRows({
  tasks,
  disabled,
  included,
  pick,
}: {
  tasks: LarkPreviewTask[];
  disabled: boolean;
  included: (id: string) => boolean;
  pick: (tasks: LarkPreviewTask[], checked: boolean) => void;
}) {
  const { t, i18n } = useTranslation();
  const date = new Intl.DateTimeFormat(i18n.language, {
    dateStyle: "short",
    timeZone: "UTC",
  });
  const dateTime = new Intl.DateTimeFormat(i18n.language, {
    dateStyle: "short",
    timeStyle: "short",
  });
  return (
    <ul className="min-w-0">
      {tasks.map((task) => {
        const deadline = task.dueAt ? new Date(task.dueAt) : undefined;
        const updated = task.updatedAt ? new Date(task.updatedAt) : undefined;
        return (
          <li key={task.guid} className="flex min-h-9 items-center gap-1 px-3">
            <label className="flex min-w-0 flex-1 items-center gap-2 py-1.5 text-sm">
              <Checkbox
                aria-label={task.title}
                disabled={disabled}
                checked={included(task.guid)}
                onCheckedChange={(value) => pick([task], value === true)}
              />
              <span className="min-w-0 [overflow-wrap:anywhere]">
                {task.title}
                {deadline ? (
                  <time
                    className="block text-xs text-muted-foreground"
                    dateTime={task.dueDate ?? deadline.toISOString()}
                  >
                    {t("tasks.larkDueOn", {
                      date: task.dueDate
                        ? date.format(new Date(task.dueDate))
                        : dateTime.format(deadline),
                    })}
                  </time>
                ) : (
                  updated && (
                    <time
                      className="block text-xs text-muted-foreground"
                      dateTime={updated.toISOString()}
                      title={t("tasks.larkUpdated")}
                    >
                      {dateTime.format(updated)}
                    </time>
                  )
                )}
              </span>
            </label>
            {task.recurring && (
              <Repeat
                className="size-3 shrink-0 text-muted-foreground"
                role="img"
                aria-label={t("tasks.larkRecurring")}
              />
            )}
            {task.url && /^https?:\/\//i.test(task.url) && (
              <Button variant="ghost" size="icon-xs" asChild>
                <a
                  href={task.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label={t("tasks.larkOpenTask", { name: task.title })}
                >
                  <ArrowUpRight />
                </a>
              </Button>
            )}
          </li>
        );
      })}
    </ul>
  );
}
