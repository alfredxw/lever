import { useRef } from "react";
import { useTranslation } from "react-i18next";
import { api, queryClient } from "@/api/client";
import type {
  Agent,
  ExternalTaskDispatch,
  NoteHandover,
  Selection,
  TaskLocation,
  TaskQueueInput,
} from "@/api/types.gen";
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
  _agent: Agent | undefined,
  _cwd: string,
  explicit?: Selection,
): Promise<Selection | undefined> {
  if (explicit) return stripPermission(explicit);
  return undefined;
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
    const selection = options.selection
      ? stripPermission(options.selection)
      : undefined;
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
