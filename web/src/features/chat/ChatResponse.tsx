import { useMemo } from "react";
import { defaultRehypePlugins, type Components } from "streamdown";
import type { Root, Session } from "@/api/types.gen";
import { MessageResponse } from "@/components/ai-elements/message-response";
import {
  absoluteFilePath,
  type FileSelection,
} from "@/features/files/filePaths";
import {
  hostFileSource,
  type AgentFileSource,
  type HostFileSource,
} from "@/features/files/fileSource";
import {
  chatFileTarget,
  chatHtmlPreview,
  chatPreviewURL,
  resolveChatFile,
} from "./chatFileLinks";
import {
  ChatHtmlLink,
  ChatHtmlParagraph,
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
  running,
  session,
  agentRoots,
  onOpenFile,
  runId,
}: {
  text: string;
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
      running={running}
      endpoint={`/api/runs/${encodeURIComponent(runId)}/preview`}
      files={files}
    />
  );
}

type MarkdownNode = {
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
const rehypePlugins = [
  defaultRehypePlugins.raw,
  localURLs,
  defaultRehypePlugins.sanitize,
];

export function ChatMarkdown({
  text,
  running = false,
  endpoint,
  files,
}: {
  text: string;
  running?: boolean;
  endpoint: string;
  files?: ChatFiles;
}) {
  const components = useMemo<Components>(() => {
    const targetFor = (url?: string) =>
      chatFileTarget(url, window.location.origin);
    const imageURL = (src?: string) => {
      const target = targetFor(src);
      if (target)
        return chatPreviewURL(endpoint, "image", target.path, target.fragment);
      if (src?.startsWith("//")) return `https:${src}`;
      if (src && /^https?:\/\//i.test(src)) return src;
    };
    return {
      p: ChatHtmlParagraph,
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
          href && chatHtmlPreview(href, endpoint, window.location.origin);
        if (preview)
          return <ChatHtmlLink preview={preview}>{children}</ChatHtmlLink>;
        const target = targetFor(href);
        if (target) {
          const { path, fragment, location } = target;
          const name = path.split("/").at(-1) || path;
          if (
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
    };
  }, [endpoint, files]);
  return (
    <ChatPreviewEndpoint.Provider value={endpoint}>
      <InlineHtmlPreview>
        <MessageResponse
          className="chat-response"
          text={text}
          running={running}
          components={components}
          rehypePlugins={rehypePlugins}
          BlockComponent={VisualizationBlock}
        />
      </InlineHtmlPreview>
    </ChatPreviewEndpoint.Provider>
  );
}
