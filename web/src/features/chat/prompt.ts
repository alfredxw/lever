import type { JSONContent } from "@tiptap/core";
import { MarkdownManager } from "@tiptap/markdown";
import StarterKit from "@tiptap/starter-kit";
import CodeBlock from "@tiptap/extension-code-block";
import type { Reference } from "@/api/types.gen";

export const promptStarter = StarterKit.configure({
  link: { openOnClick: false },
  codeBlock: false,
  underline: false,
  trailingNode: false,
});

export const promptCodeBlock = CodeBlock.extend({
  renderMarkdown(node, helpers) {
    const code = helpers.renderChildren(node.content ?? []);
    // A pasted Markdown example may itself contain triple backticks.
    const fence = "`".repeat(
      (code.match(/`+/g) ?? []).reduce(
        (length, run) => Math.max(length, run.length + 1),
        3,
      ),
    );
    return `${fence}${node.attrs?.language ?? ""}\n${code}\n${fence}`;
  },
});

export const promptExtensions = [
  promptStarter.extend({
    addExtensions() {
      return (this.parent?.() ?? []).map((extension) => {
        if (extension.name !== "paragraph") return extension;
        return extension.extend({
          renderMarkdown(node, helpers, context) {
            return (this.parent?.(node, helpers, context) ?? "").replace(
              /^[ \t](?=[ \t]*\S)/gm,
              (indent) => (indent === "\t" ? "&#9;" : "&#32;"),
            );
          },
        });
      });
    },
  }),
  promptCodeBlock.extend({
    parseMarkdown(token, helpers) {
      if (token.codeBlockStyle !== "indented")
        return this.parent?.(token, helpers) ?? [];
      const source = (token.raw ?? "").replace(/\n+$/, "");
      return source.split("\n\n").map((text) => ({
        type: "paragraph",
        ...(text ? { content: [{ type: "text", text }] } : {}),
      }));
    },
  }),
];

const markdown = new MarkdownManager({ extensions: promptExtensions });

export function markdownPrompt(text: string): JSONContent {
  // Unsupported constructs must stay editable source, never disappear on paste.
  let unsupported = false;
  markdown.instance.walkTokens(markdown.instance.lexer(text), (token) => {
    if (
      ["table", "image", "html"].includes(token.type) ||
      (token.type === "list_item" && token.task)
    )
      unsupported = true;
  });
  if (unsupported) return textPrompt(text);
  const doc = markdown.parse(text);
  return doc.content?.length ? doc : textPrompt("");
}

type PromptMarkdownNode = {
  type: string;
  value?: string;
  children?: PromptMarkdownNode[];
};

export function preservePromptWhitespace() {
  function visit(node: PromptMarkdownNode, inParagraph = false) {
    const preserve = inParagraph || node.type === "paragraph";
    if (!preserve) {
      node.children?.forEach((child) => visit(child));
      return;
    }
    if (!node.children) return;
    node.children = node.children.flatMap((child) => {
      if (child.type === "break") return [{ type: "text", value: "\n" }];
      if (child.type === "text" && child.value && /\n[ \t]/.test(child.value))
        return child.value
          .split(/(?<=\n)(?=[ \t])/)
          .map((value) => ({ ...child, value }));
      visit(child, true);
      return [child];
    });
  }
  return (tree: PromptMarkdownNode) => visit(tree);
}

export function referenceLabel(ref: Reference) {
  return ref.kind === "file" ? ref.name.split(/[\\/]/).at(-1)! : ref.name;
}

export function referenceText(ref: Reference) {
  return `${ref.kind === "skill" ? "$" : "@"}${ref.name}`;
}

const leverSources = new Set([
  "chat",
  "topic",
  "note",
  "workItem",
  "noteTask",
  "externalTask",
  "automationTask",
  "agent",
]);

export function isLeverReference(
  ref: Reference,
): ref is Reference & { id: string } {
  return (
    leverSources.has(ref.kind) &&
    typeof ref.id === "string" &&
    ref.id.length > 0
  );
}

export function textPrompt(
  text: string,
  references: Reference[] = [],
): JSONContent {
  const content: JSONContent[] = text.split(/\r\n|\n|\r/).map((line) => ({
    type: "paragraph",
    ...(line ? { content: [{ type: "text", text: line }] } : {}),
  }));
  for (const reference of references) {
    (content.at(-1)!.content ??= []).push(
      { type: "text", text: " " },
      { type: "reference", attrs: { reference } },
    );
  }
  return { type: "doc", content };
}

export function markPromptReferences(text: string, references: Reference[]) {
  let marker = "LEVERREFERENCE";
  while (text.includes(marker)) marker += "X";
  const positioned: Reference[] = [];
  const trailing: Reference[] = [];
  let source = "";
  let offset = 0;
  const ordered = [...references].sort(
    (a, b) => (a.start ?? text.length) - (b.start ?? text.length),
  );
  for (const reference of ordered) {
    const { start, end } = reference;
    if (
      start === undefined ||
      end === undefined ||
      start < offset ||
      end < start ||
      end > text.length
    ) {
      trailing.push(reference);
      continue;
    }
    source += text.slice(offset, start) + `${marker}${positioned.length}END`;
    positioned.push(reference);
    offset = end;
  }
  return {
    source: source + text.slice(offset),
    pattern: new RegExp(`${marker}(\\d+)END`, "g"),
    positioned,
    trailing,
  };
}

// Restore Markdown and inline references when editing a message.
export function messagePrompt(
  text: string,
  references: Reference[] = [],
): JSONContent {
  const { source, pattern, positioned, trailing } = markPromptReferences(
    text,
    references,
  );
  function restore(node: JSONContent): JSONContent[] {
    if (node.type === "text" && node.text) {
      const nodes: JSONContent[] = [];
      let end = 0;
      for (const match of node.text.matchAll(pattern)) {
        if (match.index > end)
          nodes.push({ ...node, text: node.text.slice(end, match.index) });
        nodes.push({
          type: "reference",
          attrs: { reference: positioned[Number(match[1])] },
          marks: node.marks,
        });
        end = match.index + match[0].length;
      }
      if (end < node.text.length)
        nodes.push({ ...node, text: node.text.slice(end) });
      return nodes;
    }
    return [
      {
        ...node,
        ...(node.content ? { content: node.content.flatMap(restore) } : {}),
      },
    ];
  }
  const doc = restore(markdownPrompt(source))[0];
  for (const ref of trailing) {
    doc.content!.push({
      type: "paragraph",
      content: [{ type: "reference", attrs: { reference: ref } }],
    });
  }
  return doc;
}

// Let Tiptap serialize formatting, then resolve reference placeholders in the
// final Markdown. Positions must include syntax, indentation and UTF-16 pairs.
export function serializePrompt(doc: JSONContent) {
  let marker = "\ufffc";
  const source = JSON.stringify(doc);
  while (source.includes(marker)) marker += "\ufffc";
  const tokens: Reference[] = [];
  function substitute(node: JSONContent): JSONContent {
    if (node.type === "reference") {
      tokens.push(node.attrs!.reference as Reference);
      return { type: "text", text: marker, marks: node.marks };
    }
    return node.content
      ? { ...node, content: node.content.map(substitute) }
      : node;
  }
  const parts = markdown.serialize(substitute(doc)).split(marker);
  let text = parts[0];
  const references: Reference[] = [];
  tokens.forEach((ref, index) => {
    const start = text.length;
    text += referenceText(ref);
    references.push({ ...ref, start, end: text.length });
    text += parts[index + 1];
  });
  return { text, references };
}
