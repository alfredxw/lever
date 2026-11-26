import { Fragment, useEffect, useId, useMemo, useRef, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Command } from "cmdk";
import {
  ArrowUpRight,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  RefreshCw,
  Search,
  X,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { cn } from "cn";
import { api, APIError } from "@/api/client";
import type {
  TaskSource,
  TaskSourceField,
  TaskSourceInspect,
  TaskSourceNotice,
  TaskSourceOption,
  TaskSourcePreview,
  TaskSourcePreviewItem,
} from "@/api/types.gen";
import { ErrorNotice } from "@/components/common";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Empty, EmptyTitle } from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
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
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  SettingsGroup,
  SettingsRow,
} from "@/features/settings/SettingsControls";

type ConfigObject = Record<string, unknown>;

function cloneConfig(value?: ConfigObject): ConfigObject {
  if (!value || typeof value !== "object") return {};
  return JSON.parse(JSON.stringify(value)) as ConfigObject;
}

function getPath(obj: ConfigObject, path: string): unknown {
  let cur: unknown = obj;
  for (const part of path.split(".")) {
    if (!cur || typeof cur !== "object" || Array.isArray(cur)) return undefined;
    cur = (cur as ConfigObject)[part];
  }
  return cur;
}

function setPath(obj: ConfigObject, path: string, value: unknown): ConfigObject {
  const next = cloneConfig(obj);
  const parts = path.split(".");
  let cur: ConfigObject = next;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i];
    const existing = cur[key];
    if (!existing || typeof existing !== "object" || Array.isArray(existing)) {
      cur[key] = {};
    }
    cur = cur[key] as ConfigObject;
  }
  cur[parts[parts.length - 1]] = value;
  return next;
}

function stripExcluded(cfg: ConfigObject): ConfigObject {
  const copy = cloneConfig(cfg);
  delete copy.excludedItemIds;
  return copy;
}

function readExcluded(cfg?: ConfigObject): string[] {
  const raw = cfg?.excludedItemIds;
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.filter((v): v is string => typeof v === "string" && v !== ""))].sort();
}

function canonicalJSON(value: unknown): string {
  if (Array.isArray(value)) {
    return "[" + value.map(canonicalJSON).join(",") + "]";
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b));
    return (
      "{" +
      entries
        .map(([k, v]) => JSON.stringify(k) + ":" + canonicalJSON(v))
        .join(",") +
      "}"
    );
  }
  return JSON.stringify(value);
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function formatSourceError(
  error: Error | null,
  t: (key: string, opts?: Record<string, unknown>) => string,
): Error | string | undefined {
  if (!error) return undefined;
  if (error instanceof APIError && error.code?.startsWith("task_source_")) {
    const code = error.code.slice("task_source_".length);
    return t("tasks.sourceError." + code, { defaultValue: error.message });
  }
  return error;
}

export function ExternalSourceScope({
  pluginId,
  contributionId,
  source,
  visible = true,
  pending,
  inDialog = false,
  onSuggestedName,
  onAccountChange,
  onCancel,
  onSave,
}: {
  pluginId: string;
  contributionId: string;
  source?: TaskSource;
  visible?: boolean;
  pending: boolean;
  inDialog?: boolean;
  onSuggestedName?: (name: string) => void;
  onAccountChange?: (account: string) => void;
  onCancel?: () => void;
  onSave: (config: ConfigObject) => void;
}) {
  const { t } = useTranslation();
  const sourceId = source?.id;
  const savedConfig = source?.config;
  const savedSig = useMemo(() => canonicalJSON(savedConfig ?? {}), [savedConfig]);

  const [edit, setEdit] = useState<{
    savedSig: string;
    config: ConfigObject;
    picks: ReadonlyMap<string, boolean>;
  }>();
  const [refreshToken, setRefreshToken] = useState(0);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [remoteSearch, setRemoteSearch] = useState<{
    field: string;
    query: string;
  }>();
  const [remoteOptions, setRemoteOptions] = useState<
    Record<string, TaskSourceOption[]>
  >({});

  const activeEdit = edit?.savedSig === savedSig ? edit : undefined;
  const baseConfig = activeEdit?.config ?? savedConfig ?? {};
  const picks = activeEdit?.picks ?? new Map<string, boolean>();

  // Debounce free-text edits while keeping discrete toggle/select changes snappy.
  const [settledConfig, setSettledConfig] = useState<ConfigObject>(() =>
    stripExcluded(baseConfig),
  );
  const immediateRef = useRef(true);
  const baseQueryKey = useMemo(
    () => canonicalJSON(stripExcluded(baseConfig)),
    [baseConfig],
  );
  useEffect(() => {
    const next = stripExcluded(baseConfig);
    if (immediateRef.current) {
      immediateRef.current = false;
      setSettledConfig(next);
      return;
    }
    const timer = window.setTimeout(() => setSettledConfig(next), 280);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseQueryKey]);

  const settledSig = useMemo(
    () => canonicalJSON(settledConfig),
    [settledConfig],
  );

  const inspect = useQuery({
    queryKey: [
      "external-task-source-inspect",
      pluginId,
      contributionId,
      sourceId ?? "",
      settledSig,
      refreshToken,
    ],
    queryFn: ({ signal }) =>
      api<TaskSourceInspect>(
        "/tasks/sources/inspect",
        {
          pluginId,
          contributionId,
          sourceId,
          config: settledConfig,
          refresh: refreshToken > 0,
        },
        "POST",
        signal,
      ),
    enabled: visible && (source?.pluginEnabled ?? true),
    placeholderData: keepPreviousData,
    staleTime: (query) => (query.state.data?.ready ? 60_000 : 0),
    retry: false,
  });

  const inspected = inspect.data;
  const effectiveConfig = useMemo(() => {
    const serverDefaults =
      inspected?.config && typeof inspected.config === "object"
        ? inspected.config
        : {};
    return activeEdit ? activeEdit.config : { ...serverDefaults, ...baseConfig };
  }, [activeEdit, baseConfig, inspected?.config]);

  useEffect(() => {
    if (inspected?.suggestedName) onSuggestedName?.(inspected.suggestedName);
  }, [inspected?.suggestedName, onSuggestedName]);

  useEffect(() => {
    onAccountChange?.(inspected?.account ?? "");
  }, [inspected?.account, onAccountChange]);

  // Remote search for searchable pickers (e.g. Meego member lookup).
  useEffect(() => {
    if (!remoteSearch || !remoteSearch.query.trim()) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void api<TaskSourceInspect>(
        "/tasks/sources/inspect",
        {
          pluginId,
          contributionId,
          sourceId,
          config: effectiveConfig,
          searchField: remoteSearch.field,
          searchQuery: remoteSearch.query.trim(),
        },
        "POST",
        controller.signal,
      )
        .then((res) => {
          const field = res.fields?.find((f) => f.key === remoteSearch.field);
          if (field?.options) {
            setRemoteOptions((prev) => ({
              ...prev,
              [remoteSearch.field]: field.options ?? [],
            }));
          }
        })
        .catch(() => {});
    }, 260);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [remoteSearch?.field, remoteSearch?.query]);

  const previewConfig = useMemo(() => {
    const serverCfg =
      inspected?.config && typeof inspected.config === "object"
        ? inspected.config
        : settledConfig;
    return stripExcluded(serverCfg);
  }, [inspected?.config, settledConfig]);
  const previewConfigSig = useMemo(
    () => canonicalJSON(previewConfig),
    [previewConfig],
  );

  const preview = useQuery({
    queryKey: [
      "external-task-source-preview",
      pluginId,
      contributionId,
      sourceId ?? "",
      previewConfigSig,
      refreshToken,
    ],
    queryFn: ({ signal }) =>
      api<TaskSourcePreview>(
        "/tasks/sources/preview",
        {
          pluginId,
          contributionId,
          sourceId,
          config: previewConfig,
          refresh: refreshToken > 0,
        },
        "POST",
        signal,
      ),
    enabled:
      visible &&
      (source?.pluginEnabled ?? true) &&
      !!inspected?.ready &&
      !!inspected?.canSave,
    placeholderData: keepPreviousData,
    staleTime: 60_000,
    retry: false,
  });

  const items = preview.data?.items ?? [];
  const savedExcluded = useMemo(
    () => new Set(readExcluded(savedConfig)),
    [savedConfig],
  );
  const included = (id: string) =>
    picks.get(id) ?? (source ? !savedExcluded.has(id) : true);

  let selectedCount = 0;
  const nextExcluded = new Set(savedExcluded);
  for (const item of items) {
    if (included(item.externalId)) {
      selectedCount += 1;
      nextExcluded.delete(item.externalId);
    } else {
      nextExcluded.add(item.externalId);
    }
  }

  const nextConfig: ConfigObject = useMemo(
    () => ({
      ...effectiveConfig,
      excludedItemIds: [...nextExcluded].sort(),
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [effectiveConfig, [...nextExcluded].sort().join("\n")],
  );

  const baselineSig = useMemo(() => {
    if (!source) return "";
    const serverMerged =
      inspected?.config && typeof inspected.config === "object"
        ? { ...inspected.config, ...(savedConfig ?? {}) }
        : (savedConfig ?? {});
    return canonicalJSON({
      ...serverMerged,
      excludedItemIds: readExcluded(savedConfig),
    });
  }, [inspected?.config, savedConfig, source]);

  const dirty = !source || canonicalJSON(nextConfig) !== baselineSig;
  const disabled = pending || source?.pluginEnabled === false;
  const canSave =
    !disabled &&
    !!inspected?.ready &&
    !!inspected?.canSave &&
    !inspect.isFetching &&
    (!source || dirty);

  function updateField(path: string, value: unknown, immediate = true) {
    immediateRef.current = immediate;
    const base = cloneConfig(effectiveConfig);
    const updated = setPath(base, path, value);
    setEdit({ savedSig, config: updated, picks });
  }

  function pickItems(targetItems: TaskSourcePreviewItem[], checked: boolean) {
    const nextPicks = new Map(picks);
    for (const item of targetItems) nextPicks.set(item.externalId, checked);
    setEdit({ savedSig, config: cloneConfig(effectiveConfig), picks: nextPicks });
  }

  function triggerRefresh() {
    setRefreshToken((n) => n + 1);
  }

  const fields = inspected?.fields ?? [];
  const mainFields = fields.filter((f) => !f.advanced);
  const advancedFields = fields.filter((f) => f.advanced);
  const previewId = useId();
  const inspectError = inspect.error ? formatSourceError(inspect.error, t) : undefined;
  const previewError = preview.error ? formatSourceError(preview.error, t) : undefined;
  const totalCount = preview.data?.total ?? items.length;
  const limitCount = preview.data?.limit ?? 200;

  const actions = (
    <>
      <Button
        type="button"
        variant="ghost"
        disabled={pending || (!!source && !dirty)}
        onClick={source ? () => setEdit(undefined) : onCancel}
      >
        {t(source ? "tasks.larkReset" : "common.cancel")}
      </Button>
      <Button
        type="button"
        disabled={!canSave}
        onClick={() => onSave(nextConfig)}
      >
        {source
          ? t(source.enabled ? "tasks.larkSaveRules" : "common.save")
          : t("tasks.larkSaveSync", { count: selectedCount })}
      </Button>
    </>
  );

  const body = (
    <div className="flex flex-col gap-5">
      {inspectError && (
        <ErrorNotice error={inspectError} retry={triggerRefresh} />
      )}

      {!inspected && inspect.isFetching && (
        <Skeleton
          className="h-32 rounded-xl"
          role="status"
          aria-label={t("common.loading")}
        />
      )}

      {inspected?.notices?.map((notice, idx) => (
        <SourceNoticeBanner
          key={`${notice.tone}-${idx}`}
          notice={notice}
          retrying={inspect.isFetching}
          onRetry={triggerRefresh}
        />
      ))}

      {inspected?.ready && mainFields.length > 0 && (
        <SettingsGroup title={t("tasks.sourceScope")}>
          {mainFields.map((field) => (
            <Fragment key={field.key}>
              {field.section && (
                <div className="external-source-subhead">{field.section}</div>
              )}
              <ExternalFieldRow
                field={field}
                value={
                  field.readOnly && field.value !== undefined
                    ? field.value
                    : getPath(effectiveConfig, field.key)
                }
                extraOptions={remoteOptions[field.key]}
                disabled={disabled}
                onChange={(val, immediate) =>
                  updateField(field.key, val, immediate)
                }
                onRemoteSearch={
                  field.searchable
                    ? (query) => setRemoteSearch({ field: field.key, query })
                    : undefined
                }
              />
            </Fragment>
          ))}

          {advancedFields.length > 0 && (
            <Collapsible
              open={advancedOpen}
              onOpenChange={setAdvancedOpen}
              className="external-source-advanced"
            >
              <CollapsibleTrigger asChild>
                <button
                  type="button"
                  className="external-source-advanced-trigger"
                >
                  <span>
                    {inspected.advancedLabel || t("tasks.sourceAdvanced")}
                  </span>
                  <ChevronRight
                    className={cn(
                      "size-3.5 text-muted-foreground transition-transform",
                      advancedOpen && "rotate-90",
                    )}
                    aria-hidden="true"
                  />
                </button>
              </CollapsibleTrigger>
              <CollapsibleContent className="external-source-advanced-body">
                {advancedFields.map((field) => (
                  <ExternalAdvancedField
                    key={field.key}
                    field={field}
                    value={
                      field.readOnly && field.value !== undefined
                        ? field.value
                        : getPath(effectiveConfig, field.key)
                    }
                    disabled={disabled}
                    onChange={(val, immediate) =>
                      updateField(field.key, val, immediate)
                    }
                  />
                ))}
              </CollapsibleContent>
            </Collapsible>
          )}
        </SettingsGroup>
      )}

      {inspected?.ready && (
        <section className="settings-section" aria-labelledby={previewId}>
          <header className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h3 id={previewId}>{t("tasks.externalExistingItems")}</h3>
              {preview.data && (
                <p className="text-xs text-muted-foreground tabular-nums">
                  {preview.data.truncated
                    ? t("tasks.externalSelectionCountTruncated", {
                        total: totalCount,
                        limit: limitCount,
                        count: selectedCount,
                      })
                    : t("tasks.larkSelectionCount", {
                        total: totalCount,
                        count: selectedCount,
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
                  disabled || !items.length || selectedCount === items.length
                }
                onClick={() => pickItems(items, true)}
              >
                {t("tasks.larkSelectMatching")}
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="xs"
                disabled={disabled || selectedCount === 0}
                onClick={() => pickItems(items, false)}
              >
                {t("tasks.larkClearSelection")}
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label={t("tasks.externalRefreshPreview")}
                title={t("tasks.externalRefreshPreview")}
                disabled={disabled || preview.isFetching || inspect.isFetching}
                onClick={triggerRefresh}
              >
                <RefreshCw
                  className={cn(
                    (preview.isFetching || inspect.isFetching) &&
                      "motion-safe:animate-spin",
                  )}
                />
              </Button>
            </div>
          </header>

          {previewError && (
            <ErrorNotice error={previewError} retry={triggerRefresh} />
          )}

          {preview.data?.notices?.map((notice, idx) => (
            <SourceNoticeBanner
              key={`preview-${notice.tone}-${idx}`}
              notice={notice}
              retrying={preview.isFetching}
              onRetry={triggerRefresh}
            />
          ))}

          {!preview.data && preview.isFetching && (
            <Skeleton
              className="h-28 rounded-xl"
              role="status"
              aria-label={t("common.loading")}
            />
          )}

          {preview.data &&
            (items.length > 0 ? (
              <div className="lark-task-preview panel-surface">
                <ul className="min-w-0 divide-y divide-border/60">
                  {items.map((item) => {
                    const isChecked = included(item.externalId);
                    return (
                      <li
                        key={item.externalId}
                        className="flex min-h-10 items-center gap-2 px-3 py-2"
                      >
                        <label className="flex min-w-0 flex-1 items-start gap-2.5 text-sm">
                          <Checkbox
                            className="mt-0.5"
                            aria-label={item.title}
                            disabled={disabled}
                            checked={isChecked}
                            onCheckedChange={(val) =>
                              pickItems([item], val === true)
                            }
                          />
                          <span className="min-w-0 flex-1">
                            <span className="flex items-center gap-1.5 min-w-0">
                              {item.badge && (
                                <Badge
                                  variant="outline"
                                  className={cn(
                                    "h-5 shrink-0 px-1.5 text-[11px] font-medium",
                                    item.badgeTone === "danger" &&
                                      "external-badge-danger",
                                    item.badgeTone === "attention" &&
                                      "external-badge-attention",
                                  )}
                                >
                                  {item.badge}
                                </Badge>
                              )}
                              <span className="min-w-0 truncate [overflow-wrap:anywhere]">
                                {item.title}
                              </span>
                            </span>
                            {(item.meta?.length || item.dueText) && (
                              <span className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground tabular-nums">
                                {item.meta?.map((part, idx) => (
                                  <Fragment key={`${part}-${idx}`}>
                                    {idx > 0 && (
                                      <span aria-hidden="true">·</span>
                                    )}
                                    <span>{part}</span>
                                  </Fragment>
                                ))}
                                {item.dueText && (
                                  <>
                                    {item.meta?.length ? (
                                      <span aria-hidden="true">·</span>
                                    ) : null}
                                    <span
                                      className={cn(
                                        item.overdue && "external-overdue-text",
                                      )}
                                    >
                                      {item.dueText}
                                    </span>
                                  </>
                                )}
                              </span>
                            )}
                          </span>
                        </label>
                        {item.url && /^https?:\/\//i.test(item.url) && (
                          <Button variant="ghost" size="icon-xs" asChild>
                            <a
                              href={item.url}
                              target="_blank"
                              rel="noopener noreferrer"
                              aria-label={t("tasks.externalOpenItem", {
                                name: item.title,
                              })}
                            >
                              <ArrowUpRight />
                            </a>
                          </Button>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </div>
            ) : (
              <Empty>
                <EmptyTitle>{t("tasks.noMatches")}</EmptyTitle>
              </Empty>
            ))}

          <p className="text-xs text-muted-foreground">
            {t("tasks.externalImportHint")}
          </p>
        </section>
      )}
    </div>
  );

  if (inDialog) {
    return (
      <>
        <div className="external-source-dialog-scroll">{body}</div>
        <div className="external-source-dialog-footer">
          <span className="text-xs text-muted-foreground tabular-nums">
            {inspected?.ready && preview.data
              ? t("tasks.externalDialogSummary", {
                  total: totalCount,
                  count: selectedCount,
                })
              : inspected && !inspected.ready
                ? t("tasks.externalWaitingAuth")
                : ""}
          </span>
          <div className="flex items-center gap-2">{actions}</div>
        </div>
      </>
    );
  }

  return (
    <>
      {body}
      <div className="flex flex-wrap justify-end gap-2">{actions}</div>
    </>
  );
}

function SourceNoticeBanner({
  notice,
  retrying = false,
  onRetry,
}: {
  notice: TaskSourceNotice;
  retrying?: boolean;
  onRetry: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div
      className={cn(
        "external-source-notice",
        notice.tone === "error" && "is-error",
        notice.tone === "attention" && "is-attention",
      )}
      role={notice.tone === "error" ? "alert" : "status"}
    >
      <div className="min-w-0 flex-1">
        {notice.title && (
          <p className="external-source-notice-title">{notice.title}</p>
        )}
        <p className="text-xs leading-relaxed text-muted-foreground">
          {notice.message}
        </p>
      </div>
      {!!notice.actions?.length && (
        <div className="flex shrink-0 flex-wrap items-center gap-1.5">
          {notice.actions.map((action, idx) =>
            action.command ? (
              <Button
                key={`${action.label}-${idx}`}
                type="button"
                variant="outline"
                size="sm"
                onClick={() => {
                  void navigator.clipboard
                    ?.writeText(action.command!)
                    .then(() =>
                      toast.success(
                        t("tasks.externalCopiedCommand", {
                          command: action.command,
                        }),
                      ),
                    );
                }}
              >
                <Copy data-icon="inline-start" />
                {action.label}
              </Button>
            ) : action.retry ? (
              <Button
                key={`${action.label}-${idx}`}
                type="button"
                size="sm"
                disabled={retrying}
                onClick={onRetry}
              >
                {retrying && (
                  <RefreshCw
                    data-icon="inline-start"
                    className="motion-safe:animate-spin"
                  />
                )}
                {action.label}
              </Button>
            ) : null,
          )}
        </div>
      )}
    </div>
  );
}

function ExternalFieldRow({
  field,
  value,
  extraOptions,
  disabled,
  onChange,
  onRemoteSearch,
}: {
  field: TaskSourceField;
  value: unknown;
  extraOptions?: TaskSourceOption[];
  disabled: boolean;
  onChange: (value: unknown, immediate: boolean) => void;
  onRemoteSearch?: (query: string) => void;
}) {
  const id = useId();
  const labelId = useId();
  const mergedOptions = useMemo(() => {
    const map = new Map<string, TaskSourceOption>();
    for (const opt of field.options ?? []) map.set(opt.value, opt);
    for (const opt of extraOptions ?? []) map.set(opt.value, opt);
    return [...map.values()];
  }, [field.options, extraOptions]);

  if (field.stacked) {
    return (
      <div className="settings-row external-source-stacked-row" data-slot="field">
        <div data-slot="field-content" className="flex flex-col gap-1">
          <label htmlFor={id} data-slot="field-label">
            {field.label}
          </label>
          {field.description && (
            <p
              data-slot="field-description"
              className="text-muted-foreground"
            >
              {field.description}
            </p>
          )}
        </div>
        <div className="flex w-full flex-col gap-2">
          <Input
            id={id}
            className="w-full"
            value={asString(value)}
            placeholder={field.placeholder}
            disabled={disabled}
            onChange={(event) => onChange(event.target.value, false)}
          />
          {!!field.presets?.length && (
            <div className="flex flex-wrap items-center gap-1.5">
              {field.presets.map((preset) => (
                <Button
                  key={preset.value}
                  type="button"
                  variant="outline"
                  size="xs"
                  disabled={disabled}
                  onClick={() => onChange(preset.value, true)}
                >
                  {preset.label}
                </Button>
              ))}
            </div>
          )}
          {field.parsed && <ParsedBadgeStrip parsed={field.parsed} />}
        </div>
      </div>
    );
  }

  switch (field.kind) {
    case "toggle":
      return (
        <SettingsRow
          labelId={labelId}
          title={field.label}
          description={field.description}
        >
          <ToggleGroup
            type="single"
            variant="outline"
            size="sm"
            spacing={field.joined ? 0 : 1}
            className="max-w-full flex-wrap"
            aria-labelledby={labelId}
            value={asString(value)}
            disabled={disabled}
            onValueChange={(next) => {
              if (next) onChange(next, true);
            }}
          >
            {mergedOptions.map((option) => (
              <ToggleGroupItem key={option.value} value={option.value}>
                {option.label}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </SettingsRow>
      );

    case "multiToggle": {
      const selected = asStringArray(value);
      return (
        <SettingsRow
          labelId={labelId}
          title={field.label}
          description={field.description}
        >
          <ToggleGroup
            type="multiple"
            variant="outline"
            size="sm"
            spacing={1}
            className="max-w-full flex-wrap"
            aria-labelledby={labelId}
            value={selected}
            disabled={disabled}
            onValueChange={(next) => onChange(next, true)}
          >
            {mergedOptions.map((option) => (
              <ToggleGroupItem key={option.value} value={option.value}>
                {option.label}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </SettingsRow>
      );
    }

    case "switch":
      return (
        <SettingsRow
          id={id}
          title={field.label}
          description={field.description}
        >
          <Switch
            id={id}
            checked={Boolean(value)}
            disabled={disabled}
            onCheckedChange={(checked) => onChange(checked, true)}
          />
        </SettingsRow>
      );

    case "select":
      return (
        <SettingsRow
          labelId={labelId}
          title={field.label}
          description={field.description}
        >
          <OptionPicker
            label={field.label}
            placeholder={field.placeholder || ""}
            options={mergedOptions}
            selected={asString(value) ? [asString(value)] : []}
            multi={false}
            disabled={disabled}
            onSearch={onRemoteSearch}
            onChange={(next) => onChange(next[0] ?? "", true)}
          />
        </SettingsRow>
      );

    case "multiSelect":
      return (
        <SettingsRow
          labelId={labelId}
          title={field.label}
          description={field.description}
        >
          <OptionPicker
            label={field.label}
            placeholder={field.placeholder || ""}
            options={mergedOptions}
            selected={asStringArray(value)}
            multi
            disabled={disabled}
            onSearch={onRemoteSearch}
            onChange={(next) => onChange(next, true)}
          />
        </SettingsRow>
      );

    case "textarea":
      return (
        <SettingsRow
          id={id}
          title={field.label}
          description={field.description}
        >
          <Textarea
            id={id}
            className="min-h-16 w-64 max-w-full font-mono text-xs"
            value={asString(value)}
            placeholder={field.placeholder}
            disabled={disabled}
            onChange={(event) => onChange(event.target.value, false)}
          />
        </SettingsRow>
      );

    default:
      return (
        <SettingsRow
          id={id}
          title={field.label}
          description={field.description}
        >
          <Input
            id={id}
            className="w-56 max-w-full"
            value={asString(value)}
            placeholder={field.placeholder}
            disabled={disabled}
            onChange={(event) => onChange(event.target.value, false)}
          />
        </SettingsRow>
      );
  }
}

function ExternalAdvancedField({
  field,
  value,
  disabled,
  onChange,
}: {
  field: TaskSourceField;
  value: unknown;
  disabled: boolean;
  onChange: (value: unknown, immediate: boolean) => void;
}) {
  const id = useId();
  if (field.kind === "code") {
    return (
      <div className="flex flex-col gap-1.5">
        <span className="text-xs font-medium text-muted-foreground">
          {field.label}
        </span>
        <pre className="external-source-code-preview">{asString(value)}</pre>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-[13px] font-medium text-foreground">
        {field.label}
      </label>
      {field.description && (
        <p className="text-xs text-muted-foreground">{field.description}</p>
      )}
      <Textarea
        id={id}
        className="min-h-16 font-mono text-xs"
        value={asString(value)}
        placeholder={field.placeholder}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value, false)}
      />
    </div>
  );
}

function ParsedBadgeStrip({
  parsed,
}: {
  parsed: NonNullable<TaskSourceField["parsed"]>;
}) {
  if (parsed.invalid) {
    return (
      <div className="external-source-parsed is-error">
        <span>{parsed.detail || parsed.title}</span>
      </div>
    );
  }
  return (
    <div className="external-source-parsed">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        {parsed.badge && (
          <Badge
            variant="outline"
            className={cn(
              "h-5 px-1.5 text-[11px]",
              parsed.tone === "positive" && "external-badge-positive",
              parsed.tone === "attention" && "external-badge-attention",
            )}
          >
            {parsed.badge}
          </Badge>
        )}
        {parsed.title && (
          <span className="text-xs font-medium text-foreground">
            {parsed.title}
          </span>
        )}
        {parsed.code && (
          <Badge variant="secondary" className="h-5 font-mono text-[10.5px]">
            {parsed.code}
          </Badge>
        )}
      </div>
      {parsed.detail && (
        <span className="text-xs text-muted-foreground">{parsed.detail}</span>
      )}
    </div>
  );
}

function OptionPicker({
  label,
  placeholder,
  options,
  selected,
  multi,
  disabled,
  onSearch,
  onChange,
}: {
  label: string;
  placeholder: string;
  options: readonly TaskSourceOption[];
  selected: string[];
  multi: boolean;
  disabled: boolean;
  onSearch?: (query: string) => void;
  onChange: (next: string[]) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");

  const groups = useMemo(() => {
    const grouped = new Map<string, TaskSourceOption[]>();
    for (const option of options) {
      const key = option.group ?? "";
      const list = grouped.get(key) ?? [];
      list.push(option);
      grouped.set(key, list);
    }
    return [...grouped.entries()];
  }, [options]);

  const byValue = useMemo(
    () => new Map(options.map((opt) => [opt.value, opt])),
    [options],
  );

  return (
    <Popover
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        if (!nextOpen) setSearch("");
      }}
    >
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          disabled={disabled}
          aria-label={label}
          className="h-auto min-h-8 w-56 max-w-full justify-between gap-2 py-1 font-normal"
        >
          <span className="flex min-w-0 flex-1 flex-wrap items-center gap-1 text-left">
            {selected.length === 0 ? (
              <span className="truncate text-muted-foreground">
                {placeholder || t("tasks.externalAnyOption")}
              </span>
            ) : multi ? (
              selected.map((val) => {
                const opt = byValue.get(val);
                return (
                  <span
                    key={val}
                    className="inline-flex max-w-36 items-center gap-1 rounded bg-control-selected px-1.5 py-0.5 text-xs text-foreground"
                  >
                    <span className="truncate">{opt?.label ?? val}</span>
                    <span
                      role="button"
                      tabIndex={-1}
                      aria-label={t("common.remove")}
                      className="inline-flex size-3.5 items-center justify-center rounded-sm text-muted-foreground hover:bg-control-hover hover:text-foreground"
                      onClick={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        onChange(selected.filter((item) => item !== val));
                      }}
                    >
                      <X className="size-2.5" />
                    </span>
                  </span>
                );
              })
            ) : (
              <span className="truncate">
                {byValue.get(selected[0])?.label ?? selected[0]}
              </span>
            )}
          </span>
          <ChevronDown
            data-icon="inline-end"
            className="size-3.5 shrink-0 text-muted-foreground"
          />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        aria-label={label}
        className="flex max-h-[min(20rem,var(--radix-popover-content-available-height))] w-72 max-w-[min(20rem,var(--radix-popover-content-available-width))] flex-col p-1.5"
      >
        <Command
          className="flex min-h-0 w-full flex-col gap-1"
          label={label}
          shouldFilter={!onSearch}
          filter={(_, term, keywords) =>
            Number(
              (keywords ?? [])
                .join(" ")
                .toLocaleLowerCase()
                .includes(term.trim().toLocaleLowerCase()),
            )
          }
          loop
        >
          <InputGroup className="shrink-0">
            <InputGroupAddon>
              <Search />
            </InputGroupAddon>
            <Command.Input
              asChild
              value={search}
              onValueChange={(val) => {
                setSearch(val);
                onSearch?.(val);
              }}
            >
              <InputGroupInput
                placeholder={t("tasks.externalSearch")}
                aria-label={t("tasks.externalSearch")}
              />
            </Command.Input>
          </InputGroup>
          <Command.List className="min-h-0 overflow-y-auto overscroll-contain">
            <Command.Empty className="px-2 py-2 text-center text-xs text-muted-foreground">
              {t("tasks.noMatches")}
            </Command.Empty>
            {groups.map(([groupName, groupOptions]) => (
              <Command.Group
                key={groupName || "__default"}
                heading={groupName || undefined}
                className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1 [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:text-muted-foreground"
              >
                {groupOptions.map((option) => {
                  const isSelected = selected.includes(option.value);
                  return (
                    <Command.Item
                      key={option.value}
                      value={`${option.value} ${option.label}`}
                      keywords={[option.label, option.value, option.sub ?? ""]}
                      className="flex min-h-8 cursor-default items-center justify-between gap-2 rounded-md px-2 py-1 text-[length:var(--text-control)] data-[selected=true]:bg-control-focus"
                      onSelect={() => {
                        if (multi) {
                          const next = isSelected
                            ? selected.filter((item) => item !== option.value)
                            : [...selected, option.value];
                          onChange(next);
                        } else {
                          onChange([option.value]);
                          setOpen(false);
                        }
                      }}
                    >
                      <span className="min-w-0 flex-1 truncate">
                        <span>{option.label}</span>
                        {option.sub && (
                          <span className="ml-1.5 font-mono text-[11px] text-muted-foreground">
                            {option.sub}
                          </span>
                        )}
                      </span>
                      {isSelected && (
                        <Check
                          className="size-3.5 shrink-0"
                          aria-hidden="true"
                        />
                      )}
                    </Command.Item>
                  );
                })}
              </Command.Group>
            ))}
          </Command.List>
          {multi && selected.length > 0 && (
            <div className="mt-1 flex items-center justify-between border-t border-border/60 px-1 pt-1">
              <span className="text-xs text-muted-foreground tabular-nums">
                {t("tasks.externalSelectedCount", { count: selected.length })}
              </span>
              <Button
                type="button"
                variant="ghost"
                size="xs"
                onClick={() => onChange([])}
              >
                {t("tasks.clearFilters")}
              </Button>
            </div>
          )}
        </Command>
      </PopoverContent>
    </Popover>
  );
}
