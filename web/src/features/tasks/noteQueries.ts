import { queryOptions } from "@tanstack/react-query";
import { api, queryClient } from "@/api/client";
import type {
  TaskNote,
  TaskNotesDirectory,
  TaskNoteSummary,
} from "@/api/types.gen";

export const selectedTaskNoteKey = "lever:task-note";
export const taskNotePath = (id: string) => "/tasks/notes/" + id;
export const taskNotesDirectoryPath = "/tasks/notes-directory";

export const taskNotesDirectoryQuery = queryOptions({
  queryKey: ["task-notes-directory"],
  queryFn: ({ signal }) =>
    api<TaskNotesDirectory>(taskNotesDirectoryPath, undefined, "GET", signal),
});

export const taskNotesQuery = queryOptions({
  queryKey: ["task-notes"],
  queryFn: ({ signal }) =>
    api<TaskNoteSummary[]>("/tasks/notes", undefined, "GET", signal),
  refetchOnWindowFocus: "always",
});

export const taskNoteQuery = (id: string) =>
  queryOptions({
    queryKey: ["task-note", id],
    queryFn: ({ signal }) =>
      api<TaskNote>(taskNotePath(id), undefined, "GET", signal),
    refetchOnWindowFocus: "always",
  });

export function resolveTaskNoteId(
  notes: readonly TaskNoteSummary[] | undefined,
  selected: string,
  hasDraft = false,
) {
  const note = notes?.find(({ id }) => id === selected);
  if (selected && note?.state !== "deleted" && (note || hasDraft))
    return selected;
  const active = notes?.filter(({ state }) => state === "active");
  return active?.find(({ conflict }) => !conflict)?.id ?? active?.[0]?.id ?? "";
}

export async function prefetchTaskNotes() {
  const notes = await queryClient.fetchQuery(taskNotesQuery);
  const id = resolveTaskNoteId(
    notes,
    localStorage.getItem(selectedTaskNoteKey) ?? "",
  );
  if (id) await queryClient.prefetchQuery(taskNoteQuery(id));
}
