import { useMutation } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { ErrorNotice } from "@/components/common";
import type { DirectorySelection } from "./filePaths";
import { changeEntry } from "./fileOperations";
import { useFileSource } from "./fileSource";

export function DeleteEntryDialog({
  target,
  onClose,
}: {
  target: DirectorySelection;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const source = useFileSource();
  const remove = useMutation({
    mutationFn: () => changeEntry(source, target, "delete"),
    onSuccess: onClose,
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
          <DialogTitle>{t("files.delete")}</DialogTitle>
          <DialogDescription className="break-all">
            {t("files.deleteConfirm", { path: target.path })}
          </DialogDescription>
        </DialogHeader>
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
            variant="destructive"
            disabled={remove.isPending}
            onClick={() => remove.mutate()}
          >
            {t(remove.isPending ? "files.operationPending" : "files.delete")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
