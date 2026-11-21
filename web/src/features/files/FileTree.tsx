import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  useQueries,
  useQueryClient,
  type UseQueryResult,
} from "@tanstack/react-query";
import { FileTree as PierreFileTree, useFileTree } from "@pierre/trees/react";
import { useTranslation } from "react-i18next";
import { api, APIError } from "@/api/client";
import { toast } from "sonner";
import type {
  ContextMenuOpenContext,
  ContextMenuItem,
  FileTreeRenameEvent,
  GitStatusEntry,
} from "@pierre/trees";
import type { FileEntry, Root } from "@/api/types.gen";
import { ErrorNotice, Loading } from "@/components/common";

import { FileContextMenu } from "./FileContextMenu";
import { DeleteEntryDialog } from "./DeleteEntryDialog";
import {
  changeEntry,
  relocateEntry,
  stageFile,
  useEntryChanges,
  useFileClipboard,
} from "./fileOperations";
import type { FileSelection, DirectorySelection } from "./filePaths";
import {
  fileEndpoint,
  fileEntriesQuery,
  fileReadOnly,
  fileScopeKey,
  fileSourceKey,
  isSkillEntry,
  useFileSource,
} from "./fileSource";

function combineDirectories(queries: UseQueryResult<FileEntry[]>[]) {
  return {
    entries: queries.flatMap((query) => query.data ?? []),
    pending: queries.some((query) => query.isPending),
    failures: queries.flatMap((query, index) =>
      query.error
        ? [{ error: query.error, refetch: query.refetch, index }]
        : [],
    ),
  };
}

/** A shared, lazily loaded Pierre tree for the sidebar and breadcrumb popovers. */
export function FileTree({
  root,
  path = ".",
  onFile,
  onDirectory,
  selected,
  expanded,
  onExpandedChange,
  creation,
  onCreationStarted,
}: {
  creation?: { target: DirectorySelection; directory: boolean };
  onCreationStarted?: () => void;
  root: Root;
  path?: string;
  onFile: (file: FileSelection) => void;
  onDirectory?: (directory: DirectorySelection) => void;
  selected?: FileSelection;
  expanded: Set<string>;
  onExpandedChange: (key: string, expanded: boolean) => void;
}) {
  const { t } = useTranslation();
  const source = useFileSource();
  const sourceKey = fileSourceKey(source);
  const scopeKey = fileScopeKey(source);
  const readOnly = fileReadOnly(source);
  const client = useQueryClient();
  const surface = useRef<HTMLDivElement>(null);
  const draft = useRef<{ path: string; directory: boolean } | undefined>(
    undefined,
  );
  const busy = useRef(false);
  const [revision, setRevision] = useState(0);
  const [deleting, setDeleting] = useState<DirectorySelection>();
  const [backgroundMenu, setBackgroundMenu] =
    useState<ContextMenuOpenContext>();
  const clipboard = useFileClipboard();
  useEntryChanges((change) => {
    if (root.path !== change.root.path) return;
    for (const key of expanded) {
      if (!key.startsWith(`${root.id}:`)) continue;
      const old = { root, path: key.slice(root.id.length + 1) };
      const next = relocateEntry(old, change);
      if (next !== old) {
        onExpandedChange(key, false);
        if (next) onExpandedChange(`${root.id}:${next.path}`, true);
      }
    }
  });
  const reveal = (entry: FileEntry) => {
    const next = { root, path: entry.path };
    const parts = entry.path
      .split("/")
      .slice(0, entry.directory ? undefined : -1);
    parts.forEach((_, index) =>
      onExpandedChange(
        `${root.id}:${parts.slice(0, index + 1).join("/")}`,
        true,
      ),
    );
    if (entry.directory) onDirectory?.(next);
    else onFile(next);
  };
  const prefix = path === "." ? "" : `${path}/`;
  const directories = [
    path,
    ...Array.from(expanded)
      .filter((key) => key.startsWith(`${root.id}:`))
      .map((key) => key.slice(root.id.length + 1))
      .filter((entry) => entry !== path && entry.startsWith(prefix)),
  ];
  const { entries, pending, failures } = useQueries({
    queries: directories.map((directory) =>
      fileEntriesQuery(source, root, directory),
    ),
    combine: combineDirectories,
  });
  const { paths, gitStatus } = useMemo(() => {
    const available = new Set(
      entries.filter((entry) => entry.directory).map((entry) => entry.path),
    );
    const paths: string[] = [];
    const gitStatus: GitStatusEntry[] = [];
    for (const entry of entries) {
      // A refresh can remove an ancestor while its old child query is cached.
      const parts = entry.path.split("/").slice(0, -1);
      const hasParents = parts.every((_, index) => {
        const parent = parts.slice(0, index + 1).join("/");
        return (
          !parent.startsWith(prefix) || parent === path || available.has(parent)
        );
      });
      if (!hasParents) continue;
      const treePath =
        entry.path.slice(prefix.length) + (entry.directory ? "/" : "");
      paths.push(treePath);
      if (entry.gitIgnored)
        gitStatus.push({ path: treePath, status: "ignored" });
    }
    return { paths, gitStatus };
  }, [entries, path, prefix]);
  const failed = failures.find(
    ({ index }) =>
      index === 0 ||
      paths.includes(directories[index].slice(prefix.length) + "/"),
  );
  const syncing = useRef(false);
  const canRename = (path: string) =>
    !busy.current && !readOnly && !isSkillEntry(source, prefix + path);
  const live = useRef({
    onFile,
    onDirectory,
    onExpandedChange,
    expanded,
    root,
    prefix,
    rename: applyRename,
    renameError,
    acceptSuggestedName,
    canRename,
  });
  live.current = {
    onFile,
    onDirectory,
    onExpandedChange,
    expanded,
    root,
    prefix,
    rename: applyRename,
    renameError,
    acceptSuggestedName,
    canRename,
  };
  const { model } = useFileTree({
    paths: [],
    initialExpansion: "closed",
    flattenEmptyDirectories: false,
    icons: { set: "complete", colored: true },
    // An ignored child should not show a change badge on its parent.
    unsafeCSS: `[data-item-section="git"] { display: none; }`,
    search: false,
    dragAndDrop: false,
    renaming: {
      canRename: (item) => live.current.canRename(item.path),
      onRename: (event) => void live.current.rename(event),
      onError: (error) => live.current.renameError(error),
    },
    composition: { contextMenu: { enabled: true, triggerMode: "right-click" } },
    onSelectionChange: (selection) => {
      if (syncing.current || busy.current || draft.current) return;
      const current = live.current;
      const selectedPath = selection.at(-1);
      if (!selectedPath) return;
      const target = {
        root: current.root,
        path: current.prefix + selectedPath.replace(/\/$/, ""),
      };
      if (selectedPath.endsWith("/")) current.onDirectory?.(target);
      else current.onFile(target);
    },
  });
  function renameError(error: unknown) {
    toast.error(
      error instanceof APIError && error.status === 409
        ? t("files.createConflict")
        : error instanceof Error
          ? error.message
          : String(error),
    );
    draft.current = undefined;
    setRevision((value) => value + 1);
  }
  async function applyRename(event: FileTreeRenameEvent) {
    const creating =
      draft.current?.path.replace(/\/$/, "") === event.sourcePath;
    draft.current = undefined;
    busy.current = true;
    const target = { root, path: prefix + event.sourcePath };
    const destination = prefix + event.destinationPath;
    try {
      if (creating) {
        const entry = await api<FileEntry>(
          fileEndpoint(source, "files", { root: root.id, path: destination }),
          { rootPath: root.path, directory: event.isFolder },
        );
        await Promise.all(
          ["files", "file-search", "diff"].map((key) =>
            client.invalidateQueries({ queryKey: [key] }),
          ),
        );
        reveal(entry);
      } else {
        await changeEntry(source, target, "move", destination);
      }
    } catch (error) {
      renameError(error);
    } finally {
      busy.current = false;
      setRevision((value) => value + 1);
    }
  }
  function beginCreate(directory: boolean, parent: string) {
    if (busy.current || readOnly) return;
    if (draft.current) {
      model.remove(draft.current.path, { recursive: true });
      draft.current = undefined;
    }
    const base = t(directory ? "files.untitledFolder" : "files.untitledFile");
    const localParent = parent === "." ? "" : `${parent}/`.slice(prefix.length);
    let placeholder = `${localParent}${base}${directory ? "/" : ""}`;
    for (let n = 2; model.getItem(placeholder); n++)
      placeholder = `${localParent}${base} ${n}${directory ? "/" : ""}`;
    draft.current = { path: placeholder, directory };
    model.add(placeholder);
    if (!model.startRenaming(placeholder, { removeIfCanceled: true })) {
      model.remove(placeholder, { recursive: true });
      draft.current = undefined;
    }
  }
  // Pierre emits onRename only when the name changes. Accepting the suggested
  // name of a new entry still needs to create it, on Enter or focus leaving.
  function acceptSuggestedName(event: Event) {
    const input = event
      .composedPath()
      .find(
        (node): node is HTMLInputElement =>
          node instanceof HTMLInputElement &&
          node.hasAttribute("data-item-rename-input"),
      );
    const pending = draft.current;
    if (
      pending &&
      input &&
      input.value === pending.path.replace(/\/$/, "").split("/").at(-1)
    ) {
      const path = pending.path.replace(/\/$/, "");
      void applyRename({
        sourcePath: path,
        destinationPath: path,
        isFolder: pending.directory,
      });
    }
  }
  useEffect(() => {
    // Native blur capture runs before Pierre removes its inline input. React's
    // focusout handler runs after that handoff and cannot see the input anymore.
    const element = surface.current!;
    const accept = (event: Event) => {
      if (
        event instanceof KeyboardEvent &&
        (event.key !== "Enter" || event.isComposing || event.keyCode === 229)
      )
        return;
      live.current.acceptSuggestedName(event);
    };
    element.addEventListener("blur", accept, true);
    element.addEventListener("keydown", accept, true);
    return () => {
      element.removeEventListener("blur", accept, true);
      element.removeEventListener("keydown", accept, true);
    };
  }, [model]);
  useEffect(
    () =>
      model.onMutation("remove", ({ path }) => {
        if (draft.current?.path === path) draft.current = undefined;
      }),
    [model],
  );
  useEffect(() => {
    if (!creation || creation.target.root.path !== root.path) return;
    beginCreate(creation.directory, creation.target.path);
    onCreationStarted?.();
  }, [creation]);
  useLayoutEffect(() => {
    if (busy.current) return;
    syncing.current = true;
    try {
      const selection = model.getSelectedPaths();
      const focused = model.getFocusedPath();
      model.resetPaths(draft.current ? [...paths, draft.current.path] : paths, {
        initialExpandedPaths: directories
          .slice(1)
          .map((directory) => directory.slice(prefix.length) + "/"),
      });
      model.setGitStatus(gitStatus);
      for (const path of selection) model.getItem(path)?.select();
      if (focused) model.focusPath(focused);
    } finally {
      syncing.current = false;
    }
  }, [model, paths, gitStatus, prefix, expanded, revision]);
  const selectedPath =
    selected?.root.id === root.id && selected.path.startsWith(prefix)
      ? selected.path.slice(prefix.length)
      : undefined;
  const selectedAvailable =
    selectedPath !== undefined && paths.includes(selectedPath);
  useLayoutEffect(() => {
    if (!selectedAvailable || !selectedPath || draft.current || busy.current)
      return;
    syncing.current = true;
    try {
      for (const path of model.getSelectedPaths())
        model.getItem(path)?.deselect();
      model.getItem(selectedPath)?.select();
      model.scrollToPath(selectedPath, { offset: "nearest" });
    } finally {
      syncing.current = false;
    }
  }, [model, selectedPath, selectedAvailable]);
  useEffect(
    () =>
      model.subscribe(() => {
        if (syncing.current) return;
        const current = live.current;
        for (const row of model.getVisibleRows(
          0,
          model.getVisibleCount() - 1,
        )) {
          if (row.kind !== "directory") continue;
          const directory = current.prefix + row.path.replace(/\/$/, "");
          const key = `${current.root.id}:${directory}`;
          if (row.isExpanded !== current.expanded.has(key))
            current.onExpandedChange(key, row.isExpanded);
        }
      }),
    [model],
  );
  const renderMenu = (
    item: ContextMenuItem,
    context: ContextMenuOpenContext,
  ) => {
    const background = item.path === ".";
    const target = {
      root,
      path: background ? path : prefix + item.path.replace(/\/$/, ""),
    };
    const directory = item.kind === "directory";
    const open = expanded.has(`${root.id}:${target.path}`);
    const parent = directory
      ? target.path
      : target.path.split("/").slice(0, -1).join("/") || ".";
    const canPaste =
      !!clipboard &&
      !readOnly &&
      clipboard.sourceKey === sourceKey &&
      clipboard.scopeKey === scopeKey &&
      clipboard.root.path === root.path;
    return (
      <FileContextMenu
        context={context}
        background={background}
        target={target}
        directory={directory}
        expanded={open}
        onOpen={() => {
          if (directory) {
            onDirectory?.(target);
            onExpandedChange(`${root.id}:${target.path}`, !open);
          } else onFile(target);
        }}
        onCreate={(directory) => beginCreate(directory, parent)}
        onRename={() => {
          model.startRenaming(item.path);
        }}
        onDelete={() => setDeleting(target)}
        onDuplicate={async () =>
          reveal(await changeEntry(source, target, "duplicate"))
        }
        onCopy={(cut) => stageFile({ ...target, sourceKey, scopeKey, cut })}
        canPaste={canPaste}
        onPaste={async () => {
          if (!canPaste || !clipboard) return;
          const name = clipboard.path.split("/").at(-1)!;
          const destination = parent === "." ? name : `${parent}/${name}`;
          if (clipboard.cut && destination === clipboard.path) {
            stageFile(undefined);
            return;
          }
          const operation = clipboard.cut
            ? "move"
            : destination === clipboard.path
              ? "duplicate"
              : "copy";
          const entry = await changeEntry(
            source,
            clipboard,
            operation,
            destination,
          );
          if (clipboard.cut) stageFile(undefined);
          reveal(entry);
        }}
        onRefresh={() => {
          void client.invalidateQueries({
            queryKey: ["files", sourceKey, root.id, root.path],
          });
          void client.invalidateQueries({
            queryKey: ["file-search", sourceKey],
          });
        }}
      />
    );
  };
  return (
    <div
      className="file-tree-surface"
      ref={surface}
      tabIndex={-1}
      onClickCapture={(event) => {
        // Pierre only emits a selection change for a different selection.
        // Activating the current file still opens it in the narrow layout.
        if (
          !selected ||
          !selectedAvailable ||
          busy.current ||
          draft.current ||
          event.button !== 0 ||
          event.metaKey ||
          event.ctrlKey ||
          event.shiftKey ||
          event.altKey
        )
          return;
        const current = event.nativeEvent
          .composedPath()
          .some(
            (node) =>
              node instanceof HTMLButtonElement &&
              node.dataset.itemPath === selectedPath &&
              node.getAttribute("aria-selected") === "true",
          );
        if (current) onFile(selected);
      }}
      onContextMenu={(event) => {
        if (
          event.nativeEvent
            .composedPath()
            .some(
              (node) =>
                node instanceof HTMLElement &&
                (node.getAttribute("role") === "treeitem" ||
                  node.tagName === "INPUT"),
            )
        )
          return;
        event.preventDefault();
        const anchor = event.currentTarget;
        setBackgroundMenu({
          anchorElement: anchor,
          anchorRect: DOMRect.fromRect({ x: event.clientX, y: event.clientY }),
          close: () => setBackgroundMenu(undefined),
          restoreFocus: () => anchor.focus(),
        });
      }}
    >
      {pending && !paths.length && <Loading />}
      {failed && (
        <ErrorNotice error={failed.error} retry={() => void failed.refetch()} />
      )}
      {!pending && !failed && paths.length === 0 && !draft.current && (
        <span className="tree-hint">{t("files.emptyDirectory")}</span>
      )}
      <PierreFileTree
        model={model}
        className="pierre-file-tree"
        aria-label={t("files.directory")}
        renderContextMenu={renderMenu}
      />
      {backgroundMenu &&
        renderMenu({ path: ".", name: "", kind: "directory" }, backgroundMenu)}
      {deleting && (
        <DeleteEntryDialog
          target={deleting}
          onClose={() => setDeleting(undefined)}
        />
      )}
    </div>
  );
}
