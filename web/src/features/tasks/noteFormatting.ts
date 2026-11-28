import {
  Extension,
  Mark,
  type ChainedCommands,
  type Editor,
} from "@tiptap/core";
import { isolateNoteEdit } from "./taskEditing";

export const noteTones = ["gray", "blue", "green", "yellow", "red", "purple"];
export const toneAttribute = {
  default: undefined,
  parseHTML: (el: HTMLElement) =>
    noteTones.includes(el.dataset.noteTone || "")
      ? el.dataset.noteTone
      : undefined,
  renderHTML: ({ tone }: { tone?: string }) =>
    tone && noteTones.includes(tone) ? { "data-note-tone": tone } : {},
};

export const noteAlignments = ["left", "center", "right"] as const;
export type NoteAlignment = (typeof noteAlignments)[number];

export function formatNoteSelection(
  editor: Editor,
  change: (chain: ChainedCommands) => ChainedCommands,
  focus = true,
) {
  if (
    editor.isDestroyed ||
    editor.view.composing ||
    editor.state.selection.empty
  )
    return false;
  const chain = editor.chain();
  if (focus) chain.focus(null, { scrollIntoView: false });
  return change(chain)
    .command(({ tr }) => {
      if (tr.docChanged) isolateNoteEdit(tr);
      return true;
    })
    .run();
}

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    noteAlignment: {
      setNoteAlignment: (alignment: NoteAlignment) => ReturnType;
    };
  }
}

const alignedBlocks = ["paragraph", "heading"];

export const NoteAlignment = Extension.create({
  name: "noteAlignment",
  addGlobalAttributes() {
    return [
      {
        types: alignedBlocks,
        attributes: {
          tone: toneAttribute,
          textAlign: {
            default: null,
            parseHTML: (element) => {
              const align =
                element.style.textAlign || element.getAttribute("align");
              return align === "center" || align === "right" ? align : null;
            },
            renderHTML: ({ textAlign }) =>
              textAlign === "center" || textAlign === "right"
                ? { style: `text-align: ${textAlign}` }
                : {},
          },
        },
      },
    ];
  },
  addCommands() {
    return {
      setNoteAlignment:
        (alignment) =>
        ({ tr, dispatch }) => {
          const align = alignment === "left" ? null : alignment;
          let applies = false;
          for (const { $from, $to } of tr.selection.ranges) {
            const { pos: from } = $from;
            const { pos: to } = $to;
            tr.doc.nodesBetween(from, to, (node, pos) => {
              if (!node.isTextblock) return;
              if (
                !alignedBlocks.includes(node.type.name) ||
                (from < to && pos + 1 === to)
              )
                return false;
              applies = true;
              if (dispatch && node.attrs.textAlign !== align)
                tr.setNodeMarkup(pos, undefined, {
                  ...node.attrs,
                  textAlign: align,
                });
              return false;
            });
          }
          if (dispatch && tr.docChanged) isolateNoteEdit(tr);
          return applies;
        },
    };
  },
});

export const noteTextColors = [
  "gray",
  "red",
  "orange",
  "yellow",
  "green",
  "blue",
  "purple",
] as const;
export const noteHighlights = [
  ...noteTextColors.map((color) => `light-${color}` as const),
  "medium-gray",
  ...noteTextColors,
] as const;

function paletteMark(
  name: string,
  attribute: string,
  palette: readonly string[],
) {
  return Mark.create({
    name,
    addAttributes: () => ({ color: { default: null, rendered: false } }),
    parseHTML: () => [
      {
        tag: `span[${attribute}]`,
        getAttrs: (element) => {
          const color = element.getAttribute(attribute);
          return color && palette.includes(color) ? { color } : false;
        },
      },
    ],
    renderHTML: ({ mark }) => [
      "span",
      palette.includes(mark.attrs.color)
        ? { [attribute]: mark.attrs.color }
        : {},
      0,
    ],
  });
}

export const NoteTextColor = paletteMark(
  "noteTextColor",
  "data-note-ink",
  noteTextColors,
);
export const NoteHighlight = paletteMark(
  "noteHighlight",
  "data-note-highlight",
  noteHighlights,
);
