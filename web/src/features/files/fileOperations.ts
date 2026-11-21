import { useEffect, useSyncExternalStore } from "react";
import { flushSync } from "react-dom";
import { api, APIError, queryClient } from "@/api/client";
import type { FileEntry } from "@/api/types.gen";
import i18n from "@/i18n";
import { withFileOperation } from "./fileDrafts";
import type { DirectorySelection } from "./filePaths";
import { fileEndpoint, type FileSource } from "./fileSource";

type Clipboard = DirectorySelection & {
  sourceKey: string;
  scopeKey?: string;
  cut: boolean;
};
export type EntryChange = DirectorySelection & { destination?: string };
let clipboard: Clipboard | undefined;
const clipboardListeners = new Set<() => void>();
const changeListeners = new Set<(change: EntryChange) => void>();

export function stageFile(value: Clipboard | undefined) {
  clipboard = value;
  clipboardListeners.forEach((listener) => listener());
}
export function useFileClipboard() {
  return useSyncExternalStore(
    (listener) => {
      clipboardListeners.add(listener);
      return () => {
        clipboardListeners.delete(listener);
      };
    },
    () => clipboard,
  );
}

export function useEntryChanges(listener: (change: EntryChange) => void) {
  useEffect(() => {
    changeListeners.add(listener);
    return () => {
      changeListeners.delete(listener);
    };
  }, [listener]);
}

export function relocateEntry<T extends DirectorySelection>(
  entry: T | undefined,
  change: EntryChange,
): T | undefined {
  if (
    !entry ||
    entry.root.path !== change.root.path ||
    !(entry.path === change.path || entry.path.startsWith(`${change.path}/`))
  )
    return entry;
  return change.destination
    ? {
        ...entry,
        path: change.destination + entry.path.slice(change.path.length),
      }
    : undefined;
}

export async function changeEntry(
  source: FileSource,
  target: DirectorySelection,
  operation: "copy" | "move" | "duplicate" | "delete",
  destination?: string,
) {
  return withFileOperation(target, async () => {
    let entry: FileEntry;
    try {
      entry = await api<FileEntry>(
        fileEndpoint(source, "files/operation", {
          root: target.root.id,
          path: target.path,
        }),
        { rootPath: target.root.path, operation, destination },
      );
    } catch (error) {
      if (error instanceof APIError && error.status === 409)
        throw new Error(i18n.t("files.createConflict"));
      throw error;
    }
    if (operation === "move" || operation === "delete") {
      const change = {
        ...target,
        destination: operation === "move" ? entry.path : undefined,
      };
      if (clipboard) stageFile(relocateEntry(clipboard, change));
      // Detach readers of the old path before refreshing active queries.
      flushSync(() => changeListeners.forEach((listener) => listener(change)));
    }
    await Promise.all(
      ["files", "file", "file-search", "diff", "skills"].map((key) =>
        queryClient.invalidateQueries({ queryKey: [key] }),
      ),
    );
    return entry;
  });
}
