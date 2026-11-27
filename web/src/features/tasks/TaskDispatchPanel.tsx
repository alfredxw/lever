import { useId, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowUpRight } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { Agent, Selection } from "@/api/types.gen";
import { ErrorNotice } from "@/components/common";
import { MessageResponse } from "@/components/ai-elements/message-response";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Textarea } from "@/components/ui/textarea";
import { ModelPicker } from "@/features/chat/ModelPicker";
import { useComposerModel } from "@/features/chat/useComposerModel";
import {
  agentProfileSelection,
  selectionForAgentProvider,
  useRuntimePreferences,
} from "@/features/runtime/runtimePreferences";
import { WorkingDirectoryPicker } from "@/features/worktrees/WorkingDirectoryPicker";
import { availableGroup, useWorkingCopies } from "@/features/worktrees/queries";
import { primaryDirectory } from "@/features/worktrees/scope";
import { noteAssetURL } from "./noteAsset";
import { NoteHandoverSheet } from "./NoteHandoverSheet";
import { TaskAgentSelect } from "./TaskAgentSelect";
import { noteHandoverQuery, taskDispatchAgent } from "./useTaskDispatch";
import type {
  TaskDispatchOptions,
  TaskDispatchTarget,
} from "./useTaskDispatch";

export function TaskDispatchPanel({
  task,
  agents,
  onCancel,
  onDispatch,
  dialog,
  noteContext,
}: {
  task: Pick<TaskDispatchTarget, "title" | "agentId" | "images" | "noteId"> & {
    id?: string;
  };
  agents: Agent[];
  onCancel: () => void;
  onDispatch: (options: TaskDispatchOptions) => Promise<void>;
  dialog?: { onCloseAutoFocus: (event: Event) => void };
  noteContext?: { title: string; text: string };
}) {
  const { t } = useTranslation();
  const noteFieldId = useId();
  const [agentOverride, setAgent] = useState<string>();
  const handover = useQuery({
    ...noteHandoverQuery(task.noteId ?? ""),
    enabled: !!task.noteId && !task.agentId,
  });
  const agent = taskDispatchAgent(
    agents,
    agentOverride ?? task.agentId,
    handover.data,
  );
  const [copyId, setCopy] = useState<string>();
  const [modelOverride, setModelOverride] = useState<Selection>();
  const [modelOpen, setModelOpen] = useState(false);
  const [note, setNote] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<unknown>();
  const copies = useWorkingCopies(agent?.id ?? "", !!agent && !noteContext);
  const copy = copies.data?.find((item) => item.id === copyId);
  const modelCwd = copy
    ? primaryDirectory(copy)
    : agent
      ? primaryDirectory(agent.profile)
      : "";
  const directory = !noteContext && modelCwd;
  const preferences = useRuntimePreferences(agent?.id ?? "");
  const profileSelection: Selection = agent
    ? agentProfileSelection(agent.profile)
    : { provider: "", model: "", effort: "", fast: false };
  const providerDefaultFallback: Selection | undefined =
    !modelOverride && profileSelection.provider && profileSelection.model
      ? {
          provider: profileSelection.provider,
          model: "",
          effort: "",
          fast: false,
        }
      : undefined;
  const {
    providers,
    catalog,
    selection,
    runtimeUnavailable,
    modelUnavailable,
    checkingPreference,
  } = useComposerModel(
    modelOverride ?? profileSelection,
    modelCwd,
    providerDefaultFallback,
  );
  const preferFavorites =
    preferences?.favoriteSelections?.[selection.provider] === selection.model;
  const modelError =
    agent && !checkingPreference
      ? runtimeUnavailable
        ? t("composer.runtimeDisabled")
        : modelUnavailable
          ? t("composer.modelUnavailable")
          : ""
      : "";
  const canDispatch =
    !!agent &&
    !!task.title &&
    (!copyId || availableGroup(copy)) &&
    !modelError;
  const images = !!task.images?.length && (
    <ul
      className="task-dispatch-images"
      role="list"
      aria-label={t("tasks.dispatchImages")}
    >
      {task.images.map(({ path, name }, index) => (
        <li key={index} title={name}>
          <img src={noteAssetURL(path, name)} alt={name} loading="lazy" />
        </li>
      ))}
    </ul>
  );
  const form = (
    <form
      className={noteContext ? "task-handover-form" : "task-dispatch"}
      aria-label={t("tasks.assign")}
      onSubmit={async (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (!agent || !canDispatch || sending) return;
        setSending(true);
        setError(undefined);
        try {
          await onDispatch({
            agentId: agent.id,
            workingCopyId: copyId,
            selection: modelOverride
              ? {
                  provider: selection.provider,
                  model: selection.model,
                  effort: selection.effort,
                  fast: selection.fast,
                }
              : undefined,
            note: note.trim() || undefined,
          });
        } catch (failure) {
          setError(failure);
        } finally {
          setSending(false);
        }
      }}
    >
      <div className={noteContext ? "task-handover-body" : "contents"}>
        {noteContext && (
          <blockquote className="task-handover-source">
            <p className="text-xs text-muted-foreground">{noteContext.title}</p>
            <MessageResponse
              mode="static"
              text={noteContext.text}
              className="task-handover-excerpt"
            />
            {images}
          </blockquote>
        )}
        <FieldGroup className={noteContext ? "gap-4" : "contents"}>
          <div className={noteContext ? "contents" : "task-dispatch-fields"}>
            <div className="grid min-w-0 gap-1">
              <span>{t("tasks.assignee")}</span>
              <TaskAgentSelect
                agents={agents}
                label={t("tasks.selectAgent")}
                value={agent?.id}
                onChange={(id) => {
                  setAgent(id);
                  setCopy(undefined);
                  setModelOverride(undefined);
                }}
                disabled={sending}
                className="w-full"
                capsule={!!noteContext}
              />
            </div>
            {agent && (
              <div className="grid min-w-0 gap-1">
                <span>{t("profile.model")}</span>
                <ModelPicker
                  key={agent.id}
                  providers={providers}
                  catalog={catalog}
                  cwd={modelCwd}
                  open={modelOpen}
                  onOpenChange={setModelOpen}
                  value={selection}
                  preferFavorites={preferFavorites}
                  effortHabit={preferences?.effortHabit}
                  selectionForProvider={(provider, previous) =>
                    selectionForAgentProvider(
                      agent.profile,
                      provider,
                      preferences,
                      previous,
                    )
                  }
                  onChange={(next) =>
                    setModelOverride({
                      provider: next.provider,
                      model: next.model,
                      effort: next.effort,
                      fast: next.fast,
                    })
                  }
                  disabled={sending}
                />
              </div>
            )}
            {!noteContext &&
              agent &&
              (copyId || copies.data?.some(availableGroup)) && (
                <div className="grid min-w-0 gap-1">
                  <span>{t("worktrees.group")}</span>
                  <WorkingDirectoryPicker
                    key={agent.id}
                    copies={copies.data}
                    originalPath={primaryDirectory(agent.profile)}
                    selected={copyId}
                    onSelect={setCopy}
                    disabled={sending}
                  />
                </div>
              )}
          </div>
          {modelError && (
            <p className="text-xs text-destructive" role="alert">
              {modelError}
            </p>
          )}
          {directory && (
            <code className="task-directory-path" title={directory}>
              {directory}
            </code>
          )}
          {!agents.length && <p>{t("tasks.noAgents")}</p>}
          {!!task.agentId && !agent && agents.length > 0 && (
            <p>{t("tasks.ownerUnavailable")}</p>
          )}
          {!noteContext && images && (
            <div className="grid gap-1">
              <span>{t("tasks.dispatchImages")}</span>
              {images}
            </div>
          )}
          <Field className="gap-1.5">
            <FieldLabel htmlFor={noteFieldId}>
              {t(noteContext ? "tasks.handoverNote" : "tasks.dispatchNote")}
            </FieldLabel>
            <Textarea
              id={noteFieldId}
              className={noteContext ? "min-h-24 max-h-48" : "max-h-40"}
              value={note}
              onChange={(event) => setNote(event.target.value)}
              disabled={sending}
            />
          </Field>
        </FieldGroup>
        {!!error && <ErrorNotice error={error} />}
      </div>
      <div
        className={
          noteContext
            ? "task-handover-actions"
            : "flex flex-wrap justify-end gap-2"
        }
      >
        {!noteContext && (
          <Button
            size="sm"
            variant="ghost"
            type="button"
            onClick={onCancel}
            disabled={sending}
          >
            {t("common.cancel")}
          </Button>
        )}
        <Button
          size={noteContext ? "default" : "sm"}
          type="submit"
          disabled={!canDispatch || sending}
        >
          <ArrowUpRight data-icon="inline-start" />
          {t(
            sending
              ? "tasks.dispatching"
              : noteContext
                ? "tasks.handover"
                : "tasks.dispatch",
          )}
        </Button>
      </div>
    </form>
  );
  if (noteContext)
    return (
      <NoteHandoverSheet
        title={t("tasks.assign")}
        onClose={() => !sending && onCancel()}
        onCloseAutoFocus={dialog?.onCloseAutoFocus}
      >
        {form}
      </NoteHandoverSheet>
    );

  if (!dialog) return form;
  return (
    <Dialog open onOpenChange={(open) => !open && !sending && onCancel()}>
      <DialogContent
        className="task-dispatch-dialog max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-md"
        showCloseButton={false}
        onCloseAutoFocus={dialog.onCloseAutoFocus}
      >
        <DialogHeader className="min-w-0">
          <DialogTitle>{t("tasks.assign")}</DialogTitle>
          <DialogDescription className="wrap-anywhere">
            {task.title}
          </DialogDescription>
        </DialogHeader>
        {form}
      </DialogContent>
    </Dialog>
  );
}
