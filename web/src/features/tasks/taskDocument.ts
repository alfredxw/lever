import {
  Extension,
  getSchema,
  InputRule,
  Node,
  type Editor,
  type JSONContent,
} from "@tiptap/core";
import {
  Fragment,
  Slice,
  type Node as ProseMirrorNode,
} from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Mapping, ReplaceStep } from "@tiptap/pm/transform";
import { DecorationSet } from "@tiptap/pm/view";
import { TableKit } from "@tiptap/extension-table";
import { MarkdownManager } from "@tiptap/markdown";
import { ReactNodeViewRenderer } from "@tiptap/react";
import type { Agent, TaskExecution, TaskWorkflow } from "@/api/types.gen";
import {
  promptStarter,
  textPrompt,
} from "@/features/chat/prompt";
import { AgentMentionView } from "./AgentMentionView";
import {
  emptyTaskAttrs,
  hasTaskCheckbox,
  noteTableDepth,
  protectBlockInput,
  TaskNoteEditing,
} from "./taskEditing";

import { NoteCodeBlock } from "./NoteCodeBlock";
import {
  NoteFolding,
  changesNoteStructure,
  changesNoteHeadings,
} from "./noteFolding";
import { CalloutView, ColumnsView } from "./NoteLayoutBlocks";
import { NoteFind } from "./noteFind";
import { NoteLink, MarkdownImage } from "./noteMarkdown";
import { NoteWhiteboard } from "./NoteWhiteboard";
import { NoteAssetBlock, noteImage, type NoteAsset } from "./noteAsset";
import {
  NoteAlignment,
  NoteHighlight,
  NoteTextColor,
  toneAttribute,
} from "./noteFormatting";

const taskIdPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
type IssueSource = { id: string; repository: string };
type TaskMention = { pos: number; agentId: string; label: string };

export function agentMentionContent(
  agent: Pick<Agent, "id" | "name">,
): JSONContent[] {
  return [
    { type: "agentMention", attrs: { agentId: agent.id, label: agent.name } },
    { type: "text", text: " " },
  ];
}

export type TaskBlock = {
  pos: number;
  paragraph: ProseMirrorNode;
  listItem?: ProseMirrorNode;
  inTable: boolean;
  id?: string;
  checkbox: boolean;
  done: boolean;
  title: string;
  agentId?: string;
  mention?: TaskMention;
  headingAgentId?: string;
  issue?: IssueSource;
};

export type TaskStatus =
  | "todo"
  | "unconfirmed"
  | "queued"
  | "running"
  | "attention"
  | "review"
  | "done"
  | "closed";

export function taskStatus(
  block: { done: boolean },
  execution?: TaskExecution,
  workflow?: TaskWorkflow,
  proposed = false,
): TaskStatus {
  if (workflow?.closed) return "closed";
  if (workflow?.disposition === "todo") {
    if (workflow.queue) return "queued";
    return block.done ? "done" : "todo";
  }
  switch (execution?.status) {
    case "queued":
    case "starting":
    case "running":
    case "cancelling":
      return "running";
    case "waiting_user":
    case "unknown":
      return "attention";
  }
  if (block.done) return "done";
  if (execution)
    return execution.status === "completed" ? "review" : "attention";
  if (workflow?.queue) return "queued";
  return proposed && !workflow?.accepted ? "unconfirmed" : "todo";
}

function lastMention(
  node: ProseMirrorNode,
  pos: number,
): TaskMention | undefined {
  let at = pos + 1 + node.content.size;
  for (let index = node.childCount - 1; index >= 0; index--) {
    const child = node.child(index);
    at -= child.nodeSize;
    if (child.type.name === "agentMention")
      return {
        pos: at,
        agentId: child.attrs.agentId,
        label: child.attrs.label,
      };
  }
}

export function taskBlocks(
  doc: ProseMirrorNode,
  { includeListItems = false } = {},
): TaskBlock[] {
  const blocks: TaskBlock[] = [];
  const headings: { level: number; owner?: string }[] = [];
  doc.descendants((node, pos, parent, index) => {
    if (node.type.name === "heading" && parent === doc) {
      while (headings.length && headings.at(-1)!.level >= node.attrs.level)
        headings.pop();
      headings.push({
        level: node.attrs.level,
        owner: lastMention(node, pos)?.agentId ?? headings.at(-1)?.owner,
      });
      return false;
    }
    if (node.type.name !== "paragraph") return;
    const id = node.attrs.taskId || undefined;
    if (!id && !includeListItems) return false;
    const listItem =
      index === 0 && parent?.type.name === "listItem" ? parent : undefined;
    if (!id && !listItem) return false;
    const mention = lastMention(node, pos);
    const inTable =
      parent !== doc &&
      (parent?.type.spec.tableRole === "cell" ||
        parent?.type.spec.tableRole === "header_cell" ||
        noteTableDepth(doc.resolve(pos)) !== undefined);
    blocks.push({
      pos,
      paragraph: node,
      listItem,
      inTable,
      id,
      checkbox: hasTaskCheckbox(node),
      done: node.attrs.done,
      title: node
        .textBetween(0, node.content.size, " ", (child) =>
          child.type.name === "hardBreak" ? " " : "",
        )
        .replace(/\s+/g, " ")
        .trim(),
      headingAgentId: headings.at(-1)?.owner,
      agentId: mention?.agentId ?? headings.at(-1)?.owner,
      mention,
      issue: node.attrs.issue || undefined,
    });
    return false;
  });
  return blocks;
}

export function taskImages(block: TaskBlock) {
  const images: NoteAsset[] = [];
  block.listItem?.forEach((child) => {
    const image =
      child.type.name === "noteWhiteboard" && child.attrs.previewPath
        ? {
            path: child.attrs.previewPath,
            name: child.attrs.title + ".png",
            image: true,
          }
        : noteImage(child);
    if (image) images.push(image);
  });
  return images;
}

export function taskPrompt(block: TaskBlock) {
  let imageNumber = 0;
  function promptBlocks(node: JSONContent, direct = false): JSONContent[] {
    if (node.type === "agentMention") return [];
    if (node.type === "paragraph" && node.attrs?.taskId)
      node = { ...node, attrs: { ...node.attrs, taskId: undefined } };
    if (node.type === "noteWhiteboard")
      return textPrompt(
        direct && node.attrs?.previewPath
          ? `[Image ${++imageNumber}: ${node.attrs.title || "Whiteboard"}]`
          : `[Whiteboard: ${node.attrs?.title || ""}]`,
      ).content!;
    if (node.type === "noteAsset" && node.attrs?.image === true) {
      // The runtime receives image attachments in this same order.
      return direct
        ? textPrompt(`[Image ${++imageNumber}: ${node.attrs.name}]`).content!
        : [];
    }
    return [
      node.content
        ? {
            ...node,
            content: node.content.flatMap((child) => promptBlocks(child)),
          }
        : node,
    ];
  }
  const body = block.listItem?.toJSON().content ?? [block.paragraph.toJSON()];
  return markdown
    .serialize({
      type: "doc",
      content: (body as JSONContent[]).flatMap((node) =>
        promptBlocks(node, true),
      ),
    })
    .trim();
}

// Describe a document change using ProseMirror positions, including marks and
// block attributes. The common prefix and suffix can overlap in repeated text.
export function taskDocumentChange(
  before: ProseMirrorNode,
  after: ProseMirrorNode,
) {
  if (before.content === after.content) return;
  const from = before.content.findDiffStart(after.content);
  if (from === null) return;
  const end = before.content.findDiffEnd(after.content)!;
  const overlap = Math.max(0, from - Math.min(end.a, end.b));
  return new ReplaceStep(
    from,
    end.a + overlap,
    after.slice(from, end.b + overlap),
  );
}

export function mergeTaskDocuments(
  base: ProseMirrorNode,
  local: ProseMirrorNode,
  latest: ProseMirrorNode,
) {
  if (local.eq(latest)) return latest;
  const edit = taskDocumentChange(base, local);
  if (!edit) return latest;
  const external = taskDocumentChange(base, latest);
  if (!external) return local;
  // Only replay changes with disjoint ranges and distinct start positions.
  if (edit.from === external.from) return null;
  if (edit.to <= external.from) return edit.apply(latest).doc;
  if (external.to <= edit.from) {
    const mapped = edit.map(external.getMap());
    return mapped?.apply(latest).doc ?? null;
  }
  return null;
}

export const taskWidgets = new PluginKey<DecorationSet>("task-widgets");

type TaskIndex = { blocks: TaskBlock[]; revision: object; structure: object };
export const noteTaskIndex = new PluginKey<TaskIndex>("note-task-index");
function indexTasks(doc: ProseMirrorNode): TaskIndex {
  return {
    blocks: taskBlocks(doc, { includeListItems: true }),
    revision: {},
    structure: {},
  };
}

const indexedTasks = new Plugin<TaskIndex>({
  key: noteTaskIndex,
  state: {
    init: (_, state) => indexTasks(state.doc),
    apply(tr, index) {
      if (!tr.docChanged) return index;
      if (changesNoteHeadings(tr)) return indexTasks(tr.doc);
      let changed = false;
      const blocks = index.blocks.map((block) => {
        const pos = tr.mapping.map(block.pos);
        const $pos = tr.doc.resolve(pos);
        const paragraph = $pos.nodeAfter!;
        const listItem = block.listItem ? $pos.parent : undefined;
        if (
          paragraph === block.paragraph &&
          listItem === block.listItem &&
          pos === block.pos
        )
          return block;
        const mention =
          paragraph === block.paragraph
            ? block.mention && {
                ...block.mention,
                pos: pos + (block.mention.pos - block.pos),
              }
            : lastMention(paragraph, pos);
        changed ||=
          paragraph !== block.paragraph || listItem !== block.listItem;
        return {
          ...block,
          pos,
          paragraph,
          listItem,
          mention,
          agentId: mention?.agentId ?? block.headingAgentId,
          title:
            paragraph === block.paragraph
              ? block.title
              : paragraph
                  .textBetween(0, paragraph.content.size, " ", (child) =>
                    child.type.name === "hardBreak" ? " " : "",
                  )
                  .replace(/\s+/g, " ")
                  .trim(),
        };
      });
      return {
        blocks,
        revision: changed ? {} : index.revision,
        structure: index.structure,
      };
    },
  },
});

const AgentMention = Node.create({
  name: "agentMention",
  group: "inline",
  inline: true,
  atom: true,
  addAttributes() {
    return {
      agentId: { default: "", rendered: false },
      label: { default: "", rendered: false },
    };
  },
  parseHTML() {
    return [
      {
        tag: "span[data-agent-mention]",
        getAttrs: (element) => {
          const agentId = element.getAttribute("data-agent-mention");
          const label =
            element.getAttribute("data-agent-label") ??
            element.textContent?.slice(1);
          return agentId && taskIdPattern.test(agentId) && label
            ? { agentId, label }
            : false;
        },
      },
    ];
  },
  renderHTML({ node }) {
    return [
      "span",
      { "data-agent-mention": node.attrs.agentId },
      "@" + node.attrs.label,
    ];
  },
  renderText({ node }) {
    return "@" + node.attrs.label;
  },
  renderMarkdown(node) {
    return "@" + node.attrs?.label;
  },
  addNodeView() {
    return ReactNodeViewRenderer(AgentMentionView, {
      // This view also depends on the task decoration when the text is unchanged.
      update: ({
        oldNode,
        newNode,
        oldDecorations,
        newDecorations,
        updateProps,
      }) => {
        if (
          oldNode !== newNode ||
          oldDecorations[0]?.spec.key !== newDecorations[0]?.spec.key
        )
          updateProps();
        return true;
      },
      stopEvent: ({ event }) =>
        event.target instanceof Element &&
        !!event.target.closest("button.task-agent-mention"),
    });
  },
});

const TaskMarkers = Extension.create<{ noteId: string }>({
  name: "taskMarkers",
  addOptions: () => ({ noteId: "" }),
  addGlobalAttributes() {
    const noteId = this.options.noteId;
    const sameNote = (element: HTMLElement) =>
      element.getAttribute("data-task-note") === noteId;
    return [
      {
        types: ["paragraph"],
        attributes: {
          taskId: {
            default: null,
            keepOnSplit: false,
            parseHTML: (element) => {
              const id = element.getAttribute("data-task-id");
              if (!id || !taskIdPattern.test(id)) return null;
              if (sameNote(element)) return id;
              return element.getAttribute("data-task-checkbox") === "false"
                ? null
                : crypto.randomUUID();
            },
            renderHTML: ({ taskId, taskCheckbox }) =>
              taskId
                ? {
                    "data-task-id": taskId,
                    "data-task-note": noteId,
                    "data-task-checkbox": String(taskCheckbox !== false),
                    class: "task-line task-line-marked",
                  }
                : {},
          },
          taskCheckbox: {
            // Only tracking without a checkbox needs an attribute in the file.
            default: undefined,
            keepOnSplit: false,
            rendered: false,
            parseHTML: (element) =>
              sameNote(element) &&
              element.getAttribute("data-task-checkbox") === "false"
                ? false
                : undefined,
          },
          done: {
            default: false,
            keepOnSplit: false,
            parseHTML: (element) =>
              sameNote(element) &&
              taskIdPattern.test(element.getAttribute("data-task-id") ?? "") &&
              element.hasAttribute("data-task-done"),
            renderHTML: ({ done }) => (done ? { "data-task-done": "" } : {}),
          },
          issue: {
            default: null,
            keepOnSplit: false,
            parseHTML: (element) => {
              const id = element.getAttribute("data-issue-id");
              const repository = element.getAttribute("data-issue-repository");
              return id && repository ? { id, repository } : null;
            },
            renderHTML: ({ issue }) =>
              issue
                ? {
                    "data-issue-id": issue.id,
                    "data-issue-repository": issue.repository,
                  }
                : {},
          },
        },
      },
    ];
  },
  addInputRules() {
    return [
      new InputRule({
        find: /^(?:\[([ xX]?)\]|【】)\s$/,
        handler: ({ state, range, match }) => {
          const { $from } = state.selection;
          const paragraph = $from.parent;
          if (paragraph.type.name !== "paragraph" || paragraph.attrs.taskId)
            return null;
          state.tr
            .delete(range.from, range.to)
            .setNodeMarkup($from.before(), undefined, {
              ...paragraph.attrs,
              taskId: crypto.randomUUID(),
              done: match[1]?.toLowerCase() === "x",
            });
        },
      }),
    ];
  },
  addProseMirrorPlugins() {
    return [
      indexedTasks,
      new Plugin({
        key: taskWidgets,
        state: {
          init: () => DecorationSet.empty,
          apply: (tr, decorations) =>
            tr.getMeta(taskWidgets) ?? decorations.map(tr.mapping, tr.doc),
        },
        props: {
          decorations: (state) => taskWidgets.getState(state),
          transformPasted: (slice, view) => {
            const ids = new Set(
              taskBlocks(view.state.doc).map((block) => block.id),
            );
            function copy(fragment: Fragment): Fragment {
              const nodes: ProseMirrorNode[] = [];
              fragment.forEach((node) => {
                const content = node.content.size
                  ? copy(node.content)
                  : node.content;
                if (node.attrs.taskId && ids.has(node.attrs.taskId)) {
                  nodes.push(
                    node.type.create(
                      {
                        ...node.attrs,
                        ...(hasTaskCheckbox(node)
                          ? { done: false, taskId: crypto.randomUUID() }
                          : emptyTaskAttrs),
                      },
                      content,
                      node.marks,
                    ),
                  );
                } else nodes.push(node.copy(content));
              });
              return Fragment.fromArray(nodes);
            }
            return new Slice(
              copy(slice.content),
              slice.openStart,
              slice.openEnd,
            );
          },
        },
        appendTransaction: (transactions, previous, state) => {
          // An edit inside one textblock cannot create a second task marker.
          if (!transactions.some(changesNoteStructure)) return null;
          const byId = new Map<string, TaskBlock[]>();
          for (const block of taskBlocks(state.doc)) {
            if (!block.id) continue;
            const matches = byId.get(block.id);
            if (matches) matches.push(block);
            else byId.set(block.id, [block]);
          }
          const duplicate = [...byId.values()].filter(
            (blocks) => blocks.length > 1,
          );
          if (!duplicate.length) return null;
          const mapping = new Mapping();
          for (const tr of transactions) mapping.appendMapping(tr.mapping);
          const originals = new Map(
            taskBlocks(previous.doc).map((block) => [block.id, block]),
          );
          const tr = state.tr;
          for (const blocks of duplicate) {
            // A split at the start keeps the task on the paragraph with its text.
            const original = originals.get(blocks[0].id);
            const anchor = original && mapping.map(original.pos + 1);
            const keep =
              blocks.find(
                (block) =>
                  block.title &&
                  anchor !== undefined &&
                  anchor > block.pos &&
                  anchor < block.pos + block.paragraph.nodeSize,
              ) ??
              blocks.find((block) => block.title) ??
              blocks[0];
            for (const block of blocks) {
              if (block !== keep)
                tr.setNodeMarkup(block.pos, undefined, {
                  ...block.paragraph.attrs,
                  ...emptyTaskAttrs,
                });
            }
          }
          return tr;
        },
      }),
    ];
  },
});

const noteStarter = promptStarter
  .configure({ link: { openOnClick: true }, underline: {} })
  .extend({
    addExtensions() {
      return (this.parent?.() ?? []).map((extension) => {
        if (extension.name === "heading" || extension.name === "horizontalRule")
          return extension.extend(protectBlockInput);
        if (extension.name === "paragraph")
          return extension.extend({
            renderMarkdown(node, helpers, context) {
              const text = this.parent?.(node, helpers, context) ?? "";
              if (!node.attrs?.taskId || node.attrs.taskCheckbox === false)
                return text;
              const bullet = context.parentType === "listItem" ? "" : "- ";
              return bullet + (node.attrs.done ? "[x] " : "[ ] ") + text;
            },
          });
        if (extension.name === "link")
          return extension.extend({
            parseMarkdown(token, helpers) {
              // Tiptap applies link marks to text only. A board's Markdown link
              // wraps an image and must retain the destination of that link.
              if (
                token.tokens?.length === 1 &&
                token.tokens[0].type === "image"
              ) {
                const [image] = helpers.parseInline(token.tokens);
                if (image)
                  return {
                    ...image,
                    marks: [
                      {
                        type: "link",
                        attrs: { href: token.href, title: token.title },
                      },
                    ],
                  };
              }
              return this.parent?.(token, helpers) ?? [];
            },
          });
        if (extension.name !== "listItem") return extension;
        return extension.extend({
          parseMarkdown(token, helpers) {
            // Marked emits a separate checkbox token before the item's text.
            // The regular list parser handles the text and nested blocks.
            const parsed = this.parent?.(
              token.task
                ? {
                    ...token,
                    tokens: token.tokens?.filter(
                      (child) => child.type !== "checkbox",
                    ),
                  }
                : token,
              helpers,
            );
            if (!parsed || Array.isArray(parsed) || !token.task)
              return parsed ?? [];
            const paragraph = parsed.content?.[0];
            if (paragraph?.type === "paragraph") {
              paragraph.attrs = {
                taskId: crypto.randomUUID(),
                done: !!token.checked,
              };
            }
            return parsed;
          },
        });
      });
    },
  });
const Callout = Node.create({
  name: "callout",
  group: "block",
  content: "block+",
  defining: true,
  parseHTML: () => [{ tag: "aside[data-note-callout]" }],
  addAttributes: () => ({
    tone: toneAttribute,
    emoji: {
      default: "",
      parseHTML: (el) => el.dataset.emoji || "",
      renderHTML: (attrs) => (attrs.emoji ? { "data-emoji": attrs.emoji } : {}),
    },
  }),
  addNodeView: () => ReactNodeViewRenderer(CalloutView),
  renderHTML: ({ HTMLAttributes }) => [
    "aside",
    { "data-note-callout": "", ...HTMLAttributes },
    0,
  ],
  renderMarkdown: (node, helpers) =>
    helpers
      .renderChildren(node.content ?? [])
      .split("\n")
      .map((line) => "> " + line)
      .join("\n"),
});

const Columns = Node.create({
  name: "columns",
  group: "block",
  content: "noteColumn{2,5}",
  addAttributes: () => ({
    ratios: {
      default: null,
      parseHTML: (el) => el.dataset.ratios?.split(",").map(Number) ?? null,
      renderHTML: (attrs) =>
        Array.isArray(attrs.ratios)
          ? { "data-ratios": attrs.ratios.join(",") }
          : {},
    },
  }),
  addNodeView: () => ReactNodeViewRenderer(ColumnsView),
  isolating: true,
  parseHTML: () => [{ tag: "div[data-note-columns]" }],
  renderHTML: ({ HTMLAttributes }) => [
    "div",
    { "data-note-columns": "", ...HTMLAttributes },
    0,
  ],
  renderMarkdown: (node, helpers) =>
    helpers.renderChildren(node.content ?? [], "\n\n"),
});

const NoteColumn = Node.create({
  name: "noteColumn",
  content: "block+",
  isolating: true,
  parseHTML: () => [{ tag: "div[data-note-column]" }],
  renderHTML: () => ["div", { "data-note-column": "" }, 0],
  renderMarkdown: (node, helpers) =>
    helpers.renderChildren(node.content ?? [], "\n\n"),
});

export const noteCellFills = ["gray", "green", "yellow", "blue"] as const;
const NoteCellFill = Extension.create({
  name: "noteCellFill",
  addGlobalAttributes() {
    return [
      {
        types: ["tableCell", "tableHeader"],
        attributes: {
          verticalAlign: {
            default: undefined,
            parseHTML: (el) => el.dataset.verticalAlign,
            renderHTML: (attrs) =>
              ["middle", "bottom"].includes(attrs.verticalAlign)
                ? { "data-vertical-align": attrs.verticalAlign }
                : {},
          },
          fill: {
            default: null,
            parseHTML: (element) => element.getAttribute("data-note-cell-fill"),
            renderHTML: ({ fill }) =>
              noteCellFills.includes(fill)
                ? { "data-note-cell-fill": fill }
                : {},
          },
        },
      },
    ];
  },
});

export const taskNoteExtensions = (noteId = "") => [
  noteStarter,
  NoteCodeBlock.configure({ noteId }),
  AgentMention,
  NoteLink,
  NoteFind,
  NoteFolding,
  MarkdownImage,
  TaskMarkers.configure({ noteId }),
  TaskNoteEditing,
  NoteAlignment,
  NoteTextColor,
  NoteHighlight,
  Callout,
  Columns,
  NoteColumn,
  NoteAssetBlock,
  NoteWhiteboard.configure({ noteId }),
  NoteCellFill,
  TableKit.configure({
    table: {
      resizable: true,
      renderWrapper: true,
      allowTableNodeSelection: true,
    },
  }),
];
const markdown = new MarkdownManager({ extensions: taskNoteExtensions() });
export const taskNoteSchema = getSchema(taskNoteExtensions());
export function parseNoteFile(source: string): JSONContent {
  if (!source.trim()) return textPrompt(source);
  const parsed = markdown.parse(source);
  function restore(node: JSONContent): JSONContent {
    const link = node.marks?.find((mark) => mark.type === "link")?.attrs?.href;
    if (
      node.type === "text" &&
      typeof link === "string" &&
      link.startsWith("lever-note:") &&
      taskIdPattern.test(link.slice(11))
    )
      return {
        type: "noteLink",
        attrs: { id: link.slice(11), label: node.text?.replace(/^@/, "") },
      };
    if (!node.content) return node;
    const content = node.content.map(restore);
    const only = content.length === 1 ? content[0] : undefined;
    if (node.type === "paragraph" && only) {
      const href = only.marks?.find((mark) => mark.type === "link")?.attrs
        ?.href;
      const image = only.type === "markdownImage";
      const asset = image ? only.attrs?.src : href;
      if (typeof asset === "string" && /^\.assets\/[a-f0-9]{64}$/.test(asset)) {
        if (
          image &&
          typeof href === "string" &&
          /^\.assets\/[a-f0-9]{64}$/.test(href)
        )
          return {
            type: "noteWhiteboard",
            attrs: {
              title: only.attrs?.alt,
              scenePath: href,
              previewPath: asset,
            },
          };
        if (!image && only.text?.endsWith(".drawnix"))
          return {
            type: "noteWhiteboard",
            attrs: { title: only.text.slice(0, -7), scenePath: asset },
          };
        return {
          type: "noteAsset",
          attrs: {
            path: asset,
            name: image ? only.attrs?.alt : only.text,
            image,
            ...(image && only.attrs?.title
              ? { caption: only.attrs.title }
              : {}),
          },
        };
      }
    }
    return { ...node, content };
  }
  const result = restore(parsed);
  taskNoteSchema.nodeFromJSON(result).check();
  return result;
}

export function serializeNoteMarkdown(doc: JSONContent) {
  return markdown.serialize(doc) + "\n";
}

export function parseTaskMarkdown(text: string): JSONContent {
  try {
    let unsupported = false;
    markdown.instance.walkTokens(markdown.instance.lexer(text), (token) => {
      if (["image", "html"].includes(token.type)) unsupported = true;
    });
    if (!unsupported) {
      const parsed = markdown.parse(text);
      taskNoteSchema.nodeFromJSON(parsed).check();
      return parsed;
    }
  } catch {
    // Keep unsupported Markdown editable as text.
  }
  return textPrompt(text);
}

export function setTaskMarker(
  editor: Editor,
  block: TaskBlock,
  done: boolean,
  addToHistory = true,
) {
  const id = block.id ?? crypto.randomUUID();
  editor.view.dispatch(
    editor.state.tr
      .setNodeMarkup(block.pos, undefined, {
        ...block.paragraph.attrs,
        taskId: id,
        taskCheckbox: block.checkbox ? undefined : false,
        done,
      })
      .setMeta("addToHistory", addToHistory),
  );
  return id;
}
