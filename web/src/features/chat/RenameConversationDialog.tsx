import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { api, queryClient } from "@/api/client";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";

export type RenameTarget = {
  chatId: string;
  topicId?: string;
  title: string;
  trigger: HTMLElement;
};

export function RenameConversationDialog({
  target,
  onClose,
}: {
  target: RenameTarget;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState(target.title);
  const title = name.trim();
  const tooLong = Array.from(title).length > 120;
  const save = useMutation({
    mutationFn: () =>
      api(
        "/chats/" + target.chatId + "/title",
        { title, topicId: target.topicId },
        "PUT",
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["overview"] });
      onClose();
    },
  });
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !save.isPending) onClose();
      }}
    >
      <DialogContent
        aria-describedby={undefined}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          const input = (event.currentTarget as HTMLElement).querySelector(
            "input",
          );
          input?.focus();
          input?.select();
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          target.trigger.focus({ preventScroll: true });
        }}
      >
        <DialogHeader>
          <DialogTitle>{t("agents.renameConversation")}</DialogTitle>
        </DialogHeader>
        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (title && !tooLong && !save.isPending) save.mutate();
          }}
        >
          <Input
            aria-label={t("agents.conversationTitle")}
            value={name}
            onChange={(event) => setName(event.target.value)}
            aria-invalid={tooLong || undefined}
          />
          {(tooLong || save.error) && (
            <p role="alert" className="text-sm text-destructive">
              {tooLong ? t("agents.titleTooLong") : save.error?.message}
            </p>
          )}
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              disabled={save.isPending}
              onClick={onClose}
            >
              {t("common.cancel")}
            </Button>
            <Button
              type="submit"
              disabled={!title || tooLong || save.isPending}
            >
              {t("common.save")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
