import { useState } from "react";
import { Link2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { Editor } from "@tiptap/core";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { formatNoteSelection } from "./noteFormatting";

function linkAddress(input: string) {
  const value = input.trim();
  if (!value || /\s/.test(value)) return;
  const href = /^(?:[a-z][a-z\d+.-]*:|[\/#])/i.test(value)
    ? value
    : `https://${value}`;
  if (URL.canParse(href, document.baseURI)) return href;
}

export function NoteLinkMenu({
  editor,
  current,
  container,
  onOutside,
  onDismiss,
}: {
  editor: Editor;
  current: string | null;
  container: HTMLElement;
  onOutside: (event: Event) => void;
  onDismiss: () => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [address, setAddress] = useState("");
  const [invalid, setInvalid] = useState(false);
  const label = t("tasks.format.link");

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) {
          setAddress(current ?? "");
          setInvalid(false);
        }
      }}
    >
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="note-format-mark"
          data-active={!!current || undefined}
          disabled={!editor.can().setMark("link")}
          aria-label={label}
          title={label}
        >
          <Link2 aria-hidden="true" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        sideOffset={7}
        hideWhenDetached
        className="w-64 max-w-[calc(100vw-24px)] p-2.5"
        portalContainer={container}
        aria-label={label}
        onInteractOutside={onOutside}
        onEscapeKeyDown={onDismiss}
        onCloseAutoFocus={(event) => event.preventDefault()}
      >
        <form
          className="flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            const href = linkAddress(address);
            if (!href || !editor.can().setLink({ href })) {
              setInvalid(true);
              return;
            }
            if (formatNoteSelection(editor, (chain) => chain.setLink({ href })))
              setOpen(false);
          }}
        >
          <Input
            type="text"
            inputMode="url"
            aria-label={t("tasks.format.linkAddress")}
            placeholder="https://"
            aria-invalid={invalid}
            value={address}
            onChange={(event) => {
              setAddress(event.target.value);
              setInvalid(false);
            }}
          />
          {invalid && (
            <p role="alert" className="text-xs text-destructive">
              {t("tasks.format.invalidLink")}
            </p>
          )}
          <div className="flex items-center justify-end gap-1.5">
            {current && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="mr-auto"
                onClick={() => {
                  if (formatNoteSelection(editor, (chain) => chain.unsetLink()))
                    setOpen(false);
                }}
              >
                {t("tasks.format.removeLink")}
              </Button>
            )}
            <Button type="submit" size="sm" disabled={!address.trim()}>
              {t("tasks.format.applyLink")}
            </Button>
          </div>
        </form>
      </PopoverContent>
    </Popover>
  );
}
