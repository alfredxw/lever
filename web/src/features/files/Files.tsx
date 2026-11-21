import { useTranslation } from "react-i18next";
import {
  lazy,
  Suspense,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useQuery } from "@tanstack/react-query";
import {
  AlertCircle,
  Copy,
  Download,
  Eye,
  FileCode,
  Folders,
  MoreHorizontal,
  RefreshCw,
  Save,
  Search,
  WrapText,
} from "lucide-react";
import { toast } from "sonner";
import type { Scope } from "@/api/types.gen";
import { APIError } from "@/api/client";
import { cn } from "@/lib/utils";
import { useCompactPanel } from "@/hooks/useCompactPanel";
import { Button } from "@/components/ui/button";
import { ErrorNotice, Loading } from "@/components/common";
import { MarkdownPreview } from "./MarkdownPreview";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  ariaShortcut,
  fileSaveShortcut,
  useShortcutListener,
} from "@/features/settings/shortcuts";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  fileContentQuery,
  fileSaveError,
  fileURL,
  isFileConflict,
  useFileDraft,
} from "./fileDrafts";
import { FileToolbar } from "./FileToolbar";
import { ToolbarButton } from "@/components/ui/toolbar-button";
import { FileSidebar } from "./FileSidebar";
import {
  absoluteFilePath,
  type FileSelection,
  type DirectorySelection,
} from "./filePaths";
import { savedPreference, useFilePreviewMode } from "./filePreferences";
import {
  FileSourceContext,
  fileReadOnly,
  isSkillEntry,
  useFileSource,
  type FileSource,
} from "./fileSource";
import { relocateEntry, useEntryChanges } from "./fileOperations";
import { fileKind, isTextKind } from "./preview/fileKind";
import { HtmlFrame } from "./preview/HtmlFrame";
import {
  PreviewDownload,
  PreviewUnavailable,
} from "./preview/PreviewUnavailable";
import "./preview/preview.css";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogClose,
} from "@/components/ui/dialog";

const FileEditor = lazy(() => import("./Editor"));
const AssetPreview = lazy(() => import("./preview/AssetPreview"));
const RichTextPreview = lazy(() => import("./preview/RichTextPreview"));

type SidebarMode = "path" | "content";
type SidebarView = SidebarMode | "closed";

export function Files({
  source,
  scope,
  dark,
  initialFile,
  initialDirectoryOpen = true,
  initialPreview,
  active,
  actions,
}: {
  source: FileSource;
  scope: Scope;
  dark: boolean;
  initialFile?: FileSelection;
  initialDirectoryOpen?: boolean;
  initialPreview?: boolean;
  active: boolean;
  actions?: ReactNode;
}) {
  const { t } = useTranslation();
  const panel = useRef<HTMLDivElement>(null);
  const directoryToggle = useRef<HTMLButtonElement>(null);
  const [file, setFile] = useState<FileSelection | undefined>(initialFile);
  const [directory, setDirectory] = useState<DirectorySelection | undefined>(
    () =>
      initialFile && {
        root: initialFile.root,
        path: initialFile.path.split("/").slice(0, -1).join("/") || ".",
      },
  );
  const compact = useCompactPanel(panel);
  const [wideSidebar, setWideSidebar] = useState<SidebarView>(
    initialDirectoryOpen ? "path" : "closed",
  );
  const [compactSidebar, setCompactSidebar] = useState<SidebarView>();
  const sidebarView = compact
    ? (compactSidebar ?? (file ? "closed" : "path"))
    : wideSidebar;
  const showSidebar = sidebarView !== "closed";
  const [wordWrap, setWordWrap] = useState(() => savedPreference("wrap", true));
  const [preview, setPreview] = useFilePreviewMode(initialPreview);
  useEntryChanges((change) => {
    setFile((current) => relocateEntry(current, change));
    setDirectory((current) => relocateEntry(current, change));
  });
  useEffect(() => {
    try {
      localStorage.setItem("lever:files:wrap", String(wordWrap));
    } catch {
      /* View preferences are optional in restricted webviews. */
    }
  }, [wordWrap]);
  const selectFile = (next: FileSelection) => {
    setFile(next);
    if (compact) {
      if (
        panel.current
          ?.querySelector(".file-sidebar")
          ?.contains(document.activeElement)
      )
        requestAnimationFrame(() => directoryToggle.current?.focus());
      setCompactSidebar(undefined);
    }
    setDirectory({
      root: next.root,
      path: next.path.split("/").slice(0, -1).join("/") || ".",
    });
  };
  useEffect(() => {
    if (initialFile) selectFile(initialFile);
  }, [initialFile]);
  const toggleSidebar = (mode: SidebarMode) => {
    const setSidebar = compact ? setCompactSidebar : setWideSidebar;
    setSidebar(sidebarView === mode ? "closed" : mode);
  };
  const navigation = (
    <>
      {actions}
      <ToolbarButton
        label={t("files.search")}
        active={sidebarView === "content"}
        onClick={() => toggleSidebar("content")}
      >
        <Search />
      </ToolbarButton>
      <ToolbarButton
        ref={directoryToggle}
        label={t(
          sidebarView === "path"
            ? "files.hideDirectory"
            : "files.showDirectory",
        )}
        active={sidebarView === "path"}
        onClick={() => toggleSidebar("path")}
      >
        <Folders />
      </ToolbarButton>
    </>
  );
  const sidebar = (
    <FileSidebar
      scope={scope}
      mode={sidebarView === "closed" ? "path" : sidebarView}
      hidden={!showSidebar}
      selected={file}
      directory={directory}
      onFile={selectFile}
    />
  );
  return (
    <FileSourceContext.Provider value={source}>
      <TooltipProvider delayDuration={350}>
        <div
          className={cn("files-panel", showSidebar && "has-sidebar")}
          ref={panel}
        >
          {file ? (
            <FilePreview
              key={JSON.stringify([
                source.kind,
                source.id,
                file.root.id,
                file.root.path,
                file.path,
              ])}
              file={file}
              dark={dark}
              active={active}
              navigation={navigation}
              wordWrap={wordWrap}
              setWordWrap={setWordWrap}
              preview={preview}
              setPreview={(value) => {
                setPreview(value);
                setFile(
                  (current) => current && { ...current, location: undefined },
                );
              }}
              onFile={selectFile}
            />
          ) : (
            <>
              <FileToolbar
                root={
                  scope.roots.find((root) => root.id === scope.primaryRootId) ??
                  scope.roots[0]
                }
                onFile={selectFile}
              >
                {navigation}
              </FileToolbar>
              <main className="file-preview">
                <Empty>
                  <EmptyHeader>
                    <EmptyMedia variant="icon">
                      <FileCode />
                    </EmptyMedia>
                    <EmptyTitle>{t("files.browse")}</EmptyTitle>
                    <EmptyDescription>{t("files.select")}</EmptyDescription>
                  </EmptyHeader>
                </Empty>
              </main>
            </>
          )}
          {sidebar}
        </div>
      </TooltipProvider>
    </FileSourceContext.Provider>
  );
}

function FilePreview({
  file,
  dark,
  active,
  navigation,
  wordWrap,
  setWordWrap,
  preview,
  setPreview,
  onFile,
}: {
  file: FileSelection;
  dark: boolean;
  active: boolean;
  navigation: ReactNode;
  wordWrap: boolean;
  setWordWrap: (value: boolean) => void;
  preview: boolean;
  setPreview: (value: boolean) => void;
  onFile: (file: FileSelection) => void;
}) {
  const { t } = useTranslation();
  const source = useFileSource();
  const { root, path, location } = file;
  const target = { source, root, path };
  const kind = fileKind(path);
  const editable = isTextKind(kind);
  const writable = editable && !fileReadOnly(source);
  const richText = editable && kind !== "text";
  const [revision, setRevision] = useState(0);
  const resource = `/api${fileURL(target)}`;
  const content = useQuery({
    ...fileContentQuery(target),
    enabled: editable,
  });
  const {
    draft,
    changingFile,
    change,
    save,
    reload: reloadDraft,
  } = useFileDraft(target, content.data);
  const [confirmReload, setConfirmReload] = useState(false);
  const data = draft?.base ?? content.data;
  const unsupported =
    content.error instanceof APIError && content.error.status === 415;
  const text = draft?.content ?? data?.content;
  const showPreview = richText && preview && !location;
  const showSource = !showPreview && !!data;
  const [sourceOpened, setSourceOpened] = useState(false);
  useEffect(() => {
    if (showSource) setSourceOpened(true);
  }, [showSource]);
  const conflict = isFileConflict(draft?.error);
  const fileBusy =
    draft?.saving || draft?.reloading || content.isFetching || changingFile;
  const canSave =
    writable &&
    !!draft &&
    !draft.saving &&
    !draft.reloading &&
    !conflict &&
    !data?.truncated &&
    !changingFile;
  useShortcutListener(
    (shortcut) => {
      if (shortcut !== fileSaveShortcut) return;
      if (canSave) save();
      return true;
    },
    active && writable && !unsupported,
  );
  const reload = async () => {
    setConfirmReload(false);
    if (kind === "html") setRevision((value) => value + 1);
    if (!editable) {
      setRevision((value) => value + 1);
    } else if (!draft) {
      void content.refetch();
    } else {
      try {
        await reloadDraft();
      } catch (error) {
        toast.error(t("files.reloadFailed"), {
          description: fileSaveError(error),
        });
      }
    }
  };
  const downloadDraft = () => {
    if (!draft) return;
    const url = URL.createObjectURL(
      new Blob([draft.content], { type: "text/plain;charset=utf-8" }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = `${path.split("/").at(-1)}.draft`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const copy = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      toast.success(t("chat.copied"));
    } catch {
      toast.error(t("chat.copyFailed"));
    }
  };
  return (
    <>
      <FileToolbar root={root} path={path} onFile={onFile}>
        {(!writable || data?.truncated || draft) && (
          <span className="file-save-status" role="status" data-dirty={!!draft}>
            {!writable || data?.truncated
              ? t("files.readOnly")
              : draft?.reloading
                ? t("common.loading")
                : draft?.saving
                  ? t("files.saving")
                  : t("files.unsaved")}
          </span>
        )}
        {richText && (
          <ToolbarButton
            label={t(showPreview ? "files.showSource" : "files.preview")}
            active={showPreview}
            disabled={!data}
            onClick={() => setPreview(!showPreview)}
          >
            <Eye />
          </ToolbarButton>
        )}
        {editable && !unsupported && (
          <ToolbarButton
            label={t(wordWrap ? "files.disableWrap" : "files.enableWrap")}
            active={wordWrap}
            disabled={showPreview}
            onClick={() => setWordWrap(!wordWrap)}
          >
            <WrapText />
          </ToolbarButton>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <ToolbarButton label={t("files.more")}>
              <MoreHorizontal />
            </ToolbarButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-56">
            <DropdownMenuGroup>
              <DropdownMenuItem
                onSelect={() => void copy(absoluteFilePath(file))}
              >
                <Copy />
                {t("files.copyPath")}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => void copy(path)}>
                <Copy />
                {t("files.copyRelativePath")}
              </DropdownMenuItem>
              {editable && !unsupported && (
                <DropdownMenuItem
                  disabled={text === undefined}
                  onSelect={() => void copy(text ?? "")}
                >
                  <Copy />
                  {t("files.copyContents")}
                </DropdownMenuItem>
              )}
              <DropdownMenuItem asChild>
                <a
                  href={`${resource}&download=true`}
                  download={path.split("/").at(-1)}
                >
                  <Download />
                  {t("files.download")}
                </a>
              </DropdownMenuItem>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              {writable && !unsupported && (
                <DropdownMenuItem
                  disabled={!canSave}
                  aria-keyshortcuts={ariaShortcut(fileSaveShortcut)}
                  onSelect={save}
                >
                  <Save />
                  {t("files.save")}
                </DropdownMenuItem>
              )}
              <DropdownMenuItem
                disabled={fileBusy}
                onSelect={() =>
                  draft ? setConfirmReload(true) : void reload()
                }
              >
                <RefreshCw />
                {t("files.refresh")}
              </DropdownMenuItem>
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
        {navigation}
      </FileToolbar>
      <main className="file-preview">
        <PreviewDownload.Provider value={`${resource}&download=true`}>
          {conflict ? (
            <div role="alert" className="error-notice flex-wrap">
              <AlertCircle size={16} />
              <span className="min-w-0 basis-44">{t("files.conflict")}</span>
              <div className="ml-auto flex flex-wrap gap-2">
                <Button variant="outline" size="sm" onClick={downloadDraft}>
                  {t("files.downloadDraft")}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={fileBusy}
                  onClick={() => setConfirmReload(true)}
                >
                  {t("files.reloadDisk")}
                </Button>
              </div>
            </div>
          ) : (
            !!draft?.error && (
              <ErrorNotice error={fileSaveError(draft.error)} retry={save} />
            )
          )}
          {content.error &&
            (unsupported ? (
              <PreviewUnavailable />
            ) : (
              <ErrorNotice
                error={content.error}
                retry={() => void content.refetch()}
              />
            ))}
          {!editable ? (
            <Suspense fallback={<Loading />}>
              <AssetPreview
                key={revision}
                kind={kind}
                src={`${resource}&raw=true&revision=${revision}`}
                name={path}
              />
            </Suspense>
          ) : !data ? (
            content.isPending && <Loading />
          ) : (
            <>
              {data.truncated && (
                <div className="file-warning">{t("files.truncated")}</div>
              )}
              {showPreview && kind === "markdown" && (
                <article
                  className="file-markdown"
                  aria-label={t("files.preview")}
                >
                  <MarkdownPreview
                    file={file}
                    text={
                      isSkillEntry(source, path)
                        ? (text ?? "").replace(
                            /^\uFEFF?---[ \t]*\r?\n(?:[^\n]*\n)*?(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/,
                            "",
                          )
                        : (text ?? "")
                    }
                    onFile={onFile}
                  />
                </article>
              )}
              {showPreview && kind === "html" && !draft && !data.truncated ? (
                <HtmlFrame
                  className="file-document-frame"
                  title={path}
                  src={`${resource}&preview=html&revision=${revision}&version=${data.version ?? ""}`}
                />
              ) : (
                showPreview &&
                (kind === "html" || kind === "mermaid" || kind === "table") && (
                  <Suspense fallback={<Loading />}>
                    <RichTextPreview
                      kind={kind}
                      text={text ?? ""}
                      name={path}
                    />
                  </Suspense>
                )
              )}
              {(!showPreview || sourceOpened) && (
                <div className="editor-host" hidden={showPreview}>
                  <Suspense fallback={<Loading />}>
                    <FileEditor
                      path={path}
                      content={text ?? ""}
                      dark={dark}
                      readOnly={
                        !writable ||
                        data.truncated ||
                        content.isFetching ||
                        !!draft?.reloading ||
                        changingFile
                      }
                      wordWrap={wordWrap}
                      selection={location}
                      onChange={change}
                      active={active && !showPreview}
                    />
                  </Suspense>
                </div>
              )}
            </>
          )}
        </PreviewDownload.Provider>
      </main>
      <Dialog open={confirmReload} onOpenChange={setConfirmReload}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("files.reloadTitle")}</DialogTitle>
            <DialogDescription>
              {t("files.reloadDescription")}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline">{t("files.keepEditing")}</Button>
            </DialogClose>
            <Button variant="destructive" disabled={fileBusy} onClick={reload}>
              {t("files.discardReload")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
