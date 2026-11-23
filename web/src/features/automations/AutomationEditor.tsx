import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import {
  Bug,
  Check,
  ChevronDown,
  GitPullRequest,
  Layers,
  Lightbulb,
  Plus,
  X,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { api } from "@/api/client";
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
import { ErrorNotice } from "@/components/common";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { AgentAvatar } from "@/features/agents/AgentAvatar";
import { displayChatTitle } from "@/features/chat/conversationTitle";
import { TaskAgentSelect } from "@/features/tasks/TaskAgentSelect";
import { WorkingDirectoryPicker } from "@/features/worktrees/WorkingDirectoryPicker";
import { availableGroup, useWorkingCopies } from "@/features/worktrees/queries";
import { primaryDirectory } from "@/features/worktrees/scope";
import { Choice, FormRow, ToggleRow } from "./AutomationFormControls";
import { AutomationRuntimeControls } from "./AutomationRuntimeControls";
import { AutomationScheduleFields } from "./AutomationScheduleFields";
import { scheduleDraft, scheduleInput } from "./automationSchedule";
import {
  automationPath,
  deliveryModeOf,
  eventSourceKey,
  notifyPolicyOf,
  triggerLabel,
  type DeliveryMode,
  type EventSourceOption,
  type NotifyPolicy,
} from "./automationsQuery";

export type { EventSourceOption };
export { eventSourceKey };

const templates = [
  {
    id: "issuePr",
    schedule: { time: "03:00" },
    icon: GitPullRequest,
    trigger: "schedule" as const,
    deliveryMode: "deliver" as DeliveryMode,
    notifyPolicy: "actionable" as NotifyPolicy,
    workItem: false,
  },
  {
    id: "techDebt",
    schedule: { time: "22:00", weekdays: [0] },
    icon: Layers,
    trigger: "schedule" as const,
    deliveryMode: "audit" as DeliveryMode,
    notifyPolicy: "always" as NotifyPolicy,
    workItem: false,
  },
  {
    id: "alertOps",
    icon: Bug,
    trigger: "event" as const,
    deliveryMode: "deliver" as DeliveryMode,
    notifyPolicy: "silent" as NotifyPolicy,
    workItem: false,
  },
  {
    id: "ideas",
    schedule: { time: "08:30", weekdays: [1] },
    icon: Lightbulb,
    trigger: "schedule" as const,
    deliveryMode: "propose" as DeliveryMode,
    notifyPolicy: "actionable" as NotifyPolicy,
    workItem: false,
  },
];

export function AutomationEditor({
  plan,
  agents,
  defaultAgentId,
  chats,
  eventSources,
  onClose,
  onSaved,
}: {
  plan?: Automation;
  agents: Agent[];
  defaultAgentId?: string;
  chats: Chat[];
  eventSources: EventSourceOption[];
  onClose: () => void;
  onSaved: (plan: Automation) => void;
}) {
  const { t } = useTranslation();
  const initialSource = plan?.trigger.source;
  const initialTemplate = templates[0];
  const [name, setName] = useState(
    plan?.name ?? t(`automations.tpl.${initialTemplate.id}`),
  );
  const [prompt, setPrompt] = useState(
    plan?.prompt ?? t(`automations.tpl.${initialTemplate.id}Prompt`),
  );
  const [trigger, setTrigger] = useState<AutomationTrigger["kind"]>(
    plan?.trigger.kind ?? "schedule",
  );
  const [sourceKey, setSourceKey] = useState(eventSourceKey(initialSource));
  const [sourceFields, setSourceFields] = useState(initialSource?.config ?? {});
  const [batchSize, setBatchSize] = useState(
    String(plan?.trigger.batchSize ?? 1),
  );
  const [schedule, setSchedule] = useState(() =>
    scheduleDraft(plan ? plan.trigger.schedule : initialTemplate.schedule),
  );
  const scheduleValue = scheduleInput(schedule);
  const [mode, setMode] = useState<AutomationDestination["mode"]>(
    plan?.destination.mode ?? "topic",
  );
  const [agentId, setAgent] = useState(
    plan?.destination.agentId ??
      agents.find((item) => item.id === defaultAgentId)?.id ??
      agents[0]?.id ??
      "",
  );
  const [extraTargets, setExtraTargets] = useState<AutomationTarget[]>(
    () => plan?.targets?.slice(1) ?? [],
  );
  const [chatId, setChat] = useState(plan?.destination.chatId ?? "");
  const [chatSource, setChatSource] = useState<
    "existing" | "dedicated" | undefined
  >(plan ? (plan.destination.chatId ? "existing" : "dedicated") : undefined);
  const [copyId, setCopy] = useState(plan?.destination.workingCopyId);
  const [selection, setSelection] = useState<Selection | undefined>(
    plan?.selection ?? plan?.targets?.[0]?.selection,
  );
  const [workItem, setWorkItem] = useState(
    plan ? (plan.workItem ?? true) : false,
  );
  const [quiet, setQuiet] = useState(plan?.quiet ?? false);
  const [notifyPolicy, setNotifyPolicy] = useState<NotifyPolicy>(
    plan ? notifyPolicyOf(plan) : initialTemplate.notifyPolicy,
  );
  const [deliveryMode, setDeliveryMode] = useState<DeliveryMode>(
    plan ? deliveryModeOf(plan) : initialTemplate.deliveryMode,
  );
  const [selectedTpl, setSelectedTpl] = useState(
    plan ? undefined : initialTemplate.id,
  );

  const agent = agents.find((item) => item.id === agentId);
  const ownedChats = chats.filter((item) => item.agentId === agentId);
  const shared = mode !== "newChat" && extraTargets.length === 0;
  const target = chatSource ?? "dedicated";
  const existing = shared && target === "existing";
  const chat = ownedChats.find((item) => item.id === chatId);
  const groupApplicable = !!agent && (mode !== "chat" || !existing);
  const copies = useWorkingCopies(agentId, groupApplicable);
  const selectedCopy = copies.data?.find((copy) => copy.id === copyId);
  const runtimeCwd = selectedCopy
    ? primaryDirectory(selectedCopy)
    : agent
      ? primaryDirectory(agent.profile)
      : "";
  const count = Number(batchSize);
  const source = eventSources.find(
    (item) => item.pluginId + "/" + item.contribution.id === sourceKey,
  );
  const fields = source?.contribution.fields ?? [];
  const sourceUnchanged =
    sourceKey === eventSourceKey(initialSource) &&
    fields.every(
      (field) =>
        field.kind === "secret" ||
        ((sourceFields[field.id] ?? "").trim() || field.default || "") ===
          (initialSource?.config?.[field.id] ?? ""),
    );
  const fieldsReady = fields.every(
    (field) =>
      !field.required ||
      !!(field.kind === "secret"
        ? sourceFields[field.id]
        : sourceFields[field.id]?.trim()) ||
      !!field.default ||
      (field.kind === "secret" &&
        sourceUnchanged &&
        plan?.sourceSecrets?.includes(field.id)),
  );
  const canSave =
    !!name.trim() &&
    !!prompt.trim() &&
    !!agent &&
    extraTargets.every((item) => !!item.agentId) &&
    (!existing || !!chat) &&
    (!groupApplicable ||
      !copyId ||
      availableGroup(copies.data?.find((copy) => copy.id === copyId))) &&
    (trigger === "schedule"
      ? !!scheduleValue
      : (sourceKey === "webhook" || !!source) &&
        fieldsReady &&
        Number.isInteger(count) &&
        count >= 1 &&
        count <= 50);

  const save = useMutation({
    mutationFn: (value: AutomationInput) =>
      api<Automation>(
        plan ? automationPath + "/" + plan.id : automationPath,
        value,
        plan ? "PUT" : "POST",
      ),
    onSuccess: (saved) => onSaved(saved),
  });

  const selectProps = { disabled: save.isPending };
  const compactOwners = !plan && agents.length > 0 && agents.length <= 4;
  const owners = [agentId, ...extraTargets.map((item) => item.agentId)].filter(
    Boolean,
  );

  function chooseOwners(ids: string[]) {
    const primary = ids[0] ?? "";
    if (primary !== agentId) {
      setAgent(primary);
      setChat("");
      setChatSource(undefined);
      setCopy(undefined);
      setSelection(undefined);
    }
    setExtraTargets(
      ids.slice(1).map(
        (id) =>
          extraTargets.find((target) => target.agentId === id) ?? {
            id: crypto.randomUUID(),
            agentId: id,
            enabled: true,
          },
      ),
    );
  }

  function applyTemplate(tpl: (typeof templates)[number]) {
    setSelectedTpl(tpl.id);
    setName(t(`automations.tpl.${tpl.id}`));
    setPrompt(t(`automations.tpl.${tpl.id}Prompt`));
    setTrigger(tpl.trigger);
    if (tpl.trigger === "schedule") {
      setSchedule(scheduleDraft({ ...tpl.schedule, timezone: schedule.zone }));
    }
    setDeliveryMode(tpl.deliveryMode);
    setNotifyPolicy(tpl.notifyPolicy);
    setQuiet(tpl.notifyPolicy === "silent");
    setWorkItem(tpl.workItem);
  }

  return (
    <Dialog open onOpenChange={(open) => !open && !save.isPending && onClose()}>
      <DialogContent aria-describedby={undefined} className="automation-editor">
        <DialogHeader>
          <DialogTitle>
            {t(plan ? "automations.edit" : "automations.create")}
          </DialogTitle>
        </DialogHeader>
        <form
          className="automation-editor-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (!canSave || save.isPending) return;
            const targets =
              extraTargets.length > 0
                ? [
                    {
                      id: plan?.targets?.[0]?.id || crypto.randomUUID(),
                      agentId,
                      workingCopyId: groupApplicable ? copyId : undefined,
                      selection,
                      enabled: true,
                    },
                    ...extraTargets,
                  ]
                : undefined;
            save.mutate({
              name,
              prompt,
              trigger:
                trigger === "event"
                  ? {
                      kind: "event",
                      batchSize: count,
                      source: source && {
                        pluginId: source.pluginId,
                        contributionId: source.contribution.id,
                        config: sourceFields,
                      },
                    }
                  : {
                      kind: "schedule",
                      schedule: scheduleValue,
                    },
              destination: {
                mode,
                agentId,
                chatId: existing ? chatId : undefined,
                workingCopyId: groupApplicable ? copyId : undefined,
              },
              selection: extraTargets.length > 0 ? undefined : selection,
              targets,
              notifyPolicy: quiet ? "silent" : notifyPolicy,
              deliveryMode,
              workItem,
              quiet,
            });
          }}
        >
          <div className="automation-editor-body">
            <fieldset
              disabled={save.isPending}
              className="automation-editor-fields"
            >
              {!plan && (
                <div className="automation-editor-templates">
                  <div
                    className="automation-tpl-grid"
                    role="group"
                    aria-label={t("automations.templatesLabel")}
                  >
                    {templates.map((tpl) => {
                      const Icon = tpl.icon;
                      return (
                        <button
                          key={tpl.id}
                          type="button"
                          className="automation-tpl-card"
                          data-selected={selectedTpl === tpl.id || undefined}
                          aria-pressed={selectedTpl === tpl.id}
                          onClick={() => applyTemplate(tpl)}
                        >
                          <span className="inline-flex items-center gap-1.5 font-medium">
                            <Icon className="size-3.5 text-muted-foreground" />
                            {t(`automations.tpl.${tpl.id}`)}
                          </span>
                          <span className="text-[11px] text-muted-foreground">
                            {t(`automations.delivery.${tpl.deliveryMode}`)} ·{" "}
                            {t(`automations.notify.${tpl.notifyPolicy}`)}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              <FieldGroup className="automation-form-group">
                <FormRow id="automation-name" label={t("automations.name")}>
                  <Input
                    id="automation-name"
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    placeholder={t("automations.name")}
                    maxLength={80}
                    required
                  />
                </FormRow>
                <FormRow
                  id="automation-agent"
                  label={t("automations.owner")}
                  description={
                    agents.length ? undefined : t("automations.agentRequired")
                  }
                >
                  {compactOwners ? (
                    <ToggleGroup
                      id="automation-agent"
                      type="multiple"
                      spacing={1}
                      value={owners}
                      onValueChange={chooseOwners}
                      aria-label={t("automations.owner")}
                      className="automation-owner-chips"
                    >
                      {agents.map((item) => (
                        <ToggleGroupItem
                          key={item.id}
                          value={item.id}
                          aria-label={item.name}
                          className="automation-owner-chip"
                        >
                          <AgentAvatar agent={item} size="xs" />
                          <span className="truncate">{item.name}</span>
                          {owners.includes(item.id) && (
                            <Check
                              className="size-3 shrink-0"
                              aria-hidden="true"
                            />
                          )}
                        </ToggleGroupItem>
                      ))}
                    </ToggleGroup>
                  ) : (
                    <div className="flex flex-wrap items-center justify-end gap-1.5">
                      <TaskAgentSelect
                        id="automation-agent"
                        label={t("automations.owner")}
                        className="automation-choice"
                        agents={agents}
                        value={agent?.id}
                        disabled={save.isPending}
                        onChange={(value) => {
                          setAgent(value);
                          setChat("");
                          setChatSource(undefined);
                          setCopy(undefined);
                          setSelection(undefined);
                        }}
                      />
                      {agents.length > 1 && (
                        <Button
                          type="button"
                          size="xs"
                          variant="ghost"
                          onClick={() => {
                            const used = new Set([
                              agentId,
                              ...extraTargets.map((item) => item.agentId),
                            ]);
                            const next =
                              agents.find((item) => !used.has(item.id)) ??
                              agents[0];
                            setExtraTargets((prev) => [
                              ...prev,
                              {
                                id: crypto.randomUUID(),
                                agentId: next.id,
                                enabled: true,
                              },
                            ]);
                          }}
                        >
                          <Plus data-icon="inline-start" />
                          {t("automations.addMultiTarget")}
                        </Button>
                      )}
                    </div>
                  )}
                </FormRow>
                {!compactOwners &&
                  extraTargets.map((extra, idx) => (
                    <FormRow
                      key={extra.id}
                      label={`${t("automations.owner")} #${idx + 2}`}
                    >
                      <div className="flex items-center gap-1.5">
                        <TaskAgentSelect
                          id={`automation-extra-agent-${idx}`}
                          label={t("automations.owner")}
                          className="automation-choice"
                          agents={agents}
                          value={extra.agentId}
                          disabled={save.isPending}
                          onChange={(value) =>
                            setExtraTargets((prev) =>
                              prev.map((item, i) =>
                                i === idx
                                  ? {
                                      ...item,
                                      agentId: value,
                                      selection: undefined,
                                    }
                                  : item,
                              ),
                            )
                          }
                        />
                        <Button
                          type="button"
                          size="icon-xs"
                          variant="ghost"
                          aria-label={t("automations.removeTarget")}
                          onClick={() =>
                            setExtraTargets((prev) =>
                              prev.filter((_, i) => i !== idx),
                            )
                          }
                        >
                          <X />
                        </Button>
                      </div>
                    </FormRow>
                  ))}
                {agent && (
                  <div className="automation-runtime-form-row">
                    <span className="automation-runtime-form-label">
                      {extraTargets.length > 0
                        ? `${agent.name} · ${t("automations.runtime")}`
                        : t("automations.runtime")}
                    </span>
                    <AutomationRuntimeControls
                      agent={agent}
                      cwd={runtimeCwd}
                      value={selection}
                      onChange={setSelection}
                      disabled={save.isPending}
                      idPrefix="automation-editor"
                    />
                  </div>
                )}
                {extraTargets.map((extra, idx) => {
                  const extraAgent = agents.find(
                    (item) => item.id === extra.agentId,
                  );
                  if (!extraAgent) return null;
                  return (
                    <div
                      key={`${extra.id}-runtime`}
                      className="automation-runtime-form-row"
                    >
                      <span className="automation-runtime-form-label">
                        {`${extraAgent.name} · ${t("automations.runtime")}`}
                      </span>
                      <AutomationRuntimeControls
                        agent={extraAgent}
                        value={extra.selection}
                        onChange={(nextSelection) =>
                          setExtraTargets((prev) =>
                            prev.map((item, i) =>
                              i === idx
                                ? { ...item, selection: nextSelection }
                                : item,
                            ),
                          )
                        }
                        disabled={save.isPending}
                        compact
                        idPrefix={`automation-editor-extra-${idx}`}
                      />
                    </div>
                  );
                })}
              </FieldGroup>
              <div className="automation-editor-prompt">
                <FieldLabel className="sr-only" htmlFor="automation-prompt">
                  {t("automations.prompt")}
                </FieldLabel>
                <Textarea
                  id="automation-prompt"
                  value={prompt}
                  onChange={(event) => setPrompt(event.target.value)}
                  placeholder={t("automations.promptPlaceholder")}
                  rows={4}
                  required
                />
              </div>

              <details
                className="automation-advanced-details"
                open={plan ? true : undefined}
              >
                <summary>
                  <ChevronDown />
                  {t("automations.advancedSchedule")}
                  <span className="automation-editor-cadence">
                    {trigger === "schedule" && scheduleValue
                      ? triggerLabel(
                          {
                            trigger: { kind: trigger, schedule: scheduleValue },
                          },
                          t,
                        )
                      : t("automations." + trigger)}
                  </span>
                </summary>
                <div className="automation-advanced-body">
                  <FieldGroup className="automation-form-group">
                    <ToggleRow
                      {...selectProps}
                      label={t("automations.trigger")}
                      value={trigger}
                      onChange={setTrigger}
                      options={(["schedule", "event"] as const).map((id) => ({
                        id,
                        label: t("automations." + id),
                      }))}
                    />
                    {trigger === "schedule" ? (
                      <AutomationScheduleFields
                        schedule={schedule}
                        onChange={(patch) =>
                          setSchedule((current) => ({ ...current, ...patch }))
                        }
                        disabled={save.isPending}
                      />
                    ) : (
                      <>
                        <FormRow
                          id="automation-event"
                          label={t("automations.eventType")}
                        >
                          <Choice
                            {...selectProps}
                            id="automation-event"
                            value={sourceKey}
                            onChange={(value) => {
                              setSourceKey(value);
                              setSourceFields(
                                value === eventSourceKey(initialSource)
                                  ? (initialSource?.config ?? {})
                                  : {},
                              );
                            }}
                            options={[
                              {
                                id: "webhook",
                                label: t("automations.webhook"),
                              },
                              ...eventSources.map((item) => ({
                                id: item.pluginId + "/" + item.contribution.id,
                                label: item.label,
                                disabled: !item.enabled,
                              })),
                            ]}
                          />
                        </FormRow>
                        {fields.map((field) => {
                          const id = "automation-event-" + field.id;
                          const saved =
                            field.kind === "secret" &&
                            sourceUnchanged &&
                            plan?.sourceSecrets?.includes(field.id);
                          return (
                            <FormRow
                              key={field.id}
                              id={id}
                              label={t(
                                "plugins.eventField." +
                                  sourceKey +
                                  "." +
                                  field.id,
                                { defaultValue: field.label },
                              )}
                            >
                              <Input
                                id={id}
                                type={
                                  field.kind === "secret" ? "password" : "text"
                                }
                                autoComplete={
                                  field.kind === "secret"
                                    ? "new-password"
                                    : "off"
                                }
                                spellCheck={false}
                                required={field.required && !saved}
                                placeholder={
                                  saved
                                    ? t("automations.secretSaved")
                                    : field.placeholder
                                }
                                value={
                                  sourceFields[field.id] ?? field.default ?? ""
                                }
                                onChange={(event) =>
                                  setSourceFields({
                                    ...sourceFields,
                                    [field.id]: event.target.value,
                                  })
                                }
                              />
                            </FormRow>
                          );
                        })}
                        <FormRow
                          id="automation-batch"
                          label={t("automations.batchSize")}
                        >
                          <Input
                            id="automation-batch"
                            className="automation-count"
                            type="number"
                            min={1}
                            max={50}
                            value={batchSize}
                            onChange={(event) =>
                              setBatchSize(event.target.value)
                            }
                            required
                          />
                        </FormRow>
                      </>
                    )}
                  </FieldGroup>

                  <FieldGroup className="automation-form-group">
                    <ToggleRow
                      {...selectProps}
                      label={t("automations.destination")}
                      value={mode}
                      onChange={setMode}
                      options={(["topic", "chat", "newChat"] as const).map(
                        (id) => ({
                          id,
                          label: t("automations.destinationOption." + id),
                        }),
                      )}
                    />
                    {shared && (
                      <ToggleRow
                        {...selectProps}
                        label={t("automations.chatSource")}
                        value={target}
                        onChange={(value) => {
                          setChatSource(value);
                          setCopy(undefined);
                        }}
                        options={[
                          {
                            id: "existing",
                            label: t("automations.chatSource.existing"),
                            disabled: !ownedChats.length,
                          },
                          {
                            id: "dedicated",
                            label: t("automations.chatSource.dedicated"),
                          },
                        ]}
                      />
                    )}
                    {existing && (
                      <FormRow id="automation-chat" label={t("workspace.chat")}>
                        <SearchableSelect
                          id="automation-chat"
                          label={t("workspace.chat")}
                          className="automation-choice"
                          value={chat?.id}
                          placeholder={t("automations.selectChat")}
                          searchLabel={t("conversationSearch.searchChats")}
                          emptyLabel={t("tasks.noMatches")}
                          disabled={save.isPending || !ownedChats.length}
                          onChange={setChat}
                          options={ownedChats.map((item) => ({
                            id: item.id,
                            label: displayChatTitle(item, t),
                          }))}
                        />
                      </FormRow>
                    )}
                    {agent &&
                      groupApplicable &&
                      (copyId || copies.data?.some(availableGroup)) && (
                        <FormRow label={t("worktrees.group")}>
                          <WorkingDirectoryPicker
                            key={agent.id}
                            copies={copies.data}
                            originalPath={primaryDirectory(agent.profile)}
                            selected={copyId}
                            onSelect={setCopy}
                            disabled={save.isPending}
                          />
                        </FormRow>
                      )}
                  </FieldGroup>

                  <FieldGroup className="automation-form-group">
                    <ToggleRow
                      {...selectProps}
                      label={t("automations.deliveryMode")}
                      stacked
                      value={deliveryMode}
                      onChange={setDeliveryMode}
                      options={(
                        ["deliver", "audit", "propose", "curate"] as const
                      ).map((id) => ({
                        id,
                        label: t("automations.delivery." + id),
                      }))}
                    />
                    <ToggleRow
                      {...selectProps}
                      label={t("automations.agentActivity")}
                      value={quiet ? "attention" : "normal"}
                      onChange={(value) => {
                        const isQuiet = value === "attention";
                        setQuiet(isQuiet);
                        setNotifyPolicy(isQuiet ? "silent" : "always");
                      }}
                      options={[
                        {
                          id: "normal",
                          label: t("automations.activityNormal"),
                        },
                        {
                          id: "attention",
                          label: t("automations.activityAttention"),
                        },
                      ]}
                    />
                    <FormRow
                      id="automation-work-item"
                      label={t("automations.workItem")}
                    >
                      <Switch
                        id="automation-work-item"
                        checked={workItem}
                        disabled={save.isPending}
                        onCheckedChange={setWorkItem}
                      />
                    </FormRow>
                  </FieldGroup>
                </div>
              </details>
            </fieldset>
          </div>
          {save.error && (
            <div className="automation-editor-error">
              <ErrorNotice error={save.error} />
            </div>
          )}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={save.isPending}
              onClick={onClose}
            >
              {t("common.cancel")}
            </Button>
            <Button type="submit" disabled={!canSave || save.isPending}>
              {t(plan ? "common.save" : "automations.createAction")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
