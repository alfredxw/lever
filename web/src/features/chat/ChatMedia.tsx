import {
  createContext,
  isValidElement,
  useContext,
  useState,
  type ComponentProps,
  type ComponentType,
  type MouseEvent,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import { isMyGo } from "mygo-runtime";
import { toast } from "sonner";
import {
  defaultComponents,
  StreamdownContext,
  type Components,
  type ExtraProps,
} from "streamdown";
import { ResponseTable } from "@/components/ai-elements/response-table";
import { rowMenuHandlers } from "@/components/ui/action-context-menu";
import {
  ChatPreviewEndpoint,
  HtmlPreviewContext,
  openOriginalHtml,
} from "./HtmlPreview";
import {
  findBlockHtmlPreview,
  htmlViewerURL,
  type HtmlPreview,
  type HtmlPreviewNode,
} from "./chatFileLinks";
import { useImagePreview } from "./ImagePreview";
import { InlineHtmlPreview, useInlineHtmlPreview } from "./InlineHtmlPreview";

// A linked thumbnail follows its authored link. Standalone images (including a
// whole <picture>) open the image actually selected by the browser.
export const InsideChatLink = createContext(false);

function followInChat(event: MouseEvent<HTMLAnchorElement>) {
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
    return false;
  event.preventDefault();
  return true;
}

export function ChatImageLink({
  src,
  name,
  children,
  displayedImage,
}: {
  src: string;
  name: string;
  children: ReactNode;
  displayedImage?: boolean;
}) {
  const preview = useImagePreview();
  return (
    <a
      href={src}
      aria-label={displayedImage ? name : undefined}
      className={displayedImage ? "chat-image-link" : undefined}
      onClick={(event) => {
        if (!followInChat(event)) return;
        const url =
          (displayedImage &&
            event.currentTarget.querySelector("img")?.currentSrc) ||
          src;
        preview.open({ id: url, name, src: url });
      }}
    >
      <InsideChatLink.Provider value>{children}</InsideChatLink.Provider>
    </a>
  );
}

export function ChatImage({
  src,
  alt,
  title,
  width,
  height,
}: ComponentProps<"img">) {
  const { t } = useTranslation();
  const linked = useContext(InsideChatLink);
  const [failed, setFailed] = useState<string>();
  if (!src || failed === src) {
    return (
      <span className="text-muted-foreground">
        {alt || t("chat.imageUnavailable")}
      </span>
    );
  }
  const image = (
    <img
      src={src}
      alt={alt ?? ""}
      title={title}
      width={width}
      height={height}
      className="chat-inline-image"
      loading="lazy"
      decoding="async"
      referrerPolicy="no-referrer"
      onError={() => setFailed(src)}
    />
  );
  if (linked) return image;
  return (
    <ChatImageLink
      src={src}
      name={alt || title || t("attachments.preview")}
      displayedImage
    >
      {image}
    </ChatImageLink>
  );
}

export function ChatPicture({
  src,
  name,
  children,
}: {
  src?: string;
  name?: string;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const linked = useContext(InsideChatLink);
  const picture = <picture>{children}</picture>;
  return src && !linked ? (
    <ChatImageLink
      src={src}
      name={name || t("attachments.preview")}
      displayedImage
    >
      {picture}
    </ChatImageLink>
  ) : (
    picture
  );
}

const listNestedBlocks = new Set([
  "ul",
  "ol",
  "p",
  "blockquote",
  "table",
  "pre",
  "hr",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
]);

function childAstNode(child: ReactNode): HtmlPreviewNode | undefined {
  return isValidElement<{ node?: HtmlPreviewNode }>(child)
    ? child.props.node
    : undefined;
}

function childTagName(child: ReactNode): string | undefined {
  if (!isValidElement<{ node?: HtmlPreviewNode }>(child)) return undefined;
  return typeof child.type === "string"
    ? child.type
    : child.props.node?.tagName;
}

export function ChatHtmlParagraph({
  node,
  ...props
}: ComponentProps<"p"> & ExtraProps) {
  const endpoint = useContext(ChatPreviewEndpoint);
  const { isAnimating } = useContext(StreamdownContext);
  const paragraph = <defaultComponents.p node={node} {...props} />;
  const preview = findBlockHtmlPreview(node, endpoint, location.origin);
  if (!preview) return paragraph;
  const wholeReport =
    node?.children.length === 1 &&
    node.children[0].type === "element" &&
    node.children[0].tagName === "a" &&
    !preview.src.includes("#");
  return (
    <InlineHtmlPreview
      key={preview.src}
      defaultPreview={!isAnimating && wholeReport ? preview : undefined}
    >
      {paragraph}
    </InlineHtmlPreview>
  );
}

function ChatHtmlListItem({
  node,
  children,
  ...props
}: ComponentProps<"li"> & ExtraProps) {
  const endpoint = useContext(ChatPreviewEndpoint);
  const preview = findBlockHtmlPreview(node, endpoint, location.origin);
  if (!preview) {
    return (
      <defaultComponents.li node={node} {...props}>
        {children}
      </defaultComponents.li>
    );
  }
  let before: ReactNode = children;
  let after: ReactNode;
  if (Array.isArray(children)) {
    const splitAt = children.findIndex((child) => {
      const tag = childTagName(child);
      return tag !== undefined && listNestedBlocks.has(tag);
    });
    if (splitAt > 0) {
      const tail = children.slice(splitAt);
      const tailNodes = tail
        .map(childAstNode)
        .filter((item): item is HtmlPreviewNode => item !== undefined);
      if (
        !findBlockHtmlPreview({ children: tailNodes }, endpoint, location.origin)
      ) {
        before = children.slice(0, splitAt);
        after = tail;
      }
    }
  }
  return (
    <defaultComponents.li node={node} {...props}>
      <InlineHtmlPreview after={after}>{before}</InlineHtmlPreview>
    </defaultComponents.li>
  );
}

function createChatHtmlBlock<P extends ExtraProps>(
  Component: ComponentType<P>,
) {
  return function ChatHtmlBlock(props: P) {
    const endpoint = useContext(ChatPreviewEndpoint);
    const element = <Component {...props} />;
    return findBlockHtmlPreview(props.node, endpoint, location.origin) ? (
      <InlineHtmlPreview>{element}</InlineHtmlPreview>
    ) : (
      element
    );
  };
}

export const chatHtmlBlockComponents: Components = {
  p: ChatHtmlParagraph,
  li: ChatHtmlListItem,
  h1: createChatHtmlBlock(defaultComponents.h1),
  h2: createChatHtmlBlock(defaultComponents.h2),
  h3: createChatHtmlBlock(defaultComponents.h3),
  h4: createChatHtmlBlock(defaultComponents.h4),
  h5: createChatHtmlBlock(defaultComponents.h5),
  h6: createChatHtmlBlock(defaultComponents.h6),
  blockquote: createChatHtmlBlock(defaultComponents.blockquote),
  table: createChatHtmlBlock(ResponseTable),
};

export function ChatHtmlLink({
  preview,
  children,
}: {
  preview: HtmlPreview;
  children: ReactNode;
}) {
  const actions = useContext(HtmlPreviewContext);
  const inline = useInlineHtmlPreview();
  const expanded = inline?.src === preview.src;
  const openFile = (event: MouseEvent<HTMLAnchorElement>) => {
    if (!isMyGo()) return;
    event.preventDefault();
    void openOriginalHtml(preview.src).catch((error) =>
      toast.error(String(error)),
    );
  };
  return (
    <a
      href={htmlViewerURL(preview.src)}
      target="_blank"
      rel="noopener noreferrer"
      aria-expanded={inline ? expanded : undefined}
      aria-controls={expanded ? inline?.id : undefined}
      {...(actions &&
        rowMenuHandlers((anchor) =>
          actions.menu(
            preview,
            anchor,
            inline && !expanded
              ? () => inline.toggle(preview, anchor.trigger)
              : undefined,
          ),
        ))}
      onClick={(event) => {
        if (inline && followInChat(event))
          inline.toggle(preview, event.currentTarget);
        else openFile(event);
      }}
      onAuxClick={(event) => {
        if (event.button === 1) openFile(event);
      }}
    >
      <InsideChatLink.Provider value>{children}</InsideChatLink.Provider>
    </a>
  );
}
