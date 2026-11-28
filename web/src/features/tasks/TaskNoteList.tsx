import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { useMutation } from "@tanstack/react-query";
import {
  AlertCircle,
  Archive,
  ChevronRight,
  FileText,
  RotateCcw,
  Trash2,
} from "lucide-react";
import { ContextMenu, Slot } from "radix-ui";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import type { TaskNoteState, TaskNoteSummary } from "@/api/types.gen";
import { ErrorNotice } from "@/components/common";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { TaskSidebarItems, type TaskDragTrigger } from "./TaskSidebar";
import {
  renameTaskNote,
  setTaskNoteState,
  useTaskDraftSummaries,
} from "./useTaskNote";

const noteGroups = [
  { state: "archived", label: "common.archived", icon: Archive },
  { state: "deleted", label: "tasks.recentlyDeleted", icon: Trash2 },
] as const;

function openNoteMenu(event: KeyboardEvent<HTMLButtonElement>) {
  if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10"))
    return;
  event.preventDefault();
  const trigger = event.currentTarget;
  const { left, bottom } = trigger.getBoundingClientRect();
  trigger.dispatchEvent(
    new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      clientX: left,
      clientY: bottom,
    }),
  );
}

export function TaskNoteList({
  notes,
  currentId,
  onOpen,
}: {
  notes: TaskNoteSummary[];
  currentId?: string;
  onOpen: (id: string) => void;
}) {
  const { t } = useTranslation();
  const drafts = useTaskDraftSummaries();
  const list = useRef<HTMLUListElement>(null);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [deleting, setDeleting] = useState<{
    note: TaskNoteSummary;
    title: string;
    trigger: HTMLButtonElement | null;
  }>();
  const archiveSelection = notes.find(
    (note) => note.id === currentId && note.state === "archived",
  )?.id;
  useEffect(() => {
    if (archiveSelection) setArchiveOpen(true);
  }, [archiveSelection]);

  const move = useMutation({
    mutationFn: ({
      note,
      state,
    }: {
      note: TaskNoteSummary;
      state: TaskNoteState;
    }) => setTaskNoteState(note, state),
    onSuccess: (_, { state }) => {
      if (state === "deleted") setDeleting(undefined);
    },
    onError: (error, { state }) => {
      if (state !== "deleted") toast.error(error.message);
    },
  });

  const row = (note: TaskNoteSummary, drag?: TaskDragTrigger) => {
    const draft = drafts.get(note.id);
    const title = draft?.note.title ?? note.title;
    return (
      <TaskNoteRow
        note={note}
        drag={drag}
        title={title}
        current={currentId === note.id}
        pending={move.isPending}
        unsaved={!!draft?.error}
        onOpen={() => onOpen(note.id)}
        onMove={(state) => move.mutate({ note, state })}
        onDelete={(trigger) => {
          move.reset();
          setDeleting({
            note,
            title: title.trim() || t("tasks.note"),
            trigger,
          });
        }}
      />
    );
  };

  return (
    <>
      <ul className="task-nav-children" ref={list}>
        <TaskSidebarItems
          scope="notes"
          items={notes.filter(
            (note) => note.state !== "archived" && note.state !== "deleted",
          )}
        >
          {row}
        </TaskSidebarItems>
        {noteGroups.map(({ state, label, icon: Icon }) => {
          const items = notes.filter((note) => note.state === state);
          if (!items.length) return null;
          return (
            <li key={state}>
              <Collapsible
                open={state === "archived" ? archiveOpen : undefined}
                onOpenChange={state === "archived" ? setArchiveOpen : undefined}
              >
                <CollapsibleTrigger asChild>
                  <Button
                    variant="ghost"
                    className="sidebar-nav-item task-nav-child task-nav-parent"
                  >
                    <Icon data-icon="inline-start" />
                    {t(label)}
                    <ChevronRight className="task-nav-chevron" />
                  </Button>
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <ul className="task-nav-children">
                    {items.map((note) => (
                      <li key={note.id}>{row(note)}</li>
                    ))}
                  </ul>
                </CollapsibleContent>
              </Collapsible>
            </li>
          );
        })}
      </ul>
      {deleting && (
        <Dialog
          open
          onOpenChange={(open) =>
            !open && !move.isPending && setDeleting(undefined)
          }
        >
          <DialogContent
            showCloseButton={false}
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              const target = deleting.trigger?.isConnected
                ? deleting.trigger
                : list.current?.querySelector<HTMLButtonElement>(
                    '[aria-current="page"], .task-nav-parent',
                  );
              target?.focus({ preventScroll: true });
            }}
          >
            <DialogHeader>
              <DialogTitle>{t("tasks.deleteNote")}</DialogTitle>
              <DialogDescription>
                {t("tasks.deleteNoteConfirm", { name: deleting.title })}
              </DialogDescription>
            </DialogHeader>
            {!!move.error && <ErrorNotice error={move.error} />}
            <DialogFooter>
              <Button
                variant="ghost"
                disabled={move.isPending}
                onClick={() => setDeleting(undefined)}
              >
                {t("common.cancel")}
              </Button>
              <Button
                variant="destructive"
                disabled={move.isPending}
                onClick={() =>
                  move.mutate({ note: deleting.note, state: "deleted" })
                }
              >
                {t("tasks.deleteNote")}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}

function TaskNoteRow({
  note,
  drag,
  title,
  current,
  pending,
  unsaved,
  onOpen,
  onMove,
  onDelete,
}: {
  note: TaskNoteSummary;
  drag?: TaskDragTrigger;
  title: string;
  current: boolean;
  pending: boolean;
  unsaved: boolean;
  onOpen: () => void;
  onMove: (state: TaskNoteState) => void;
  onDelete: (trigger: HTMLButtonElement | null) => void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState<string>();
  const [saving, setSaving] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const actionOwnsFocus = useRef(false);
  const deleted = note.state === "deleted";
  const canArchive = !deleted && note.state !== "archived";
  const displayTitle = title.trim() || t("tasks.note");
  const label = <span className="truncate">{displayTitle}</span>;

  function closeRename(restoreFocus: boolean) {
    setName(undefined);
    if (restoreFocus)
      requestAnimationFrame(() =>
        trigger.current?.focus({ preventScroll: true }),
      );
  }

  if (note.markdown && !note.conflict)
    return (
      <Button
        {...drag}
        variant="ghost"
        className="sidebar-nav-item task-nav-child"
        aria-current={current ? "page" : undefined}
        onClick={onOpen}
      >
        <FileText aria-hidden="true" />
        {label}
        {unsaved && (
          <span className="task-unsaved-dot" title={t("tasks.unsaved")} />
        )}
      </Button>
    );

  if (note.conflict) {
    return (
      <Button
        {...drag}
        variant="ghost"
        className="sidebar-nav-item task-nav-child"
        aria-current={current ? "page" : undefined}
        title={t("tasks.noteFileConflict")}
        onClick={onOpen}
      >
        {label}
        <AlertCircle data-icon="inline-end" />
        <span className="sr-only">{t("tasks.noteFileConflict")}</span>
      </Button>
    );
  }

  return (
    <ContextMenu.Root modal={false}>
      {name !== undefined ? (
        <Input
          className="task-note-rename"
          autoFocus
          aria-label={t("tasks.renameNote")}
          placeholder={t("tasks.noteTitle")}
          value={name}
          maxLength={100}
          readOnly={saving}
          onFocus={(event) => event.currentTarget.select()}
          onChange={(event) => setName(event.target.value)}
          onBlur={() => !saving && closeRename(false)}
          onKeyDown={async (event) => {
            if (event.nativeEvent.isComposing || event.keyCode === 229) return;
            if (event.key !== "Enter" && event.key !== "Escape") return;
            event.preventDefault();
            event.stopPropagation();
            if (saving) return;
            if (event.key === "Escape") {
              closeRename(true);
              return;
            }
            const value = name.trim();
            if (!value) return;
            const input = event.currentTarget;
            setSaving(true);
            try {
              await renameTaskNote(note, value);
              closeRename(document.activeElement === input);
            } catch (error) {
              toast.error(
                error instanceof Error ? error.message : String(error),
              );
            } finally {
              setSaving(false);
            }
          }}
        />
      ) : deleted ? (
        <ContextMenu.Trigger asChild disabled={pending}>
          <div className="task-note-deleted-row" title={displayTitle}>
            {label}
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={t("tasks.restoreNote")}
              aria-keyshortcuts="Shift+F10"
              title={t("tasks.restoreNote")}
              disabled={pending}
              onClick={() => onMove("active")}
              onKeyDown={openNoteMenu}
            >
              <RotateCcw />
            </Button>
          </div>
        </ContextMenu.Trigger>
      ) : (
        <ContextMenu.Trigger asChild disabled={pending}>
          <Slot.Root {...drag}>
            <Button
              ref={trigger}
              variant="ghost"
              className="sidebar-nav-item task-nav-child"
              aria-current={current ? "page" : undefined}
              aria-haspopup="menu"
              aria-keyshortcuts={
                drag?.["aria-keyshortcuts"]
                  ? "Shift+F10 Shift+Space"
                  : "Shift+F10"
              }
              onClick={onOpen}
              onKeyDown={pending ? undefined : openNoteMenu}
              title={displayTitle}
            >
              <FileText className="task-nav-child-icon" aria-hidden="true" />
              {label}
              {unsaved && (
                <span className="task-unsaved-dot" title={t("tasks.unsaved")} />
              )}
            </Button>
          </Slot.Root>
        </ContextMenu.Trigger>
      )}
      <ContextMenu.Portal>
        <ContextMenu.Content
          aria-label={displayTitle}
          className="task-note-menu floating-surface"
          collisionPadding={8}
          onCloseAutoFocus={(event) => {
            if (actionOwnsFocus.current) {
              actionOwnsFocus.current = false;
              event.preventDefault();
            }
          }}
        >
          {!deleted && (
            <ContextMenu.Item
              onSelect={() => {
                actionOwnsFocus.current = true;
                setName(title);
              }}
            >
              {t("tasks.renameNote")}
            </ContextMenu.Item>
          )}
          <ContextMenu.Item
            onSelect={() => onMove(canArchive ? "archived" : "active")}
          >
            {t(canArchive ? "tasks.archiveNote" : "tasks.restoreNote")}
          </ContextMenu.Item>
          {!deleted && (
            <>
              <ContextMenu.Separator />
              <ContextMenu.Item
                className="text-destructive"
                onSelect={() => {
                  actionOwnsFocus.current = true;
                  onDelete(trigger.current);
                }}
              >
                {t("tasks.deleteNote")}…
              </ContextMenu.Item>
            </>
          )}
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}
