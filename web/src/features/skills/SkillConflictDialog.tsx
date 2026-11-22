import { useMutation } from "@tanstack/react-query";
import { CopyPlus, RefreshCw, Shield } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { api, queryClient } from "@/api/client";
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
import { skillsQuery, skillSubscriptionsQuery } from "./skillsQuery";

type ResolveAction = "keep" | "overwrite" | "fork";

export function SkillConflictDialog({
  skill,
  onClose,
  onForked,
}: {
  skill: Skill;
  onClose: () => void;
  onForked?: (forked: Skill) => void;
}) {
  const { t } = useTranslation();

  const resolve = useMutation({
    mutationFn: (strategy: ResolveAction) =>
      api<Skill>(`/skills/${skill.id}/resolve-update`, { strategy }),
    onSuccess: (result, strategy) => {
      void queryClient.invalidateQueries(skillsQuery);
      void queryClient.invalidateQueries(skillSubscriptionsQuery);
      if (strategy === "keep") {
        toast.success(t("skills.conflictResolvedKeep"));
      } else if (strategy === "overwrite") {
        toast.success(t("skills.conflictResolvedOverwrite"));
      } else if (strategy === "fork") {
        toast.success(
          t("skills.conflictResolvedFork", {
            name: result.name || `${skill.name}-custom`,
          }),
        );
        if (result.id) onForked?.(result);
      }
      onClose();
    },
  });

  const busy = resolve.isPending;

  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent showCloseButton={!busy} className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {t("skills.conflictTitle", { name: skill.name })}
          </DialogTitle>
          <DialogDescription>{t("skills.conflictDesc")}</DialogDescription>
        </DialogHeader>

        <div className="grid gap-2.5">
          <button
            type="button"
            className="skills-conflict-choice"
            disabled={busy}
            onClick={() => resolve.mutate("fork")}
          >
            <CopyPlus className="mt-0.5 size-4 shrink-0 text-foreground" />
            <div className="min-w-0 flex-1 text-start">
              <div className="text-[13px] font-semibold text-foreground">
                {t("skills.conflictFork")}
              </div>
              <p className="mt-0.5 text-xs text-muted-foreground">
                data/skills/{skill.name}-custom/
              </p>
            </div>
          </button>

          <button
            type="button"
            className="skills-conflict-choice"
            disabled={busy}
            onClick={() => resolve.mutate("keep")}
          >
            <Shield className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            <div className="min-w-0 flex-1 text-start">
              <div className="text-[13px] font-medium text-foreground">
                {t("skills.conflictKeep")}
              </div>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {t("skills.localModifiedBanner")}
              </p>
            </div>
          </button>

          <button
            type="button"
            className="skills-conflict-choice"
            data-destructive="true"
            disabled={busy}
            onClick={() => resolve.mutate("overwrite")}
          >
            <RefreshCw className="mt-0.5 size-4 shrink-0 text-destructive" />
            <div className="min-w-0 flex-1 text-start">
              <div className="text-[13px] font-medium text-destructive">
                {t("skills.conflictOverwrite")}
              </div>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {skill.subscriptionName || skill.path}
              </p>
            </div>
          </button>
        </div>

        {resolve.error && <ErrorNotice error={resolve.error} />}

        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            disabled={busy}
            onClick={onClose}
          >
            {t("common.cancel")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
