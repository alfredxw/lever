import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
} from "react";
import { createPortal } from "react-dom";
import { TextSelection } from "@tiptap/pm/state";
import { useEditorState, type Editor } from "@tiptap/react";
import { BubbleMenu } from "@tiptap/react/menus";
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  Bold,
  ChevronDown,
  Code,
  Globe,
  Italic,
  LayoutGrid,
  RotateCcw,
  Search,
  Strikethrough,
  Underline,
  type LucideIcon,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Toggle } from "@/components/ui/toggle";
import {
  noteImageAlignment,
  selectedNoteImage,
  setNoteImageAttribute,
} from "./noteAsset";
import { noteBlockItems } from "./NoteBlockMenu";
import { NoteColorMenu, type NoteColors } from "./NoteColorMenu";
import { NoteLinkMenu } from "./NoteLinkMenu";
import {
  noteBlockType,
  noteHeadingLevels,
  type NoteBlockType,
} from "./taskEditing";
import {
  formatNoteSelection,
  noteAlignments,
  type NoteAlignment,
} from "./noteFormatting";

const formats = [
  { mark: "bold", icon: Bold },
  { mark: "strike", icon: Strikethrough },
  { mark: "italic", icon: Italic },
  { mark: "underline", icon: Underline },
] as const;
const inlineMarks = [...formats.map(({ mark }) => mark), "code"];

const blocksByType = new Map(noteBlockItems.map((item) => [item.type, item]));
const blockTypes: NoteBlockType[] = [
  "paragraph",
  ...noteHeadingLevels,
  "orderedList",
  "bulletList",
  "task",
  "codeBlock",
  "blockquote",
  "callout",
];
const alignmentIcons = {
  left: AlignLeft,
  center: AlignCenter,
  right: AlignRight,
};

const toolbarKey = "note-selection-toolbar";
const shouldShow: NonNullable<
  ComponentProps<typeof BubbleMenu>["shouldShow"]
> = ({ editor, state, element, view }) =>
  ((state.selection instanceof TextSelection && !state.selection.empty) ||
    !!selectedNoteImage(state.selection)) &&
  !view.composing &&
  (view.hasFocus() ||
    !!element.parentElement?.contains(document.activeElement)) &&
  editor.isEditable;

function MenuButton({
  icon: Icon,
  label,
  disabled,
}: {
  icon: LucideIcon;
  label: string;
  disabled?: boolean;
}) {
  return (
    <DropdownMenuTrigger asChild>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="note-format-trigger"
        disabled={disabled}
        aria-label={label}
        title={label}
      >
        <Icon aria-hidden="true" />
        <ChevronDown className="note-format-chevron" aria-hidden="true" />
      </Button>
    </DropdownMenuTrigger>
  );
}

function BlockChoices({
  editor,
  block,
}: {
  editor: Editor;
  block: NoteBlockType;
}) {
  const { t } = useTranslation();
  return (
    <DropdownMenuRadioGroup value={String(block)}>
      {blockTypes.map((type) => {
        const item = blocksByType.get(type)!;
        return (
          <DropdownMenuRadioItem
            key={type}
            value={String(type)}
            disabled={!editor.can().setNoteBlock(type)}
            onSelect={() =>
              formatNoteSelection(editor, (chain) => chain.setNoteBlock(type))
            }
          >
            <item.icon aria-hidden="true" />
            {t(item.label, { level: type })}
          </DropdownMenuRadioItem>
        );
      })}
    </DropdownMenuRadioGroup>
  );
}

export function NoteInlineToolbar({
  editor,
  scrollTarget,
  onFindText,
  onPreviewImage,
}: {
  editor: Editor;
  scrollTarget?: HTMLElement;
  onFindText: (text: string) => void;
  onPreviewImage: (pos: number) => void;
}) {
  const { t } = useTranslation();
  // Keep the bubble and its popups in the same focus scope, outside the scrolling document.
  const [container, setContainer] = useState<HTMLDivElement | null>(null);
  const toolbar = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const view = editor.view;
    function tabToImageActions(event: KeyboardEvent) {
      if (
        event.key !== "Tab" ||
        event.shiftKey ||
        event.altKey ||
        event.metaKey ||
        event.ctrlKey ||
        view.composing ||
        !selectedNoteImage(view.state.selection)
      )
        return;
      // The toolbar is portalled out of the note's normal tab order.
      const menu = toolbar.current;
      const button = menu?.querySelector<HTMLButtonElement>("button:enabled");
      if (
        menu?.style.visibility !== "visible" ||
        !button?.getClientRects().length
      )
        return;
      event.preventDefault();
      button.focus({ preventScroll: true });
    }
    view.dom.addEventListener("keydown", tabToImageActions, true);
    return () =>
      view.dom.removeEventListener("keydown", tabToImageActions, true);
  }, [editor]);
  const [lastColors, setLastColors] = useState<NoteColors>({
    ink: null,
    highlight: "light-yellow",
  });
  const options = useMemo<
    NonNullable<ComponentProps<typeof BubbleMenu>["options"]>
  >(() => {
    const boundary = { boundary: scrollTarget, padding: 8 };
    return {
      strategy: "fixed",
      placement: "top",
      offset: 6,
      flip: boundary,
      shift: boundary,
      hide: scrollTarget ? boundary : undefined,
      size: {
        ...boundary,
        apply: ({ availableWidth, elements }) => {
          elements.floating.style.maxWidth = `${Math.max(0, availableWidth)}px`;
        },
      },
      scrollTarget,
    };
  }, [scrollTarget]);
  const selected = useEditorState({
    editor,
    selector: ({ editor }) => {
      const { selection } = editor.state;
      if (editor.view.composing) return null;
      const image = selectedNoteImage(selection);
      if (image)
        return {
          kind: "image" as const,
          alignment: noteImageAlignment(image.node.attrs.align),
          customSize: image.node.attrs.width != null,
        };
      if (!(selection instanceof TextSelection) || selection.empty) return null;
      const marks = selection.$from.nodeAfter?.marks;
      const color = (name: string): string | null =>
        marks?.find((mark) => mark.type.name === name)?.attrs.color ?? null;
      return {
        kind: "text" as const,
        block: noteBlockType(selection.$from),
        alignment: (selection.$from.parent.attrs.textAlign ||
          "left") as NoteAlignment,
        link: (editor.getAttributes("link").href ?? null) as string | null,
        colors: {
          ink: color("noteTextColor"),
          highlight: color("noteHighlight"),
        },
        active: Object.fromEntries(
          inlineMarks.map((mark) => [mark, editor.isActive(mark)]),
        ),
      };
    },
  });

  function focusEditor() {
    if (!editor.isDestroyed)
      editor.commands.focus(null, { scrollIntoView: false });
  }

  function onOutside(event: Event) {
    const target = event.target;
    if (
      target instanceof globalThis.Node &&
      !container?.contains(target) &&
      !editor.view.dom.contains(target)
    )
      editor.commands.setMeta(toolbarKey, "hide");
  }

  function searchText(web: boolean) {
    const { doc, selection } = editor.state;
    const text = doc
      .textBetween(selection.from, selection.to, " ", (node) =>
        node.type.name === "agentMention" ? `@${node.attrs.label}` : "",
      )
      .trim();
    if (!text) return focusEditor();
    if (web) {
      window.open(
        `https://www.google.com/search?q=${encodeURIComponent(text)}`,
        "_blank",
        "noopener,noreferrer",
      );
      focusEditor();
    } else {
      editor.commands.setMeta(toolbarKey, "hide");
      onFindText(text);
    }
  }

  const menuProps = {
    portalContainer: container ?? undefined,
    sideOffset: 7,
    hideWhenDetached: true,
    onEscapeKeyDown: focusEditor,
    onInteractOutside: onOutside,
    onCloseAutoFocus: (event: Event) => event.preventDefault(),
  };
  const currentBlock =
    blocksByType.get(
      selected?.kind === "text" ? selected.block : "paragraph",
    ) ?? blocksByType.get("paragraph")!;
  const image = selected?.kind === "image" ? selected : undefined;

  function markButton(mark: string, Icon: LucideIcon) {
    const label = t(`tasks.format.${mark}`);
    return (
      <Toggle
        key={mark}
        size="sm"
        className="note-format-mark"
        aria-label={label}
        title={label}
        pressed={selected?.kind === "text" && selected.active[mark]}
        disabled={!editor.can().toggleMark(mark)}
        onMouseDown={(event) => event.preventDefault()}
        onPressedChange={() =>
          formatNoteSelection(editor, (chain) => chain.toggleMark(mark))
        }
      >
        <Icon aria-hidden="true" />
      </Toggle>
    );
  }

  return (
    <>
      {createPortal(<div ref={setContainer} />, document.body)}
      {container && (
        <BubbleMenu
          ref={toolbar}
          editor={editor}
          pluginKey={toolbarKey}
          appendTo={container}
          shouldShow={shouldShow}
          updateDelay={80}
          options={options}
          role="group"
          aria-label={t(image ? "tasks.image.layout" : "tasks.format")}
          className={`task-note-inline-toolbar floating-surface${image ? " task-note-image-toolbar" : ""}`}
          onBlur={
            image
              ? (event) => {
                  const { relatedTarget } = event.nativeEvent;
                  if (
                    relatedTarget !== editor.view.dom &&
                    !(
                      relatedTarget instanceof HTMLElement &&
                      event.currentTarget.contains(relatedTarget)
                    )
                  )
                    editor.commands.setMeta(toolbarKey, "hide");
                }
              : undefined
          }
        >
          {image && (
            <>
              <Button
                variant="ghost"
                size="xs"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => onPreviewImage(editor.state.selection.from)}
              >
                {t("tasks.image.view")}
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                disabled={!image.customSize}
                aria-label={t("tasks.image.resetSize")}
                title={t("tasks.image.resetSize")}
                onPointerDown={(event) => event.preventDefault()}
                onClick={() => {
                  const selection = selectedNoteImage(editor.state.selection);
                  if (selection)
                    setNoteImageAttribute(
                      editor.view,
                      selection.from,
                      "width",
                      null,
                    );
                }}
              >
                <RotateCcw aria-hidden="true" />
              </Button>
              <span className="note-format-separator" aria-hidden="true" />
              {noteAlignments.map((alignment) => {
                const Icon = alignmentIcons[alignment];
                const label = t(`tasks.format.align.${alignment}`);
                return (
                  <Toggle
                    key={alignment}
                    size="sm"
                    className="note-format-mark"
                    aria-label={label}
                    title={label}
                    pressed={image.alignment === alignment}
                    onPointerDown={(event) => event.preventDefault()}
                    onPressedChange={() => {
                      const selection = selectedNoteImage(
                        editor.state.selection,
                      );
                      if (selection)
                        setNoteImageAttribute(
                          editor.view,
                          selection.from,
                          "align",
                          alignment,
                        );
                    }}
                  >
                    <Icon aria-hidden="true" />
                  </Toggle>
                );
              })}
            </>
          )}
          {selected?.kind === "text" && (
            <>
              <DropdownMenu modal={false}>
                <MenuButton
                  icon={currentBlock.icon}
                  label={t("tasks.changeBlock")}
                />
                <DropdownMenuContent
                  {...menuProps}
                  className="note-format-menu w-48"
                >
                  <BlockChoices editor={editor} block={selected.block} />
                </DropdownMenuContent>
              </DropdownMenu>
              <span className="note-format-separator" aria-hidden="true" />
              <DropdownMenu modal={false}>
                <MenuButton
                  icon={alignmentIcons[selected.alignment] ?? AlignLeft}
                  label={t("tasks.format.alignment")}
                  disabled={!editor.can().setNoteAlignment("left")}
                />
                <DropdownMenuContent
                  {...menuProps}
                  className="note-format-menu w-40"
                >
                  <DropdownMenuRadioGroup value={selected.alignment}>
                    {noteAlignments.map((alignment) => {
                      const Icon = alignmentIcons[alignment];
                      return (
                        <DropdownMenuRadioItem
                          key={alignment}
                          value={alignment}
                          onSelect={() =>
                            formatNoteSelection(editor, (chain) =>
                              chain.setNoteAlignment(alignment),
                            )
                          }
                        >
                          <Icon aria-hidden="true" />
                          {t(`tasks.format.align.${alignment}`)}
                        </DropdownMenuRadioItem>
                      );
                    })}
                  </DropdownMenuRadioGroup>
                </DropdownMenuContent>
              </DropdownMenu>
              <span className="note-format-separator" aria-hidden="true" />
              {formats.map(({ mark, icon }) => markButton(mark, icon))}
              <NoteLinkMenu
                editor={editor}
                current={selected.link}
                container={container}
                onOutside={onOutside}
                onDismiss={focusEditor}
              />
              {markButton("code", Code)}
              <NoteColorMenu
                editor={editor}
                colors={selected.colors}
                last={lastColors}
                onChangeLast={setLastColors}
                container={container}
                onOutside={onOutside}
                onDismiss={focusEditor}
              />
              <span
                className="note-format-separator note-format-separator-end"
                aria-hidden="true"
              />
              <DropdownMenu modal={false}>
                <DropdownMenuTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label={t("tasks.format.more")}
                    title={t("tasks.format.more")}
                  >
                    <LayoutGrid aria-hidden="true" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent
                  {...menuProps}
                  align="end"
                  className="note-format-menu w-44"
                >
                  <DropdownMenuItem onSelect={() => searchText(false)}>
                    <Search aria-hidden="true" />
                    {t("tasks.findInNote")}
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => searchText(true)}>
                    <Globe aria-hidden="true" />
                    {t("tasks.format.webSearch")}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </>
          )}
        </BubbleMenu>
      )}
    </>
  );
}
