import { decodeHTMLAttribute } from "entities";
import { embeddedRaster } from "./documentMarkup";
import type { NotebookCell, OfficeWorkerResult } from "./officePreviewProtocol";

const rasterFormats = ["image/png", "image/jpeg", "image/gif", "image/webp"];

function fields(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value))
    return value as Record<string, unknown>;
  return {};
}

function multiline(value: unknown, limit = 256_000) {
  const text = Array.isArray(value)
    ? value.filter((line) => typeof line === "string").join("")
    : value;
  if (typeof text !== "string") return "";
  if (text.length > limit)
    throw new Error("A notebook cell exceeds the preview size limit.");
  return text;
}

function previewOutput(
  value: unknown,
): NotebookCell["outputs"][number] | undefined {
  const output = fields(value);
  const data = fields(output.data);
  for (const mime of rasterFormats) {
    const encoded = multiline(data[mime], 4 * 1024 * 1024).replace(/\s/g, "");
    if (encoded && embeddedRaster(mime, encoded))
      return { kind: "image", text: `data:${mime};base64,${encoded}` };
  }
  const html = multiline(data["text/html"]);
  if (html.trim()) {
    const inline = decodeHTMLAttribute(html).matchAll(
      /data:(image\/(?:png|jpeg|gif|webp));base64,([\da-z+/=]*)/gi,
    );
    if (
      Array.from(inline).every(([, mime, encoded]) =>
        embeddedRaster(mime.toLowerCase(), encoded),
      )
    )
      return { kind: "html", text: html };
  }
  const fallback = multiline(
    output.text ?? data["text/plain"] ?? output.traceback,
  );
  if (fallback.trim()) return { kind: "text", text: fallback };
}

export function openNotebook(bytes: ArrayBuffer): OfficeWorkerResult {
  if (bytes.byteLength > 8 * 1024 * 1024)
    throw new Error("Notebook preview limited to files under 8 MB.");
  const notebook = fields(
    JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
  );
  if (
    notebook.nbformat !== 4 ||
    !Array.isArray(notebook.cells) ||
    notebook.cells.length > 500
  )
    throw new Error(
      "Preview supports version 4 notebooks with up to 500 cells.",
    );
  const cells = notebook.cells.map((value): NotebookCell => {
    const cell = fields(value);
    const kind =
      cell.cell_type === "markdown" || cell.cell_type === "code"
        ? cell.cell_type
        : "raw";
    const outputs: NotebookCell["outputs"] = [];
    if (Array.isArray(cell.outputs)) {
      if (cell.outputs.length > 100)
        throw new Error("A notebook cell has too many outputs to preview.");
      for (const item of cell.outputs) {
        const output = previewOutput(item);
        if (output) outputs.push(output);
      }
    }
    return { kind, source: multiline(cell.source), outputs };
  });
  return { type: "notebook", cells };
}
