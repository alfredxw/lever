export const SQLITE_PAGE_SIZE = 50;

type ArchiveItem = { path: string; size: number; directory: boolean };
type SQLiteTable = { name: string; count: number };

export type BinaryWorkerRequest =
  | {
      type: "open";
      kind: "archive" | "sqlite";
      name: string;
      bytes: ArrayBuffer;
    }
  | { type: "rows"; table: string; page: number };

export type BinaryWorkerResult =
  | { type: "archive"; entries: ArchiveItem[] }
  | { type: "sqlite"; tables: SQLiteTable[] }
  | {
      type: "rows";
      table: string;
      page: number;
      columns: string[];
      rows: string[][];
    }
  | { type: "error"; message: string };
