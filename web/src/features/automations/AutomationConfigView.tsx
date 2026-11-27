import { useEffect, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Copy, Play, Plus, X } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
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
  Selection,
} from "@/api/types.gen";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { displayChatTitle } from "@/features/chat/conversationTitle";
import { TaskAgentSelect } from "@/features/tasks/TaskAgentSelect";
import { WorkingDirectoryPicker } from "@/features/worktrees/WorkingDirectoryPicker";
import { availableGroup, useWorkingCopies } from "@/features/worktrees/queries";
import { primaryDirectory } from "@/features/worktrees/scope";
import { usePrefersReducedMotion } from "@/hooks/usePrefersReducedMotion";
import { directoryName } from "@/lib/paths";
import { Choice, FormRow, ToggleRow } from "./AutomationFormControls";
import {
  AutomationRuntimeControls,
  snapshotAgentSelection,
} from "./AutomationRuntimeControls";
import { AutomationScheduleFields } from "./AutomationScheduleFields";
import { scheduleDraft, scheduleInput } from "./automationSchedule";
import {
  automationPath,
  automationsQuery,
  deliveryModeOf,
  eventSourceKey,
  notifyPolicyOf,
  planTargets,
  type AutomationConfigSection,
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

export function AutomationConfigView({
  plan,
  agents,
  chats,
  eventSources,
  busy,
  jumpTarget,
  onRunNow,
  onSaved,
}: {
  plan: Automation;
  agents: Agent[];
  chats: Chat[];
  eventSources: EventSourceOption[];
  busy: boolean;
  jumpTarget?: { section: AutomationConfigSection; seq: number };
  onRunNow: (targetId?: string) => void;
  onSaved: () => void;
}) {
  const { t } = useTranslation();
  const reducedMotion = usePrefersReducedMotion();

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
  const [selection, setSelection] = useState<Selection | undefined>(
    plan.selection,
  );
  const [notifyPolicy, setNotifyPolicy] = useState<NotifyPolicy>(() =>
    notifyPolicyOf(plan),
  );
  const [deliveryMode, setDeliveryMode] = useState<DeliveryMode>(() =>
    deliveryModeOf(plan),
  );
  const [workItem, setWorkItem] = useState(plan.workItem ?? true);
  const [addingScope, setAddingScope] = useState(false);
  const [pendingAgentId, setPendingAgentId] = useState("");
  const [highlightedSection, setHighlightedSection] =
    useState<AutomationConfigSection>();

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
    setSelection(plan.selection);
    setNotifyPolicy(notifyPolicyOf(plan));
    setDeliveryMode(deliveryModeOf(plan));
    setWorkItem(plan.workItem ?? true);
  }, [plan]);

  useEffect(() => {
    if (!jumpTarget) return;
    const el = document.getElementById(`automation-cfg-${jumpTarget.section}`);
    if (!el) return;
    const raf = window.requestAnimationFrame(() => {
      el.scrollIntoView({
        behavior: reducedMotion ? "auto" : "smooth",
        block: "start",
      });
    });
    setHighlightedSection(jumpTarget.section);
    const timer = window.setTimeout(() => setHighlightedSection(undefined), 900);
    return () => {
      window.cancelAnimationFrame(raf);
      window.clearTimeout(timer);
    };
  }, [jumpTarget, reducedMotion]);

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
      onSaved();
    },
    onError: (error) => toast.error(error.message),
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
    selection?: Selection | null;
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
    const nextSelection =
      overrides && "selection" in overrides
        ? (overrides.selection ?? undefined)
        : selection;
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
      selection: nextMulti ? undefined : nextSelection,
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

  function startAddScope() {
    if (!activeAgents.length) {
      toast.error(t("automations.agentRequired"));
      return;
    }
    const used = new Set(targets.map((item) => item.agentId));
    const suggested =
      activeAgents.find((item) => !used.has(item.id)) ?? activeAgents[0];
    setPendingAgentId(suggested.id);
    setAddingScope(true);
  }

  function confirmAddScope() {
    if (!pendingAgentId) return;
    const addedAgent = activeAgents.find((item) => item.id === pendingAgentId);
    const base = targets.map((item, idx) => ({
      ...item,
      id: item.id || crypto.randomUUID(),
      selection:
        item.selection ??
        (idx === 0
          ? (selection ??
            (primaryAgent ? snapshotAgentSelection(primaryAgent) : undefined))
          : undefined),
    }));
    const nextTargets: AutomationTarget[] = [
      ...base,
      {
        id: crypto.randomUUID(),
        agentId: pendingAgentId,
        enabled: true,
        prompt: "",
        selection: addedAgent ? snapshotAgentSelection(addedAgent) : undefined,
      },
    ];
    setTargets(nextTargets);
    setSelection(undefined);
    setAddingScope(false);
    commit({ targets: nextTargets, selection: null });
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

  const subtleTransition = reducedMotion
    ? { duration: 0 }
    : { duration: 0.16, ease: [0.23, 1, 0.32, 1] as const };

  return (
    <div className="automation-config-scroll">
      <div className="automation-config-inner">
        {/* 1. Basics & Instructions */}
        <section
          id="automation-cfg-prompt"
          className="automation-config-section"
          data-highlighted={highlightedSection === "prompt" || undefined}
        >
          <div className="automation-config-section-head">
            <h3>{t("automations.sectionBasics")}</h3>
            {dirtyText && (
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
            )}
          </div>
          <div className="automation-config-panel panel-surface">
            <div className="automation-cfg-row">
              <div className="min-w-0">
                <label
                  htmlFor="automation-config-name"
                  className="automation-cfg-label"
                >
                  {t("automations.name")}
                </label>
              </div>
              <Input
                id="automation-config-name"
                className="automation-config-name-input"
                value={name}
                maxLength={80}
                disabled={savePlan.isPending}
                onChange={(event) => setName(event.target.value)}
                onBlur={() => {
                  if (name.trim() && name.trim() !== plan.name) {
                    commit({ name: name.trim() });
                  } else {
                    setName(plan.name);
                  }
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") event.currentTarget.blur();
                  if (event.key === "Escape") {
                    setName(plan.name);
                    event.currentTarget.blur();
                  }
                }}
              />
            </div>

            <div className="automation-cfg-row automation-cfg-row--stacked">
              <label
                htmlFor="automation-config-prompt"
                className="automation-cfg-label"
              >
                {t(
                  isMultiTarget
                    ? "automations.globalPrompt"
                    : "automations.prompt",
                )}
              </label>
              <Textarea
                id="automation-config-prompt"
                className="automation-config-textarea"
                rows={4}
                value={prompt}
                placeholder={t("automations.promptPlaceholder")}
                disabled={savePlan.isPending}
                onChange={(event) => setPrompt(event.target.value)}
                onBlur={() => {
                  if (prompt.trim() && prompt.trim() !== plan.prompt) {
                    commit({ prompt });
                  }
                }}
                onKeyDown={(event) => {
                  if ((event.metaKey || event.ctrlKey) && event.key === "s") {
                    event.preventDefault();
                    commit();
                  }
                }}
              />
            </div>
          </div>
        </section>

        {/* 2. Execution Targets & Runtime */}
        <section
          id="automation-cfg-targets"
          className="automation-config-section"
          data-highlighted={highlightedSection === "targets" || undefined}
        >
          <div className="automation-config-section-head">
            <h3>{t("automations.sectionTargets")}</h3>
            {isMultiTarget && (
              <span className="automation-config-section-sub">
                {t("automations.multiTargetTitle", { count: targets.length })}
              </span>
            )}
          </div>

          <div className="automation-config-panel panel-surface">
            {!isMultiTarget ? (
              <>
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
                      id="automation-config-agent"
                      label={t("automations.owner")}
                      className="automation-compact-select"
                      agents={activeAgents}
                      value={primaryTarget?.agentId}
                      disabled={savePlan.isPending}
                      onChange={(agentId) => {
                        const nextAgent = activeAgents.find(
                          (item) => item.id === agentId,
                        );
                        const locked = nextAgent
                          ? snapshotAgentSelection(nextAgent)
                          : undefined;
                        const nextTargets: AutomationTarget[] = [
                          {
                            ...(primaryTarget ?? { id: "" }),
                            agentId,
                            chatId: undefined,
                            workingCopyId: undefined,
                            selection: undefined,
                          },
                        ];
                        setTargets(nextTargets);
                        setSelection(locked);
                        setChatId("");
                        setChatSource("dedicated");
                        commit({
                          targets: nextTargets,
                          selection: locked ?? null,
                          chatId: "",
                          chatSource: "dedicated",
                        });
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
                  </div>
                </div>
                {primaryAgent && (
                  <div className="automation-cfg-row automation-cfg-row--runtime">
                    <div className="min-w-0">
                      <div className="automation-cfg-label">
                        {t("automations.runtime")}
                      </div>
                      <div className="automation-cfg-desc">
                        {t("automations.runtimeDesc")}
                      </div>
                    </div>
                    <AutomationRuntimeControls
                      agent={primaryAgent}
                      value={selection}
                      disabled={savePlan.isPending}
                      compact
                      lockOnReset
                      idPrefix="automation-config"
                      onChange={(nextSelection) => {
                        setSelection(nextSelection);
                        commit({ selection: nextSelection ?? null });
                      }}
                    />
                  </div>
                )}
              </>
            ) : (
              <div>
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
                      <div className="automation-target-row-top">
                        <div className="flex min-w-0 flex-wrap items-center gap-2">
                          <TaskAgentSelect
                            id={`automation-target-agent-${index}`}
                            label={t("automations.owner")}
                            className="automation-compact-select"
                            agents={activeAgents}
                            value={target.agentId}
                            disabled={savePlan.isPending}
                            onChange={(agentId) => {
                              const nextAgent = activeAgents.find(
                                (item) => item.id === agentId,
                              );
                              const locked = nextAgent
                                ? snapshotAgentSelection(nextAgent)
                                : undefined;
                              const nextTargets = targets.map((item, idx) =>
                                idx === index
                                  ? {
                                      ...item,
                                      agentId,
                                      workingCopyId: undefined,
                                      selection: locked,
                                    }
                                  : item,
                              );
                              setTargets(nextTargets);
                              commit({ targets: nextTargets });
                            }}
                          />
                          <TargetWorkingCopyCell
                            agent={targetAgent}
                            selected={target.workingCopyId}
                            disabled={savePlan.isPending}
                            onSelect={(workingCopyId) => {
                              const nextTargets = targets.map((item, idx) =>
                                idx === index
                                  ? { ...item, workingCopyId }
                                  : item,
                              );
                              setTargets(nextTargets);
                              commit({ targets: nextTargets });
                            }}
                          />
                        </div>
                        <div className="ml-auto flex items-center gap-1.5">
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
                              if (nextTargets.length === 1) {
                                const carried = nextTargets[0]?.selection;
                                setSelection(carried);
                                commit({
                                  targets: nextTargets,
                                  selection: carried ?? null,
                                });
                              } else {
                                commit({ targets: nextTargets });
                              }
                            }}
                          >
                            <X />
                          </Button>
                        </div>
                      </div>

                      <div className="automation-target-row-meta">
                        {targetDir && (
                          <span
                            className="automation-target-path mono truncate"
                            title={targetDir}
                          >
                            {directoryName(targetDir)}
                          </span>
                        )}
                        <Input
                          className="h-7 min-w-0 flex-1 text-xs"
                          placeholder={t("automations.targetPromptPlaceholder")}
                          value={target.prompt ?? ""}
                          disabled={savePlan.isPending}
                          onChange={(event) => {
                            const value = event.target.value;
                            setTargets((prev) =>
                              prev.map((item, idx) =>
                                idx === index
                                  ? { ...item, prompt: value }
                                  : item,
                              ),
                            );
                          }}
                          onBlur={() => commit({ targets })}
                        />
                      </div>

                      {targetAgent && (
                        <div className="automation-target-runtime">
                          <AutomationRuntimeControls
                            agent={targetAgent}
                            value={target.selection ?? selection}
                            disabled={savePlan.isPending || !targetEnabled}
                            compact
                            lockOnReset
                            idPrefix={`automation-target-${index}`}
                            onChange={(nextSelection) => {
                              const nextTargets = targets.map((item, idx) =>
                                idx === index
                                  ? { ...item, selection: nextSelection }
                                  : item,
                              );
                              setTargets(nextTargets);
                              commit({ targets: nextTargets });
                            }}
                          />
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            <div className="automation-add-scope-footer">
              <AnimatePresence initial={false} mode="wait">
                {addingScope ? (
                  <motion.div
                    key="picker"
                    className="automation-add-scope-picker"
                    initial={reducedMotion ? false : { opacity: 0, y: -4 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={reducedMotion ? undefined : { opacity: 0, y: -4 }}
                    transition={subtleTransition}
                  >
                    <span className="automation-cfg-label">
                      {t("automations.pickScopeAgent")}
                    </span>
                    <TaskAgentSelect
                      id="automation-add-scope-agent"
                      label={t("automations.pickScopeAgent")}
                      className="automation-compact-select"
                      agents={activeAgents}
                      value={pendingAgentId}
                      disabled={savePlan.isPending}
                      onChange={setPendingAgentId}
                    />
                    <Button
                      type="button"
                      size="xs"
                      disabled={savePlan.isPending || !pendingAgentId}
                      onClick={confirmAddScope}
                    >
                      {t("automations.confirmAddTarget")}
                    </Button>
                    <Button
                      type="button"
                      size="xs"
                      variant="ghost"
                      disabled={savePlan.isPending}
                      onClick={() => setAddingScope(false)}
                    >
                      {t("common.cancel")}
                    </Button>
                  </motion.div>
                ) : (
                  <motion.div
                    key="cta"
                    className="automation-add-scope-bar"
                    initial={reducedMotion ? false : { opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={reducedMotion ? undefined : { opacity: 0 }}
                    transition={subtleTransition}
                  >
                    <span className="automation-cfg-desc">
                      {t(
                        isMultiTarget
                          ? "automations.multiTargetDesc"
                          : "automations.singleTargetHint",
                      )}
                    </span>
                    <Button
                      type="button"
                      size="xs"
                      variant="outline"
                      disabled={
                        savePlan.isPending ||
                        activeAgents.length === 0 ||
                        targets.length >= 20
                      }
                      onClick={startAddScope}
                    >
                      <Plus data-icon="inline-start" />
                      {t("automations.addTarget")}
                    </Button>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          </div>
        </section>

        {/* 3. Trigger (Flat — zero nested <details>!) */}
        <section
          id="automation-cfg-trigger"
          className="automation-config-section"
          data-highlighted={highlightedSection === "trigger" || undefined}
        >
          <div className="automation-config-section-head">
            <h3>{t("automations.sectionTrigger")}</h3>
          </div>
          <div className="automation-config-panel panel-surface automation-inline-trigger">
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
            <AnimatePresence initial={false} mode="wait">
              {trigger === "schedule" ? (
                <motion.div
                  key="schedule"
                  className="automation-trigger-fields"
                  initial={reducedMotion ? false : { opacity: 0, y: 4 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={reducedMotion ? undefined : { opacity: 0 }}
                  transition={subtleTransition}
                >
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
                </motion.div>
              ) : (
                <motion.div
                  key="event"
                  className="automation-trigger-fields"
                  initial={reducedMotion ? false : { opacity: 0, y: 4 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={reducedMotion ? undefined : { opacity: 0 }}
                  transition={subtleTransition}
                >
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
                        value={sourceFields[field.id] ?? field.default ?? ""}
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
                  {plan.eventUrl && plan.eventToken && sourceKey === "webhook" && (
                    <div className="automation-webhook-block">
                      <div className="automation-cfg-label">
                        {t("automations.eventSource")}
                      </div>
                      <code className="automation-endpoint">
                        POST {plan.eventUrl}
                      </code>
                      <p className="automation-cfg-desc">
                        {t("automations.eventHint")}
                      </p>
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
                          <Copy data-icon="inline-start" />{" "}
                          {t("automations.copyCLI")}
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
                  )}
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </section>

        {/* 4. Delivery & Notifications */}
        <section
          id="automation-cfg-output"
          className="automation-config-section"
          data-highlighted={highlightedSection === "output" || undefined}
        >
          <div className="automation-config-section-head">
            <h3>{t("automations.sectionOutput")}</h3>
          </div>
          <div className="automation-config-panel panel-surface">
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
                    const nextMode = value as AutomationDestination["mode"];
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

            <div className="automation-cfg-row">
              <div className="min-w-0">
                <div className="automation-cfg-label">
                  {t("automations.workItem")}
                </div>
                <div className="automation-cfg-desc">
                  {t(workItem ? "automations.boardOn" : "automations.boardOff")}
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
          </div>
        </section>
      </div>
    </div>
  );
}
