import { type ComponentProps, useId, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { PanelRightClose, PanelRightOpen, Plus } from "lucide-react";
import { motion } from "motion/react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { ToolbarButton } from "@/components/ui/toolbar-button";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ErrorNotice } from "@/components/common";
import { useCompactPanel } from "@/hooks/useCompactPanel";
import {
  taskNotesQuery,
  resolveTaskNoteId,
  selectedTaskNoteKey,
} from "./noteQueries";
import { TaskNotePane } from "./TaskNotePane";
import { TaskNoteList } from "./TaskNoteList";
import { TaskLabelDialog } from "./TaskLabelDialog";
import { useTaskActivity } from "./taskWorkflow";
import {
  createTaskNote,
  useTaskDraftSummaries,
  useUnsavedTaskWarning,
} from "./useTaskNote";
import "./tasks.css";

export default function WorkspaceNotes(
  props: Pick<
    ComponentProps<typeof TaskNotePane>,
    "visible" | "agents" | "chats" | "onOpenChat" | "onOpenRun"
  >,
) {
  const { t } = useTranslation();
  const panel = useRef<HTMLDivElement>(null);
  const listToggle = useRef<HTMLButtonElement>(null);
  const createTrigger = useRef<HTMLButtonElement>(null);
  const listId = useId();
  const compact = useCompactPanel(panel);
  const [wideList, setWideList] = useState(true);
  const [compactList, setCompactList] = useState(false);
  const showList = compact ? compactList : wideList;
  const [selected, setSelected] = useState(
    () => localStorage.getItem(selectedTaskNoteKey) ?? "",
  );
  const [creating, setCreating] = useState(false);
  const notes = useQuery({ ...taskNotesQuery, enabled: props.visible });
  const drafts = useTaskDraftSummaries();
  const id = resolveTaskNoteId(notes.data, selected, drafts.has(selected));
  const { executions, workflows, runQuery, workflowQuery } = useTaskActivity(
    props.visible,
  );
  useUnsavedTaskWarning();
  function selectNote(id: string) {
    localStorage.setItem(selectedTaskNoteKey, id);
    setSelected(id);
    if (compact) {
      setCompactList(false);
      listToggle.current?.focus({ preventScroll: true });
    }
  }
  const failedActivity = runQuery.error
    ? runQuery
    : workflowQuery.error
      ? workflowQuery
      : undefined;
  return (
    <TooltipProvider delayDuration={350}>
      <div
        className="workspace-notes"
        ref={panel}
        data-compact={compact || undefined}
        data-list-open={showList}
      >
        <div
          className="workspace-note-document tasks-content"
          inert={compact && showList}
          aria-hidden={compact && showList}
        >
          <TaskNotePane
            onOpenNote={selectNote}
            {...props}
            id={id}
            notes={notes}
            executions={executions}
            workflows={workflows}
            toolbarAction={
              <ToolbarButton
                ref={createTrigger}
                label={t("tasks.newNote")}
                aria-haspopup="dialog"
                onClick={() => setCreating(true)}
              >
                <Plus />
              </ToolbarButton>
            }
            empty={
              <div className="task-notes-empty">
                <Button
                  ref={createTrigger}
                  variant="outline"
                  aria-haspopup="dialog"
                  onClick={() => setCreating(true)}
                >
                  <Plus />
                  {t("tasks.newNote")}
                </Button>
              </div>
            }
          />
          {failedActivity && (
            <ErrorNotice
              error={failedActivity.error}
              retry={() => void failedActivity.refetch()}
            />
          )}
        </div>
        <motion.aside
          id={listId}
          className="workspace-note-list"
          aria-label={t("tasks.notes")}
          aria-hidden={!showList}
          inert={!showList}
          initial={false}
          animate={{
            "--note-list-wide": Number(wideList),
            "--note-list-compact": Number(compactList),
          }}
        >
          <div className="file-sidebar">
            <div className="file-sidebar-heading">
              <span>{t("tasks.notes")}</span>
            </div>
            <div className="file-sidebar-scroll">
              <TaskNoteList
                notes={notes.data ?? []}
                currentId={id}
                onOpen={selectNote}
              />
            </div>
          </div>
        </motion.aside>
        <ToolbarButton
          ref={listToggle}
          className="workspace-notes-toggle"
          label={t(showList ? "tasks.hideNoteList" : "tasks.showNoteList")}
          aria-expanded={showList}
          aria-controls={listId}
          onClick={() => (compact ? setCompactList : setWideList)(!showList)}
        >
          {showList ? <PanelRightClose /> : <PanelRightOpen />}
        </ToolbarButton>
        {props.visible && creating && (
          <TaskLabelDialog
            title={t("tasks.newNote")}
            label={t("tasks.noteTitle")}
            saveLabel={t("tasks.create")}
            onClose={() => setCreating(false)}
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              if (props.visible)
                (createTrigger.current ?? listToggle.current)?.focus({
                  preventScroll: true,
                });
            }}
            onSave={async (title, id) => {
              selectNote((await createTaskNote({ id, title })).id);
            }}
          />
        )}
      </div>
    </TooltipProvider>
  );
}
