import { useEffect, useId, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { api, APIError, queryClient } from "@/api/client";
import {
  TaskSourceKindBoth,
  TaskSourceKindIssue,
  TaskSourceKindPR,
  type TaskSource,
  type TaskSourceCreate,
  type TaskSourceKind,
  type TaskSourceUpdate,
} from "@/api/types.gen";
import { ErrorNotice } from "@/components/common";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Field,
  FieldGroup,
  FieldLabel,
  FieldTitle,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { pluginsQuery } from "@/features/plugins/pluginsQuery";
import { Switch } from "@/components/ui/switch";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  SettingsGroup,
  SettingsRow,
} from "@/features/settings/SettingsControls";
import { LarkSourceScope } from "./LarkSourceScope";

const scopeDialog = "max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg";
const taskSourcesKey = ["task-sources"] as const;
const syncKinds = [
  TaskSourceKindIssue,
  TaskSourceKindPR,
  TaskSourceKindBoth,
] as const;

const sourceTypeKey = (
  source: Pick<TaskSource, "pluginId" | "contributionId">,
) => source.pluginId + "/" + source.contributionId;

export function useTaskSources(visible: boolean) {
  return useQuery({
    queryKey: taskSourcesKey,
    queryFn: ({ signal }) =>
      api<TaskSource[]>("/tasks/sources", undefined, "GET", signal),
    enabled: visible,
    refetchOnWindowFocus: true,
  });
}

const refreshTaskSources = () =>
  queryClient.invalidateQueries({ queryKey: taskSourcesKey });
const refreshSourceFeed = () =>
  Promise.all([
    refreshTaskSources(),
    queryClient.invalidateQueries({ queryKey: ["external-tasks"] }),
  ]);

export function TaskSourceDetail({
  source,
  visible,
  embedded = false,
}: {
  source: TaskSource;
  visible: boolean;
  embedded?: boolean;
}) {
  const { t } = useTranslation();
  const titleId = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (visible && !embedded) heading.current?.focus({ preventScroll: true });
  }, [source.id, visible, embedded]);
  const plugins = useQuery({ ...pluginsQuery, enabled: visible });
  const typeName =
    plugins.data
      ?.find((plugin) => plugin.id === source.pluginId)
      ?.manifest.contributes.taskSources?.find(
        (type) => type.id === source.contributionId,
      )?.name ??
    t("tasks.source." + source.contributionId, {
      defaultValue: source.contributionId,
    });
  const change = useMutation({
    mutationFn: (update: TaskSourceUpdate) =>
      api("/tasks/sources/" + source.id, update, "PUT"),
    onSuccess: (_result, update) =>
      update.syncKind || update.larkScope || update.name
        ? refreshSourceFeed()
        : refreshTaskSources(),
    onError: (error) => toast.error(error.message),
  });
  const sync = useMutation({
    mutationFn: () => api("/tasks/sources/" + source.id + "/sync", {}),
    onSuccess: refreshTaskSources,
    onError: (error) =>
      toast.error(
        error instanceof APIError && error.code === "task_source_rateLimit"
          ? t("tasks.sourceError.rateLimit")
          : error.message,
      ),
  });
  const syncEnabled = source.enabled && source.pluginEnabled;
  const syncId = useId();
  const kindId = useId();
  const [removeOpen, setRemoveOpen] = useState(false);
  const remove = useMutation({
    mutationFn: () => api("/tasks/sources/" + source.id, {}, "DELETE"),
    onSuccess: () => {
      queryClient.setQueryData<TaskSource[]>(taskSourcesKey, (items) =>
        items?.filter((item) => item.id !== source.id),
      );
      return refreshSourceFeed();
    },
  });

  return (
    <section
      className={embedded ? "flex flex-col gap-4" : "task-source-view"}
      aria-labelledby={embedded ? undefined : titleId}
    >
      <div className={embedded ? "flex flex-col gap-4" : "task-source-inner"}>
        {!embedded && (
          <header className="task-source-heading">
            <h2 ref={heading} id={titleId} tabIndex={-1}>
              {source.name}
            </h2>
            <p className="text-xs text-muted-foreground">{typeName}</p>
          </header>
        )}
        <div className="flex flex-col gap-5">
          {source.contributionId === "lark-todos" && (
            <SettingsGroup title={t("tasks.sourceGeneral")}>
              <SourceNameRow
                key={source.id}
                name={source.name}
                disabled={change.isPending}
                onChange={(name) => change.mutate({ name })}
              />
            </SettingsGroup>
          )}
          <SettingsGroup title={t("tasks.sourceSyncSettings")}>
            <SettingsRow title={t("tasks.sourceSyncStatus")}>
              <TaskSourceStatus source={source} />
              <Button
                variant="outline"
                size="sm"
                aria-label={t("tasks.syncSource", { name: source.name })}
                disabled={!syncEnabled || source.syncPending || sync.isPending}
                onClick={() => sync.mutate()}
              >
                <RefreshCw
                  data-icon="inline-start"
                  className={
                    syncEnabled && source.syncPending
                      ? "motion-safe:animate-spin"
                      : undefined
                  }
                />
                {t("tasks.syncNow")}
              </Button>
            </SettingsRow>
            <SettingsRow id={syncId} title={t("tasks.sourceAutoSync")}>
              <Switch
                id={syncId}
                checked={source.enabled}
                disabled={change.isPending}
                onCheckedChange={(enabled) => change.mutate({ enabled })}
              />
            </SettingsRow>
            {source.contributionId === "github" && (
              <SettingsRow labelId={kindId} title={t("tasks.syncKind")}>
                <SyncKindPicker
                  labelId={kindId}
                  value={source.syncKind}
                  disabled={change.isPending}
                  onChange={(syncKind) => change.mutate({ syncKind })}
                />
              </SettingsRow>
            )}
          </SettingsGroup>
          {source.contributionId === "lark-todos" && (
            <LarkSourceScope
              source={source}
              visible={visible}
              pending={change.isPending}
              onSave={(_, larkScope) => change.mutate({ larkScope })}
            />
          )}
          <Dialog
            open={visible && removeOpen}
            onOpenChange={(open) => {
              if (remove.isPending) return;
              if (open) remove.reset();
              setRemoveOpen(open);
            }}
          >
            <DialogTrigger asChild>
              <Button
                variant="destructive"
                size="sm"
                className="self-start"
                disabled={change.isPending}
              >
                {t("tasks.removeSource")}
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>{t("tasks.removeSource")}</DialogTitle>
                <DialogDescription>
                  {t("tasks.removeSourceConfirm", { name: source.name })}
                </DialogDescription>
              </DialogHeader>
              {remove.error && <ErrorNotice error={remove.error} />}
              <DialogFooter>
                <Button
                  variant="ghost"
                  disabled={remove.isPending}
                  onClick={() => setRemoveOpen(false)}
                >
                  {t("common.cancel")}
                </Button>
                <Button
                  variant="destructive"
                  disabled={remove.isPending}
                  onClick={() => remove.mutate()}
                >
                  {t("tasks.removeSource")}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>
      </div>
    </section>
  );
}

function SourceNameRow({
  name,
  disabled,
  onChange,
}: {
  name: string;
  disabled: boolean;
  onChange: (name: string) => void;
}) {
  const { t } = useTranslation();
  const id = useId();
  // Keep the typed name until the saved name changes, so a rename does not flash back.
  const [edit, setEdit] = useState<{ saved: string; draft: string }>();
  const draft = edit?.saved === name ? edit.draft : undefined;
  return (
    <SettingsRow id={id} title={t("tasks.sourceName")}>
      <Input
        id={id}
        className="w-56 max-w-full"
        maxLength={100}
        value={draft ?? name}
        disabled={disabled}
        onChange={(event) =>
          setEdit({ saved: name, draft: event.target.value })
        }
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
          if (event.key === "Escape") {
            setEdit(undefined);
            event.currentTarget.blur();
          }
        }}
        onBlur={() => {
          const next = draft?.trim();
          if (next && next !== name) onChange(next);
          else setEdit(undefined);
        }}
      />
    </SettingsRow>
  );
}

function TaskSourceStatus({ source }: { source: TaskSource }) {
  const { t, i18n } = useTranslation();
  const lastSynced = source.lastSyncedAt
    ? new Date(source.lastSyncedAt * 1000)
    : undefined;
  const active = source.enabled && source.pluginEnabled;
  const pending = active && source.syncPending;
  const error = active && !pending && source.error;
  const status = !source.pluginEnabled
    ? "tasks.sourcePluginOff"
    : !source.enabled
      ? "tasks.sourcePaused"
      : pending
        ? "tasks.sourceSyncing"
        : !lastSynced && !error
          ? "tasks.sourceWaiting"
          : undefined;
  return (
    <div className="min-w-0 text-xs text-muted-foreground tabular-nums">
      {status && <p role={pending ? "status" : undefined}>{t(status)}</p>}
      {error && (
        <p className="task-source-error" role="status">
          {t("tasks.sourceError." + error)}
        </p>
      )}
      {lastSynced && (
        <time className="block" dateTime={lastSynced.toISOString()}>
          {t("tasks.syncedAt", {
            time: new Intl.DateTimeFormat(i18n.language, {
              dateStyle: "medium",
              timeStyle: "short",
            }).format(lastSynced),
          })}
        </time>
      )}
    </div>
  );
}

function SyncKindPicker({
  labelId,
  value,
  disabled,
  onChange,
}: {
  labelId: string;
  value: TaskSourceKind;
  disabled: boolean;
  onChange: (value: TaskSourceKind) => void;
}) {
  const { t } = useTranslation();
  return (
    <ToggleGroup
      type="single"
      size="sm"
      variant="outline"
      spacing={0}
      className="max-w-full flex-wrap"
      aria-labelledby={labelId}
      value={value}
      disabled={disabled}
      onValueChange={(next) => {
        const kind = syncKinds.find((kind) => kind === next);
        if (kind && kind !== value) onChange(kind);
      }}
    >
      {syncKinds.map((kind) => (
        <ToggleGroupItem key={kind} value={kind}>
          {t("tasks.syncKind." + kind)}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}

export function AddTaskSourceDialog({
  pluginId,
  onAdded,
  onClose,
  onCloseAutoFocus,
}: {
  pluginId?: string;
  onAdded: (source: TaskSource) => void;
  onClose: () => void;
  onCloseAutoFocus: (event: Event) => void;
}) {
  const { t } = useTranslation();
  const plugins = useQuery(pluginsQuery);
  const types = (plugins.data ?? [])
    .filter((plugin) => plugin.enabled && (!pluginId || plugin.id === pluginId))
    .flatMap((plugin) =>
      (plugin.manifest.contributes.taskSources ?? []).map((type) => ({
        pluginId: plugin.id,
        contributionId: type.id,
        name: type.name,
      })),
    );
  const [selection, setSelection] = useState("");
  const [target, setTarget] = useState("");
  const [name, setName] = useState<string>();
  const [syncKind, setSyncKind] = useState<TaskSourceKind>(TaskSourceKindBoth);
  const type =
    types.find((item) => sourceTypeKey(item) === selection) ?? types[0];
  const github = type?.contributionId === "github";
  const lark = type?.contributionId === "lark-todos";
  const add = useMutation({
    mutationFn: (input: TaskSourceCreate) =>
      api<TaskSource>("/tasks/sources", input),
    onSuccess: (source) => {
      queryClient.setQueryData<TaskSource[]>(taskSourcesKey, (items = []) => [
        ...items.filter((item) => item.id !== source.id),
        source,
      ]);
      void refreshSourceFeed();
      onAdded(source);
      onClose();
    },
  });
  const canAdd = type && !lark && target.trim() && !add.isPending;
  const addError = add.error;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !add.isPending) onClose();
      }}
    >
      <DialogContent
        className={lark ? scopeDialog : undefined}
        onCloseAutoFocus={onCloseAutoFocus}
      >
        <DialogHeader>
          <DialogTitle>{t("tasks.addSource")}</DialogTitle>
          <DialogDescription>
            {t(
              github
                ? "tasks.githubSourceHint"
                : lark
                  ? "tasks.larkSourceHint"
                  : type
                    ? "tasks.sourceTargetHint"
                    : plugins.isPending
                      ? "common.loading"
                      : "tasks.noSourcePlugins",
            )}
          </DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (canAdd)
              add.mutate({
                pluginId: type.pluginId,
                contributionId: type.contributionId,
                target: target.trim(),
                ...(github && { syncKind }),
              });
          }}
        >
          {type && (
            <FieldGroup className="gap-4">
              {types.length > 1 && (
                <Field>
                  <FieldLabel htmlFor="task-source-type">
                    {t("tasks.filterSource")}
                  </FieldLabel>
                  <Select
                    value={sourceTypeKey(type)}
                    onValueChange={(value) => {
                      setSelection(value);
                      setTarget("");
                      setName(undefined);
                      setSyncKind(TaskSourceKindBoth);
                      add.reset();
                    }}
                    disabled={add.isPending}
                  >
                    <SelectTrigger id="task-source-type" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        {types.map((item) => (
                          <SelectItem
                            key={sourceTypeKey(item)}
                            value={sourceTypeKey(item)}
                          >
                            {item.name}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                </Field>
              )}
              {!lark && (
                <Field>
                  <FieldLabel htmlFor="task-source-target">
                    {t(
                      github ? "tasks.githubRepository" : "tasks.sourceTarget",
                    )}
                  </FieldLabel>
                  <Input
                    id="task-source-target"
                    placeholder={github ? "owner/repo" : undefined}
                    autoFocus
                    required
                    value={target}
                    disabled={add.isPending}
                    onChange={(event) => {
                      setTarget(event.target.value);
                      add.reset();
                    }}
                  />
                </Field>
              )}
              {lark && (
                <Field>
                  <FieldLabel htmlFor="task-source-name">
                    {t("tasks.sourceName")}
                  </FieldLabel>
                  <Input
                    id="task-source-name"
                    maxLength={100}
                    placeholder={type.name}
                    value={name ?? type.name}
                    disabled={add.isPending}
                    onChange={(event) => {
                      setName(event.target.value);
                      add.reset();
                    }}
                  />
                </Field>
              )}
              {github && (
                <Field data-disabled={add.isPending || undefined}>
                  <FieldTitle id="task-source-sync-kind">
                    {t("tasks.syncKind")}
                  </FieldTitle>
                  <SyncKindPicker
                    labelId="task-source-sync-kind"
                    value={syncKind}
                    disabled={add.isPending}
                    onChange={setSyncKind}
                  />
                </Field>
              )}
            </FieldGroup>
          )}
          {(plugins.error || addError) && (
            <ErrorNotice
              error={
                addError instanceof APIError &&
                addError.code?.startsWith("task_source_")
                  ? t(
                      "tasks.sourceError." +
                        addError.code.slice("task_source_".length),
                    )
                  : (addError ?? plugins.error)
              }
            />
          )}
          {lark ? (
            <LarkSourceScope
              pending={add.isPending}
              onCancel={onClose}
              onSave={(target, larkScope) =>
                add.mutate({
                  pluginId: type.pluginId,
                  contributionId: type.contributionId,
                  target,
                  name: name?.trim() || undefined,
                  larkScope,
                })
              }
            />
          ) : (
            <DialogFooter>
              <Button
                type="button"
                variant="ghost"
                disabled={add.isPending}
                onClick={onClose}
              >
                {t("common.cancel")}
              </Button>
              <Button type="submit" disabled={!canAdd}>
                {t(add.isPending ? "tasks.addingSource" : "tasks.addSource")}
              </Button>
            </DialogFooter>
          )}
        </form>
      </DialogContent>
    </Dialog>
  );
}
