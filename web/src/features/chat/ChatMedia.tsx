import {
  createContext,
  useContext,
  useRef,
  useState,
  type ComponentProps,
  type MouseEvent,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import { Dialog } from "@/components/ui/dialog";
import { useImagePreview } from "./ImagePreview";
import { HtmlPreviewDialogContent } from "./VisualizationBlock";

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

export function ChatHtmlLink({
  src,
  name,
  children,
}: {
  src: string;
  name: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const link = useRef<HTMLAnchorElement>(null);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <a
        ref={link}
        href={src}
        aria-haspopup="dialog"
        onClick={(event) => {
          if (followInChat(event)) setOpen(true);
        }}
      >
        <InsideChatLink.Provider value>{children}</InsideChatLink.Provider>
      </a>
      <HtmlPreviewDialogContent
        src={src}
        title={name}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          link.current?.focus({ preventScroll: true });
        }}
      />
    </Dialog>
  );
}
