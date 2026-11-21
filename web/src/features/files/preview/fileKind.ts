export type OfficeKind =
  | "docx"
  | "xlsx"
  | "pptx"
  | "odt"
  | "ods"
  | "odp"
  | "rtf"
  | "epub"
  | "ipynb";
export type FileKind =
  | "image"
  | "audio"
  | "video"
  | "pdf"
  | "font"
  | "archive"
  | "sqlite"
  | "html"
  | "markdown"
  | "mermaid"
  | "table"
  | "text"
  | OfficeKind;

// Literal file paths, not URLs: a '#' or '?' in a filename is not a fragment.
const extensions: [FileKind, string][] = [
  ["image", "avif bmp gif ico heic heif jpeg jpg png svg tif tiff webp"],
  ["audio", "mp3 wav ogg oga flac aac m4a opus aiff webm-audio weba"],
  ["video", "avi m4v mkv mov mp4 ogv webm"],
  ["pdf", "pdf"],
  ["font", "ttf otf woff woff2"],
  ["archive", "zip jar tar gz tgz"],
  ["sqlite", "sqlite sqlite3 db"],
  ["html", "html htm"],
  ["markdown", "md markdown mdown mkd mdx"],
  ["mermaid", "mmd mermaid"],
  ["table", "csv tsv"],
  ...["docx", "xlsx", "pptx", "odt", "ods", "odp", "rtf", "epub", "ipynb"].map(
    (kind) => [kind as OfficeKind, kind] as [OfficeKind, string],
  ),
];
const kinds = new Map(
  extensions.flatMap(([kind, values]) =>
    values.split(" ").map((ext) => [ext, kind] as const),
  ),
);
export const fileKind = (path: string): FileKind => {
  const name = path.split(/[\\/]/).at(-1) ?? "";
  return name.includes(".")
    ? (kinds.get(name.slice(name.lastIndexOf(".") + 1).toLowerCase()) ?? "text")
    : "text";
};
export const isTextKind = (kind: FileKind) =>
  ["text", "markdown", "html", "mermaid", "table"].includes(kind);

export class PreviewLoadError extends Error {}

export async function readPreviewBytes(
  src: string,
  signal: AbortSignal,
  limit = 50 * 1024 * 1024,
) {
  const response = await fetch(src, {
    signal,
    credentials: "same-origin",
  }).catch(() => {
    throw new PreviewLoadError(
      "Could not load this file. Check the connection and try again.",
    );
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new PreviewLoadError(`Could not load file (${response.status}).`);
  }
  if (Number(response.headers.get("content-length")) > limit) {
    await response.body?.cancel();
    throw new Error(`Preview limited to ${limit / 1024 / 1024} MiB.`);
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("File is unavailable.");
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if ((size += value.length) > limit)
        throw new Error(`Preview limited to ${limit / 1024 / 1024} MiB.`);
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  return new Blob(chunks).arrayBuffer();
}
