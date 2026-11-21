import { useContext } from "react";
import type { ContextMenuOpenContext } from "@pierre/trees";
import {
  ChevronDown,
  ChevronRight,
  Copy,
  FilePlus2,
  FolderOpen,
  FolderPlus,
  RefreshCw,
  FileCode,
  MessageCircle,
  ExternalLink,
  AtSign,
  ClipboardPaste,
  CopyPlus,
  Scissors,
  Pencil,
  Trash2,
} from "lucide-react";
import { isMyGo, runtime } from "mygo-runtime";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Dialogs } from "@/api/desktop.gen";
import { ComposerContext } from "@/features/chat/ComposerContext";
import {
  ActionContextMenu,
  type MenuAction,
} from "@/components/ui/action-context-menu";
import {
  absoluteFilePath,
  fileReference,
  type DirectorySelection,
} from "./filePaths";
import { fileReadOnly, isSkillEntry, useFileSource } from "./fileSource";

const writeActions = new Set([
  "new-file",
  "new-folder",
  "cut",
  "copy",
  "paste",
  "duplicate",
  "rename",
  "delete",
]);
const moveActions = new Set(["cut", "rename", "delete"]);

export function FileContextMenu({
  context,
  background = false,
  target,
  directory,
  expanded,
  onOpen,
  onCreate,
  onRename,
  onDelete,
  onDuplicate,
  onCopy,
  onPaste,
  canPaste,
  onRefresh,
}: {
  context: ContextMenuOpenContext;
  background?: boolean;
  target: DirectorySelection;
  directory: boolean;
  expanded: boolean;
  onOpen: () => void;
  onCreate: (directory: boolean) => void;
  onRename: () => void;
  onDelete: () => void;
  onDuplicate: () => Promise<void>;
  onCopy: (cut: boolean) => void;
  onPaste: () => Promise<void>;
  canPaste: boolean;
  onRefresh: () => void;
}) {
  const { t } = useTranslation();
  const chat = useContext(ComposerContext);
  const source = useFileSource();
  const native = isMyGo();
  const absolute = absoluteFilePath(target);
  const reference = fileReference(target);
  const copy = async (text: string, markup = "") => {
    if (native) await Dialogs.writeClipboard(text, markup);
    else if (markup)
      await navigator.clipboard.write([
        new ClipboardItem({
          "text/plain": new Blob([text], { type: "text/plain" }),
          "text/html": new Blob([markup], { type: "text/html" }),
        }),
      ]);
    else await navigator.clipboard.writeText(text);
    toast.success(t("chat.copied"));
  };
  const entryActions: (MenuAction | null)[] = [
    {
      id: "open",
      label: t(
        directory
          ? expanded
            ? "files.collapseFolder"
            : "files.expandFolder"
          : "files.open",
      ),
      icon: directory ? (expanded ? ChevronRight : ChevronDown) : FileCode,
      restoreFocus: directory,
      run: onOpen,
    },
    ...(native
      ? [
          {
            id: "reveal",
            label: t(
              runtime().platform === "darwin"
                ? "files.revealInFinder"
                : "files.revealInFileManager",
            ),
            icon: FolderOpen,
            run: () => Dialogs.showItemInFolder(absolute),
          },
          {
            id: "open-external",
            label: t("files.openDefault"),
            icon: ExternalLink,
            run: () => Dialogs.openPath(absolute),
          },
        ]
      : []),
    ...[
      null,
      {
        id: "new-file",
        label: t("files.newFile"),
        icon: FilePlus2,
        restoreFocus: false,
        run: () => onCreate(false),
      },
      {
        id: "new-folder",
        label: t("files.newFolder"),
        icon: FolderPlus,
        restoreFocus: false,
        run: () => onCreate(true),
      },
    ],
    null,
    {
      id: "cut",
      label: t("files.cut"),
      icon: Scissors,
      run: () => onCopy(true),
    },
    {
      id: "copy",
      label: t("files.copy"),
      icon: Copy,
      run: () => onCopy(false),
    },
    {
      id: "paste",
      label: t("files.paste"),
      icon: ClipboardPaste,
      disabled: !canPaste,
      run: onPaste,
    },
    null,
    {
      id: "add-to-chat",
      label: t("files.addToChat"),
      icon: MessageCircle,
      disabled: !chat?.addToChat,
      restoreFocus: false,
      run: () => chat?.addToChat?.(reference),
    },
    {
      id: "copy-reference",
      label: t("files.copyReference"),
      icon: AtSign,
      run: () => {
        const span = document.createElement("span");
        span.dataset.leverReference = JSON.stringify(reference);
        span.textContent = `@${reference.name}`;
        return copy(`@${reference.name}`, span.outerHTML);
      },
    },
    null,
    {
      id: "copy-path",
      label: t("files.copyPath"),
      icon: Copy,
      run: () => copy(absolute),
    },
    {
      id: "copy-relative-path",
      label: t("files.copyRelativePath"),
      icon: Copy,
      run: () => copy(target.path),
    },
    {
      id: "duplicate",
      label: t("files.duplicate"),
      icon: CopyPlus,
      run: onDuplicate,
    },
    null,
    {
      id: "rename",
      label: t("files.rename"),
      icon: Pencil,
      restoreFocus: false,
      run: onRename,
    },
    {
      id: "delete",
      label: t("files.delete"),
      icon: Trash2,
      restoreFocus: false,
      run: onDelete,
    },
    ...(directory
      ? [
          null,
          {
            id: "refresh",
            label: t("files.refreshTree"),
            icon: RefreshCw,
            run: onRefresh,
          },
        ]
      : []),
  ];
  const actions = entryActions
    .filter((action) => {
      if (!action) return true;
      if (fileReadOnly(source) && writeActions.has(action.id)) return false;
      if (isSkillEntry(source, target.path) && moveActions.has(action.id))
        return false;
      if (
        source.kind === "skill" &&
        ["add-to-chat", "copy-reference"].includes(action.id)
      )
        return false;
      return true;
    })
    .filter(
      (action) =>
        !background ||
        !["open", "cut", "copy", "duplicate", "rename", "delete"].includes(
          action?.id ?? "",
        ),
    )
    .filter(
      (action, index, all) =>
        action ||
        (index > 0 && index < all.length - 1 && all[index - 1] !== null),
    );
  return (
    <ActionContextMenu
      actions={actions}
      point={{ x: context.anchorRect.left, y: context.anchorRect.bottom }}
      label={t("files.more")}
      onClose={(restoreFocus) => context.close({ restoreFocus })}
      attributes={{ "data-file-tree-context-menu-root": "true" }}
    />
  );
}
