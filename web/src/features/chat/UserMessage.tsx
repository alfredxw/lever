import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { Message as MessageData } from "@/api/types.gen";
import { Bubble, BubbleContent } from "@/components/ui/bubble";
import { Message, MessageContent } from "@/components/ui/message";
import { Attachments } from "./Attachments";
import { MessageInput } from "./References";
import { MessageActions, type MessageActionHandlers } from "./MessageActions";
import { QuotedMessage } from "./QuotedMessage";

export function UserMessage({
  chatId,
  sessionId,
  message: run,
  archived,
  onQuote,
  onForward,
  onEdit,
  children,
  footerActions,
}: {
  chatId: string;
  sessionId?: string;
  message: MessageData;
  archived?: boolean;
  children?: ReactNode;
  footerActions?: ReactNode;
  onEdit?: () => void;
} & MessageActionHandlers) {
  const { t } = useTranslation();
  return (
    <Message
      align="end"
      className="user-message"
      role="group"
      aria-label={t("chat.you")}
    >
      <MessageContent>
        <Attachments files={run.attachments ?? []} />
        {(run.input || !!run.references?.length || run.quote || children) && (
          <Bubble align="end" variant="muted">
            <BubbleContent className="flex flex-col gap-2">
              {run.quote && <QuotedMessage quote={run.quote} />}
              <MessageInput
                text={run.input}
                references={run.references}
                sessionId={sessionId}
              />
              {children}
            </BubbleContent>
          </Bubble>
        )}
        <MessageActions
          chatId={chatId}
          message={{
            runId: run.id,
            role: "user",
            author: t("chat.you"),
            text:
              run.input ||
              run.quote?.text ||
              (run.attachments ?? [])
                .map((file) => `[${file.name}]`)
                .join("\n"),
          }}
          timestamp={run.createdAt}
          disabled={archived}
          onQuote={onQuote}
          onForward={onForward}
          onEdit={onEdit}
        >
          {footerActions}
        </MessageActions>
      </MessageContent>
    </Message>
  );
}
