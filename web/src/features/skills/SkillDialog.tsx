import { useId, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { FolderOpen } from "lucide-react";
import { isMyGo } from "mygo-runtime";
import { useTranslation } from "react-i18next";
import { api, queryClient } from "@/api/client";
import { Dialogs } from "@/api/desktop.gen";
import type { Skill } from "@/api/types.gen";
import { ErrorNotice } from "@/components/common";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldLabel } from "@/components/ui/field";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group";
import { skillsQuery } from "./skillsQuery";

export function SkillDialog({
  mode,
  homeDir,
  onClose,
  onSaved,
}: {
  mode: "create" | "directory";
  homeDir: string;
  onClose: () => void;
  onSaved: (skill: Skill) => void;
}) {
  const { t } = useTranslation();
  const id = useId();
  const [value, setValue] = useState("");
  const create = mode === "create";
  const pick = useMutation({
    mutationFn: () => Dialogs.pickDirectories(value.trim() || homeDir, false),
    onSuccess: ([directory]) => {
      if (directory) setValue(directory);
    },
  });
  const save = useMutation({
    mutationFn: () =>
      api<Skill>(
        "/skills",
        create ? { name: value.trim() } : { directory: value.trim() },
      ),
    onSuccess: (skill) => {
      void queryClient.cancelQueries(skillsQuery);
      queryClient.setQueryData(skillsQuery.queryKey, (skills) => [
        ...(skills ?? []).filter((item) => item.id !== skill.id),
        {
          ...skill,
          origin: skills?.find((item) => item.id === skill.id)?.origin,
        },
      ]);
      void queryClient.invalidateQueries(skillsQuery);
      onSaved(skill);
    },
  });
  const error = save.error ?? pick.error;
  const busy = save.isPending || pick.isPending;
  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent showCloseButton={!busy}>
        <DialogHeader>
          <DialogTitle>
            {t(create ? "skills.create" : "skills.addDirectory")}
          </DialogTitle>
          <DialogDescription className={create ? "sr-only" : undefined}>
            {t(create ? "skills.nameHint" : "skills.directoryHint")}
          </DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            event.stopPropagation();
            if (!busy && value.trim()) save.mutate();
          }}
        >
          <Field>
            <FieldLabel htmlFor={id}>
              {t(create ? "skills.name" : "profile.skillDirectory")}
            </FieldLabel>
            <InputGroup>
              <InputGroupInput
                id={id}
                value={value}
                placeholder={create ? "my-skill" : "/path/to/skill"}
                autoFocus
                disabled={save.isPending}
                onChange={(event) => {
                  save.reset();
                  setValue(event.target.value);
                }}
              />
              {!create && isMyGo() && (
                <InputGroupAddon align="inline-end">
                  <InputGroupButton
                    type="button"
                    size="icon-xs"
                    aria-label={t("skills.chooseDirectory")}
                    title={t("skills.chooseDirectory")}
                    disabled={busy}
                    onClick={() => pick.mutate()}
                  >
                    <FolderOpen />
                  </InputGroupButton>
                </InputGroupAddon>
              )}
            </InputGroup>
          </Field>
          {error && <ErrorNotice error={error} />}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={onClose}
            >
              {t("common.cancel")}
            </Button>
            <Button type="submit" disabled={busy || !value.trim()}>
              {t(create ? "skills.createAction" : "skills.addAction")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
