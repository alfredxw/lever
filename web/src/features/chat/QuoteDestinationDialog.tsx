import { useMutation, useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type { MessageQuote } from "@/api/types.gen";
import { chatTopicsQuery } from "./queries";
import { ErrorNotice, Loading } from "@/components/common";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { QuotedMessage } from "./QuotedMessage";

export type QuoteDestination =
  | { kind: "main" | "new-topic" }
  | { kind: "topic"; sessionId: string };

export function QuoteDestinationDialog({
  chatId,
  quote,
  onSelect,
  onClose,
}: {
  chatId: string;
  quote: MessageQuote;
  onSelect: (destination: QuoteDestination) => Promise<void>;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const topics = useQuery(chatTopicsQuery(chatId));
  const select = useMutation({ mutationFn: onSelect, onSuccess: onClose });
  return (
    <Dialog
      open
      onOpenChange={(open) => !open && !select.isPending && onClose()}
    >
      <DialogContent aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>{t("chat.quoteTo")}</DialogTitle>
        </DialogHeader>
        <QuotedMessage quote={quote} />
        <div className="flex max-h-64 flex-col gap-1 overflow-y-auto">
          <Button
            variant="ghost"
            className="justify-start"
            disabled={select.isPending}
            onClick={() => select.mutate({ kind: "main" })}
          >
            {t("chat.mainDestination")}
          </Button>
          <Button
            variant="ghost"
            className="justify-start"
            disabled={select.isPending}
            onClick={() => select.mutate({ kind: "new-topic" })}
          >
            {t("chat.newTopicDestination")}
          </Button>
          {topics.data?.map((topic) => (
            <Button
              key={topic.id}
              variant="ghost"
              className="justify-start"
              disabled={select.isPending}
              onClick={() =>
                select.mutate({ kind: "topic", sessionId: topic.id })
              }
            >
              <span className="truncate">{topic.title || t("chat.topic")}</span>
            </Button>
          ))}
        </div>
        {topics.isPending && <Loading />}
        {topics.error && (
          <ErrorNotice
            error={topics.error}
            retry={() => void topics.refetch()}
          />
        )}
        {select.error && <ErrorNotice error={select.error} />}
      </DialogContent>
    </Dialog>
  );
}
