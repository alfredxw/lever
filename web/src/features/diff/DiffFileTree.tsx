import { useLayoutEffect, useRef } from "react";
import { prepareFileTreeInput } from "@pierre/trees";
import { FileTree, useFileTree } from "@pierre/trees/react";
import { useTranslation } from "react-i18next";
import type { DiffFile } from "@/api/types.gen";

export function prepareDiffFileTree(files: DiffFile[]) {
  // Pierre drops leading slashes. Keep an absolute Codex path distinct
  // from its relative spelling and map selections back to the actual file.
  const paths = files.map((file) =>
    file.path.startsWith("/") ? `\u200b${file.path}` : file.path,
  );
  const directories = new Set<string>();
  for (const path of paths) {
    const parts = path.split("/");
    for (let i = 1; i < parts.length; i++)
      directories.add(parts.slice(0, i).join("/"));
  }
  const occupied = new Set(paths);
  const entries = new Map(
    files.map((file, index) => {
      let path = paths[index];
      // A Git change can replace a file with a directory (or vice versa).
      // Pierre needs distinct paths; only the tree gets the invisible alias.
      if (directories.has(path)) {
        do path += "\u200b";
        while (occupied.has(path));
        occupied.add(path);
      }
      return [path, file];
    }),
  );
  const preparedInput = prepareFileTreeInput([...entries.keys()]);
  return {
    entries,
    preparedInput,
    files: preparedInput.paths.map((path) => entries.get(path)!),
  };
}

export function DiffFileTree({
  tree,
  selected,
  viewed,
  commentCounts,
  onSelect,
}: {
  tree: ReturnType<typeof prepareDiffFileTree>;
  selected?: string;
  viewed?: ReadonlySet<string>;
  commentCounts?: ReadonlyMap<string, number>;
  onSelect: (path: string) => void;
}) {
  const { t } = useTranslation();
  const { entries, preparedInput } = tree;
  const syncing = useRef(false);
  const live = useRef({ entries, onSelect, viewed, commentCounts });
  live.current = { entries, onSelect, viewed, commentCounts };
  const { model } = useFileTree({
    paths: [],
    initialExpansion: "open",
    flattenEmptyDirectories: true,
    icons: { set: "complete", colored: true },
    search: false,
    dragAndDrop: false,
    renaming: false,
    onSelectionChange: (paths) => {
      if (syncing.current) return;
      const file = live.current.entries.get(paths.at(-1) ?? "");
      if (file) live.current.onSelect(file.path);
    },
    renderRowDecoration: ({ item }) => {
      const file = live.current.entries.get(item.path);
      if (!file) return null;
      const isViewed = live.current.viewed?.has(file.path) ?? false;
      const count = live.current.commentCounts?.get(file.path) ?? 0;
      const parts: { text: string; color?: string }[] = [];
      if (isViewed) {
        parts.push({ text: "✓", color: "var(--muted-foreground)" });
        parts.push({ text: "\u00a0\u00a0" });
      }
      parts.push(
        { text: `+${file.additions}`, color: "var(--diff-added)" },
        { text: `\u00a0−${file.deletions}`, color: "var(--diff-removed)" },
      );
      if (count > 0) {
        parts.push(
          { text: "\u00a0·\u00a0", color: "var(--muted-foreground)" },
          { text: String(count), color: "var(--foreground)" },
        );
      }
      return {
        text: parts.map((part) => part.text).join(""),
        parts,
      };
    },
  });
  useLayoutEffect(() => {
    model.setComposition(undefined);
  }, [model, viewed, commentCounts]);
  useLayoutEffect(() => {
    syncing.current = true;
    try {
      const closed = model
        .getVisibleRows(0, model.getVisibleCount() - 1)
        .filter((row) => row.kind === "directory" && !row.isExpanded);
      model.resetPaths({ preparedInput });
      for (const row of closed) {
        const item = model.getItem(row.path);
        if (item && "collapse" in item) item.collapse();
      }
      model.setGitStatus(
        [...entries].map(([path, file]) => ({
          path,
          status:
            file.status === "A"
              ? "added"
              : file.status === "D"
                ? "deleted"
                : "modified",
        })),
      );
    } finally {
      syncing.current = false;
    }
  }, [entries, model, preparedInput]);
  useLayoutEffect(() => {
    const path = [...entries].find(([, file]) => file.path === selected)?.[0];
    if (!path) return;
    syncing.current = true;
    try {
      for (const previous of model.getSelectedPaths())
        model.getItem(previous)?.deselect();
      const parts = path.split("/");
      for (let i = 1; i < parts.length; i++) {
        const item = model.getItem(parts.slice(0, i).join("/") + "/");
        if (item && "expand" in item) item.expand();
      }
      model.getItem(path)?.select();
      model.scrollToPath(path, { offset: "nearest" });
    } finally {
      syncing.current = false;
    }
  }, [entries, model, selected]);
  return (
    <FileTree
      model={model}
      className="pierre-file-tree diff-file-tree"
      aria-label={t("diff.changedFiles")}
      onClickCapture={(event) => {
        if (
          event.button !== 0 ||
          event.metaKey ||
          event.ctrlKey ||
          event.shiftKey
        )
          return;
        // Clicking the selected file should also reopen a collapsed diff.
        for (const node of event.nativeEvent.composedPath()) {
          if (!(node instanceof HTMLElement)) continue;
          const path = node.getAttribute("data-item-path");
          const file = path && entries.get(path);
          if (file && model.getSelectedPaths().includes(path))
            onSelect(file.path);
          if (path) break;
        }
      }}
    />
  );
}
