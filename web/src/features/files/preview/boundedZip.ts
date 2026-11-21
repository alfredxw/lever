import JSZip from "jszip";

import {
  ARCHIVE_MAX_BYTES,
  ARCHIVE_ENTRY_MAX_BYTES,
  ARCHIVE_MAX_ENTRIES,
  ARCHIVE_MAX_RATIO,
} from "./archiveLimits.ts";

// Only decompressed, bounded entries reach document engines. Never extract to disk.
export async function boundedZip(
  bytes: ArrayBuffer,
  limit = ARCHIVE_MAX_BYTES,
) {
  if (bytes.byteLength > limit)
    throw new Error("Archive exceeds the preview size limit.");
  const zip = await JSZip.loadAsync(bytes);
  const entries = Object.values(zip.files);
  if (entries.length > ARCHIVE_MAX_ENTRIES)
    throw new Error("Archive has too many entries.");
  const result = new Map<
    string,
    { bytes: Uint8Array<ArrayBuffer>; directory: boolean; date: Date }
  >();
  let total = 0;
  for (const entry of entries) {
    const chunks: Uint8Array<ArrayBuffer>[] = [];
    let size = 0;
    await new Promise<void>((resolve, reject) => {
      const stream = (
        entry as JSZip.JSZipObject & {
          internalStream(
            type: "uint8array",
          ): JSZip.JSZipStreamHelper<Uint8Array<ArrayBuffer>>;
        }
      ).internalStream("uint8array");
      stream
        .on("data", (chunk) => {
          size += chunk.length;
          total += chunk.length;
          if (
            size > ARCHIVE_ENTRY_MAX_BYTES ||
            total > limit ||
            total > Math.max(1024 * 1024, bytes.byteLength * ARCHIVE_MAX_RATIO)
          ) {
            stream.pause();
            reject(
              new Error("Expanded archive exceeds the preview size limit."),
            );
          } else chunks.push(chunk);
        })
        .on("error", reject)
        .on("end", resolve)
        .resume();
    });
    const data = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      data.set(chunk, offset);
      offset += chunk.length;
    }
    result.set(entry.name, {
      bytes: data,
      directory: entry.dir,
      date: entry.date,
    });
  }
  return result;
}

export async function documentArchive(bytes: ArrayBuffer) {
  const entries = await boundedZip(bytes);
  const archive = new JSZip();
  for (const [path, entry] of entries) {
    if (/\.(xml|rels)$/i.test(path)) {
      const xml = new TextDecoder().decode(entry.bytes);
      if (
        /<!\s*(DOCTYPE|ENTITY)/i.test(xml) ||
        (xml.match(/</g)?.length ?? 0) > 100_000
      )
        throw new Error("Document XML exceeds the preview limits.");
    }
    archive.file(path, entry.bytes, { dir: entry.directory });
  }
  return archive;
}
