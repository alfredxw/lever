import type { QueryClient } from "@tanstack/react-query";
import type {
  ArchiveCursor,
  ArchivePage,
  Record as Shared,
} from "@/api/hub.gen";
import { readLocal, saveLocal, type Transport } from "./client";

export interface ArchiveCache {
  records: Shared[];
  cursor?: ArchiveCursor;
  at: number;
}

export function applyArchive(
  previous: ArchiveCache | undefined,
  page: ArchivePage,
): Shared[] {
  if (!page.full && !previous) throw new Error("缺少同步起点");
  if (!page.full && !page.changes.length) return previous!.records;
  const rows = new Map<string, Shared>();
  if (!page.full)
    for (const r of previous!.records) rows.set(r.kind + "/" + r.id, r);
  for (const { deleted, ...record } of page.changes) {
    const key = record.kind + "/" + record.id;
    if (deleted) rows.delete(key);
    else rows.set(key, record);
  }
  return [...rows.values()];
}

export function savedArchive(key: string, host: string, chat = "") {
  return readLocal<ArchiveCache | undefined>(
    storageKey(key, host, chat),
    undefined,
  );
}
function storageKey(key: string, host: string, chat: string) {
  return key + ":sync:" + host + ":" + chat;
}
export async function fetchArchive(
  qc: QueryClient,
  transport: Transport,
  key: string,
  path: string,
  host: string,
  chat = "",
  signal?: AbortSignal,
) {
  const cacheKey = [key, "archive-cache", host, chat];
  const native = transport.kind !== "web";
  const previous =
    qc.getQueryData<ArchiveCache>(cacheKey) ??
    (native ? savedArchive(key, host, chat) : undefined);
  const query = new URLSearchParams({ sync: "1", chat });
  if (previous?.cursor) {
    query.set("epoch", previous.cursor.epoch);
    query.set("version", String(previous.cursor.version));
    query.set("stream", previous.cursor.stream);
  }
  const page = await transport.request<ArchivePage | Shared[]>(
    path + "/archive/" + encodeURIComponent(host) + "?" + query,
  );
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
  const result: ArchiveCache = Array.isArray(page)
    ? { records: page, at: Date.now() }
    : {
        records: applyArchive(previous, page),
        cursor: page.cursor,
        at: Date.now(),
      };
  qc.setQueryData(cacheKey, result);
  if (
    native &&
    (result.records !== previous?.records ||
      result.cursor?.version !== previous?.cursor?.version)
  )
    saveLocal(storageKey(key, host, chat), result);
  return result;
}
