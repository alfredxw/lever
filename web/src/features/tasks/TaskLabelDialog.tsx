import { useState } from "react";
import { useTranslation } from "react-i18next";
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
import { Input } from "@/components/ui/input";

export function TaskLabelDialog({
  title,
  label,
  initialValue = "",
  allowEmpty = false,
  suggestions,
  saveLabel,
  onClose,
  onCloseAutoFocus,
  onSave,
}: {
  title: string;
  label: string;
  initialValue?: string;
  allowEmpty?: boolean;
  suggestions?: string[];
  saveLabel?: string;
  onClose: () => void;
  onCloseAutoFocus?: (event: Event) => void;
  onSave: (value: string, requestId: string) => void | Promise<void>;
}) {
  const { t } = useTranslation();
  const [requestId] = useState(() => crypto.randomUUID());
  const [value, setValue] = useState(initialValue);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>();
  const canSave = allowEmpty || !!value.trim();

  return (
    <Dialog open onOpenChange={(open) => !open && !pending && onClose()}>
      <DialogContent onCloseAutoFocus={onCloseAutoFocus}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription className="sr-only">{label}</DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-3"
          onSubmit={async (event) => {
            event.preventDefault();
            if (!canSave || pending) return;
            setPending(true);
            setError(undefined);
            try {
              await onSave(value.trim(), requestId);
              onClose();
            } catch (error) {
              setError(error);
              setPending(false);
            }
          }}
        >
          <Input
            autoFocus
            aria-label={label}
            placeholder={label}
            value={value}
            maxLength={100}
            disabled={pending}
            onChange={(event) => setValue(event.target.value)}
          />
          {!!suggestions?.length && (
            <div className="flex max-h-24 flex-wrap gap-1 overflow-auto">
              {suggestions.map((suggestion) => (
                <Button
                  key={suggestion}
                  type="button"
                  variant="secondary"
                  size="xs"
                  disabled={pending}
                  className="max-w-full"
                  onClick={() => setValue(suggestion)}
                >
                  <span className="truncate">{suggestion}</span>
                </Button>
              ))}
            </div>
          )}
          {!!error && <ErrorNotice error={error} />}
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              disabled={pending}
              onClick={onClose}
            >
              {t("common.cancel")}
            </Button>
            <Button type="submit" disabled={!canSave || pending}>
              {saveLabel ?? t("common.save")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
