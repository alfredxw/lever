import { Maximize2 } from "lucide-react";
import {
  createContext,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentProps,
} from "react";
import { useTranslation } from "react-i18next";
import { Block, type BlockProps } from "streamdown";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { fileKind } from "@/features/files/preview/fileKind";
import { HtmlFrame } from "@/features/files/preview/HtmlFrame";
import { chatPreviewURL } from "./chatFileLinks";

export const ChatPreviewEndpoint = createContext("/api/visualizations");

export function VisualizationBlock(props: BlockProps) {
  const endpoint = useContext(ChatPreviewEndpoint);
  // Streamdown keeps fenced examples together. Only handle a standalone block.
  const marker = /^ {0,3}\uE200visualize\uE202([^\r\n]+)\uE201$/u.exec(
    props.content.trimEnd(),
  );
  if (marker) {
    try {
      const reference = JSON.parse(marker[1]);
      const path: unknown = reference?.path;
      if (
        typeof path === "string" &&
        /^(?:\/|[a-z]:[\\/])/i.test(path) &&
        path.length <= 4096 &&
        fileKind(path) === "html"
      ) {
        const title =
          (typeof reference.title === "string" && reference.title.trim()) ||
          path.split(/[\\/]/).at(-1)!;
        const src = chatPreviewURL(endpoint, "visualization", path);
        return (
          <VisualizationPreview
            key={src}
            src={src}
            title={title}
            wide={reference.mode === "wide"}
          />
        );
      }
    } catch {
      // Partial or invalid markers remain readable Markdown.
    }
  }
  return <Block {...props} />;
}

function VisualizationPreview({
  src,
  title,
  wide,
}: {
  src: string;
  title: string;
  wide: boolean;
}) {
  const { t } = useTranslation();
  const frame = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(260);
  useLayoutEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (
        event.origin !== "null" ||
        event.source !== frame.current?.contentWindow
      )
        return;
      const { type, height } = event.data ?? {};
      if (
        type === "lever:visualization-height" &&
        typeof height === "number" &&
        Number.isFinite(height)
      )
        setHeight(Math.max(64, Math.min(640, height)));
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);
  return (
    <Dialog>
      <div
        className="chat-visualization my-2 min-w-0 overflow-hidden rounded-lg border border-border"
        data-wide={wide}
      >
        <div className="flex items-center gap-2 border-b border-border py-1 pr-1 pl-3 text-xs text-muted-foreground">
          <span className="min-w-0 flex-1 truncate" title={title}>
            {title}
          </span>
          <DialogTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={t("chat.expandVisualization")}
              title={t("chat.expandVisualization")}
            >
              <Maximize2 />
            </Button>
          </DialogTrigger>
        </div>
        <HtmlFrame
          ref={frame}
          className="chat-visualization-frame block w-full border-0"
          title={title}
          src={src}
          style={{ height }}
          loading="lazy"
        />
      </div>
      <HtmlPreviewDialogContent src={src} title={title} />
    </Dialog>
  );
}

export function HtmlPreviewDialogContent({
  src,
  title,
  onCloseAutoFocus,
}: {
  src: string;
  title: string;
  onCloseAutoFocus?: ComponentProps<typeof DialogContent>["onCloseAutoFocus"];
}) {
  const dialogTitle = useRef<HTMLHeadingElement>(null);
  return (
    <DialogContent
      className="flex h-[calc(100dvh-2rem)] flex-col gap-2 pt-3 sm:max-w-[calc(100%-2rem)]"
      aria-describedby={undefined}
      onCloseAutoFocus={onCloseAutoFocus}
      onOpenAutoFocus={(event) => {
        event.preventDefault();
        dialogTitle.current?.focus();
      }}
    >
      <DialogTitle
        ref={dialogTitle}
        tabIndex={-1}
        className="truncate pr-8 outline-none"
      >
        {title}
      </DialogTitle>
      <HtmlFrame
        className="chat-visualization-frame min-h-0 w-full flex-1 rounded-md border"
        src={src}
        title={title}
      />
    </DialogContent>
  );
}
