import type { ReactNode } from "react";
import { Forward, Pencil, Quote } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import type { MessageQuote } from "@/api/types.gen";
import { Button } from "@/components/ui/button";
import { CodeBlockCopyButton } from "@/components/ui/code-block";
import { MessageFooter } from "@/components/ui/message";
import { useLocalDayKey } from "@/hooks/useLocalDayKey";
import { formatMessageTime } from "./messageTime";

export type MessageActionHandlers = {
  onQuote?: (message: MessageQuote) => void;
  onForward: (message: MessageQuote) => void;
};

export function MessageActions({
  message,
  timestamp,
  disabled,
  onQuote,
  onForward,
  onEdit,
  leadingAction,
  leadingActionPersistent = false,
  children,
}: MessageActionHandlers & {
  message: MessageQuote;
  timestamp?: string;
  disabled?: boolean;
  onEdit?: () => void;
  leadingAction?: ReactNode;
  leadingActionPersistent?: boolean;
  children?: ReactNode;
}) {
  const { t, i18n } = useTranslation();
  useLocalDayKey();
  const formattedTime = formatMessageTime(timestamp, i18n.language, {
    formatYesterday: (time) => t("chat.yesterdayTime", { time }),
  });
  return (
    <MessageFooter className="message-actions gap-1 px-0">
      {leadingActionPersistent && leadingAction}
      <div className="message-actions-secondary flex min-w-0 items-center gap-1 overflow-x-auto">
        {!leadingActionPersistent && leadingAction}
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
