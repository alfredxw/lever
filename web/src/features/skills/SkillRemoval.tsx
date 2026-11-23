import { useId, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { api, queryClient } from "@/api/client";
import type {
  Skill,
  SkillRemovalResult,
  SkillSubscription,
} from "@/api/types.gen";
import { ErrorNotice } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { withFileOperation } from "@/features/files/fileDrafts";
import { skillsQuery, skillSubscriptionsQuery } from "./skillsQuery";

export type SkillRemovalTarget =
  | { skill: Skill }
  | { subscription: SkillSubscription };

export function SkillActionButton({
  skill,
  compact = false,
  onAction,
}: {
  skill: Skill;
  compact?: boolean;
  onAction: (skill: Skill) => void;
}) {
  const { t } = useTranslation();
  const label = t("skills.deleteSkill");
  return (
    <Button
      variant="ghost"
      size={compact ? "icon-xs" : "xs"}
      className="text-muted-foreground"
      title={label}
      aria-label={compact ? `${label} · ${skill.name}` : label}
      onClick={() => onAction(skill)}
    >
      <Trash2 />
      {!compact && label}
    </Button>
  );
}

export function SkillRemovalDialog({
  target,
  onClose,
  onRemoved,
}: {
  target: SkillRemovalTarget;
  onClose: () => void;
  onRemoved: () => void;
}) {
  const { t } = useTranslation();
  const [deleteFiles, setDeleteFiles] = useState(false);
  const checkboxId = useId();
  const entry = "skill" in target ? target.skill : target.subscription;
  const skill = "skill" in target ? target.skill : undefined;
  const sub = "subscription" in target ? target.subscription : undefined;
  const directory = skill?.path ?? sub?.directory;
  const title = t(sub ? "skills.removeSubscription" : "skills.deleteSkill");
  const confirmLabel = deleteFiles
    ? t("skills.removeAndDelete")
    : t(sub ? "skills.removeSubscription" : "skills.unlinkSkill");
  const remove = useMutation({
    mutationFn: () => {
      const id = entry.id;
      const resource = sub ? "skill-subscriptions" : "skills";
      const request = () =>
        api<SkillRemovalResult>(
          `/${resource}/${encodeURIComponent(id)}/remove`,
          { deleteFiles },
        );
      return directory
        ? withFileOperation(
            { root: { id, path: directory }, path: "." },
            request,
          )
        : request();
    },
    onSuccess: (result) => {
      onRemoved();
      queryClient.setQueryData(skillsQuery.queryKey, (previous) =>
        previous?.filter((item) =>
          sub ? item.subscriptionId !== sub.id : item.id !== skill?.id,
        ),
      );
      void queryClient.invalidateQueries(skillsQuery);
      void queryClient.invalidateQueries({ queryKey: ["overview"] });
      for (const key of ["files", "file", "file-search"])
        void queryClient.invalidateQueries({ queryKey: [key] });
      if (sub || skill?.subscriptionId)
        void queryClient.invalidateQueries(skillSubscriptionsQuery);
      if (result.remainingDirectory) {
        toast.warning(t("skills.incompleteCleanup"), {
          description: result.remainingDirectory,
          closeButton: true,
          duration: Infinity,
        });
        return;
      }
      toast.success(
        t(
          sub
            ? "skills.subscriptionRemoved"
            : deleteFiles
              ? "skills.skillDeleted"
              : "skills.skillUnlinked",
        ),
      );
    },
  });

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !remove.isPending) onClose();
      }}
    >
      <DialogContent showCloseButton={!remove.isPending}>
        <DialogHeader>
          <DialogTitle className="break-words">
            {title} · {entry.name}
          </DialogTitle>
          <DialogDescription>
            {sub
              ? t("skills.removeSubscriptionConfirm", { count: sub.skillCount })
              : t("skills.unlinkSkillConfirm")}
          </DialogDescription>
        </DialogHeader>
        {directory && (
          <div className="flex flex-col gap-2">
            <code className="select-all break-all rounded-md bg-muted px-2 py-1.5 text-xs">
              {directory}
            </code>
            <div className="flex items-center gap-2">
              <Checkbox
                id={checkboxId}
                checked={deleteFiles}
                disabled={remove.isPending}
                aria-describedby={`${checkboxId}-effect`}
                onCheckedChange={(value) => {
                  setDeleteFiles(value === true);
                  remove.reset();
                }}
              />
              <label htmlFor={checkboxId} className="cursor-pointer text-sm">
                {t("skills.deleteSourceDirectory")}
              </label>
            </div>
            <p
              id={`${checkboxId}-effect`}
              className={
                deleteFiles
                  ? "text-xs text-destructive"
                  : "text-xs text-muted-foreground"
              }
              role="status"
            >
              {t(
                deleteFiles
                  ? "skills.deleteDirectoryWarning"
                  : "skills.keepDirectoryHint",
              )}
            </p>
          </div>
        )}
        {remove.error && <ErrorNotice error={remove.error} />}
        <DialogFooter>
          <Button
            autoFocus
            variant="outline"
            disabled={remove.isPending}
            onClick={onClose}
          >
            {t("common.cancel")}
          </Button>
          <Button
            variant={deleteFiles ? "destructive" : "default"}
            disabled={remove.isPending}
            onClick={() => remove.mutate()}
          >
            {remove.isPending ? t("files.operationPending") : confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
