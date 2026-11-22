import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { queryOptions, skipToken, useQuery } from "@tanstack/react-query";
import {
  ChevronUp,
  Copy,
  Ellipsis,
  ExternalLink,
  Eye,
  FolderOpen,
  Globe,
  Link2,
  Maximize2,
  RotateCw,
} from "lucide-react";
import { isMyGo, runtime } from "mygo-runtime";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { api, APIError } from "@/api/client";
import { Dialogs } from "@/api/desktop.gen";
import { ErrorNotice, Loading } from "@/components/common";
import {
  ActionContextMenu,
  type MenuAction,
  type MenuAnchor,
} from "@/components/ui/action-context-menu";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { HtmlFrame } from "@/features/files/preview/HtmlFrame";
import { useEventCallback } from "@/hooks/useEventCallback";
import {
  htmlViewerURL,
  parseHtmlPreviewURL,
  type HtmlPreview,
} from "./chatFileLinks";

function previewFile(src: string) {
  const url = new URL(src, location.origin);
  url.searchParams.set("info", "true");
  return api<{ path: string; needsImages?: boolean }>(
    url.pathname.slice("/api".length) + url.search,
  );
}

function previewFileQuery(src?: string) {
  return queryOptions({
    queryKey: ["html-preview-file", src],
    queryFn: src ? () => previewFile(src) : skipToken,
    retry: false,
  });
}

function AttachmentImagesNotice({ src }: { src: string }) {
  const { t } = useTranslation();
  const { data } = useQuery(previewFileQuery(src));
  return data?.needsImages ? (
    <p
      role="note"
      className="border-b bg-muted px-3 py-1.5 text-xs text-muted-foreground"
    >
      {t("chat.htmlPreviewMissingImages")}
    </p>
  ) : null;
}

function PreviewFrame({
  src,
  title,
  className,
  loading,
}: HtmlPreview & { className: string; loading?: "lazy" }) {
  return (
    <>
      {src.startsWith("/api/attachments/") && (
        <AttachmentImagesNotice src={src} />
      )}
      <HtmlFrame
        src={src}
        title={title}
        className={className}
        loading={loading}
      />
    </>
  );
}

type PreviewMenu = {
  preview: HtmlPreview;
  anchor: MenuAnchor;
  inline?: () => void;
};
export const ChatPreviewEndpoint = createContext<string | undefined>(undefined);
export const HtmlPreviewContext = createContext<{
  menu: (preview: HtmlPreview, anchor: MenuAnchor, inline?: () => void) => void;
  quick: (preview: HtmlPreview, trigger: HTMLElement) => void;
} | null>(null);

export function PreviewMenuButton({ preview }: { preview: HtmlPreview }) {
  const actions = useContext(HtmlPreviewContext);
  const { t } = useTranslation();
  if (!actions) return null;
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      aria-label={t("chat.htmlPreviewMenu")}
      aria-haspopup="menu"
      title={t("chat.htmlPreviewMenu")}
      onClick={({ currentTarget: trigger }) => {
        const rect = trigger.getBoundingClientRect();
        actions.menu(preview, { trigger, x: rect.left, y: rect.bottom });
      }}
    >
      <Ellipsis />
    </Button>
  );
}

function PreviewMenuItems({
  menu,
  close,
  onTab,
  onQuick,
}: {
  menu: PreviewMenu;
  close: (restoreFocus: boolean) => void;
  onTab?: () => void;
  onQuick?: () => void;
}) {
  const { t } = useTranslation();
  const desktop = isMyGo();
  const { src } = menu.preview;
  const file = useQuery(previewFileQuery(src));
  if (desktop && file.isLoading) return null;
  const viewer = htmlViewerURL(src);
  const items: MenuAction[] = [];
  if (menu.inline)
    items.push({
      id: "inline",
      label: t("chat.htmlPreviewInline"),
      icon: Eye,
      run: menu.inline,
    });
  if (onTab)
    items.push({
      id: "tab",
      label: t("chat.htmlPreviewTab"),
      icon: Globe,
      restoreFocus: false,
      run: onTab,
    });
  if (onQuick)
    items.push({
      id: "quick",
      label: t("chat.htmlPreviewQuick"),
      icon: Maximize2,
      restoreFocus: false,
      run: onQuick,
    });
  items.push({
    id: "external",
    label: t(desktop ? "browser.external" : "chat.htmlPreviewBrowserTab"),
    icon: ExternalLink,
    run: () => {
      if (desktop) return Dialogs.openPreviewInBrowser(viewer);
      window.open(viewer, "_blank", "noopener,noreferrer");
    },
  });
  if (file.data)
    items.push({
      id: "copy-path",
      label: t("files.copyPath"),
      icon: Copy,
      run: async () => {
        if (desktop) await Dialogs.writeClipboard(file.data.path, "");
        else await navigator.clipboard.writeText(file.data.path);
        toast.success(t("chat.copied"));
      },
    });
  if (desktop && file.isSuccess)
    items.push({
      id: "reveal",
      label: t(
        runtime().platform === "darwin"
          ? "files.revealInFinder"
          : "files.revealInFileManager",
      ),
      icon: FolderOpen,
      run: async () => Dialogs.showItemInFolder((await previewFile(src)).path),
    });
  if (desktop)
    items.push({
      id: "pair",
      label: t("chat.htmlPreviewPairBrowser"),
      icon: Link2,
      run: () => Dialogs.pairSystemBrowser(),
    });
  return (
    <ActionContextMenu
      point={menu.anchor}
      label={t("chat.htmlPreviewMenu")}
      actions={items}
      onClose={close}
    />
  );
}

export function HtmlPreviewHost({
  children,
  onOpenTab,
}: {
  children: ReactNode;
  onOpenTab?: (preview: HtmlPreview, file: string) => void;
}) {
  const { t } = useTranslation();
  const [menu, setMenu] = useState<PreviewMenu>();
  const [quick, setQuick] = useState<HtmlPreview>();
  const quickTitle = useRef<HTMLHeadingElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const open = useEventCallback(async (preview: HtmlPreview) => {
    try {
      const { path } = await previewFile(preview.src);
      returnFocus.current = null;
      setQuick(undefined);
      onOpenTab?.(preview, path);
    } catch (error) {
      toast.error(
        error instanceof APIError && error.status === 404
          ? t("chat.htmlPreviewUnavailable")
          : String(error),
      );
    }
  });
  const actions = useMemo(
    () => ({
      menu: (preview: HtmlPreview, anchor: MenuAnchor, inline?: () => void) =>
        setMenu({ preview, anchor, inline }),
      quick: (preview: HtmlPreview, trigger: HTMLElement) => {
        returnFocus.current = trigger;
        setQuick(preview);
      },
    }),
    [],
  );
  const popup = menu && (
    <PreviewMenuItems
      menu={menu}
      close={(restore) => {
        setMenu(undefined);
        if (restore) menu.anchor.trigger.focus({ preventScroll: true });
      }}
      onTab={onOpenTab && (() => void open(menu.preview))}
      onQuick={
        !quick
          ? () => actions.quick(menu.preview, menu.anchor.trigger)
          : undefined
      }
    />
  );
  return (
    <HtmlPreviewContext.Provider value={actions}>
      {children}
      {quick ? (
        <Dialog
          open
          onOpenChange={(value) => {
            if (!value) setQuick(undefined);
          }}
        >
          <DialogContent
            className="flex h-[calc(100dvh-2rem)] flex-col gap-2 pt-3 sm:max-w-[calc(100%-2rem)]"
            aria-describedby={undefined}
            onOpenAutoFocus={(event) => {
              event.preventDefault();
              quickTitle.current?.focus();
            }}
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              returnFocus.current?.focus({ preventScroll: true });
            }}
          >
            <div className="flex min-w-0 items-center gap-2 pr-8">
              <DialogTitle
                ref={quickTitle}
                tabIndex={-1}
                className="min-w-0 flex-1 truncate outline-none"
              >
                {quick.title}
              </DialogTitle>
              <PreviewMenuButton preview={quick} />
            </div>
            <PreviewFrame
              className="chat-visualization-frame min-h-0 w-full flex-1 rounded-md border"
              {...quick}
            />
            {popup}
          </DialogContent>
        </Dialog>
      ) : (
        popup
      )}
    </HtmlPreviewContext.Provider>
  );
}

export function HtmlPreviewPanel({
  preview,
  onCollapse,
}: {
  preview: HtmlPreview;
  onCollapse?: () => void;
}) {
  const { t } = useTranslation();
  const [revision, setRevision] = useState(0);
  return (
    <section
      className="flex h-full min-h-0 flex-col"
      aria-label={preview.title}
    >
      <header className="flex min-w-0 items-center gap-1 border-b py-1 pr-2 pl-3">
        <span className="min-w-0 flex-1 truncate text-sm" title={preview.title}>
          {preview.title}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={t("browser.reload")}
          title={t("browser.reload")}
          onClick={() => setRevision((value) => value + 1)}
        >
          <RotateCw />
        </Button>
        <PreviewMenuButton preview={preview} />
        {onCollapse && (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={t("chat.htmlPreviewCollapse")}
            title={t("chat.htmlPreviewCollapse")}
            onClick={onCollapse}
          >
            <ChevronUp />
          </Button>
        )}
      </header>
      <PreviewFrame
        key={revision}
        loading={onCollapse ? "lazy" : undefined}
        className="chat-visualization-frame min-h-0 w-full flex-1 border-0"
        {...preview}
      />
    </section>
  );
}

export function StandaloneHtmlPreview() {
  const { t } = useTranslation();
  const preview = parseHtmlPreviewURL(location.href, location.origin);
  const title = preview?.title;
  useEffect(() => {
    if (title) document.title = title;
  }, [title]);
  const file = useQuery(previewFileQuery(preview?.src));
  if (!preview || file.isError)
    return (
      <main className="p-6">
        <ErrorNotice
          error={
            !preview ||
            (file.error instanceof APIError && file.error.status === 404)
              ? t("chat.htmlPreviewUnavailable")
              : file.error instanceof APIError && file.error.status === 401
                ? t("chat.htmlPreviewPairHint")
                : file.error
          }
          retry={preview ? () => void file.refetch() : undefined}
        />
      </main>
    );
  if (!file.isSuccess) return <Loading />;
  return (
    <main className="flex h-dvh flex-col">
      <PreviewFrame
        className="chat-visualization-frame min-h-0 w-full flex-1 border-0"
        {...preview}
      />
    </main>
  );
}
