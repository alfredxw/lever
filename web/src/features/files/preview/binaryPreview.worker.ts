import { createTarDecoder } from "modern-tar";
import type { Database } from "sql.js";
import {
  ARCHIVE_MAX_BYTES,
  ARCHIVE_MAX_ENTRIES,
  ARCHIVE_MAX_RATIO,
} from "./archiveLimits";
import { boundedDecompression, streamByteLength } from "./boundedDecompression";
import {
  SQLITE_PAGE_SIZE,
  type BinaryWorkerRequest,
  type BinaryWorkerResult,
} from "./binaryPreviewProtocol";
import { boundedZip } from "./boundedZip";

type ArchivePreview = Extract<BinaryWorkerResult, { type: "archive" }>;

async function archivePreview(
  bytes: ArrayBuffer,
  name: string,
): Promise<ArchivePreview> {
  const signature = new Uint8Array(bytes, 0, Math.min(4, bytes.byteLength));
  const zip =
    signature.length === 4 &&
    [0x504b0304, 0x504b0506].includes(new DataView(bytes).getUint32(0));
  if (zip || /\.(zip|jar)$/i.test(name)) {
    const index = await boundedZip(bytes);
    return {
      type: "archive",
      entries: Array.from(index, ([path, entry]) => ({
        path,
        size: entry.bytes.length,
        directory: entry.directory,
      })),
    };
  }

  const source = new Blob([bytes]);
  const gzip =
    /\.(gz|tgz)$/i.test(name) ||
    (signature[0] === 0x1f && signature[1] === 0x8b);
  const stream = gzip
    ? boundedDecompression(
        source,
        "gzip",
        Math.min(bytes.byteLength * ARCHIVE_MAX_RATIO, ARCHIVE_MAX_BYTES),
      )
    : source.stream();
  const uncompressedName = name.replace(/\.gz$/i, "");
  if (gzip && !/\.(tar|tgz)$/i.test(uncompressedName)) {
    return {
      type: "archive",
      entries: [
        {
          path: uncompressedName || "contents",
          size: await streamByteLength(stream),
          directory: false,
        },
      ],
    };
  }

  const entries: ArchivePreview["entries"] = [];
  const reader = stream
    .pipeThrough(createTarDecoder({ strict: true }))
    .getReader();
  try {
    for (let index = 0; ; index++) {
      const { done, value } = await reader.read();
      if (done) break;
      const { header, body } = value;
      const { name: path, size, type } = header;
      if (
        index >= ARCHIVE_MAX_ENTRIES ||
        path.length > 1024 ||
        !Number.isSafeInteger(size) ||
        size < 0 ||
        size > ARCHIVE_MAX_BYTES
      )
        throw new Error("Archive entries exceed the preview limits.");
      if (type === "file" || type === "directory")
        entries.push({ path, size, directory: type === "directory" });
      await body.cancel();
    }
  } finally {
    await reader.cancel();
  }
  if (!entries.length) throw new Error("This archive has no readable entries.");
  return { type: "archive", entries };
}

const MAX_TABLES = 100;
let sqlite: { database: Database; tables: Set<string> } | undefined;

function identifier(name: string) {
  return `"${name.replaceAll('"', '""')}"`;
}

async function openDatabase(bytes: ArrayBuffer): Promise<BinaryWorkerResult> {
  const [{ default: init }, { default: wasm }] = await Promise.all([
    import("sql.js"),
    import("sql.js/dist/sql-wasm.wasm?url"),
  ]);
  const sql = await init({ locateFile: () => wasm });
  const database = new sql.Database(new Uint8Array(bytes));
  try {
    database.run("PRAGMA trusted_schema=OFF");
    database.run("PRAGMA query_only=ON");
    const names =
      database
        .exec(
          `
      SELECT name FROM pragma_table_list
      WHERE schema = 'main' AND type IN ('table', 'shadow') AND name NOT GLOB 'sqlite_*'
      ORDER BY name LIMIT ${MAX_TABLES + 1}
    `,
        )[0]
        ?.values.map(([name]) => String(name)) ?? [];
    if (names.length > MAX_TABLES)
      throw new Error(`Preview limited to ${MAX_TABLES} database tables.`);
    const tables = names.map((name) => ({
      name,
      count: Number(
        database.exec(`SELECT count(*) FROM main.${identifier(name)}`)[0]
          ?.values[0]?.[0],
      ),
    }));
    sqlite = { database, tables: new Set(names) };
    return { type: "sqlite", tables };
  } catch (error) {
    database.close();
    throw error;
  }
}

function tablePage(table: string, page: number): BinaryWorkerResult {
  const offset = page * SQLITE_PAGE_SIZE;
  if (
    !sqlite?.tables.has(table) ||
    offset < 0 ||
    !Number.isSafeInteger(offset) ||
    !Number.isInteger(page)
  )
    throw new Error("This table page is unavailable.");
  const { database } = sqlite;
  const columns =
    database
      .exec(
        "SELECT name FROM pragma_table_xinfo(?, 'main') WHERE hidden != 1 ORDER BY cid LIMIT 50",
        [table],
      )[0]
      ?.values.map(([name]) => String(name)) ?? [];
  const fields = columns.map((column) => {
    const name = identifier(column);
    return `CASE typeof(${name})
      WHEN 'blob' THEN printf('[blob: %d bytes]', length(${name}))
      WHEN 'null' THEN 'NULL'
      ELSE substr(CAST(${name} AS TEXT), 1, 1024) END`;
  });
  const result = database.exec(
    `SELECT ${fields.join(", ")} FROM main.${identifier(table)} LIMIT ? OFFSET ?`,
    [SQLITE_PAGE_SIZE, offset],
  );
  return {
    type: "rows",
    table,
    page,
    columns,
    rows: result[0]?.values.map((row) => row.map(String)) ?? [],
  };
}

async function preview(
  input: BinaryWorkerRequest,
): Promise<BinaryWorkerResult> {
  if (input.type === "rows") return tablePage(input.table, input.page);
  if (input.bytes.byteLength > ARCHIVE_MAX_BYTES)
    throw new Error("Preview limited to files under 50 MB.");
  sqlite?.database.close();
  sqlite = undefined;
  return input.kind === "sqlite"
    ? openDatabase(input.bytes)
    : archivePreview(input.bytes, input.name);
}

self.addEventListener("message", (event: MessageEvent<BinaryWorkerRequest>) => {
  void preview(event.data).then(
    (result) => self.postMessage(result, { transfer: [] }),
    (error: unknown) =>
      self.postMessage(
        {
          type: "error",
          message:
            error instanceof Error
              ? error.message
              : "Could not preview this file.",
        } satisfies BinaryWorkerResult,
        { transfer: [] },
      ),
  );
});
