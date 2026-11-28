import type { ComponentProps, ReactNode } from "react";
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { APIError } from "@/api/client";
import type { TaskNoteSummary } from "@/api/types.gen";
import { ErrorNotice, Loading } from "@/components/common";
import { taskNoteQuery } from "./noteQueries";
import { MarkdownSourceNote } from "./MarkdownSourceNote";
import { NoteImport } from "./NoteImport";
import { TaskNoteView } from "./TaskNoteView";
import { useTaskDraftSummaries } from "./useTaskNote";

export function TaskNotePane({
  id,
  notes,
  empty,
  ...props
}: Omit<
  ComponentProps<typeof TaskNoteView>,
  "note" | "saveError" | "library"
> & {
  id: string;
  notes: UseQueryResult<TaskNoteSummary[]>;
  empty: ReactNode;
}) {
  const { t } = useTranslation();
  const note = useQuery({
    ...taskNoteQuery(id),
    enabled: props.visible && !!id,
  });
  const draft = useTaskDraftSummaries().get(id);
  const current = draft?.note ?? note.data;
  const conflict = notes.data?.find((item) => item.id === id)?.conflict;
  const localize = (error: Error) =>
    error instanceof APIError && error.code === "task_notes_unavailable"
      ? t("tasks.notesDirectoryUnavailable")
      : error;
  return (
    <>
      {notes.error && (notes.data || !draft) && (
        <ErrorNotice
          error={localize(notes.error)}
          retry={() => void notes.refetch()}
        />
      )}
      {notes.isPending ? (
        <Loading />
      ) : notes.error && !notes.data && !draft ? null : conflict && !draft ? (
        <ErrorNotice error={conflict} retry={() => void notes.refetch()} />
      ) : current && /\.(md|markdown)$/i.test(current.path) ? (
        <MarkdownSourceNote
          key={id}
          note={current}
          library={notes.data ?? []}
          saveError={draft?.error ?? conflict}
          onOpenNote={props.onOpenNote}
          toolbarAction={props.toolbarAction}
        />
      ) : current ? (
        <TaskNoteView
          key={id}
          {...props}
          note={current}
          library={notes.data ?? []}
          saveError={draft?.error ?? conflict}
        />
      ) : note.error ? (
        <ErrorNotice
          error={localize(note.error)}
          retry={() => void note.refetch()}
        />
      ) : id ? (
        <Loading />
      ) : (
        <div className="task-notes-empty">
          {empty}
          <NoteImport onOpen={props.onOpenNote} />
        </div>
      )}
    </>
  );
}
