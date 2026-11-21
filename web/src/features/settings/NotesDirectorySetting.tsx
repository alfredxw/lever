import { useId, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { FolderOpen } from "lucide-react";
import { isMyGo } from "mygo-runtime";
import { useTranslation } from "react-i18next";
import { api, queryClient, resetTaskNotes } from "@/api/client";
import { Dialogs } from "@/api/desktop.gen";
import type {
  TaskNotesDirectory,
  TaskNotesDirectoryUpdate,
} from "@/api/types.gen";
import { ErrorNotice } from "@/components/common";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group";
import { Skeleton } from "@/components/ui/skeleton";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  taskNotesDirectoryPath,
  taskNotesDirectoryQuery,
} from "@/features/tasks/noteQueries";
import { flushTaskNoteEdits } from "@/features/tasks/useTaskNote";
import { SettingsRow } from "./SettingsControls";

export function NotesDirectorySetting() {
  const { t } = useTranslation();
  const fieldId = useId();
  const directory = useQuery(taskNotesDirectoryQuery);
  const [draft, setDraft] = useState<TaskNotesDirectoryUpdate>();
  const copying = draft?.newFolder !== undefined;
  const change = useMutation({
    mutationFn: async (input: TaskNotesDirectoryUpdate) => {
      await flushTaskNoteEdits();
      return api<TaskNotesDirectory>(taskNotesDirectoryPath, input, "PUT");
    },
    onSuccess: (saved) => {
      queryClient.setQueryData(taskNotesDirectoryQuery.queryKey, saved);
      resetTaskNotes();
      setDraft(undefined);
    },
    onError: () => void directory.refetch(),
  });
  const pick = useMutation({
    mutationFn: (path: string) => Dialogs.pickDirectories(path, false),
    onSuccess: ([path]) => {
      if (path) setDraft((current) => current && { ...current, path });
    },
  });
  const busy = change.isPending || pick.isPending;

  return (
    <SettingsRow
      title={t("settings.notesDirectory")}
      description={t("settings.notesDirectoryDescription")}
    >
      {directory.data ? (
        <Dialog
          open={!!draft}
          onOpenChange={(open) => {
            if (busy) return;
            change.reset();
            pick.reset();
            setDraft(
              open ? { currentPath: directory.data.path, path: "" } : undefined,
            );
          }}
        >
          <div className="settings-directory">
            <code className="settings-path" title={directory.data.path}>
              {directory.data.path}
            </code>
            <DialogTrigger asChild>
              <Button variant="outline" size="sm">
                {t("settings.changeNotesDirectory")}
              </Button>
            </DialogTrigger>
          </div>
          {draft && (
            <DialogContent showCloseButton={false}>
              <form
                className="grid min-w-0 gap-4"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (
                    busy ||
                    !draft.path.trim() ||
                    (copying && !draft.newFolder?.trim())
                  )
                    return;
                  change.mutate({
                    ...draft,
                    newFolder: draft.newFolder?.trim(),
                  });
                }}
              >
                <DialogHeader>
                  <DialogTitle>
                    {t("settings.changeNotesDirectory")}
                  </DialogTitle>
                  <DialogDescription>
                    {t(
                      copying
                        ? "settings.copyNotesDirectoryDescription"
                        : "settings.openNotesDirectoryDescription",
                    )}
                  </DialogDescription>
                </DialogHeader>
                <ToggleGroup
                  type="single"
                  variant="outline"
                  spacing={1}
                  className="flex-wrap"
                  aria-label={t("settings.changeNotesDirectory")}
                  value={copying ? "copy" : "open"}
                  disabled={busy}
                  onValueChange={(mode) => {
                    if (!mode) return;
                    change.reset();
                    setDraft({
                      ...draft,
                      path: "",
                      newFolder: mode === "copy" ? "Lever Notes" : undefined,
                    });
                  }}
                >
                  <ToggleGroupItem value="open">
                    {t("settings.openNotesDirectory")}
                  </ToggleGroupItem>
                  <ToggleGroupItem value="copy">
                    {t("settings.copyNotesDirectory")}
                  </ToggleGroupItem>
                </ToggleGroup>
                <FieldGroup>
                  <Field>
                    <FieldLabel htmlFor={fieldId}>
                      {t(
                        copying
                          ? "settings.notesParentDirectory"
                          : "settings.notesDirectory",
                      )}
                    </FieldLabel>
                    <InputGroup>
                      <InputGroupInput
                        id={fieldId}
                        value={draft.path}
                        autoComplete="off"
                        spellCheck={false}
                        disabled={busy}
                        onChange={(event) =>
                          setDraft({ ...draft, path: event.target.value })
                        }
                      />
                      {isMyGo() && (
                        <InputGroupAddon align="inline-end">
                          <InputGroupButton
                            disabled={busy}
                            variant="ghost"
                            aria-label={t("settings.browseNotesDirectory")}
                            title={t("settings.browseNotesDirectory")}
                            onClick={() =>
                              pick.mutate(draft.path || draft.currentPath)
                            }
                          >
                            <FolderOpen />
                          </InputGroupButton>
                        </InputGroupAddon>
                      )}
                    </InputGroup>
                  </Field>
                  {copying && (
                    <Field>
                      <FieldLabel htmlFor={`${fieldId}-name`}>
                        {t("settings.notesFolderName")}
                      </FieldLabel>
                      <Input
                        id={`${fieldId}-name`}
                        value={draft.newFolder}
                        disabled={busy}
                        onChange={(event) =>
                          setDraft({ ...draft, newFolder: event.target.value })
                        }
                      />
                    </Field>
                  )}
                </FieldGroup>
                {(change.error || pick.error) && (
                  <ErrorNotice error={change.error ?? pick.error} />
                )}
                <DialogFooter>
                  <Button
                    type="button"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => setDraft(undefined)}
                  >
                    {t("common.cancel")}
                  </Button>
                  <Button
                    type="submit"
                    disabled={
                      busy ||
                      !draft.path.trim() ||
                      (copying && !draft.newFolder?.trim())
                    }
                  >
                    {t(
                      change.isPending
                        ? copying
                          ? "settings.copyingNotesDirectory"
                          : "settings.openingNotesDirectory"
                        : copying
                          ? "settings.copyAndUseNotesDirectory"
                          : "common.save",
                    )}
                  </Button>
                </DialogFooter>
              </form>
            </DialogContent>
          )}
        </Dialog>
      ) : directory.error ? (
        <ErrorNotice
          error={directory.error}
          retry={() => void directory.refetch()}
        />
      ) : (
        <Skeleton className="h-5 w-40" />
      )}
    </SettingsRow>
  );
}
