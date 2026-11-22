import { useEffect, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import {
  BellOff,
  Check,
  ChevronDown,
  Copy,
  Ellipsis,
  Play,
  Plus,
  SlidersHorizontal,
  X,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { isMyGo } from "mygo-runtime";
import { toast } from "sonner";
import { api, queryClient } from "@/api/client";
import { Dialogs } from "@/api/desktop.gen";
import type {
  Agent,
  Automation,
  AutomationDestination,
  AutomationInput,
  AutomationTarget,
  AutomationTrigger,
  Chat,
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
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { SearchableSelect } from "@/components/ui/searchable-select";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { AgentAvatar } from "@/features/agents/AgentAvatar";
import { displayChatTitle } from "@/features/chat/conversationTitle";
import { TaskAgentSelect } from "@/features/tasks/TaskAgentSelect";
import { WorkingDirectoryPicker } from "@/features/worktrees/WorkingDirectoryPicker";
import { availableGroup, useWorkingCopies } from "@/features/worktrees/queries";
import { primaryDirectory } from "@/features/worktrees/scope";
import { directoryName } from "@/lib/paths";
import { Choice, FormRow, ToggleRow } from "./AutomationFormControls";
import { AutomationPlanIcon } from "./AutomationPlanIcon";
import { AutomationScheduleFields } from "./AutomationScheduleFields";
import { scheduleDraft, scheduleInput } from "./automationSchedule";
import {
  automationPath,
  automationsQuery,
  deliveryModeOf,
  eventSourceKey,
  notifyPolicyOf,
  planTargets,
  type DeliveryMode,
  type EventSourceOption,
  type NotifyPolicy,
} from "./automationsQuery";

function TargetWorkingCopyCell({
  agent,
  selected,
  disabled,
  onSelect,
}: {
  agent?: Agent;
  selected?: string;
  disabled: boolean;
  onSelect: (id?: string) => void;
}) {
  const { t } = useTranslation();
  const copies = useWorkingCopies(agent?.id ?? "", !!agent);
  if (!agent) return null;
  const hasGroups = !!selected || !!copies.data?.some(availableGroup);
  if (!hasGroups) {
    return (
      <span className="automation-target-scope-static truncate">
        {t("worktrees.defaultScope")}
      </span>
    );
  }
  return (
    <WorkingDirectoryPicker
      key={agent.id}
      copies={copies.data}
      originalPath={primaryDirectory(agent.profile)}
      selected={selected}
      onSelect={onSelect}
      disabled={disabled}
    />
  );
}

export function AutomationRuleRibbon({
  plan,
  agents,
  chats,
  eventSources,
  kind,
  timing,
  next,
  busy,
  expanded,
  onExpandedChange,
  onRunNow,
  onArchived,
}: {
  plan: Automation;
  agents: Agent[];
  chats: Chat[];
  eventSources: EventSourceOption[];
  kind: string;
  timing: string;
  next: string;
  busy: boolean;
  expanded: boolean;
  onExpandedChange: (open: boolean) => void;
  onRunNow: (targetId?: string) => void;
  onArchived: () => void;
}) {
  const { t, i18n } = useTranslation();
  const [editingTitle, setEditingTitle] = useState(false);
  const [name, setName] = useState(plan.name);
  const [prompt, setPrompt] = useState(plan.prompt);
  const [trigger, setTrigger] = useState<AutomationTrigger["kind"]>(
    plan.trigger.kind,
  );
  const [schedule, setSchedule] = useState(() =>
    scheduleDraft(plan.trigger.schedule),
  );
  const [sourceKey, setSourceKey] = useState(
    eventSourceKey(plan.trigger.source),
  );
  const [sourceFields, setSourceFields] = useState(
    plan.trigger.source?.config ?? {},
  );
  const [batchSize, setBatchSize] = useState(
    String(plan.trigger.batchSize ?? 1),
  );
  const [mode, setMode] = useState<AutomationDestination["mode"]>(
    plan.destination.mode,
  );
  const [chatId, setChatId] = useState(plan.destination.chatId ?? "");
  const [chatSource, setChatSource] = useState<"existing" | "dedicated">(
    plan.destination.chatId ? "existing" : "dedicated",
  );
  const [targets, setTargets] = useState<AutomationTarget[]>(() =>
    planTargets(plan),
  );
  const [notifyPolicy, setNotifyPolicy] = useState<NotifyPolicy>(() =>
    notifyPolicyOf(plan),
  );
  const [deliveryMode, setDeliveryMode] = useState<DeliveryMode>(() =>
    deliveryModeOf(plan),
  );
  const [workItem, setWorkItem] = useState(plan.workItem ?? true);
  const [archiving, setArchiving] = useState(false);
  const [savedNotice, setSavedNotice] = useState(false);

  // Re-sync local draft when plan updates from server or switching plans.
  useEffect(() => {
    setName(plan.name);
    setPrompt(plan.prompt);
    setTrigger(plan.trigger.kind);
    setSchedule(scheduleDraft(plan.trigger.schedule));
    setSourceKey(eventSourceKey(plan.trigger.source));
    setSourceFields(plan.trigger.source?.config ?? {});
    setBatchSize(String(plan.trigger.batchSize ?? 1));
    setMode(plan.destination.mode);
    setChatId(plan.destination.chatId ?? "");
    setChatSource(plan.destination.chatId ? "existing" : "dedicated");
    setTargets(planTargets(plan));
    setNotifyPolicy(notifyPolicyOf(plan));
    setDeliveryMode(deliveryModeOf(plan));
    setWorkItem(plan.workItem ?? true);
    setEditingTitle(false);
  }, [plan]);

  const activeAgents = agents.filter((item) => !item.archived);
  const primaryTarget = targets[0];
  const primaryAgent = agents.find((a) => a.id === primaryTarget?.agentId);
  const isMultiTarget = targets.length > 1;
  const ownedChats = chats.filter(
    (c) => !c.channel && c.agentId === primaryTarget?.agentId,
  );
  const sharedMode = mode !== "newChat" && !isMultiTarget;
  const existingChat = sharedMode && chatSource === "existing";

  const selectedSource = eventSources.find(
    (item) => item.pluginId + "/" + item.contribution.id === sourceKey,
  );
  const sourceFieldDefs = selectedSource?.contribution.fields ?? [];

  const path = `${automationPath}/${plan.id}`;

  const savePlan = useMutation({
    mutationFn: (input: AutomationInput) => api<Automation>(path, input, "PUT"),
    onSuccess: (saved) => {
      queryClient.setQueryData<Automation[]>(
        automationsQuery.queryKey,
        (cached) =>
          cached?.map((item) =>
            item.id === saved.id ? { ...item, ...saved } : item,
          ),
      );
      void queryClient.invalidateQueries({
        queryKey: automationsQuery.queryKey,
      });
      setSavedNotice(true);
      window.setTimeout(() => setSavedNotice(false), 2400);
    },
    onError: (error) => toast.error(error.message),
  });

  const toggleEnabled = useMutation({
    mutationFn: (enabled: boolean) => api(path, { enabled }, "PATCH"),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: automationsQuery.queryKey }),
    onError: (error) => toast.error(error.message),
  });

  const archivePlan = useMutation({
    mutationFn: () => api(path, {}, "DELETE"),
    onSuccess: () => {
      setArchiving(false);
      onArchived();
      void queryClient.invalidateQueries({
        queryKey: automationsQuery.queryKey,
      });
      void queryClient.invalidateQueries({ queryKey: ["automation-runs"] });
    },
  });

  function buildInput(overrides?: {
    name?: string;
    prompt?: string;
    trigger?: AutomationTrigger["kind"];
    schedule?: ReturnType<typeof scheduleDraft>;
    sourceKey?: string;
    sourceFields?: Record<string, string>;
    batchSize?: string;
    mode?: AutomationDestination["mode"];
    chatSource?: "existing" | "dedicated";
    chatId?: string;
    targets?: AutomationTarget[];
    notifyPolicy?: NotifyPolicy;
    deliveryMode?: DeliveryMode;
    workItem?: boolean;
  }): AutomationInput | undefined {
    const nextName = (overrides?.name ?? name).trim();
    const nextPrompt = (overrides?.prompt ?? prompt).trim();
    const nextTrigger = overrides?.trigger ?? trigger;
    const nextScheduleDraft = overrides?.schedule ?? schedule;
    const nextSourceKey = overrides?.sourceKey ?? sourceKey;
    const nextSourceFields = overrides?.sourceFields ?? sourceFields;
    const nextBatch = Number(overrides?.batchSize ?? batchSize);
    const nextMode = overrides?.mode ?? mode;
    const nextTargets = overrides?.targets ?? targets;
    const nextMulti = nextTargets.length > 1;
    const nextChatSource = overrides?.chatSource ?? chatSource;
    const nextChatId = overrides?.chatId ?? chatId;
    const useExisting =
      !nextMulti && nextMode !== "newChat" && nextChatSource === "existing";
    const nextNotify = overrides?.notifyPolicy ?? notifyPolicy;
    const nextDelivery = overrides?.deliveryMode ?? deliveryMode;
    const nextWorkItem = overrides?.workItem ?? workItem;

    if (!nextName || !nextPrompt || !nextTargets.length) return;
    if (useExisting && !nextChatId) return;

    const first = nextTargets[0];
    if (!first?.agentId) return;

    let triggerObj: AutomationTrigger;
    if (nextTrigger === "schedule") {
      const sched = scheduleInput(nextScheduleDraft);
      if (!sched) return;
      triggerObj = { kind: "schedule", schedule: sched };
    } else {
      if (!Number.isInteger(nextBatch) || nextBatch < 1 || nextBatch > 50)
        return;
      const src = eventSources.find(
        (item) => item.pluginId + "/" + item.contribution.id === nextSourceKey,
      );
      if (nextSourceKey !== "webhook" && !src) return;
      triggerObj = {
        kind: "event",
        batchSize: nextBatch,
        source: src && {
          pluginId: src.pluginId,
          contributionId: src.contribution.id,
          config: nextSourceFields,
        },
      };
    }

    const normalizedTargets = nextMulti
      ? nextTargets.map((item) => ({
          ...item,
          id: item.id || crypto.randomUUID(),
          chatId: undefined,
        }))
      : undefined;

    return {
      name: nextName,
      prompt: nextPrompt,
      trigger: triggerObj,
      destination: {
        mode: nextMode,
        agentId: first.agentId,
        chatId: useExisting ? nextChatId : undefined,
        workingCopyId:
          nextMode !== "chat" || !useExisting ? first.workingCopyId : undefined,
      },
      targets: normalizedTargets,
      notifyPolicy: nextNotify,
      deliveryMode: nextDelivery,
      workItem: nextWorkItem,
      quiet: nextNotify === "silent",
    };
  }

  function commit(overrides?: Parameters<typeof buildInput>[0]) {
    const input = buildInput(overrides);
    if (!input) return;
    savePlan.mutate(input);
  }

  function addMultiTarget() {
    const used = new Set(targets.map((item) => item.agentId));
    const fallback =
      activeAgents.find((item) => !used.has(item.id)) ?? activeAgents[0];
    if (!fallback) {
      toast.error(t("automations.agentRequired"));
      return;
    }
    const base = targets.map((item) => ({
      ...item,
      id: item.id || crypto.randomUUID(),
    }));
    const nextTargets: AutomationTarget[] = [
      ...base,
      {
        id: crypto.randomUUID(),
        agentId: fallback.id,
        enabled: true,
        prompt: "",
      },
    ];
    setTargets(nextTargets);
    onExpandedChange(true);
    commit({ targets: nextTargets });
  }

  const copy = async (value: string) => {
    try {
      if (isMyGo()) await Dialogs.writeClipboard(value, "");
      else await navigator.clipboard.writeText(value);
      toast.success(t("automations.copied"));
    } catch {
      toast.error(t("automations.copyFailed"));
    }
  };

  const dirtyText =
    name.trim() !== plan.name ||
    prompt.trim() !== plan.prompt ||
    JSON.stringify(scheduleInput(schedule)) !==
      JSON.stringify(plan.trigger.schedule) ||
    trigger !== plan.trigger.kind ||
    sourceKey !== eventSourceKey(plan.trigger.source) ||
    Number(batchSize) !== (plan.trigger.batchSize ?? 1);

  const nextAt =
    plan.enabled && plan.nextAt ? new Date(plan.nextAt * 1000) : undefined;

  return (
    <div className="automation-plan-head-wrap">
      <header className="automation-stage-header">
        <div className="automation-stage-title min-w-0 flex-1">
          <AutomationPlanIcon
            plan={plan}
            className="size-4 shrink-0 text-muted-foreground"
          />
          {editingTitle ? (
            <Input
              autoFocus
              className="automation-inline-title-input"
              value={name}
              maxLength={80}
              aria-label={t("automations.name")}
              onChange={(event) => setName(event.target.value)}
              onBlur={() => {
                setEditingTitle(false);
                if (name.trim() && name.trim() !== plan.name)
                  commit({ name: name.trim() });
                else setName(plan.name);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") event.currentTarget.blur();
                if (event.key === "Escape") {
                  setName(plan.name);
                  setEditingTitle(false);
                }
              }}
            />
          ) : (
            <h2 className="min-w-0 truncate">
              <button
                type="button"
                className="automation-inline-title max-w-full truncate"
                title={plan.name}
                onClick={() => setEditingTitle(true)}
              >
                {plan.name}
              </button>
            </h2>
          )}
          <span className="automation-pill" data-tone="muted">
            {notifyPolicy === "silent" && (
              <BellOff className="size-3" aria-hidden="true" />
            )}
            {notifyPolicy === "silent"
              ? t("automations.activityAttention")
              : t("automations.notify." + notifyPolicy)}
          </span>
          {savedNotice && (
            <span className="automation-saved-tag">
              <Check className="size-3" aria-hidden="true" />
              {t("automations.autoSaved")}
            </span>
          )}
        </div>
        <div className="automation-stage-actions">
          {plan.trigger.kind === "schedule" && (
            <Button
              size="xs"
              aria-label={t("automations.runNow")}
              title={t("automations.runNow")}
              disabled={busy || savePlan.isPending}
              onClick={() => onRunNow()}
            >
              <Play data-icon="inline-start" />
              <span>{t("automations.runNow")}</span>
            </Button>
          )}
          <Switch
            size="sm"
            checked={plan.enabled}
            disabled={toggleEnabled.isPending}
            aria-label={t("automations.toggle", { name: plan.name })}
            onCheckedChange={(enabled) => toggleEnabled.mutate(enabled)}
          />
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label={t("automations.actions")}
                disabled={archivePlan.isPending}
              >
                <Ellipsis />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                onSelect={() => {
                  archivePlan.reset();
                  setArchiving(true);
                }}
              >
                {t("automations.archive")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </header>

      <div className="automation-rule-ribbon">
        <div className="automation-ribbon-row">
          <span
            className="automation-pill"
            data-tone="muted"
            title={
              nextAt
                ? nextAt.toLocaleString(i18n.language, {
                    dateStyle: "full",
                    timeStyle: "long",
                  })
                : undefined
            }
          >
            {kind} · {timing}
            {plan.enabled && ` · ${next}`}
          </span>

          {!isMultiTarget ? (
            <>
              <div className="automation-ribbon-agent">
                <TaskAgentSelect
                  id="automation-ribbon-agent"
                  label={t("automations.owner")}
                  className="automation-compact-select"
                  agents={activeAgents}
                  value={primaryTarget?.agentId}
                  disabled={savePlan.isPending}
                  onChange={(agentId) => {
                    const nextTargets: AutomationTarget[] = [
                      {
                        ...(primaryTarget ?? { id: "" }),
                        agentId,
                        chatId: undefined,
                        workingCopyId: undefined,
                      },
                    ];
                    setTargets(nextTargets);
                    setChatId("");
                    setChatSource("dedicated");
                    commit({
                      targets: nextTargets,
                      chatId: "",
                      chatSource: "dedicated",
                    });
                  }}
                />
              </div>
              <Button
                size="xs"
                variant="ghost"
                disabled={savePlan.isPending || activeAgents.length === 0}
                onClick={addMultiTarget}
              >
                <Plus data-icon="inline-start" />
                {t("automations.addMultiTarget")}
              </Button>
            </>
          ) : (
            <button
              type="button"
              className="automation-pill automation-pill--clickable"
              onClick={() => onExpandedChange(!expanded)}
            >
              <span className="automation-avatar-stack">
                {targets.slice(0, 4).map((target) => {
                  const targetAgent = agents.find(
                    (a) => a.id === target.agentId,
                  );
                  return targetAgent ? (
                    <AgentAvatar
                      key={target.id || target.agentId}
                      agent={targetAgent}
                      size="xs"
                    />
                  ) : null;
                })}
              </span>
              <span>
                {t("automations.targetCount", { count: targets.length })}
              </span>
            </button>
          )}

          <Select
            value={deliveryMode}
            disabled={savePlan.isPending}
            onValueChange={(value) => {
              const nextDelivery = value as DeliveryMode;
              setDeliveryMode(nextDelivery);
              commit({ deliveryMode: nextDelivery });
            }}
          >
            <SelectTrigger className="automation-ribbon-select">
              <SelectValue />
            </SelectTrigger>
            <SelectContent position="popper">
              {(["deliver", "audit", "propose", "curate"] as const).map(
                (id) => (
                  <SelectItem key={id} value={id}>
                    {t("automations.delivery." + id)}
                  </SelectItem>
                ),
              )}
            </SelectContent>
          </Select>

          <Select
            value={notifyPolicy}
            disabled={savePlan.isPending}
            onValueChange={(value) => {
              const nextPolicy = value as NotifyPolicy;
              setNotifyPolicy(nextPolicy);
              commit({ notifyPolicy: nextPolicy });
            }}
          >
            <SelectTrigger className="automation-ribbon-select">
              <SelectValue />
            </SelectTrigger>
            <SelectContent position="popper">
              {(["always", "actionable", "silent"] as const).map((id) => (
                <SelectItem key={id} value={id}>
                  {t("automations.notify." + id)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          {plan.workItem !== false && (
            <span className="automation-pill" data-tone="positive">
              {t("automations.boardOn")}
            </span>
          )}

          <Button
            size="xs"
            variant="outline"
            className="ml-auto"
            aria-pressed={expanded}
            onClick={() => onExpandedChange(!expanded)}
          >
            <SlidersHorizontal data-icon="inline-start" />
            {t(
              expanded
                ? "automations.collapseConfig"
                : "automations.editInline",
            )}
          </Button>
        </div>

        {plan.error && <ErrorNotice error={plan.error} />}
        {(plan.sourceDisabled || plan.sourceError) && (
          <ErrorNotice
            error={
              plan.sourceDisabled
                ? t("automations.sourceDisabled")
                : plan.sourceError
            }
          />
        )}

        {plan.eventUrl && plan.eventToken && (
          <details className="automation-event-inline">
            <summary>
              <ChevronDown aria-hidden="true" />
              {t("automations.eventSource")}
            </summary>
            <div className="automation-event-inline-body">
              <code className="automation-endpoint">POST {plan.eventUrl}</code>
              <p>{t("automations.eventHint")}</p>
              <div className="flex flex-wrap gap-1.5">
                <Button
                  size="xs"
                  variant="outline"
                  onClick={() =>
                    void copy(
                      "curl -X POST " +
                        JSON.stringify(plan.eventUrl) +
                        ' -H "Authorization: Bearer ' +
                        plan.eventToken +
                        '" -H "Content-Type: application/json" -d \'{"type":"example"}\'',
                    )
                  }
                >
                  <Copy data-icon="inline-start" />{" "}
                  {t("automations.copyRequest")}
                </Button>
                <Button
                  size="xs"
                  variant="outline"
                  onClick={() =>
                    void copy(
                      "lever automations emit --id " +
                        plan.id +
                        ' --data \'{"type":"example"}\'',
                    )
                  }
                >
                  <Copy data-icon="inline-start" /> {t("automations.copyCLI")}
                </Button>
                <Button
                  size="xs"
                  variant="ghost"
                  onClick={() => void copy(plan.eventToken!)}
                >
                  {t("automations.copyToken")}
                </Button>
              </div>
            </div>
          </details>
        )}

        {expanded && (
          <div className="automation-ribbon-expand">
            <div className="automation-cfg-group">
              <div className="automation-cfg-row">
                <div className="min-w-0">
                  <div className="automation-cfg-label">
                    {t("automations.notifyPolicy")}
                  </div>
                  <div className="automation-cfg-desc">
                    {t("automations.notify." + notifyPolicy + "Desc")}
                  </div>
                </div>
                <ToggleGroup
                  type="single"
                  size="sm"
                  className="automation-segmented"
                  spacing={0}
                  value={notifyPolicy}
                  disabled={savePlan.isPending}
                  onValueChange={(value) => {
                    if (!value) return;
                    const nextPolicy = value as NotifyPolicy;
                    setNotifyPolicy(nextPolicy);
                    commit({ notifyPolicy: nextPolicy });
                  }}
                >
                  {(["always", "actionable", "silent"] as const).map((id) => (
                    <ToggleGroupItem key={id} value={id}>
                      {t("automations.notify." + id)}
                    </ToggleGroupItem>
                  ))}
                </ToggleGroup>
              </div>

              <div className="automation-cfg-row">
                <div className="min-w-0">
                  <div className="automation-cfg-label">
                    {t("automations.deliveryMode")}
                  </div>
                  <div className="automation-cfg-desc">
                    {t("automations.deliveryModeDesc")}
                  </div>
                </div>
                <ToggleGroup
                  type="single"
                  size="sm"
                  className="automation-segmented"
                  spacing={0}
                  value={deliveryMode}
                  disabled={savePlan.isPending}
                  onValueChange={(value) => {
                    if (!value) return;
                    const nextDelivery = value as DeliveryMode;
                    setDeliveryMode(nextDelivery);
                    commit({ deliveryMode: nextDelivery });
                  }}
                >
                  {(["deliver", "audit", "propose", "curate"] as const).map(
                    (id) => (
                      <ToggleGroupItem key={id} value={id}>
                        {t("automations.delivery." + id)}
                      </ToggleGroupItem>
                    ),
                  )}
                </ToggleGroup>
              </div>

              {!isMultiTarget && (
                <div className="automation-cfg-row">
                  <div className="min-w-0">
                    <div className="automation-cfg-label">
                      {t("automations.owner")} &amp; {t("worktrees.group")}
                    </div>
                    {primaryAgent && (
                      <div className="automation-cfg-desc mono truncate">
                        {primaryDirectory(primaryAgent.profile) ||
                          directoryName(primaryDirectory(primaryAgent.profile))}
                      </div>
                    )}
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <TaskAgentSelect
                      id="automation-inline-agent"
                      label={t("automations.owner")}
                      className="automation-compact-select"
                      agents={activeAgents}
                      value={primaryTarget?.agentId}
                      disabled={savePlan.isPending}
                      onChange={(agentId) => {
                        const nextTargets: AutomationTarget[] = [
                          {
                            ...(primaryTarget ?? { id: "" }),
                            agentId,
                            chatId: undefined,
                            workingCopyId: undefined,
                          },
                        ];
                        setTargets(nextTargets);
                        commit({ targets: nextTargets });
                      }}
                    />
                    <TargetWorkingCopyCell
                      agent={primaryAgent}
                      selected={primaryTarget?.workingCopyId}
                      disabled={savePlan.isPending}
                      onSelect={(workingCopyId) => {
                        const nextTargets = targets.map((item, idx) =>
                          idx === 0 ? { ...item, workingCopyId } : item,
                        );
                        setTargets(nextTargets);
                        commit({ targets: nextTargets });
                      }}
                    />
                    <Button
                      size="xs"
                      variant="outline"
                      disabled={savePlan.isPending}
                      onClick={addMultiTarget}
                    >
                      <Plus data-icon="inline-start" />
                      {t("automations.addMultiTarget")}
                    </Button>
                  </div>
                </div>
              )}
            </div>

            {isMultiTarget && (
              <div className="automation-targets-box">
                <div className="automation-targets-head">
                  <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
                    <span className="automation-cfg-label">
                      {t("automations.multiTargetTitle", {
                        count: targets.length,
                      })}
                    </span>
                    <span className="automation-cfg-desc">
                      {t("automations.multiTargetDesc")}
                    </span>
                  </div>
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={savePlan.isPending || targets.length >= 20}
                    onClick={addMultiTarget}
                  >
                    <Plus data-icon="inline-start" />
                    {t("automations.addTarget")}
                  </Button>
                </div>
                {targets.map((target, index) => {
                  const targetAgent = agents.find(
                    (item) => item.id === target.agentId,
                  );
                  const targetEnabled = target.enabled !== false;
                  const targetDir = targetAgent
                    ? primaryDirectory(targetAgent.profile)
                    : "";
                  return (
                    <div
                      key={target.id || index}
                      className="automation-target-row"
                      data-disabled={!targetEnabled || undefined}
                    >
                      <div className="min-w-0">
                        <TaskAgentSelect
                          id={`automation-target-agent-${index}`}
                          label={t("automations.owner")}
                          className="automation-compact-select w-full"
                          agents={activeAgents}
                          value={target.agentId}
                          disabled={savePlan.isPending}
                          onChange={(agentId) => {
                            const nextTargets = targets.map((item, idx) =>
                              idx === index
                                ? {
                                    ...item,
                                    agentId,
                                    workingCopyId: undefined,
                                  }
                                : item,
                            );
                            setTargets(nextTargets);
                            commit({ targets: nextTargets });
                          }}
                        />
                        {targetDir && (
                          <div
                            className="automation-target-path mono truncate"
                            title={targetDir}
                          >
                            {directoryName(targetDir)}
                          </div>
                        )}
                      </div>
                      <TargetWorkingCopyCell
                        agent={targetAgent}
                        selected={target.workingCopyId}
                        disabled={savePlan.isPending}
                        onSelect={(workingCopyId) => {
                          const nextTargets = targets.map((item, idx) =>
                            idx === index ? { ...item, workingCopyId } : item,
                          );
                          setTargets(nextTargets);
                          commit({ targets: nextTargets });
                        }}
                      />
                      <Input
                        className="h-7 text-xs"
                        placeholder={t("automations.targetPromptPlaceholder")}
                        value={target.prompt ?? ""}
                        disabled={savePlan.isPending}
                        onChange={(event) => {
                          const value = event.target.value;
                          setTargets((prev) =>
                            prev.map((item, idx) =>
                              idx === index ? { ...item, prompt: value } : item,
                            ),
                          );
                        }}
                        onBlur={() => commit({ targets })}
                      />
                      <div className="flex items-center gap-1.5">
                        {plan.trigger.kind === "schedule" && target.id && (
                          <Button
                            size="xs"
                            variant="ghost"
                            disabled={busy || !targetEnabled}
                            onClick={() => onRunNow(target.id)}
                          >
                            <Play data-icon="inline-start" />
                            {t("automations.runTarget")}
                          </Button>
                        )}
                        <Switch
                          size="sm"
                          checked={targetEnabled}
                          disabled={savePlan.isPending}
                          aria-label={
                            targetAgent?.name ?? t("automations.owner")
                          }
                          onCheckedChange={(enabled) => {
                            const nextTargets = targets.map((item, idx) =>
                              idx === index ? { ...item, enabled } : item,
                            );
                            setTargets(nextTargets);
                            commit({ targets: nextTargets });
                          }}
                        />
                        <Button
                          size="icon-xs"
                          variant="ghost"
                          aria-label={t("automations.removeTarget")}
                          disabled={savePlan.isPending || targets.length <= 1}
                          onClick={() => {
                            const nextTargets = targets.filter(
                              (_, idx) => idx !== index,
                            );
                            setTargets(nextTargets);
                            commit({ targets: nextTargets });
                          }}
                        >
                          <X />
                        </Button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            <div className="automation-inline-prompt-box">
              <div className="flex items-center justify-between gap-2">
                <label
                  htmlFor="automation-inline-prompt"
                  className="automation-cfg-label"
                >
                  {t(
                    isMultiTarget
                      ? "automations.globalPrompt"
                      : "automations.prompt",
                  )}
                </label>
                {dirtyText ? (
                  <Button
                    size="xs"
                    disabled={savePlan.isPending || !buildInput()}
                    onClick={() => commit()}
                  >
                    {t(
                      savePlan.isPending
                        ? "automations.saving"
                        : "automations.saveChanges",
                    )}
                  </Button>
                ) : (
                  <span className="automation-saved-tag">
                    <Check className="size-3" aria-hidden="true" />
                    {t("automations.autoSaved")}
                  </span>
                )}
              </div>
              <Textarea
                id="automation-inline-prompt"
                rows={3}
                value={prompt}
                placeholder={t("automations.promptPlaceholder")}
                disabled={savePlan.isPending}
                onChange={(event) => setPrompt(event.target.value)}
                onBlur={() => {
                  if (prompt.trim() && prompt.trim() !== plan.prompt)
                    commit({ prompt });
                }}
                onKeyDown={(event) => {
                  if ((event.metaKey || event.ctrlKey) && event.key === "s") {
                    event.preventDefault();
                    commit();
                  }
                }}
              />
            </div>

            <details className="automation-advanced-details">
              <summary>
                <ChevronDown aria-hidden="true" />
                {t("automations.advancedSchedule")}
              </summary>
              <div className="automation-advanced-body">
                <div className="automation-cfg-group">
                  <div className="automation-cfg-row">
                    <div className="min-w-0">
                      <div className="automation-cfg-label">
                        {t("automations.workItem")}
                      </div>
                      <div className="automation-cfg-desc">
                        {t(
                          workItem
                            ? "automations.boardOn"
                            : "automations.boardOff",
                        )}
                      </div>
                    </div>
                    <Switch
                      size="sm"
                      checked={workItem}
                      disabled={savePlan.isPending}
                      aria-label={t("automations.workItem")}
                      onCheckedChange={(checked) => {
                        setWorkItem(checked);
                        commit({ workItem: checked });
                      }}
                    />
                  </div>
                  <div className="automation-cfg-row">
                    <div className="min-w-0">
                      <div className="automation-cfg-label">
                        {t("automations.destination")}
                      </div>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <ToggleGroup
                        type="single"
                        size="sm"
                        className="automation-segmented"
                        spacing={0}
                        value={mode}
                        disabled={savePlan.isPending}
                        onValueChange={(value) => {
                          if (!value) return;
                          const nextMode =
                            value as AutomationDestination["mode"];
                          setMode(nextMode);
                          commit({ mode: nextMode });
                        }}
                      >
                        {(["topic", "chat", "newChat"] as const).map((id) => (
                          <ToggleGroupItem key={id} value={id}>
                            {t("automations.destinationOption." + id)}
                          </ToggleGroupItem>
                        ))}
                      </ToggleGroup>
                      {sharedMode && (
                        <ToggleGroup
                          type="single"
                          size="sm"
                          className="automation-segmented"
                          spacing={0}
                          value={chatSource}
                          disabled={savePlan.isPending}
                          onValueChange={(value) => {
                            if (!value) return;
                            const nextSrc = value as "existing" | "dedicated";
                            setChatSource(nextSrc);
                            if (nextSrc === "dedicated") {
                              setChatId("");
                              commit({ chatSource: "dedicated", chatId: "" });
                            }
                          }}
                        >
                          <ToggleGroupItem
                            value="existing"
                            disabled={!ownedChats.length}
                          >
                            {t("automations.chatSource.existing")}
                          </ToggleGroupItem>
                          <ToggleGroupItem value="dedicated">
                            {t("automations.chatSource.dedicated")}
                          </ToggleGroupItem>
                        </ToggleGroup>
                      )}
                      {existingChat && (
                        <SearchableSelect
                          id="automation-inline-chat"
                          label={t("workspace.chat")}
                          className="automation-compact-select"
                          value={chatId}
                          placeholder={t("automations.selectChat")}
                          searchLabel={t("conversationSearch.searchChats")}
                          emptyLabel={t("tasks.noMatches")}
                          disabled={savePlan.isPending || !ownedChats.length}
                          onChange={(nextChat) => {
                            setChatId(nextChat);
                            commit({
                              chatSource: "existing",
                              chatId: nextChat,
                            });
                          }}
                          options={ownedChats.map((item) => ({
                            id: item.id,
                            label: displayChatTitle(item, t),
                          }))}
                        />
                      )}
                    </div>
                  </div>
                </div>

                <div className="automation-cfg-group automation-inline-trigger">
                  <ToggleRow
                    disabled={savePlan.isPending}
                    label={t("automations.trigger")}
                    value={trigger}
                    onChange={(nextTrigger) => {
                      setTrigger(nextTrigger);
                      if (nextTrigger === "schedule") {
                        commit({ trigger: nextTrigger, schedule });
                      } else {
                        commit({
                          trigger: nextTrigger,
                          sourceKey,
                          sourceFields,
                          batchSize,
                        });
                      }
                    }}
                    options={(["schedule", "event"] as const).map((id) => ({
                      id,
                      label: t("automations." + id),
                    }))}
                  />
                  {trigger === "schedule" ? (
                    <AutomationScheduleFields
                      schedule={schedule}
                      onChange={(patch) => {
                        const nextSched = { ...schedule, ...patch };
                        setSchedule(nextSched);
                        if (scheduleInput(nextSched))
                          commit({ schedule: nextSched });
                      }}
                      disabled={savePlan.isPending}
                    />
                  ) : (
                    <>
                      <FormRow
                        id="automation-inline-event"
                        label={t("automations.eventType")}
                      >
                        <Choice
                          disabled={savePlan.isPending}
                          id="automation-inline-event"
                          value={sourceKey}
                          onChange={(value) => {
                            setSourceKey(value);
                            const nextFields =
                              value === eventSourceKey(plan.trigger.source)
                                ? (plan.trigger.source?.config ?? {})
                                : {};
                            setSourceFields(nextFields);
                            commit({
                              sourceKey: value,
                              sourceFields: nextFields,
                            });
                          }}
                          options={[
                            { id: "webhook", label: t("automations.webhook") },
                            ...eventSources.map((item) => ({
                              id: item.pluginId + "/" + item.contribution.id,
                              label: item.label,
                              disabled: !item.enabled,
                            })),
                          ]}
                        />
                      </FormRow>
                      {sourceFieldDefs.map((field) => (
                        <FormRow
                          key={field.id}
                          id={`automation-inline-ev-${field.id}`}
                          label={t(
                            `plugins.eventField.${sourceKey}.${field.id}`,
                            { defaultValue: field.label },
                          )}
                        >
                          <Input
                            id={`automation-inline-ev-${field.id}`}
                            type={field.kind === "secret" ? "password" : "text"}
                            value={
                              sourceFields[field.id] ?? field.default ?? ""
                            }
                            placeholder={
                              field.kind === "secret" &&
                              plan.sourceSecrets?.includes(field.id)
                                ? t("automations.secretSaved")
                                : field.placeholder
                            }
                            onChange={(event) =>
                              setSourceFields({
                                ...sourceFields,
                                [field.id]: event.target.value,
                              })
                            }
                            onBlur={() => commit({ sourceFields })}
                          />
                        </FormRow>
                      ))}
                      <FormRow
                        id="automation-inline-batch"
                        label={t("automations.batchSize")}
                      >
                        <Input
                          id="automation-inline-batch"
                          className="automation-count"
                          type="number"
                          min={1}
                          max={50}
                          value={batchSize}
                          onChange={(event) => setBatchSize(event.target.value)}
                          onBlur={() => commit({ batchSize })}
                        />
                      </FormRow>
                    </>
                  )}
                </div>
              </div>
            </details>
          </div>
        )}
      </div>

      {archiving && (
        <Dialog
          open
          onOpenChange={(open) =>
            !open && !archivePlan.isPending && setArchiving(false)
          }
        >
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{t("automations.archive")}</DialogTitle>
              <DialogDescription>
                {t("automations.archiveConfirm", { name: plan.name })}
              </DialogDescription>
            </DialogHeader>
            {archivePlan.error && <ErrorNotice error={archivePlan.error} />}
            <DialogFooter>
              <Button
                variant="outline"
                disabled={archivePlan.isPending}
                onClick={() => setArchiving(false)}
              >
                {t("common.cancel")}
              </Button>
              <Button
                variant="destructive"
                disabled={archivePlan.isPending}
                onClick={() => archivePlan.mutate()}
              >
                {t("automations.archive")}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}
