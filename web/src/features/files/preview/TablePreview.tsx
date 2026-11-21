import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { ChevronLeft, ChevronRight } from "lucide-react";

export function PreviewPager({
  page,
  count,
  onPage,
}: {
  page: number;
  count: number;
  onPage: (page: number) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="file-preview-pager">
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={t("files.previousPage")}
        disabled={page <= 0}
        onClick={() => onPage(page - 1)}
      >
        <ChevronLeft />
      </Button>
      <span>
        {page + 1} / {Math.max(1, count)}
      </span>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={t("files.nextPage")}
        disabled={page + 1 >= count}
        onClick={() => onPage(page + 1)}
      >
        <ChevronRight />
      </Button>
    </div>
  );
}

export function DataTable({
  rows,
  columns,
}: {
  rows: string[][];
  columns?: string[];
}) {
  return (
    <div className="file-table-scroll">
      <table className="file-data-table">
        {columns && (
          <thead>
            <tr>
              {columns.map((value, index) => (
                <th key={index}>{value}</th>
              ))}
            </tr>
          </thead>
        )}
        <tbody>
          {rows.map((row, index) => (
            <tr key={index}>
              {row.map((value, column) => (
                <td key={column}>{value}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function TablePreview({
  rows,
  truncated,
}: {
  rows: string[][];
  truncated?: boolean;
}) {
  const [page, setPage] = useState(0);
  const { t } = useTranslation();
  return (
    <>
      {truncated && (
        <div className="file-warning">{t("files.previewLimited")}</div>
      )}
      <PreviewPager
        page={page}
        count={Math.ceil(rows.length / 50)}
        onPage={setPage}
      />
      <DataTable rows={rows.slice(page * 50, (page + 1) * 50)} />
    </>
  );
}
