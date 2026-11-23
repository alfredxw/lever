import {
  createContext,
  useContext,
  useState,
  type ComponentProps,
  type MouseEvent,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import { isMyGo } from "mygo-runtime";
import { toast } from "sonner";
import {
  defaultComponents,
  StreamdownContext,
  type ExtraProps,
} from "streamdown";
import { rowMenuHandlers } from "@/components/ui/action-context-menu";
import {
  ChatPreviewEndpoint,
  HtmlPreviewContext,
  openOriginalHtml,
} from "./HtmlPreview";
import {
  chatHtmlPreview,
  htmlViewerURL,
  type HtmlPreview,
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

export function ChatHtmlParagraph({
  node,
  ...props
}: ComponentProps<"p"> & ExtraProps) {
  const endpoint = useContext(ChatPreviewEndpoint);
  const { isAnimating } = useContext(StreamdownContext);
  const paragraph = <defaultComponents.p node={node} {...props} />;
  for (const child of node?.children ?? []) {
    if (child.type !== "element" || child.tagName !== "a") continue;
    const href = child.properties.href;
    const preview =
      typeof href === "string" &&
      chatHtmlPreview(href, endpoint, location.origin);
    if (preview) {
      const wholeReport =
        node?.children.length === 1 && !preview.src.includes("#");
      return (
        <InlineHtmlPreview
          key={preview.src}
          defaultPreview={!isAnimating && wholeReport ? preview : undefined}
        >
          {paragraph}
        </InlineHtmlPreview>
      );
    }
  }
  return paragraph;
}

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
