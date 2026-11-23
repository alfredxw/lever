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
import { cn } from "cn";
import {
  ChevronUp,
  Copy,
  Download,
  ExternalLink,
  Eye,
  FolderOpen,
  Globe,
  Maximize2,
  RotateCw,
  type LucideIcon,
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
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { ToolbarButton } from "@/components/ui/toolbar-button";
import { TooltipProvider } from "@/components/ui/tooltip";
import { HtmlFrame } from "@/features/files/preview/HtmlFrame";
import { useEventCallback } from "@/hooks/useEventCallback";
import { parseHtmlPreviewURL, type HtmlPreview } from "./chatFileLinks";

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

export async function openOriginalHtml(src: string) {
  const { path } = await previewFile(src);
  await Dialogs.openPreviewInBrowser(path, new URL(src, location.origin).hash);
}

function downloadOriginalHtml(src: string) {
  const url = new URL(src, location.origin);
  url.hash = "";
  url.searchParams.set("download", "true");
  const link = document.createElement("a");
  link.href = url.href;
  link.download = "";
  link.click();
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
  anchor: MenuAnchor;
  inline?: () => void;
};
type PreviewAction = Omit<MenuAction, "icon" | "run"> & {
  icon: LucideIcon;
  run: (trigger: HTMLElement) => void | Promise<unknown>;
};
export const ChatPreviewEndpoint = createContext<string | undefined>(undefined);
export const HtmlPreviewContext = createContext<{
  menu: (preview: HtmlPreview, anchor: MenuAnchor, inline?: () => void) => void;
  quick: (preview: HtmlPreview, trigger: HTMLElement) => void;
  openTab?: (preview: HtmlPreview) => void;
} | null>(null);

export function HtmlPreviewHeader({
  children,
  className,
}: {
  children: ReactNode;
  className: string;
}) {
  return (
    <TooltipProvider delayDuration={350}>
      <header
        className={cn("flex min-w-0 flex-wrap items-center gap-1", className)}
      >
        {children}
      </header>
    </TooltipProvider>
  );
}

export function HtmlPreviewActions({
  preview,
  expanded = false,
  menu,
}: {
  preview: HtmlPreview;
  expanded?: boolean;
  menu?: PreviewMenu & { close: (restoreFocus: boolean) => void };
}) {
  const host = useContext(HtmlPreviewContext);
  const { t } = useTranslation();
  const desktop = isMyGo();
  const { src } = preview;
  const file = useQuery(previewFileQuery(host ? src : undefined));
  if (!host || (menu && desktop && file.isLoading)) return null;
  const items: PreviewAction[] = [];
  if (menu?.inline)
    items.push({
      id: "inline",
      label: t("chat.htmlPreviewInline"),
      icon: Eye,
      run: menu.inline,
    });
  if (!expanded)
    items.push({
      id: "quick",
      label: t("chat.htmlPreviewQuick"),
      icon: Maximize2,
      restoreFocus: false,
      run: (trigger) => host.quick(preview, trigger),
    });
  if (host.openTab)
    items.push({
      id: "tab",
      label: t("chat.htmlPreviewTab"),
      icon: Globe,
      restoreFocus: false,
      run: () => host.openTab?.(preview),
    });
  items.push({
    id: desktop ? "external" : "download",
    label: t(desktop ? "browser.external" : "chat.htmlPreviewDownload"),
    icon: desktop ? ExternalLink : Download,
    disabled: !file.isSuccess,
    run: () => (desktop ? openOriginalHtml(src) : downloadOriginalHtml(src)),
  });
  items.push({
    id: "copy-path",
    label: t("files.copyPath"),
    icon: Copy,
    disabled: !file.isSuccess,
    run: async () => {
      if (!file.data) return;
      if (desktop) await Dialogs.writeClipboard(file.data.path, "");
      else await navigator.clipboard.writeText(file.data.path);
      toast.success(t("chat.copied"));
    },
  });
  if (desktop)
    items.push({
      id: "reveal",
      label: t(
        runtime().platform === "darwin"
          ? "files.revealInFinder"
          : "files.revealInFileManager",
      ),
      icon: FolderOpen,
      disabled: !file.isSuccess,
      run: async () => Dialogs.showItemInFolder((await previewFile(src)).path),
    });
  if (menu)
    return (
      <ActionContextMenu
        point={menu.anchor}
        label={t("chat.htmlPreviewMenu")}
        actions={items.map((item) => ({
          ...item,
          run: () => item.run(menu.anchor.trigger),
        }))}
        onClose={menu.close}
      />
    );
  return items.map(({ id, label, icon: Icon, disabled, run }) => (
    <ToolbarButton
      key={id}
      type="button"
      label={label}
      disabled={disabled}
      onClick={async ({ currentTarget }) => {
        try {
          await run(currentTarget);
        } catch (error) {
          toast.error(error instanceof Error ? error.message : String(error));
        }
      }}
    >
      <Icon />
    </ToolbarButton>
  ));
}

export function HtmlPreviewHost({
  children,
  onOpenTab,
}: {
  children: ReactNode;
  onOpenTab?: (preview: HtmlPreview, file: string) => void;
}) {
  const { t } = useTranslation();
  const [menu, setMenu] = useState<PreviewMenu & { preview: HtmlPreview }>();
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
  const openTab = onOpenTab ? open : undefined;
  const actions = useMemo(
    () => ({
      menu: (preview: HtmlPreview, anchor: MenuAnchor, inline?: () => void) =>
        setMenu({ preview, anchor, inline }),
      quick: (preview: HtmlPreview, trigger: HTMLElement) => {
        returnFocus.current = trigger;
        setQuick(preview);
      },
      openTab,
    }),
    [openTab],
  );
  const popup = menu && (
    <HtmlPreviewActions
      preview={menu.preview}
      expanded={!!quick}
      menu={{
        ...menu,
        close: (restore) => {
          setMenu(undefined);
          if (restore) menu.anchor.trigger.focus({ preventScroll: true });
        },
      }}
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
            <HtmlPreviewHeader className="pr-8">
              <DialogTitle
                ref={quickTitle}
                tabIndex={-1}
                className="min-w-0 flex-[1_1_6ch] truncate outline-none"
              >
                {quick.title}
              </DialogTitle>
              <HtmlPreviewActions preview={quick} expanded />
            </HtmlPreviewHeader>
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
      <HtmlPreviewHeader className="border-b py-1 pr-2 pl-3">
        <span
          className="min-w-0 flex-[1_1_6ch] truncate text-sm"
          title={preview.title}
        >
          {preview.title}
        </span>
        <ToolbarButton
          type="button"
          label={t("browser.reload")}
          onClick={() => setRevision((value) => value + 1)}
        >
          <RotateCw />
        </ToolbarButton>
        <HtmlPreviewActions preview={preview} />
        {onCollapse && (
          <ToolbarButton
            type="button"
            label={t("chat.htmlPreviewCollapse")}
            onClick={onCollapse}
          >
            <ChevronUp />
          </ToolbarButton>
        )}
      </HtmlPreviewHeader>
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
