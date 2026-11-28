import { useMemo } from "react";
import { defaultRehypePlugins, type Components } from "streamdown";
import type { Citation, Item, Root, Session } from "@/api/types.gen";
import { MessageResponse } from "@/components/ai-elements/message-response";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  absoluteFilePath,
  type FileSelection,
} from "@/features/files/filePaths";
import {
  hostFileSource,
  type AgentFileSource,
  type HostFileSource,
} from "@/features/files/fileSource";
import { ChatCitationsContext, InlineCitation } from "./InlineCitation";
import {
  CITATION_SENTINEL_PATTERN,
  CITATION_SENTINEL_START,
  insertCitationSentinels,
  resolveDisplayCitations,
} from "./chatCitations";
import {
  chatFileTarget,
  chatHtmlPreview,
  chatPreviewURL,
  resolveChatFile,
} from "./chatFileLinks";
import {
  chatHtmlBlockComponents,
  ChatHtmlLink,
  ChatImage,
  ChatImageLink,
  ChatPicture,
  InsideChatLink,
} from "./ChatMedia";
import { VisualizationBlock } from "./VisualizationBlock";
import { ChatPreviewEndpoint } from "./HtmlPreview";
import { InlineHtmlPreview } from "./InlineHtmlPreview";

export type ChatFileSelection = FileSelection & { source?: HostFileSource };

export type OpenChatFile = (
  file: ChatFileSelection,
  source: AgentFileSource,
) => void;

export type ChatFiles = {
  resolve: (href?: string) => ChatFileSelection | null;
  open: (file: ChatFileSelection) => void;
};

export function ChatResponse({
  text,
  citations,
  fallbackItems,
  running,
  session,
  agentRoots,
  onOpenFile,
  runId,
}: {
  text: string;
  citations?: Citation[];
  fallbackItems?: Item[];
  running: boolean;
  session: Session;
  agentRoots?: Root[];
  onOpenFile: OpenChatFile;
  runId: string;
}) {
  const files = useMemo<ChatFiles>(() => {
    const sessionId =
      session.kind === "topic" || session.workingCopyId
        ? session.id
        : undefined;
    const source: AgentFileSource = {
      kind: "agent",
      id: session.agentId,
      sessionId,
    };
    const roots = sessionId ? session.roots : (agentRoots ?? session.roots);
    return {
      resolve: (href) => {
        const resolved = resolveChatFile(
          href,
          session,
          roots,
          window.location.origin,
        );
        if (!resolved) return null;
        return resolved.host
          ? { ...resolved.file, source: hostFileSource }
          : resolved.file;
      },
      open: (file) => onOpenFile(file, source),
    };
  }, [session, agentRoots, onOpenFile]);
  return (
    <ChatMarkdown
      text={text}
      citations={citations}
      fallbackItems={fallbackItems}
      running={running}
      endpoint={`/api/runs/${encodeURIComponent(runId)}/preview`}
      files={files}
    />
  );
}

type MarkdownNode = {
  type?: string;
  value?: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: MarkdownNode[];
};

// Keep local destinations through Markdown sanitization, including file: URLs
// and Windows drive letters. The browser only receives a scoped preview URL.
const urlProperty: Record<string, string | undefined> = {
  a: "href",
  img: "src",
  source: "srcSet",
};

function localURLs() {
  function visit(node: MarkdownNode) {
    const key = node.tagName && urlProperty[node.tagName];
    const value = key && node.properties?.[key];
    // Only scheme-like destinations need escaping. Preserve regular web links,
    // including ones on Lever's own origin.
    if (
      key &&
      typeof value === "string" &&
      /^[a-z][a-z\d+.-]*:/i.test(value) &&
      !/^https?:/i.test(value) &&
      node.properties
    ) {
      const target = chatFileTarget(value, window.location.origin);
      if (target) {
        const { path, location, fragment } = target;
        const suffix = location ? `:${location.line}:${location.column}` : "";
        node.properties[key] =
          (path + suffix).split("/").map(encodeURIComponent).join("/") +
          fragment;
      }
    }
    node.children?.forEach(visit);
  }
  return visit;
}
function restoreCitations() {
  function visit(node: MarkdownNode, literal = false) {
    if (!node.children) return;
    const next: MarkdownNode[] = [];
    for (const child of node.children) {
      if (child.type === "element") {
        visit(
          child,
          literal ||
            child.tagName === "code" ||
            child.tagName === "pre" ||
            child.tagName === "a",
        );
        next.push(child);
        continue;
      }
      if (
        child.type !== "text" ||
        typeof child.value !== "string" ||
        !child.value.includes(CITATION_SENTINEL_START)
      ) {
        next.push(child);
        continue;
      }
      if (literal) {
        child.value = child.value.replace(CITATION_SENTINEL_PATTERN, "");
        next.push(child);
        continue;
      }
      let offset = 0;
      for (const match of child.value.matchAll(CITATION_SENTINEL_PATTERN)) {
        const start = match.index ?? 0;
        if (start > offset) {
          next.push({ type: "text", value: child.value.slice(offset, start) });
        }
        next.push({
          type: "element",
          tagName: "lever-citation",
          properties: { index: Number(match[1]) },
          children: [],
        });
        offset = start + match[0].length;
      }
      if (offset === 0) {
        next.push(child);
      } else if (offset < child.value.length) {
        next.push({ type: "text", value: child.value.slice(offset) });
      }
    }
    node.children = next;
  }
  return (tree: MarkdownNode) => visit(tree);
}

const rehypePlugins = [
  defaultRehypePlugins.raw,
  localURLs,
  defaultRehypePlugins.sanitize,
  restoreCitations,
];

export function ChatMarkdown({
  text,
  citations,
  fallbackItems,
  running = false,
  endpoint,
  files,
}: {
  text: string;
  citations?: Citation[];
  fallbackItems?: Item[];
  running?: boolean;
  endpoint?: string;
  files?: ChatFiles;
}) {
  const { markdown, citations: activeCitations } = useMemo(() => {
    const resolved = resolveDisplayCitations(
      text,
      citations,
      fallbackItems,
      running,
    );
    return insertCitationSentinels(resolved.text, resolved.citations);
  }, [text, citations, fallbackItems, running]);
  const components = useMemo<Components>(() => {
    const targetFor = (url?: string) =>
      chatFileTarget(url, window.location.origin);
    const imageURL = (src?: string) => {
      const target = targetFor(src);
      if (target && endpoint)
        return chatPreviewURL(endpoint, "image", target.path, target.fragment);
      if (src?.startsWith("//")) return `https:${src}`;
      if (src && /^https?:\/\//i.test(src)) return src;
    };
    return {
      ...(endpoint && chatHtmlBlockComponents),
      img: ({ src, ...props }) => <ChatImage {...props} src={imageURL(src)} />,
      source: ({ srcSet, media }) => {
        const src = srcSet && /^\S+$/.test(srcSet) && imageURL(srcSet);
        return src ? <source media={media} srcSet={src} /> : null;
      },
      picture: ({ node, children }) => {
        const img = node?.children.find(
          (child) => child.type === "element" && child.tagName === "img",
        );
        const { src, alt } = img?.type === "element" ? img.properties : {};
        return (
          <ChatPicture
            src={typeof src === "string" ? imageURL(src) : undefined}
            name={typeof alt === "string" ? alt : undefined}
          >
            {children}
          </ChatPicture>
        );
      },
      a: ({ href, children }) => {
        const preview =
          href &&
          endpoint &&
          chatHtmlPreview(href, endpoint, window.location.origin);
        if (preview)
          return <ChatHtmlLink preview={preview}>{children}</ChatHtmlLink>;
        const target = targetFor(href);
        if (target) {
          const { path, fragment, location } = target;
          const name = path.split("/").at(-1) || path;
          if (
            endpoint &&
            !location &&
            /\.(?:png|jpe?g|gif|webp|bmp|ico|svg)$/i.test(path)
          ) {
            return (
              <ChatImageLink
                src={chatPreviewURL(endpoint, "image", path, fragment)}
                name={name}
              >
                {children}
              </ChatImageLink>
            );
          }
          const file = files?.resolve(href);
          if (file && files) {
            return (
              <a
                href={href}
                title={absoluteFilePath(file)}
                onClick={(event) => {
                  event.preventDefault();
                  files.open(file);
                }}
              >
                <InsideChatLink.Provider value>
                  {children}
                </InsideChatLink.Provider>
              </a>
            );
          }
        }
        return href && /^(?:https?:|mailto:|tel:|\/\/)/i.test(href) ? (
          <a href={href} target="_blank" rel="noreferrer noopener">
            <InsideChatLink.Provider value>{children}</InsideChatLink.Provider>
          </a>
        ) : (
          <span title={target?.path}>{children}</span>
        );
      },
      "lever-citation": ({ node }) => (
        <InlineCitation index={Number(node?.properties?.index)} />
      ),
    };
  }, [endpoint, files]);
  return (
    <ChatPreviewEndpoint.Provider value={endpoint}>
      <ChatCitationsContext.Provider value={activeCitations}>
        <TooltipProvider delayDuration={300}>
          <InlineHtmlPreview>
            <MessageResponse
              className="chat-response"
              text={markdown}
              running={running}
              components={components}
              rehypePlugins={rehypePlugins}
              BlockComponent={endpoint ? VisualizationBlock : undefined}
            />
          </InlineHtmlPreview>
        </TooltipProvider>
      </ChatCitationsContext.Provider>
    </ChatPreviewEndpoint.Provider>
  );
}
