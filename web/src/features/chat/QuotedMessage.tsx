import { useTranslation } from "react-i18next";
import { X } from "lucide-react";
import type { MessageQuote } from "@/api/types.gen";
import { Button } from "@/components/ui/button";

export function QuotedMessage({
  quote,
  onRemove,
}: {
  quote: MessageQuote;
  onRemove?: () => void;
}) {
  const { t } = useTranslation();
  const author = quote.role === "user" ? t("chat.you") : quote.author;
  return (
    <div className="message-quote" data-slot="message-quote">
      <span
        className="line-clamp-2 min-w-0 flex-1"
        title={`${author}: ${quote.text}`}
      >
        <span className="font-medium">{t("chat.replyTo", { author })}</span>{" "}
        {quote.text}
      </span>
      {onRemove && (
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={t("chat.cancelQuote")}
          title={t("chat.cancelQuote")}
          onClick={onRemove}
        >
          <X />
        </Button>
      )}
    </div>
  );
}
