import { Maximize2 } from "lucide-react";
import { useContext, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Block, type BlockProps } from "streamdown";
import { ToolbarButton } from "@/components/ui/toolbar-button";
import {
  ChatPreviewEndpoint,
  HtmlPreviewActions,
  HtmlPreviewContext,
  HtmlPreviewHeader,
} from "./HtmlPreview";
import { fileKind } from "@/features/files/preview/fileKind";
import { HtmlFrame } from "@/features/files/preview/HtmlFrame";
import { chatPreviewURL, htmlViewerURL } from "./chatFileLinks";

export function VisualizationBlock(props: BlockProps) {
  const endpoint = useContext(ChatPreviewEndpoint) ?? "/api/visualizations";
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
  const actions = useContext(HtmlPreviewContext);
  const preview = { src, title };
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
    <div
      className="chat-visualization my-2 min-w-0 overflow-hidden rounded-lg border border-border"
      data-wide={wide}
    >
      <HtmlPreviewHeader className="border-b border-border py-1 pr-1 pl-3 text-xs text-muted-foreground">
        <span className="min-w-0 flex-[1_1_6ch] truncate" title={title}>
          {title}
        </span>
        {actions ? (
          <HtmlPreviewActions preview={preview} />
        ) : (
          <ToolbarButton
            type="button"
            label={t("chat.htmlPreviewQuick")}
            onClick={() =>
              window.open(htmlViewerURL(src), "_blank", "noopener,noreferrer")
            }
          >
            <Maximize2 />
          </ToolbarButton>
        )}
      </HtmlPreviewHeader>
      <HtmlFrame
        ref={frame}
        className="chat-visualization-frame block w-full border-0"
        title={title}
        src={src}
        style={{ height }}
        loading="lazy"
      />
    </div>
  );
}
