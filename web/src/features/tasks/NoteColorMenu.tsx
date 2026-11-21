import { ChevronDown } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { ChainedCommands, Editor } from "@tiptap/core";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  formatNoteSelection,
  noteHighlights,
  noteTextColors,
} from "./noteFormatting";

export type NoteColors = { ink: string | null; highlight: string | null };
const palettes = {
  ink: { mark: "noteTextColor", colors: noteTextColors },
  highlight: { mark: "noteHighlight", colors: noteHighlights },
} as const;

function setColor(
  chain: ChainedCommands,
  kind: keyof NoteColors,
  color: string | null,
) {
  const { mark } = palettes[kind];
  return color ? chain.setMark(mark, { color }) : chain.unsetMark(mark);
}

export function NoteColorMenu({
  editor,
  colors,
  last,
  onChangeLast,
  container,
  onOutside,
  onDismiss,
}: {
  editor: Editor;
  colors: NoteColors;
  last: NoteColors;
  onChangeLast: (colors: NoteColors) => void;
  container: HTMLElement;
  onOutside: (event: Event) => void;
  onDismiss: (event: Event) => void;
}) {
  const { t } = useTranslation();
  const enabled = editor.can().setMark("noteTextColor");

  function colorLabel(color: string | null) {
    if (!color) return t("tasks.format.defaultColor");
    const [tone, hue] = color.split("-");
    return hue
      ? t(`tasks.format.${tone}Color`, {
          color: t(`tasks.format.color.${hue}`),
        })
      : t(`tasks.format.color.${tone}`);
  }

  function pick(kind: keyof NoteColors, color: string | null) {
    const value = color === colors[kind] ? null : color;
    if (
      formatNoteSelection(
        editor,
        (chain) => setColor(chain, kind, value),
        false,
      )
    )
      onChangeLast({ ...last, [kind]: value });
  }

  function apply(colors: NoteColors, focus: boolean) {
    return formatNoteSelection(
      editor,
      (chain) =>
        setColor(
          setColor(chain, "ink", colors.ink),
          "highlight",
          colors.highlight,
        ),
      focus,
    );
  }

  return (
    <Popover>
      <PopoverAnchor asChild>
        <div className="note-color-control">
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={t("tasks.format.applyColors")}
            title={t("tasks.format.applyColors")}
            disabled={!enabled}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => apply(last, true)}
          >
            <span
              className="note-color-preview"
              aria-hidden="true"
              data-note-ink={last.ink || undefined}
              data-note-highlight={last.highlight || undefined}
            >
              A
            </span>
          </Button>
          <PopoverTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="note-color-chevron"
              disabled={!enabled}
              aria-label={t("tasks.format.colors")}
              title={t("tasks.format.colors")}
            >
              <ChevronDown className="note-format-chevron" aria-hidden="true" />
            </Button>
          </PopoverTrigger>
        </div>
      </PopoverAnchor>
      <PopoverContent
        align="start"
        sideOffset={7}
        hideWhenDetached
        className="note-color-panel"
        portalContainer={container}
        aria-label={t("tasks.format.colors")}
        onInteractOutside={onOutside}
        onEscapeKeyDown={onDismiss}
        onCloseAutoFocus={(event) => event.preventDefault()}
      >
        {(["ink", "highlight"] as const).map((kind) => (
          <div key={kind} role="group" aria-label={t(`tasks.format.${kind}`)}>
            <div className="note-color-heading">
              {t(`tasks.format.${kind}`)}
            </div>
            <div className="note-color-grid">
              {[null, ...palettes[kind].colors].map((color) => (
                <Button
                  key={color ?? "default"}
                  type="button"
                  size="icon-xs"
                  variant="ghost"
                  className="note-color-swatch"
                  aria-label={colorLabel(color)}
                  title={colorLabel(color)}
                  aria-pressed={colors[kind] === color}
                  onClick={() => pick(kind, color)}
                >
                  <span
                    aria-hidden="true"
                    className="note-color-sample"
                    data-note-ink={
                      kind === "ink" ? (color ?? undefined) : undefined
                    }
                    data-note-highlight={
                      kind === "highlight" ? (color ?? undefined) : undefined
                    }
                    data-transparent={
                      kind === "highlight" && !color ? "" : undefined
                    }
                  >
                    {kind === "ink" ? "A" : null}
                  </span>
                </Button>
              ))}
            </div>
          </div>
        ))}
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="w-full"
          onClick={() => {
            const cleared = { ink: null, highlight: null };
            if (apply(cleared, false)) onChangeLast(cleared);
          }}
        >
          {t("tasks.format.resetColors")}
        </Button>
      </PopoverContent>
    </Popover>
  );
}
