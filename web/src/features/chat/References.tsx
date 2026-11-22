import { useContext, useMemo } from "react";
import {
  Box,
  FileText,
  MousePointer2,
  ListTodo,
  MessageCircle,
  MessagesCircle,
  NotebookPen,
  UsersRound,
} from "lucide-react";
import {
  defaultRehypePlugins,
  defaultRemarkPlugins,
  type AllowElement,
  type Components,
  type StreamdownProps,
} from "streamdown";
import type { Reference } from "@/api/types.gen";
import { MessageResponse } from "@/components/ai-elements/message-response";
import { Button } from "@/components/ui/button";
import type { ReferenceScope } from "@/features/files/fileSource";
import { ComposerContext, ReferenceScopeContext } from "./ComposerContext";
import { ChatHtmlLink, ChatHtmlParagraph } from "./ChatMedia";
import { InlineHtmlPreview } from "./InlineHtmlPreview";
import {
  chatHtmlPreview,
  htmlViewerURL,
  parseHtmlPreviewURL,
} from "./chatFileLinks";
import {
  isLeverReference,
  markPromptReferences,
  preservePromptWhitespace,
  referenceLabel,
  referenceText,
} from "./prompt";

const promptRemarkPlugins = [
  ...Object.values(defaultRemarkPlugins),
  preservePromptWhitespace,
];

export function ReferenceIcon({
  kind,
  size = 15,
}: {
  kind: string;
  size?: number;
}) {
  const Icon =
    {
      file: FileText,
      skill: Box,
      chat: MessageCircle,
      topic: MessagesCircle,
      note: NotebookPen,
      agent: UsersRound,
      browserElement: MousePointer2,
    }[kind] ?? ListTodo;
  return <Icon size={size} />;
}

export function InlineReference({
  reference,
  scope,
}: {
  reference: Reference;
  scope?: ReferenceScope;
}) {
  const composer = useContext(ComposerContext);
  const editorScope = useContext(ReferenceScopeContext);
  const openReference =
    reference.kind === "file" && reference.path
      ? composer?.openFileReference
      : reference.kind === "skill" || isLeverReference(reference)
        ? composer?.openReference
        : undefined;
  const title =
    reference.kind === "browserElement" && reference.element
      ? `${reference.element.url}\n${reference.element.selector}`
      : reference.path || reference.name;
  const content = (
    <>
      <ReferenceIcon kind={reference.kind} />
      <span>{referenceLabel(reference)}</span>
    </>
  );
  return openReference ? (
    <Button
      type="button"
      variant="ghost"
      size="xs"
      className="inline-reference"
      title={title}
      onClick={(event) => {
        event.stopPropagation();
        void openReference(reference, scope ?? editorScope);
      }}
    >
      {content}
    </Button>
  ) : (
    <span className="inline-reference" title={title}>
      {content}
    </span>
  );
}

type MarkdownNode = NonNullable<
  Parameters<AllowElement>[2]
>["children"][number];
type MarkdownParent = { children: MarkdownNode[] };

function promptHtmlLinks({ endpoint }: { endpoint?: string }) {
  function visit(node: MarkdownParent) {
    for (const child of node.children) {
      if (child.type !== "element") continue;
      if (child.tagName === "a" && typeof child.properties.href === "string") {
        const preview = chatHtmlPreview(
          child.properties.href,
          endpoint,
          location.origin,
        );
        if (preview)
          child.properties.href = location.origin + htmlViewerURL(preview.src);
      } else visit(child);
    }
  }
  return visit;
}

const promptLink: Components["a"] = ({ href, children }) => {
  const preview = href && parseHtmlPreviewURL(href, location.origin);
  return preview ? (
    <ChatHtmlLink preview={preview}>{children}</ChatHtmlLink>
  ) : (
    <a href={href} target="_blank" rel="noreferrer noopener">
      {children}
    </a>
  );
};

function restorePromptReferences({
  markerPattern,
  referenceTexts,
}: {
  markerPattern: string;
  referenceTexts: string[];
}) {
  const pattern = new RegExp(markerPattern, "g");
  // Restore references after parsing so they can sit inside headings, lists,
  // or emphasis without splitting the Markdown around them.
  function restore(node: MarkdownParent, literal = false) {
    node.children = node.children.flatMap((child): MarkdownNode[] => {
      if (child.type === "element") {
        restore(
          child,
          literal || child.tagName === "code" || child.tagName === "a",
        );
      }
      if (child.type !== "text") return [child];
      if (literal) {
        child.value = child.value.replace(
          pattern,
          (match, index: string) => referenceTexts[Number(index)] ?? match,
        );
        return [child];
      }
      const parts: MarkdownNode[] = [];
      let offset = 0;
      for (const match of child.value.matchAll(pattern)) {
        const index = Number(match[1]);
        if (referenceTexts[index] === undefined) continue;
        if (match.index > offset) {
          parts.push({
            type: "text",
            value: child.value.slice(offset, match.index),
          });
        }
        parts.push({
          type: "element",
          tagName: "lever-reference",
          properties: { index },
          children: [],
        });
        offset = match.index + match[0].length;
      }
      if (!parts.length) return [child];
      if (offset < child.value.length) {
        parts.push({ type: "text", value: child.value.slice(offset) });
      }
      return parts;
    });
  }
  return (node: MarkdownParent) => restore(node);
}

function renderReferences(
  text: string,
  references: Reference[],
  scope: ReferenceScope,
) {
  const { source, pattern, positioned, trailing } = markPromptReferences(
    text,
    references,
  );
  // Streamdown caches Markdown processors by plugin name and serialized options.
  const rehypePlugins: StreamdownProps["rehypePlugins"] = [
    [
      restorePromptReferences,
      {
        markerPattern: pattern.source,
        referenceTexts: positioned.map(referenceText),
      },
    ],
  ];
  const components: Components = {
    "lever-reference": ({ node }) => (
      <InlineReference
        reference={positioned[Number(node?.properties.index)]}
        scope={scope}
      />
    ),
  };
  return { source, trailing, components, rehypePlugins };
}

export function MessageInput({
  text,
  references,
  sessionId,
  previewEndpoint,
}: {
  text: string;
  references?: Reference[];
  sessionId?: string;
  previewEndpoint?: string;
}) {
  const rendering = useMemo(
    () =>
      references?.length
        ? renderReferences(text, references, { sessionId })
        : undefined,
    [text, references, sessionId],
  );
  const components = useMemo(
    () => ({
      a: promptLink,
      ...(previewEndpoint && { p: ChatHtmlParagraph }),
      ...rendering?.components,
    }),
    [previewEndpoint, rendering],
  );
  const plugins = useMemo<StreamdownProps["rehypePlugins"]>(
    () => [
      defaultRehypePlugins.raw,
      [promptHtmlLinks, { endpoint: previewEndpoint }],
      defaultRehypePlugins.sanitize,
      defaultRehypePlugins.harden,
      ...(rendering?.rehypePlugins ?? []),
    ],
    [previewEndpoint, rendering],
  );
  const source = rendering?.source ?? text;
  return (
    <>
      {source && (
        <InlineHtmlPreview>
          <MessageResponse
            text={source}
            mode="static"
            className="space-y-2 wrap-anywhere [&_a]:underline [&_a]:underline-offset-3 [&_p]:whitespace-pre-wrap"
            components={components}
            remarkPlugins={promptRemarkPlugins}
            rehypePlugins={plugins}
          />
        </InlineHtmlPreview>
      )}
      {!!rendering?.trailing.length && (
        <div className="flex flex-wrap items-baseline gap-x-1">
          {rendering.trailing.map((reference, index) => (
            <InlineReference
              key={index}
              reference={reference}
              scope={{ sessionId }}
            />
          ))}
        </div>
      )}
    </>
  );
}
