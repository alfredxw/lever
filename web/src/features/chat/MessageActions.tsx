import { useContext, type ReactNode } from "react";
import { Forward, MessagesSquare, Pencil, Quote } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import type { MessageQuote } from "@/api/types.gen";
import { Button } from "@/components/ui/button";
import { CodeBlockCopyButton } from "@/components/ui/code-block";
import { MessageFooter } from "@/components/ui/message";
import { useLocalDayKey } from "@/hooks/useLocalDayKey";
import { ComposerContext } from "./ComposerContext";
import { formatMessageTime } from "./messageTime";

export type MessageActionHandlers = {
  onQuote?: (message: MessageQuote) => void;
  onForward: (message: MessageQuote) => void;
};

export function MessageActions({
  chatId,
  message,
  timestamp,
  disabled,
  onQuote,
  onForward,
  onEdit,
  persistentAction,
  children,
}: MessageActionHandlers & {
  chatId: string;
  message: MessageQuote;
  timestamp?: string;
  disabled?: boolean;
  onEdit?: () => void;
  persistentAction?: ReactNode;
  children?: ReactNode;
}) {
  const { t, i18n } = useTranslation();
  const composer = useContext(ComposerContext);
  useLocalDayKey();
  const formattedTime = formatMessageTime(timestamp, i18n.language, {
    formatYesterday: (time) => t("chat.yesterdayTime", { time }),
  });
  return (
    <MessageFooter className="message-actions gap-1 px-0">
      {persistentAction}
      <div className="message-actions-secondary flex min-w-0 items-center gap-1 overflow-x-auto">
        {onEdit && (
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={t("chat.editFromHere")}
            title={t("chat.editFromHere")}
            onClick={onEdit}
          >
            <Pencil />
          </Button>
        )}
        {message.text.trim() && (
          <>
            <CodeBlockCopyButton
              value={message.text}
              size="icon-xs"
              copyLabel={t("chat.copy")}
              copiedLabel={t("chat.copied")}
              onCopyError={() => toast.error(t("chat.copyFailed"))}
            />
            {onQuote && (
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={t("chat.quote")}
                title={t("chat.quote")}
                disabled={disabled}
                onClick={() => onQuote(message)}
              >
                <Quote />
              </Button>
            )}
            {composer && (
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={t("chat.quoteTo")}
                title={t("chat.quoteTo")}
                disabled={disabled}
                onClick={() => composer.quoteTo(chatId, message)}
              >
                <MessagesSquare />
              </Button>
            )}
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={t("chat.forward")}
              title={t("chat.forward")}
              onClick={() => onForward(message)}
            >
              <Forward />
            </Button>
          </>
        )}
        {children}
        {formattedTime && (
          <time
            className="ml-1 shrink-0 whitespace-nowrap font-normal tabular-nums"
            dateTime={timestamp}
            title={formattedTime.full}
          >
            {formattedTime.displayed}
          </time>
        )}
      </div>
    </MessageFooter>
  );
}
