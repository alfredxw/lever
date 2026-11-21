import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation } from "@tanstack/react-query";
import { Forward, LoaderCircle } from "lucide-react";
import { api, queryClient } from "@/api/client";
import type { Chat, MessageQuote, Overview, SendInput } from "@/api/types.gen";
import { QuotedMessage } from "./QuotedMessage";
import { ErrorNotice } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Field, FieldLabel } from "@/components/ui/field";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";

export function ForwardMessageDialog({
  message,
  overview,
  onClose,
  onForwarded,
}: {
  message: MessageQuote;
  overview: Pick<Overview, "agents">;
  onClose: () => void;
  onForwarded: (chat: Chat) => void;
}) {
  const { t } = useTranslation();
  const [agentId, setAgentId] = useState("");
  const [note, setNote] = useState("");
  const destination = useRef<Chat>(undefined);
  const submission = useRef<SendInput>(undefined);
  const agents = overview.agents.filter((agent) => !agent.archived);
  const forward = useMutation({
    mutationFn: async () => {
      if (destination.current?.agentId !== agentId) {
        destination.current = await api<Chat>("/chats", {
          agentId,
          title: t("chat.forward"),
        });
      }
      const chat = destination.current;
      const text = note.trim();
      // Retrying a lost send response must not start a second execution.
      if (
        submission.current?.chatId !== chat.id ||
        submission.current.text !== text
      ) {
        submission.current = {
          commandId: crypto.randomUUID(),
          chatId: chat.id,
          operation: "main",
          text,
          quote: message,
        };
      }
      await api("/messages", submission.current);
      return chat;
    },
    onSuccess: onForwarded,
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ["overview"] });
    },
  });
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !forward.isPending) onClose();
      }}
    >
      <DialogContent showCloseButton={!forward.isPending}>
        <DialogHeader>
          <DialogTitle>{t("chat.forward")}</DialogTitle>
          <DialogDescription>{t("chat.forwardDescription")}</DialogDescription>
        </DialogHeader>
        <div className="rounded-lg bg-muted p-3">
          <QuotedMessage quote={message} />
        </div>
        <Field>
          <FieldLabel htmlFor="forward-agent">
            {t("chat.forwardAgent")}
          </FieldLabel>
          <Select
            value={agentId}
            onValueChange={setAgentId}
            disabled={forward.isPending}
          >
            <SelectTrigger id="forward-agent" className="w-full">
              <SelectValue placeholder={t("chat.chooseAgent")} />
            </SelectTrigger>
            <SelectContent>
              {agents.map((agent) => (
                <SelectItem key={agent.id} value={agent.id}>
                  {agent.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field>
          <FieldLabel htmlFor="forward-note">
            {t("chat.forwardNote")}
          </FieldLabel>
          <Textarea
            id="forward-note"
            value={note}
            onChange={(event) => setNote(event.target.value)}
            placeholder={t("chat.forwardNotePlaceholder")}
            disabled={forward.isPending}
          />
        </Field>
        {forward.error && <ErrorNotice error={forward.error} />}
        <DialogFooter>
          <Button
            variant="outline"
            disabled={forward.isPending}
            onClick={onClose}
          >
            {t("common.close")}
          </Button>
          <Button
            disabled={
              !agents.some((agent) => agent.id === agentId) || forward.isPending
            }
            onClick={() => forward.mutate()}
          >
            {forward.isPending ? (
              <LoaderCircle className="animate-spin" />
            ) : (
              <Forward />
            )}
            {t("chat.forwardSend")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
