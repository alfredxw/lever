import { Node } from "@tiptap/core";
import {
  NodeViewWrapper,
  ReactNodeViewRenderer,
  type NodeViewProps,
} from "@tiptap/react";
import { TextSelection } from "@tiptap/pm/state";
import { closeHistory } from "@tiptap/pm/history";
import { isLeverReference, referenceLabel, referenceText } from "./prompt";

import { InlineReference } from "./References";

function ReferenceView({ node }: NodeViewProps) {
  return (
    <NodeViewWrapper as="span" contentEditable={false} data-reference="true">
      <InlineReference reference={node.attrs.reference} />
    </NodeViewWrapper>
  );
}

export const ReferenceNode = Node.create({
  name: "reference",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  addAttributes() {
    return { reference: { default: null, rendered: false } };
  },
  parseHTML() {
    return [
      {
        tag: "span[data-lever-reference]",
        getAttrs: (element) => {
          try {
            const ref = JSON.parse(
              element.getAttribute("data-lever-reference")!,
            );
            if (
              typeof ref.name !== "string" ||
              !(
                (ref.kind === "file" && typeof ref.path === "string") ||
                (ref.kind === "browserElement" &&
                  typeof ref.element?.url === "string" &&
                  typeof ref.element?.selector === "string") ||
                (ref.kind === "skill" && typeof ref.provider === "string") ||
                isLeverReference(ref)
              )
            )
              return false;
            return { reference: ref };
          } catch {
            return false;
          }
        },
      },
    ];
  },
  renderHTML({ node }) {
    return [
      "span",
      { "data-lever-reference": JSON.stringify(node.attrs.reference) },
      referenceLabel(node.attrs.reference),
    ];
  },
  renderText({ node }) {
    return referenceText(node.attrs.reference);
  },
  addNodeView() {
    return ReactNodeViewRenderer(ReferenceView);
  },
  addKeyboardShortcuts() {
    const remove = (backward: boolean) => {
      const { selection } = this.editor.state;
      if (!(selection instanceof TextSelection) || !selection.empty)
        return false;
      const node = backward
        ? selection.$from.nodeBefore
        : selection.$from.nodeAfter;
      if (node?.type.name !== this.name) return false;
      const from = selection.from - (backward ? node.nodeSize : 0);
      this.editor.view.dispatch(
        closeHistory(this.editor.state.tr).delete(from, from + node.nodeSize),
      );
      return true;
    };
    return { Backspace: () => remove(true), Delete: () => remove(false) };
  },
});
