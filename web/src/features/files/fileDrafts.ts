import { queryOptions } from "@tanstack/react-query";
import { useEffect, useSyncExternalStore } from "react";
import { toast } from "sonner";
import { api, APIError, queryClient } from "@/api/client";
import type { FileContent, FileWrite, Root } from "@/api/types.gen";
import i18n from "@/i18n";
import { absoluteFilePath, type DirectorySelection } from "./filePaths";
import {
  fileEndpoint,
  fileReadOnly,
  fileScopeKey,
  fileSourceKey,
  skillEntry,
  type FileSource,
} from "./fileSource";

type FileTarget = {
  source: FileSource;
  root: Root;
  path: string;
};
type Draft = {
  base: FileContent;
  content: string;
  saving: boolean;
  reloading?: boolean;
  error: unknown;
};
type SaveSession = {
  target: FileTarget;
  draft: Draft;
  timer?: ReturnType<typeof setTimeout>;
};

// Sessions outlive the visible panel: switching files never cancels a save or
// loses a failed draft. Every surface of a file shares one ordered write queue.
const sessions = new Map<string, SaveSession>();
const listeners = new Set<() => void>();
let changing: DirectorySelection | undefined;
const within = (target: DirectorySelection, parent: DirectorySelection) => {
  const path = absoluteFilePath(target).replaceAll("\\", "/");
  const base = absoluteFilePath(parent).replaceAll("\\", "/");
  return path === base || path.startsWith(`${base}/`);
};

// A move/delete must not strand an autosave at the old path. Keep failed drafts
// intact and make affected editors read-only until the filesystem call finishes.
export async function withFileOperation<T>(
  target: DirectorySelection,
  run: () => Promise<T>,
) {
  if (changing) throw new Error(i18n.t("files.operationPending"));
  if (
    Array.from(sessions.values()).some((session) =>
      within(session.target, target),
    )
  )
    throw new Error(i18n.t("files.unsavedOperation"));
  changing = target;
  notify();
  try {
    return await run();
  } finally {
    changing = undefined;
    notify();
  }
}
const notify = () => listeners.forEach((listener) => listener());
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
const keyFor = (target: FileTarget) => absoluteFilePath(target);
const fileQueryKey = (target: FileTarget) =>
  [
    "file",
    keyFor(target),
    fileSourceKey(target.source),
    target.root.id,
    fileScopeKey(target.source),
  ] as const;
export const fileURL = ({ source, root, path }: FileTarget) =>
  fileEndpoint(source, "file", { root: root.id, rootPath: root.path, path });

const readFile = (target: FileTarget, signal?: AbortSignal) =>
  api<FileContent>(fileURL(target), undefined, undefined, signal);

export const fileContentQuery = (target: FileTarget) =>
  queryOptions({
    queryKey: fileQueryKey(target),
    queryFn: ({ signal }) => readFile(target, signal),
    retry: (count, error) =>
      !(error instanceof APIError && error.status === 415) && count < 1,
  });

async function cacheFile(target: FileTarget, file: FileContent) {
  const sameFile = { queryKey: ["file", keyFor(target)] };
  await queryClient.cancelQueries(sameFile);
  queryClient.setQueriesData<FileContent>(sameFile, (previous) =>
    previous ? { ...file, path: previous.path } : previous,
  );
  queryClient.setQueryData(fileQueryKey(target), file);
}

export function isFileConflict(error: unknown) {
  return error instanceof APIError && error.code === "file_conflict";
}

export function fileSaveError(error: unknown) {
  return isFileConflict(error)
    ? i18n.t("files.conflict")
    : error instanceof Error
      ? error.message
      : String(error);
}

async function save(session: SaveSession) {
  if (
    session.draft.saving ||
    session.draft.reloading ||
    isFileConflict(session.draft.error)
  )
    return;
  clearTimeout(session.timer);
  const { target } = session;
  const key = keyFor(target);
  const contents = session.draft.content;
  const input: FileWrite = {
    content: contents,
    version: session.draft.base.version,
    rootPath: target.root.path,
  };
  session.draft = { ...session.draft, saving: true, error: null };
  notify();
  try {
    const saved = await api<FileContent>(fileURL(target), input, "PUT");
    await cacheFile(target, saved);
    session.draft = { ...session.draft, base: saved, saving: false };
    if (session.draft.content === contents) sessions.delete(key);
    notify();
    void queryClient.invalidateQueries({ queryKey: ["diff"] });
    void queryClient.invalidateQueries({
      queryKey: ["file-search", fileSourceKey(target.source)],
    });
    void queryClient.invalidateQueries({
      queryKey: ["files", fileSourceKey(target.source), target.root.id],
    });
    if (
      target.path.split("/").at(-1)?.toLowerCase() === skillEntry.toLowerCase()
    )
      void queryClient.invalidateQueries({ queryKey: ["skills"] });
    // Typing during the request must be saved against its confirmed version.
    if (sessions.has(key)) void save(session);
  } catch (error) {
    session.draft = { ...session.draft, saving: false, error };
    notify();
    if (!isFileConflict(error)) {
      toast.error(i18n.t("files.saveFailed", { path: target.path }), {
        description: fileSaveError(error),
      });
    }
  }
}

export function useFileDraft(target: FileTarget, source?: FileContent) {
  const key = keyFor(target);
  const readOnly = fileReadOnly(target.source);
  const draft = useSyncExternalStore(subscribe, () =>
    readOnly ? undefined : sessions.get(key)?.draft,
  );
  const changingFile = useSyncExternalStore(
    subscribe,
    () => !!changing && within(target, changing),
  );
  return {
    draft,
    changingFile,
    change(content: string) {
      if (readOnly || (changing && within(target, changing))) return;
      let session = sessions.get(key);
      const base = session?.draft.base ?? source;
      if (!base || base.truncated) return;
      if (content === (session?.draft.content ?? base.content)) return;
      if (!session) {
        session = {
          target,
          draft: { base, content, saving: false, error: null },
        };
        sessions.set(key, session);
      } else {
        session.draft = { ...session.draft, content };
      }
      clearTimeout(session.timer);
      if (!session.draft.saving && !session.draft.reloading) {
        if (
          content === session.draft.base.content &&
          !isFileConflict(session.draft.error)
        ) {
          sessions.delete(key);
        } else if (!session.draft.error) {
          const pending = session;
          session.timer = setTimeout(() => void save(pending), 500);
        }
      }
      notify();
    },
    save() {
      if (readOnly) return;
      const session = sessions.get(key);
      if (session) void save(session);
    },
    async reload() {
      if (readOnly) return;
      const session = sessions.get(key);
      if (!session || session.draft.saving || session.draft.reloading) return;
      clearTimeout(session.timer);
      const requested = { ...session.draft, reloading: true };
      session.draft = requested;
      notify();
      try {
        const fresh = await readFile(session.target);
        if (fresh.truncated) throw new Error(i18n.t("files.truncated"));
        await cacheFile(session.target, fresh);
        // A second editor may have supplied a newer draft while the read ran.
        if (session.draft === requested) sessions.delete(key);
      } finally {
        session.draft = { ...session.draft, reloading: false };
        if (sessions.has(key) && !session.draft.error) {
          session.timer = setTimeout(() => void save(session), 500);
        }
        notify();
      }
    },
  };
}

export function useUnsavedFileWarning() {
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (sessions.size === 0) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, []);
}
