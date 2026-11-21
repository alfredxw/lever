import { documentArchive } from "./boundedZip";
import { openEpub } from "./epubPreview";
import { openDocument } from "./openDocumentPreview";
import { openNotebook } from "./notebookPreview";
import { openRtf } from "./rtfPreview";
import type { OfficeKind } from "./fileKind";
import type { OfficeWorkerResult } from "./officePreviewProtocol";
import { openPresentation } from "./presentation";

async function open(
  bytes: ArrayBuffer,
  kind: OfficeKind,
): Promise<OfficeWorkerResult> {
  if (kind === "ipynb") return openNotebook(bytes);
  if (kind === "rtf") return openRtf(bytes);
  const archive = await documentArchive(bytes);
  if (kind === "epub") return openEpub(archive);
  if (kind === "odt" || kind === "ods" || kind === "odp")
    return openDocument(archive, kind);
  if (kind === "pptx") return openPresentation(archive);
  const bounded = await archive.generateAsync({
    type: "arraybuffer",
    compression: "STORE",
  });
  if (kind === "docx") {
    const { default: mammoth } = await import("mammoth");
    const result = await mammoth.convertToHtml(
      { arrayBuffer: bounded },
      { externalFileAccess: false, includeEmbeddedStyleMap: false },
    );
    if (result.value.length > 16 * 1024 * 1024)
      throw new Error("Rendered document exceeds the preview limit.");
    return {
      type: "document",
      navigation: "page",
      pages: [{ title: "Document", html: result.value }],
    };
  }
  const { default: readXlsx } = await import("read-excel-file/web-worker");
  const sheets = await readXlsx(new Blob([bounded]));
  if (sheets.length > 100) throw new Error("Preview limited to 100 sheets.");
  return {
    type: "ods",
    sheets: sheets.map((sheet) => ({
      name: sheet.sheet,
      rows: sheet.data
        .slice(0, 500)
        .map((row) =>
          row
            .slice(0, 50)
            .map((cell) =>
              cell instanceof Date
                ? cell.toISOString()
                : String(cell ?? "").slice(0, 10_000),
            ),
        ),
      rowCount: Math.min(sheet.data.length, 500),
      columns: Math.min(
        50,
        Math.max(1, ...sheet.data.slice(0, 500).map((row) => row.length)),
      ),
      truncated:
        sheet.data.length > 500 || sheet.data.some((row) => row.length > 50),
    })),
  };
}
self.addEventListener(
  "message",
  (event: MessageEvent<{ bytes: ArrayBuffer; kind: OfficeKind }>) => {
    void open(event.data.bytes, event.data.kind).then(
      (result) => self.postMessage(result, { transfer: [] }),
      (error: unknown) =>
        self.postMessage(
          {
            type: "error",
            message:
              error instanceof Error
                ? error.message
                : "Could not preview document.",
          },
          { transfer: [] },
        ),
    );
  },
);
