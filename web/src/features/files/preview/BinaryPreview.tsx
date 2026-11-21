import { PreviewFailure } from "./PreviewUnavailable";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Loading } from "@/components/common";
import type { BinaryWorkerResult } from "./binaryPreviewProtocol";
import { SQLITE_PAGE_SIZE } from "./binaryPreviewProtocol";
import { usePreviewWorker } from "./usePreviewWorker";
import { DataTable, PreviewPager } from "./TablePreview";

export default function BinaryPreview({
  src,
  name,
  kind,
}: {
  src: string;
  name: string;
  kind: "archive" | "sqlite";
}) {
  const { t } = useTranslation();
  const { result, error, send } = usePreviewWorker<BinaryWorkerResult>(
    src,
    () =>
      new Worker(new URL("./binaryPreview.worker.ts", import.meta.url), {
        type: "module",
      }),
    { type: "open", kind, name },
  );
  const [tables, setTables] = useState<{ name: string; count: number }[]>([]);
  const [table, setTable] = useState("");
  const [page, setPage] = useState(0);
  useEffect(() => {
    if (result?.type === "sqlite") {
      setTables(result.tables);
      const first = result.tables[0]?.name ?? "";
      setTable(first);
      if (first) send({ type: "rows", table: first, page: 0 });
    }
  }, [result]);
  if (error) return <PreviewFailure error={error} />;
  if (!result) return <Loading />;
  if (result.type === "archive")
    return (
      <DataTable
        columns={[t("files.name"), t("files.size")]}
        rows={result.entries.map((entry) => [
          entry.path,
          entry.directory ? "—" : `${entry.size.toLocaleString()} B`,
        ])}
      />
    );
  const select = (name: string, index: number) => {
    setTable(name);
    setPage(index);
    send({ type: "rows", table: name, page: index });
  };
  return (
    <>
      <select
        className="file-sheet-select"
        aria-label={t("files.table")}
        value={table}
        onChange={(event) => select(event.target.value, 0)}
      >
        {tables.map((value) => (
          <option key={value.name}>{value.name}</option>
        ))}
      </select>
      <PreviewPager
        page={page}
        count={Math.ceil(
          (tables.find((value) => value.name === table)?.count ?? 0) /
            SQLITE_PAGE_SIZE,
        )}
        onPage={(index) => select(table, index)}
      />
      {result.type === "rows" &&
      result.table === table &&
      result.page === page ? (
        <DataTable columns={result.columns} rows={result.rows} />
      ) : tables.length > 0 ? (
        <Loading />
      ) : (
        <p className="file-warning">{t("files.emptyTable")}</p>
      )}
    </>
  );
}
