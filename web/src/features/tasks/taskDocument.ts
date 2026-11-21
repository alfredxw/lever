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
import { Plugin, PluginKey, type Transaction } from "@tiptap/pm/state";
import { Mapping, ReplaceStep } from "@tiptap/pm/transform";
import { DecorationSet } from "@tiptap/pm/view";
import { TableKit } from "@tiptap/extension-table";
import { MarkdownManager } from "@tiptap/markdown";
import { ReactNodeViewRenderer } from "@tiptap/react";
import type { Agent, TaskExecution, TaskWorkflow } from "@/api/types.gen";
import {
  promptCodeBlock,
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

import { NoteAssetBlock, noteImage, type NoteAsset } from "./noteAsset";
import { NoteAlignment, NoteHighlight, NoteTextColor } from "./noteFormatting";

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
    const image = noteImage(child);
    if (image) images.push(image);
  });
  return images;
}

export function taskPrompt(block: TaskBlock) {
  let imageNumber = 0;
  function promptBlocks(node: JSONContent, direct = false): JSONContent[] {
    if (node.type === "agentMention") return [];
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

function changesTaskStructure(tr: Transaction) {
  return tr.steps.some((step, index) => {
    if (!(step instanceof ReplaceStep)) return true;
    const { slice } = step;
    if (
      slice.openStart ||
      slice.openEnd ||
      (slice.size && !slice.content.firstChild?.isInline)
    )
      return true;
    const doc = tr.docs[index];
    const from = doc.resolve(step.from);
    return !from.parent.isTextblock || !from.sameParent(doc.resolve(step.to));
  });
}

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
          if (!transactions.some(changesTaskStructure)) return null;
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
  renderHTML: () => ["aside", { "data-note-callout": "" }, 0],
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
  content: "noteColumn noteColumn",
  isolating: true,
  parseHTML: () => [{ tag: "div[data-note-columns]" }],
  renderHTML: () => ["div", { "data-note-columns": "" }, 0],
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
  promptCodeBlock.extend(protectBlockInput),
  AgentMention,
  TaskMarkers.configure({ noteId }),
  TaskNoteEditing,
  NoteAlignment,
  NoteTextColor,
  NoteHighlight,
  Callout,
  Columns,
  NoteColumn,
  NoteAssetBlock,
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
