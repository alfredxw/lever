import type { Node as ProseMirrorNode, Schema } from "@tiptap/pm/model";
import { Transform } from "@tiptap/pm/transform";
import { useEffect, useSyncExternalStore } from "react";
import { api, APIError, queryClient } from "@/api/client";
import type { TaskNote, TaskNoteState, TaskNoteSummary } from "@/api/types.gen";
import i18n from "@/i18n";
import { taskNotePath, taskNoteQuery, taskNotesQuery } from "./noteQueries";
import { mergeTaskDocuments, taskBlocks, taskNoteSchema } from "./taskDocument";

const maxVersionRetries = 2;
const saveDelay = 500;
const saveMaxDelay = 2_000;

// Keep the immutable document in memory and serialize it only when it is saved.
type NoteDraft = {
  base: TaskNote;
  note: TaskNote;
  doc?: ProseMirrorNode;
  error?: unknown;
};
type SaveSession = {
  draft: NoteDraft;
  timer?: ReturnType<typeof setTimeout>;
  pending?: Promise<TaskNote>;
  dirtySince?: number;
  changedAt: number;
  recovery?: { draft: NoteDraft; input: Parameters<typeof createTaskNote>[0] };
};

export class TaskNoteConflict extends Error {
  constructor() {
    super("The task note contains overlapping edits");
  }
}

// Drafts outlive the editor so changing notes and opening Chat cannot lose edits.
const sessions = new Map<string, SaveSession>();
// Keep the document before IME input so only the committed edit is replayed.
const compositions = new Map<string, ProseMirrorNode>();
const listeners = new Set<() => void>();
let snapshot = new Map<string, NoteDraft>();
let summaries = new Map<string, Pick<NoteDraft, "note" | "error">>();

function publish(id: string) {
  const next = new Map(snapshot);
  const draft = sessions.get(id)?.draft;
  if (draft) next.set(id, draft);
  else next.delete(id);
  snapshot = next;
  // Editing the body should not redraw the workspace and its note sidebar.
  const previous = summaries.get(id);
  if (previous?.note !== draft?.note || previous?.error !== draft?.error) {
    summaries = new Map(summaries);
    if (draft) summaries.set(id, { note: draft.note, error: draft.error });
    else summaries.delete(id);
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useTaskDrafts() {
  return useSyncExternalStore(subscribe, () => snapshot);
}

export function useTaskDraftSummaries() {
  return useSyncExternalStore(subscribe, () => summaries);
}

async function cacheTaskNote(note: TaskNote) {
  const { queryKey } = taskNoteQuery(note.id);
  await queryClient.cancelQueries({ queryKey });
  return queryClient.setQueryData<TaskNote>(queryKey, note)!;
}

export async function createTaskNote(
  input: Pick<TaskNote, "id" | "title"> &
    Pick<Partial<TaskNote>, "project" | "content" | "directory">,
) {
  const created = await api<TaskNote>("/tasks/notes", input);
  await cacheTaskNote(created);
  queryClient.setQueryData<TaskNoteSummary[]>(
    taskNotesQuery.queryKey,
    (notes = []) =>
      notes.some((note) => note.id === created.id)
        ? notes
        : [
            ...notes,
            {
              id: created.id,
              title: created.title,
              state: created.state,
              directory: created.directory,
            },
          ],
  );
  return created;
}

async function flushNoteEdits(id: string) {
  if (compositions.has(id)) throw new Error(i18n.t("tasks.finishNoteInput"));
  if (sessions.has(id)) await saveTaskNote(id);
}

export async function flushTaskNoteEdits() {
  if (compositions.size) throw new Error(i18n.t("tasks.finishNoteInput"));
  await Promise.all([...sessions.keys()].map(saveTaskNote));
}

async function cacheChangedNote(note: TaskNote) {
  if (note.state !== "deleted") await cacheTaskNote(note);
  await queryClient.cancelQueries({ queryKey: taskNotesQuery.queryKey });
  const { id, title, state, directory } = note;
  queryClient.setQueryData<TaskNoteSummary[]>(
    taskNotesQuery.queryKey,
    (notes) =>
      notes?.map((item) =>
        item.id === id ? { id, title, state, directory } : item,
      ),
  );
  void queryClient.invalidateQueries({ queryKey: taskNotesQuery.queryKey });
}

export async function renameTaskNote(summary: TaskNoteSummary, title: string) {
  await flushNoteEdits(summary.id);
  const path = taskNotePath(summary.id);
  const note = await api<TaskNote>(path);
  if (title === note.title) return;
  await cacheChangedNote(
    await api<TaskNote>(
      path,
      { ...note, title, directory: summary.directory ?? note.directory },
      "PUT",
    ),
  );
}

export async function setTaskNoteState(
  note: TaskNoteSummary,
  state: TaskNoteState,
) {
  if (note.state !== "deleted") await flushNoteEdits(note.id);
  const saved = await api<TaskNote>(
    taskNotePath(note.id),
    { state, directory: note.directory },
    "PATCH",
  );
  await cacheChangedNote(saved);
  void queryClient.invalidateQueries({ queryKey: ["task-executions"] });
}

// Acknowledgements carry the exact immutable document sent to the server.
const savedDocuments = new WeakMap<object, ProseMirrorNode>();

export function noteDraftDocument(
  draft: NoteDraft,
  schema: Schema = taskNoteSchema,
) {
  const content = draft.note.content;
  const cached =
    typeof content === "object" && content !== null
      ? savedDocuments.get(content)
      : undefined;
  const doc = draft.doc ?? cached;
  if (doc?.type.schema === schema) return doc;
  const parsed = schema.nodeFromJSON(doc?.toJSON() ?? content);
  if (!draft.doc && typeof content === "object" && content !== null)
    savedDocuments.set(content, parsed);
  return parsed;
}

function mergeField(before: string, local: string, remote: string) {
  if (local === before) return remote;
  if (remote === before || remote === local) return local;
  throw new TaskNoteConflict();
}

// A file version belongs to the exact snapshot the draft was edited against.
function rebaseTaskDraft(draft: NoteDraft, latest: TaskNote): NoteDraft {
  const { base } = draft;
  const title = mergeField(base.title, draft.note.title, latest.title);
  const project = mergeField(
    base.project ?? "",
    draft.note.project ?? "",
    latest.project ?? "",
  );
  let doc = draft.doc;
  if (doc && base.content !== latest.content) {
    const schema = doc.type.schema;
    const merged = mergeTaskDocuments(
      schema.nodeFromJSON(base.content),
      doc,
      schema.nodeFromJSON(latest.content),
    );
    if (!merged) throw new TaskNoteConflict();
    doc = merged;
  }
  return { base: latest, note: { ...latest, title, project }, doc };
}

export function taskNoteSnapshot(fallback: TaskNote): NoteDraft {
  const saved =
    queryClient.getQueryData<TaskNote>(taskNoteQuery(fallback.id).queryKey) ??
    fallback;
  return sessions.get(fallback.id)?.draft ?? { base: saved, note: saved };
}

export function saveTaskNote(id: string): Promise<TaskNote> {
  return persistTaskNote(id, true);
}

function scheduleTaskNote(id: string, session: SaveSession) {
  clearTimeout(session.timer);
  if (
    session.pending ||
    session.draft.error ||
    session.dirtySince === undefined
  )
    return;
  const now = Date.now();
  // Quiet.md: save after 500ms idle, at most 2s after the oldest unsaved edit.
  const delay = Math.max(
    0,
    Math.min(
      session.changedAt + saveDelay - now,
      session.dirtySince + saveMaxDelay - now,
    ),
  );
  session.timer = setTimeout(
    () => void persistTaskNote(id, false).catch(() => {}),
    delay,
  );
}

function persistTaskNote(id: string, flush: boolean): Promise<TaskNote> {
  const session = sessions.get(id);
  if (!session) return queryClient.ensureQueryData(taskNoteQuery(id));
  if (session.draft.error instanceof TaskNoteConflict)
    return Promise.reject(session.draft.error);
  clearTimeout(session.timer);
  if (session.pending)
    return flush
      ? session.pending.then(() => saveTaskNote(id))
      : session.pending;
  session.pending = (async () => {
    try {
      if (session.draft.error) {
        session.draft = { ...session.draft, error: undefined };
        publish(id);
      }
      let retries = 0;
      while (true) {
        const current = session.draft;
        session.dirtySince = undefined;
        const input: TaskNote = {
          ...current.note,
          content: current.doc?.toJSON() ?? current.note.content,
          version: current.base.version,
        };
        let saved: TaskNote;
        try {
          saved = await api<TaskNote>(taskNotePath(id), input, "PUT");
        } catch (error) {
          if (
            !(error instanceof APIError) ||
            error.code !== "task_note_version" ||
            retries >= maxVersionRetries
          )
            throw error;
          retries++;
          const latest = await cacheTaskNote(
            await api<TaskNote>(taskNotePath(id)),
          );
          if (session.draft.error instanceof TaskNoteConflict)
            throw session.draft.error;
          session.draft = rebaseTaskDraft(session.draft, latest);
          publish(id);
          continue;
        }
        retries = 0;
        const cached = await cacheTaskNote(saved);
        if (current.doc && typeof cached.content === "object" && cached.content)
          savedDocuments.set(cached.content, current.doc);
        if (current === session.draft) {
          sessions.delete(id);
          publish(id);
          return saved;
        }
        // Advance the baseline while keeping the edits made during the request.
        session.draft = {
          ...session.draft,
          base: saved,
          note: {
            ...saved,
            title:
              session.draft.note.title === current.note.title
                ? saved.title
                : session.draft.note.title,
            project:
              session.draft.note.project === current.note.project
                ? saved.project
                : session.draft.note.project,
          },
        };
        publish(id);
        if (session.draft.error instanceof TaskNoteConflict)
          throw session.draft.error;
        // An acknowledgement must not turn continuous typing into a write loop.
        // Autosave schedules newer edits normally; explicit flushes drain them.
        if (!flush) return saved;
      }
    } catch (error) {
      session.draft = { ...session.draft, error };
      session.dirtySince ??= Date.now();
      publish(id);
      throw error;
    } finally {
      session.pending = undefined;
      if (sessions.get(id) === session) scheduleTaskNote(id, session);
    }
  })();
  return session.pending;
}

export function changeTaskNote(
  base: TaskNote,
  fields: Partial<Pick<TaskNote, "title" | "project">>,
) {
  const draft = sessions.get(base.id)?.draft ?? { base, note: base };
  queueTaskDraft({ ...draft, note: { ...draft.note, ...fields } });
}

function queueTaskDraft(draft: NoteDraft) {
  const { id } = draft.note;
  let session = sessions.get(id);
  const now = Date.now();
  if (!session) {
    session = { draft, changedAt: now };
    sessions.set(id, session);
  } else session.draft = draft;
  session.dirtySince ??= now;
  session.changedAt = now;
  scheduleTaskNote(id, session);
  publish(id);
}

export function changeTaskNoteDocument(
  note: TaskNote,
  before: ProseMirrorNode,
  after: ProseMirrorNode,
) {
  const draft = taskNoteSnapshot(note);
  const current = noteDraftDocument(draft, before.type.schema);
  const doc = current.eq(before)
    ? after
    : mergeTaskDocuments(before, after, current);
  if (doc?.eq(current)) return;
  queueTaskDraft(
    doc
      ? { ...draft, doc }
      : { ...draft, doc: after, error: new TaskNoteConflict() },
  );
}

export function markTaskNoteComposing(id: string, before: ProseMirrorNode) {
  if (!compositions.has(id)) compositions.set(id, before);
}

export function finishTaskNoteComposition(
  note: TaskNote,
  after?: ProseMirrorNode,
) {
  const before = compositions.get(note.id);
  compositions.delete(note.id);
  if (before && after && !before.eq(after))
    changeTaskNoteDocument(note, before, after);
}

export async function recoverTaskNote(id: string, title: string) {
  const session = sessions.get(id);
  if (!session || !(session.draft.error instanceof TaskNoteConflict)) return;
  const current = session.draft;
  if (session.recovery?.draft !== current) {
    const doc = noteDraftDocument(current);
    const tr = new Transform(doc);
    for (const task of taskBlocks(doc)) {
      if (!task.id) continue;
      tr.setNodeMarkup(task.pos, undefined, {
        ...task.paragraph.attrs,
        taskId: crypto.randomUUID(),
      });
    }
    session.recovery = {
      draft: current,
      input: {
        id: crypto.randomUUID(),
        title,
        project: current.note.project,
        content: tr.doc.toJSON(),
      },
    };
  }
  const { input } = session.recovery;
  const latest = await api<TaskNote>(taskNotePath(id));
  await cacheTaskNote(latest);
  const copy = await createTaskNote(input);
  if (current === sessions.get(id)?.draft) {
    sessions.delete(id);
    publish(id);
  }
  return copy;
}

export function useUnsavedTaskWarning() {
  useEffect(() => {
    const flush = () => {
      for (const id of sessions.keys()) void saveTaskNote(id).catch(() => {});
    };
    const hide = () => {
      if (document.visibilityState === "hidden") flush();
    };
    const warn = (event: BeforeUnloadEvent) => {
      if (!sessions.size && !compositions.size) return;
      flush();
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("blur", flush);
    document.addEventListener("visibilitychange", hide);
    window.addEventListener("beforeunload", warn);
    return () => {
      window.removeEventListener("blur", flush);
      document.removeEventListener("visibilitychange", hide);
      window.removeEventListener("beforeunload", warn);
    };
  }, []);
}
