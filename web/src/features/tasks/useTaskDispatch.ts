import { useRef } from "react";
import { useTranslation } from "react-i18next";
import { api, queryClient } from "@/api/client";
import type {
  Agent,
  ExternalTaskDispatch,
  NoteHandover,
  Overview,
  Selection,
  TaskLocation,
  TaskQueueInput,
  WorkingCopy,
} from "@/api/types.gen";
import {
  isModelUnavailable,
  modelSelection,
  selectedModel,
} from "@/features/chat/useComposerModel";
import { modelsQuery, providersQuery } from "@/features/runtime/queries";
import {
  readRuntimePreferences,
  recentAgentSelection,
} from "@/features/runtime/runtimePreferences";
import { copyKey } from "@/features/worktrees/queries";
import { primaryDirectory } from "@/features/worktrees/scope";
import type { NoteAsset } from "./noteAsset";
import {
  taskBlocks,
  taskImages,
  taskNoteSchema,
  taskPrompt,
} from "./taskDocument";
import { saveTaskNote } from "./useTaskNote";

export type TaskTarget = TaskLocation & { id: string };

export type TaskDispatchTarget = TaskTarget & {
  title: string;
  agentId?: string;
  images?: NoteAsset[];
};

export type TaskDispatchOptions = Omit<ExternalTaskDispatch, "commandId">;

function stripPermission({
  provider,
  model,
  effort,
  fast,
}: Selection): Selection {
  return { provider, model, effort, fast };
}

export async function resolveTaskSelection(
  agent: Agent | undefined,
  cwd: string,
  explicit?: Selection,
): Promise<Selection | undefined> {
  if (explicit) return stripPermission(explicit);
  if (!agent) return undefined;
  const recent = recentAgentSelection(
    agent.profile,
    readRuntimePreferences(agent.id),
  );
  if (!recent) return undefined;
  try {
    const providers = await queryClient.ensureQueryData(providersQuery);
    if (
      !providers.some(
        (runtime) => runtime.id === recent.provider && runtime.available,
      )
    ) {
      return undefined;
    }
    const catalog = await queryClient.ensureQueryData(
      modelsQuery(recent.provider, cwd),
    );
    if (isModelUnavailable(recent, catalog)) return undefined;
    const model = selectedModel(recent, catalog);
    const resolved =
      model && ((!recent.model && model.id) || !catalog?.provisional)
        ? modelSelection(recent, model)
        : recent;
    return stripPermission(resolved);
  } catch {
    return undefined;
  }
}

export function taskDispatchAgent(
  agents: Agent[],
  agentId?: string,
  settings?: NoteHandover,
) {
  const id = agentId ?? settings?.agentId;
  if (id) return agents.find((agent) => agent.id === id);
  return agents.length === 1 ? agents[0] : undefined;
}

export function noteHandoverQuery(id: string) {
  return {
    queryKey: ["note-handover", id] as const,
    queryFn: ({ signal }: { signal: AbortSignal }) =>
      api<NoteHandover>(
        `/tasks/notes/${id}/handover`,
        undefined,
        "GET",
        signal,
      ),
  };
}

export function useTaskDispatch() {
  const { t } = useTranslation();
  const submissions = useRef(
    new Map<string, { payload: string; commandId: string }>(),
  );

  return async function dispatch(
    {
      id,
      noteId,
      record,
      images = [],
    }: TaskTarget & Pick<TaskDispatchTarget, "images">,
    options: TaskDispatchOptions,
  ) {
    const agent = queryClient
      .getQueryData<Overview>(["overview"])
      ?.agents.find((item) => item.id === options.agentId);
    const copy = options.workingCopyId
      ? queryClient
          .getQueryData<WorkingCopy[]>(copyKey(options.agentId))
          ?.find((item) => item.id === options.workingCopyId)
      : undefined;
    const cwd = copy
      ? primaryDirectory(copy)
      : agent
        ? primaryDirectory(agent.profile)
        : "";
    const selection = await resolveTaskSelection(agent, cwd, options.selection);
    const { selection: _ignored, ...rest } = options;
    let input: Omit<TaskQueueInput, "commandId"> = {
      ...rest,
      ...(selection ? { selection } : {}),
      record,
      taskId: id,
      title: "",
      text: "",
    };
    if (record === "automation") throw new Error(t("tasks.sourceRemoved"));
    if (record === "note") {
      if (!noteId) throw new Error(t("tasks.sourceRemoved"));
      const saved = await saveTaskNote(noteId);
      const task = taskBlocks(taskNoteSchema.nodeFromJSON(saved.content)).find(
        (block) => block.id === id,
      );
      if (!task?.title || task.done) throw new Error(t("tasks.sourceRemoved"));
      const savedImages = taskImages(task);
      if (
        savedImages.length !== images.length ||
        savedImages.some(
          ({ path, name }, i) =>
            path !== images[i].path || name !== images[i].name,
        )
      )
        throw new Error(t("tasks.dispatchImagesChanged"));
      input = {
        ...input,
        noteId,
        version: saved.version,
        title: Array.from(task.title).slice(0, 80).join(""),
        text: taskPrompt(task),
      };
    }

    const payload = JSON.stringify(input);
    let submission = submissions.current.get(id);
    if (submission?.payload !== payload) {
      submission = { payload, commandId: crypto.randomUUID() };
      submissions.current.set(id, submission);
    }

    try {
      await api("/tasks/queue", {
        ...input,
        commandId: submission.commandId,
      });
      if (submissions.current.get(id) === submission)
        submissions.current.delete(id);
    } finally {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["task-workflows"] }),
        queryClient.invalidateQueries({ queryKey: ["task-executions"] }),
      ]);
    }
  };
}
