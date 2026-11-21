import { PreviewFailure } from "./PreviewUnavailable";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Loading } from "@/components/common";
import { MessageResponse } from "@/components/ai-elements/message-response";
import type { OfficeKind } from "./fileKind";
import type { OfficeWorkerResult } from "./officePreviewProtocol";
import { usePreviewWorker } from "./usePreviewWorker";
import { DocumentFrame } from "./DocumentFrame";
import { PreviewPager, TablePreview } from "./TablePreview";

export default function OfficePreview({
  src,
  name,
  kind,
}: {
  src: string;
  name: string;
  kind: OfficeKind;
}) {
  const { t } = useTranslation();
  const [page, setPage] = useState(0);
  const { result, error } = usePreviewWorker<OfficeWorkerResult>(
    src,
    () =>
      new Worker(new URL("./office.worker.ts", import.meta.url), {
        type: "module",
      }),
    { kind },
  );
  if (error) return <PreviewFailure error={error} />;
  if (!result) return <Loading />;
  return (
    <>
      <div className="file-warning">{t("files.contentPreview")}</div>
      {result.type === "document" && (
        <>
          <PreviewPager
            page={page}
            count={result.pages.length}
            onPage={setPage}
          />
          <DocumentFrame
            html={result.pages[page]?.html ?? ""}
            title={`${name}: ${result.pages[page]?.title}`}
          />
        </>
      )}
      {result.type === "ods" && (
        <>
          <select
            className="file-sheet-select"
            aria-label={t("files.sheet")}
            value={page}
            onChange={(event) => setPage(Number(event.target.value))}
          >
            {result.sheets.map((sheet, index) => (
              <option key={index} value={index}>
                {sheet.name}
              </option>
            ))}
          </select>
          <TablePreview
            key={page}
            rows={result.sheets[page]?.rows ?? []}
            truncated={result.sheets[page]?.truncated}
          />
        </>
      )}
      {result.type === "notebook" && (
        <div className="file-notebook">
          {result.cells.map((cell, index) => (
            <section key={index}>
              {cell.kind === "markdown" ? (
                <MessageResponse text={cell.source} />
              ) : (
                <pre>{cell.source}</pre>
              )}
              {cell.outputs.map((output, i) =>
                output.kind === "image" ? (
                  <img key={i} src={output.text} alt={`Output ${index + 1}`} />
                ) : output.kind === "html" ? (
                  <DocumentFrame
                    key={i}
                    title={`Output ${index + 1}`}
                    html={output.text}
                  />
                ) : (
                  <pre key={i}>{output.text}</pre>
                ),
              )}
            </section>
          ))}
        </div>
      )}
    </>
  );
}
