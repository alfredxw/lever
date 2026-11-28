import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Download } from "lucide-react";
import { toast } from "sonner";
import type { TaskNote, TaskNoteSummary } from "@/api/types.gen";
import { Button } from "@/components/ui/button";
import { ErrorNotice } from "@/components/common";
import { NoteImport } from "./NoteImport";
import { NoteBacklinks } from "./NoteBacklinks";
import { downloadNote } from "./noteFiles";
import {
  changeTaskNoteDocument,
  finishTaskNoteComposition,
  markTaskNoteComposing,
  noteDraftDocument,
  recoverTaskNote,
  saveTaskNote,
  TaskNoteConflict,
  useTaskDrafts,
} from "./useTaskNote";

// Textareas expose LF even for CRLF files. Keep the original line endings
// outside the edited range, including mixed endings, BOM and final newline.
function updateSource(source: string, next: string) {
  const before = source.replace(/\r\n?/g, "\n");
  let from = 0,
    oldEnd = before.length,
    newEnd = next.length;
  while (from < oldEnd && from < newEnd && before[from] === next[from]) from++;
  while (
    oldEnd > from &&
    newEnd > from &&
    before[oldEnd - 1] === next[newEnd - 1]
  ) {
    oldEnd--;
    newEnd--;
  }
  const rawOffset = (offset: number) => {
    let index = 0;
    for (let n = 0; n < offset; n++, index++)
      if (source[index] === "\r" && source[index + 1] === "\n") index++;
    return index;
  };
  const eol = source.match(/\r\n|\n|\r/)?.[0] ?? "\n";
  return (
    source.slice(0, rawOffset(from)) +
    next.slice(from, newEnd).replaceAll("\n", eol) +
    source.slice(rawOffset(oldEnd))
  );
}

export function MarkdownSourceNote({
  note,
  library,
  saveError,
  onOpenNote,
  toolbarAction,
}: {
  note: TaskNote;
  library: TaskNoteSummary[];
  saveError?: unknown;
  onOpenNote: (id: string) => void;
  toolbarAction?: ReactNode;
}) {
  const { t } = useTranslation();
  const draft = useTaskDrafts().get(note.id);
  const doc = useMemo(
    () => noteDraftDocument(draft ?? { note, base: note }),
    [note, draft],
  );
  const source = doc.textContent;
  const composing = useRef(false);
  const [candidate, setCandidate] = useState<string>();
  useEffect(
    () => () => {
      finishTaskNoteComposition(note);
      void saveTaskNote(note.id).catch(() => {});
    },
    [note.id],
  );
  function changed(value: string, commit = false) {
    const raw = updateSource(source, value);
    const block = doc.firstChild!.type.create(
      null,
      raw ? doc.type.schema.text(raw) : undefined,
    );
    const next = doc.type.create(null, block);
    if (commit) finishTaskNoteComposition(note, next);
    else changeTaskNoteDocument(note, doc, next);
  }
  return (
    <div className="task-note-workspace">
      <header className="task-document-toolbar">
        <span className="task-document-crumb" title={note.path}>
          {note.path}
        </span>
        <NoteImport onOpen={onOpenNote} />
        <Button
          variant="ghost"
          size="icon-sm"
          title={t("tasks.exportMarkdown")}
          aria-label={t("tasks.exportMarkdown")}
          onClick={() =>
            downloadNote(
              new Blob([source], { type: "text/markdown" }),
              note.title,
            )
          }
        >
          <Download />
        </Button>
        {toolbarAction}
      </header>
      {!!saveError && (
        <ErrorNotice
          error={saveError}
          retry={() =>
            void saveTaskNote(note.id).catch((e) => toast.error(String(e)))
          }
        />
      )}
      {saveError instanceof TaskNoteConflict && (
        <Button
          variant="outline"
          onClick={() =>
            void recoverTaskNote(
              note.id,
              t("tasks.recoveredNote", { title: note.title.slice(0, 75) }),
            )
              .then((copy) => copy && onOpenNote(copy.id))
              .catch((e) => toast.error(String(e)))
          }
        >
          {t("tasks.recoverNote")}
        </Button>
      )}
      <textarea
        className="note-markdown-source"
        aria-label={t("tasks.markdownSource")}
        value={candidate ?? source}
        spellCheck={false}
        onCompositionStart={(e) => {
          composing.current = true;
          markTaskNoteComposing(note.id, doc);
          setCandidate(e.currentTarget.value);
        }}
        onCompositionEnd={(e) => {
          composing.current = false;
          setCandidate(undefined);
          changed(e.currentTarget.value, true);
        }}
        onChange={(e) =>
          composing.current
            ? setCandidate(e.currentTarget.value)
            : changed(e.currentTarget.value)
        }
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
            e.preventDefault();
            void saveTaskNote(note.id).catch((err) => toast.error(String(err)));
          }
        }}
      />
      <NoteBacklinks id={note.id} library={library} onOpen={onOpenNote} />
    </div>
  );
}
