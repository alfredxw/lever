import { imageSize } from "image-size";
import type JSZip from "jszip";

const IMAGE_LIMIT = 4 * 1024 * 1024;
const HEADER_LIMIT = 256 * 1024;
const rasterTypes: Readonly<Record<string, string>> = {
  png: "image/png",
  jpg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

function rasterFits(bytes: Uint8Array, mime: string) {
  try {
    const { width, height, type } = imageSize(bytes.subarray(0, HEADER_LIMIT));
    return (
      !!type &&
      rasterTypes[type] === mime &&
      width > 0 &&
      height > 0 &&
      width * height <= 16_777_216
    );
  } catch {
    return false;
  }
}

export function embeddedRaster(mime: string, data: string) {
  if (
    data.length > Math.ceil(IMAGE_LIMIT / 3) * 4 ||
    !/^[\d+/a-z]*={0,2}$/i.test(data)
  )
    return false;
  try {
    const head = atob(data.slice(0, Math.ceil(HEADER_LIMIT / 3) * 4));
    return rasterFits(
      Uint8Array.from(head, (byte) => byte.charCodeAt(0)),
      mime,
    );
  } catch {
    return false;
  }
}

export async function packageRaster(archive: JSZip, path: string | undefined) {
  if (!path) return;
  const extension = path.split(".").at(-1)?.toLowerCase() ?? "";
  const mime = rasterTypes[extension === "jpeg" ? "jpg" : extension];
  const file = archive.file(path);
  if (!mime || !file) return;
  const bytes = await file.async("uint8array");
  if (bytes.byteLength <= IMAGE_LIMIT && rasterFits(bytes, mime)) {
    return `data:${mime};base64,${await file.async("base64")}`;
  }
}

export function resolvePackagePath(base: string, reference: string) {
  const resource = reference.split(/[?#]/, 1)[0];
  if (!resource) return;
  try {
    const path = decodeURIComponent(resource);
    if (/^(\/|[a-z][a-z\d+.-]*:)|[\\\x00-\x1f]/i.test(path)) return;
    const parts = base.split("/").slice(0, -1);
    for (const part of path.split("/")) {
      if (part === "..") {
        if (!parts.length) return;
        parts.pop();
      } else if (part && part !== ".") parts.push(part);
    }
    return parts.join("/");
  } catch {
    return;
  }
}

export class DocumentMarkup {
  private parts: string[] = [];

  constructor(private remaining = 16 * 1024 * 1024) {}

  append(fragment: string) {
    this.remaining -= fragment.length;
    if (this.remaining < 0)
      throw new Error("Rendered document exceeds the preview limit.");
    this.parts.push(fragment);
  }

  finishPage() {
    const html = this.parts.join("");
    this.parts = [];
    return html;
  }
}
