import { displayChatTitle } from "@/features/chat/conversationTitle";
import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { api } from "@/api/client";
import type {
  Agent,
  Automation,
  AutomationDestination,
  AutomationEventSource,
  AutomationInput,
  AutomationTrigger,
  Chat,
  EventSourceContribution,
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
import { WorkingDirectoryPicker } from "@/features/worktrees/WorkingDirectoryPicker";
import { availableGroup, useWorkingCopies } from "@/features/worktrees/queries";
import { primaryDirectory } from "@/features/worktrees/scope";
import { Choice, FormRow, ToggleRow } from "./AutomationFormControls";
import { AutomationScheduleFields } from "./AutomationScheduleFields";
import { TaskAgentSelect } from "@/features/tasks/TaskAgentSelect";
import { scheduleDraft, scheduleInput } from "./automationSchedule";
import { automationPath } from "./automationsQuery";

export type EventSourceOption = {
  pluginId: string;
  contribution: EventSourceContribution;
  label: string;
  enabled: boolean;
};

export function eventSourceKey(source?: AutomationEventSource) {
  return source ? source.pluginId + "/" + source.contributionId : "webhook";
}

export function AutomationEditor({
  plan,
  agents,
  chats,
  eventSources,
  onClose,
  onSaved,
}: {
  plan?: Automation;
  agents: Agent[];
  chats: Chat[];
  eventSources: EventSourceOption[];
  onClose: () => void;
  onSaved: (plan: Automation) => void;
}) {
  const { t } = useTranslation();
  const initialSource = plan?.trigger.source;
  const [name, setName] = useState(plan?.name ?? "");
  const [prompt, setPrompt] = useState(plan?.prompt ?? "");
  const [trigger, setTrigger] = useState<AutomationTrigger["kind"]>(
    plan?.trigger.kind ?? "schedule",
  );
  const [sourceKey, setSourceKey] = useState(eventSourceKey(initialSource));
  const [sourceFields, setSourceFields] = useState(initialSource?.config ?? {});
  const [batchSize, setBatchSize] = useState(
    String(plan?.trigger.batchSize ?? 1),
  );
  const [schedule, setSchedule] = useState(() =>
    scheduleDraft(plan?.trigger.schedule),
  );
  const scheduleValue = scheduleInput(schedule);
  const [mode, setMode] = useState<AutomationDestination["mode"]>(
    plan?.destination.mode ?? "topic",
  );
  const [agentId, setAgent] = useState(
    plan?.destination.agentId ?? (agents.length === 1 ? agents[0].id : ""),
  );
  const [chatId, setChat] = useState(plan?.destination.chatId ?? "");
  const [chatSource, setChatSource] = useState<
    "existing" | "dedicated" | undefined
  >(plan ? (plan.destination.chatId ? "existing" : "dedicated") : undefined);
  const [copyId, setCopy] = useState(plan?.destination.workingCopyId);
  const [workItem, setWorkItem] = useState(
    plan ? (plan.workItem ?? true) : false,
  );
  const [quiet, setQuiet] = useState(plan?.quiet ?? false);
  const agent = agents.find((item) => item.id === agentId);
  const ownedChats = chats.filter((item) => item.agentId === agentId);
  const shared = mode !== "newChat";
  const target = chatSource ?? (ownedChats.length ? "existing" : "dedicated");
  const existing = shared && target === "existing";
  const chat = ownedChats.find((item) => item.id === chatId);
  const groupApplicable = !!agent && (mode !== "chat" || !existing);
  const copies = useWorkingCopies(agentId, groupApplicable);
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
              <div className="automation-editor-prompt">
                <FieldLabel className="sr-only" htmlFor="automation-name">
                  {t("automations.name")}
                </FieldLabel>
                <Input
                  id="automation-name"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder={t("automations.name")}
                  maxLength={80}
                  required
                />
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
                          { id: "webhook", label: t("automations.webhook") },
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
                            "plugins.eventField." + sourceKey + "." + field.id,
                            {
                              defaultValue: field.label,
                            },
                          )}
                        >
                          <Input
                            id={id}
                            type={field.kind === "secret" ? "password" : "text"}
                            autoComplete={
                              field.kind === "secret" ? "new-password" : "off"
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
                        onChange={(event) => setBatchSize(event.target.value)}
                        required
                      />
                    </FormRow>
                  </>
                )}
              </FieldGroup>
              {!!plan?.pendingEvents &&
                (trigger !== plan.trigger.kind ||
                  (trigger === "event" && !sourceUnchanged)) && (
                  <p className="automation-form-hint">
                    {t("automations.switchTrigger", {
                      count: plan.pendingEvents,
                    })}
                  </p>
                )}
              <FieldGroup className="automation-form-group">
                <FormRow
                  id="automation-agent"
                  label={t("automations.owner")}
                  description={
                    agents.length ? undefined : t("automations.agentRequired")
                  }
                >
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
                    }}
                  />
                </FormRow>
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
                  <FormRow id="automation-chat" label="Chat">
                    <SearchableSelect
                      id="automation-chat"
                      label="Chat"
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
                  label={t("automations.agentActivity")}
                  value={quiet ? "attention" : "normal"}
                  onChange={(value) => setQuiet(value === "attention")}
                  options={[
                    { id: "normal", label: t("automations.activityNormal") },
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
