import type { Editor } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { useLayoutEffect, useRef, useState } from "react";
import {
  Decoration,
  DecorationSet,
  type DecorationAttrs,
} from "@tiptap/pm/view";
import type { TFunction } from "i18next";
import { buttonVariants } from "@/components/ui/button";
import type { AgentMentionAction } from "./AgentMentionView";
import {
  noteTaskIndex,
  taskWidgets,
  type TaskBlock,
  type TaskStatus,
} from "./taskDocument";
import { noteTableDepth } from "./taskEditing";

export type TaskLine = TaskBlock & {
  status: TaskStatus;
  owner?: string;
  executionAgentId?: string;
  oneClickAgentId?: string;
  sending: boolean;
  linked: boolean;
  busy: boolean;
};
type Action = "open" | "check";

function sameLineControls(a: TaskLine, b: TaskLine) {
  return (
    a.paragraph === b.paragraph &&
    a.listItem === b.listItem &&
    a.status === b.status &&
    a.owner === b.owner &&
    a.executionAgentId === b.executionAgentId &&
    a.oneClickAgentId === b.oneClickAgentId &&
    a.linked === b.linked &&
    a.busy === b.busy &&
    a.sending === b.sending
  );
}

function decorateBlock(from: number, to: number, attrs: DecorationAttrs) {
  return Decoration.node(from, to, attrs, { key: JSON.stringify(attrs) });
}

function sameDecorations(current: DecorationSet, next: DecorationSet) {
  if (current === next) return true;
  const before = current.find();
  const after = next.find();
  return (
    before.length === after.length &&
    before.every((decoration, index) => {
      const other = after[index];
      return (
        decoration.from === other.from &&
        decoration.to === other.to &&
        decoration.spec.key === other.spec.key
      );
    })
  );
}

export function useTaskControls({
  editor,
  doc,
  lines,
  active,
  loadingHandover,
  assignment,
  detail,
  inlineDetail,
  onAction,
  t,
}: {
  editor: Editor | null;
  doc?: ProseMirrorNode;
  lines: TaskLine[];
  active: number | undefined;
  loadingHandover: boolean;
  assignment?: number;
  detail?: string;
  inlineDetail?: string;
  onAction: (action: Action, pos: number, trigger: HTMLButtonElement) => void;
  t: TFunction;
}) {
  const callback = useRef(onAction);
  callback.current = onAction;
  const [detailSlot, setDetailSlot] = useState<HTMLElement | null>(null);
  const [agentSlots, setAgentSlots] = useState(
    () => new Map<string, HTMLElement>(),
  );
  const last = useRef<{
    doc: ProseMirrorNode;
    structure: object;
    lines: TaskLine[];
    active?: number;
    loading: boolean;
    t: TFunction;
  }>(undefined);
  useLayoutEffect(() => {
    if (
      !editor ||
      editor.isDestroyed ||
      editor.view.composing ||
      !doc ||
      editor.state.doc !== doc
    )
      return;
    const current = taskWidgets.getState(editor.state) ?? DecorationSet.empty;
    const decorations: Decoration[] = [],
      remove: Decoration[] = [];
    const paragraph = active !== undefined ? doc.nodeAt(active) : null;
    const showPlaceholder =
      active !== undefined &&
      doc.childCount > 1 &&
      paragraph?.type.name === "paragraph" &&
      !paragraph.content.size &&
      !paragraph.attrs.taskId &&
      noteTableDepth(doc.resolve(active)) === undefined;
    // Ordinary text edits preserve the order of task lines. ProseMirror has
    // already mapped their widgets, so only replace controls on changed lines.
    const structure = noteTaskIndex.getState(editor.state)?.structure;
    const previous = last.current;
    const track =
      structure &&
      !showPlaceholder &&
      assignment === undefined &&
      !detail &&
      !inlineDetail;
    const incremental =
      track &&
      previous &&
      previous.doc !== doc &&
      previous.structure === structure &&
      previous.active === active &&
      previous.loading === loadingHandover &&
      previous.t === t;
    last.current = track
      ? { doc, structure, lines, active, loading: loadingHandover, t }
      : undefined;
    const nextAgentSlots = incremental
      ? new Map(agentSlots)
      : new Map<string, HTMLElement>();
    if (showPlaceholder) {
      decorations.push(
        decorateBlock(active, active + paragraph.nodeSize, {
          "data-note-empty-label": t("tasks.placeholder"),
        }),
      );
    }
    for (const [index, line] of lines.entries()) {
      if (incremental) {
        if (sameLineControls(line, previous.lines[index])) continue;
        const end = line.pos + line.paragraph.nodeSize;
        remove.push(
          ...current
            .find(line.pos, end)
            .filter((widget) => widget.from >= line.pos && widget.to <= end),
        );
        if (line.id) nextAgentSlots.delete(line.id);
      }
      if (!line.id && !line.title) continue;
      const { pos, paragraph, id, status, owner, linked, title, inTable } =
        line;
      const showStatus = linked || status === "done";
      const label = showStatus
        ? t("tasks.status." + status)
        : t("tasks.assign");
      const end = pos + paragraph.nodeSize;
      const expanded = pos === assignment || !!(id && id === detail);
      // Task classes and completion already come from the paragraph's attrs.
      // A node decoration for every task makes ProseMirror scan all task ranges
      // for every paragraph, including each IME candidate update.
      if (expanded || (!id && pos === active))
        decorations.push(
          decorateBlock(pos, end, {
            ...(!id && { class: "task-line" }),
            ...(expanded && { "data-task-expanded": "" }),
          }),
        );
      function actionWidget(
        action: Action,
        className: string,
        name: string,
        key: string,
        configure: (button: HTMLButtonElement) => void,
      ) {
        return Decoration.widget(
          pos + 1,
          (_view, getPos) => {
            const button = document.createElement("button");
            button.type = "button";
            button.className = buttonVariants({
              size: inTable ? "icon-xs" : "xs",
              variant: "ghost",
              className,
            });
            button.setAttribute("aria-label", name);
            button.addEventListener("mousedown", (event) =>
              event.preventDefault(),
            );
            button.addEventListener("click", () => {
              const at = getPos();
              if (at !== undefined) callback.current(action, at - 1, button);
            });
            configure(button);
            return button;
          },
          {
            side: action === "check" ? -2 : -1,
            stopEvent: () => true,
            key,
          },
        );
      }
      if (line.checkbox) {
        // The checkbox does not depend on whether the task is ready to hand off.
        const name = t(line.done ? "tasks.reopen" : "tasks.complete");
        decorations.push(
          actionWidget(
            "check",
            "task-line-check",
            name,
            JSON.stringify(["check", id, name, line.done, line.busy, inTable]),
            (button) => {
              button.setAttribute("role", "checkbox");
              button.setAttribute("aria-checked", String(line.done));
              button.disabled = line.busy;
            },
          ),
        );
      }
      if (
        id &&
        line.checkbox &&
        !showStatus &&
        !line.sending &&
        !line.mention &&
        title &&
        pos !== assignment
      ) {
        // Keep the picker mounted as the document maps its widget to a new position.
        let slot = agentSlots.get(id);
        if (!slot) {
          slot = document.createElement("span");
          slot.className = "task-agent-picker-slot";
        }
        nextAgentSlots.set(id, slot);
        decorations.push(
          Decoration.widget(end - 1, slot, {
            side: 1,
            key: "agent-picker:" + id,
            stopEvent: () => true,
            ignoreSelection: true,
          }),
        );
      }
      if ((title || linked) && (line.listItem || line.checkbox || showStatus)) {
        const disabled = !showStatus && (loadingHandover || line.sending);
        const opensDialog = !showStatus && !line.oneClickAgentId;
        const mention = line.mention;
        if (mention && (!linked || mention.agentId === line.executionAgentId)) {
          const agentAction: AgentMentionAction = {
            caption: label + " · " + (owner ?? mention.label),
            expanded: showStatus || opensDialog ? expanded : undefined,
            disabled,
            status: showStatus ? { value: status, label } : undefined,
            open: (pos, trigger) => callback.current("open", pos, trigger),
          };
          decorations.push(
            Decoration.node(
              mention.pos,
              mention.pos + 1,
              {},
              {
                key: JSON.stringify([
                  "agent",
                  agentAction.caption,
                  status,
                  showStatus,
                  agentAction.expanded,
                  disabled,
                ]),
                agentAction,
              },
            ),
          );
        }
        const caption = showStatus
          ? t("tasks.itemStatus", { status: label, title, defaultValue: label })
          : t("tasks.handoverItem", { title });
        const actionLabel = showStatus
          ? label
          : t(line.sending ? "tasks.dispatching" : "tasks.handover");
        decorations.push(
          actionWidget(
            "open",
            "task-line-status",
            caption,
            JSON.stringify([
              "open",
              caption,
              actionLabel,
              status,
              owner,
              inTable,
              disabled,
              opensDialog,
            ]),
            (button) => {
              button.textContent = inTable ? "↗" : actionLabel;
              button.title = owner ? `${caption} · ${owner}` : caption;
              button.dataset.status = status;
              button.disabled = disabled;
              if (opensDialog) button.setAttribute("aria-haspopup", "dialog");
            },
          ),
        );
      }
      if (id && id === inlineDetail) {
        const afterText = line.listItem
          ? pos + line.listItem.nodeSize - 2
          : end;
        decorations.push(
          Decoration.widget(
            afterText,
            () => {
              const element = document.createElement("div");
              element.dataset.taskSlot = "detail";
              element.className = "task-inline-slot";
              element.contentEditable = "false";
              return element;
            },
            {
              side: -1,
              key: "detail:" + id,
              stopEvent: () => true,
            },
          ),
        );
      }
    }
    const next = incremental
      ? current.remove(remove).add(doc, decorations)
      : DecorationSet.create(doc, decorations);
    if (
      incremental
        ? remove.length || decorations.length
        : !sameDecorations(current, next)
    )
      editor.view.dispatch(
        editor.state.tr
          .setMeta(taskWidgets, next)
          .setMeta("addToHistory", false),
      );
    if (
      nextAgentSlots.size !== agentSlots.size ||
      [...nextAgentSlots.keys()].some((id) => !agentSlots.has(id))
    )
      setAgentSlots(nextAgentSlots);
    setDetailSlot(
      inlineDetail
        ? editor.view.dom.querySelector('[data-task-slot="detail"]')
        : null,
    );
  }, [
    editor,
    doc,
    lines,
    active,
    loadingHandover,
    assignment,
    agentSlots,
    detail,
    inlineDetail,
    t,
  ]);
  return { detailSlot, agentSlots };
}
