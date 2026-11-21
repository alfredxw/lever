import type { TiffIfd } from "tiff";
import { ARCHIVE_MAX_BYTES } from "./archiveLimits";
import { boundedDecompression, streamByteLength } from "./boundedDecompression";

function checkCanvasSize(width: number, height: number) {
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    Math.min(width, height) < 1 ||
    Math.max(width, height) > 16_384 ||
    width * height > 32_000_000
  )
    throw new Error(
      "Image previews are limited to 32 megapixels and 16,384 pixels per side.",
    );
}

function validateHeifExtent(buffer: ArrayBuffer) {
  const view = new DataView(buffer);
  const expected = ["meta", "iprp", "ipco", "ispe"];
  let inspected = 0;
  let extents = 0;
  function scan(start: number, end: number, level: number) {
    for (let cursor = start; cursor < end; ) {
      if (++inspected > 2048 || end - cursor < 8)
        throw new Error("Invalid HEIF box layout.");
      const type = String.fromCharCode(
        ...new Uint8Array(buffer, cursor + 4, 4),
      );
      const size = view.getUint32(cursor);
      const header = size === 1 ? 16 : 8;
      if (end - cursor < header) throw new Error("Truncated HEIF header.");
      const length =
        size === 1
          ? Number(view.getBigUint64(cursor + 8))
          : size || end - cursor;
      if (length < header || length > end - cursor)
        throw new Error("Invalid HEIF box length.");
      const payload = cursor + header;
      const next = cursor + length;
      if (type === expected[level]) {
        if (type === "ispe") {
          if (next - payload < 12)
            throw new Error("Truncated HEIF image extent.");
          checkCanvasSize(
            view.getUint32(payload + 4),
            view.getUint32(payload + 8),
          );
          extents++;
        } else {
          const startChildren = payload + (type === "meta" ? 4 : 0);
          if (startChildren > next) throw new Error("Truncated HEIF metadata.");
          scan(startChildren, next, level + 1);
        }
      }
      cursor = next;
    }
  }
  scan(0, buffer.byteLength, 0);
  if (extents === 0)
    throw new Error("This HEIF image has no readable dimensions.");
}

function validateTiffDirectories(buffer: ArrayBuffer) {
  const view = new DataView(buffer);
  if (view.byteLength < 8) throw new Error("Truncated TIFF header.");
  const marker = view.getUint16(0);
  const little = marker === 0x4949;
  if ((!little && marker !== 0x4d4d) || view.getUint16(2, little) !== 42)
    throw new Error("Unsupported TIFF header.");
  const valueWidths = [0, 1, 1, 2, 4, 8, 1, 1, 2, 4, 8, 4, 8];
  const pending = [{ offset: view.getUint32(4, little), depth: 0 }];
  const seen = new Set<number>();
  let fieldsLeft = 2048;
  let valuesLeft = 512 * 1024;
  while (pending.length) {
    const { offset, depth } = pending.pop()!;
    if (
      offset < 8 ||
      offset > view.byteLength - 2 ||
      depth > 8 ||
      seen.has(offset)
    )
      throw new Error("Invalid TIFF directory offset.");
    seen.add(offset);
    const fields = view.getUint16(offset, little);
    fieldsLeft -= fields;
    const end = offset + 2 + 12 * fields;
    if (fieldsLeft < 0 || end + 4 > view.byteLength)
      throw new Error("Invalid TIFF directory size.");
    for (let field = offset + 2; field < end; field += 12) {
      const tag = view.getUint16(field, little);
      const type = view.getUint16(field + 2, little);
      const count = view.getUint32(field + 4, little);
      const width = valueWidths[type];
      if (!width) throw new Error("Unsupported TIFF field type.");
      const length = count * width;
      const value = field + 8;
      const start = length > 4 ? view.getUint32(value, little) : value;
      valuesLeft -= count;
      if (valuesLeft < 0 || start + length > view.byteLength)
        throw new Error("TIFF metadata exceeds the preview limits.");
      // These two directory pointers are followed by the decoder even in metadata-only mode.
      if (tag === 34665 || tag === 34853) {
        if (count !== 1 || type !== 4)
          throw new Error("Invalid TIFF directory pointer.");
        pending.push({
          offset: view.getUint32(value, little),
          depth: depth + 1,
        });
      }
    }
  }
}

// TIFF LZW adds a dictionary slot one code before a bit-width boundary.
// Only lengths are needed to budget the data before the decoder expands it.
function lzwByteLength(bytes: Uint8Array, maximum: number) {
  const sizes = new Uint16Array(4096);
  sizes.fill(1, 0, 256);
  let mask = 511;
  let width = 9;
  let nextSlot = 258;
  let previous = 0;
  let length = 0;
  let bits = 0;
  let register = 0;
  let expectingLiteral = false;
  for (const byte of bytes) {
    register = (register << 8) | byte;
    bits += 8;
    if (bits < width) continue;
    bits -= width;
    const code = (register >>> bits) & mask;
    if (code === 257) return length;
    if (code === 256 && !expectingLiteral) {
      mask = 511;
      width = 9;
      nextSlot = 258;
      previous = 0;
      expectingLiteral = true;
      continue;
    }
    if (
      (!previous && !expectingLiteral) ||
      (expectingLiteral && code > 255) ||
      code > nextSlot
    )
      break;
    const decoded = code === nextSlot ? previous + 1 : sizes[code];
    length += decoded;
    if (length > maximum)
      throw new Error("TIFF block exceeds its declared dimensions.");
    if (previous) {
      if (nextSlot >= sizes.length) break;
      sizes[nextSlot++] = previous + 1;
      if (width < 12 && nextSlot === mask) {
        width++;
        mask = (1 << width) - 1;
      }
    }
    previous = decoded;
    expectingLiteral = false;
  }
  throw new Error("Invalid TIFF LZW block.");
}

async function checkTiffBlocks(buffer: ArrayBuffer, page: TiffIfd) {
  const { tiled, width, height, components, bitsPerSample, compression } = page;
  const blockWidth = tiled ? page.tileWidth! : width;
  const blockHeight = tiled
    ? page.tileHeight!
    : Math.min(page.rowsPerStrip, height);
  checkCanvasSize(blockWidth, blockHeight);
  const offsets = tiled ? page.tileOffsets : page.stripOffsets;
  const lengths = tiled ? page.tileByteCounts : page.stripByteCounts;
  const count = Math.ceil(width / blockWidth) * Math.ceil(height / blockHeight);
  const stride = blockWidth * components * (bitsPerSample / 8);
  const capacity = stride * blockHeight;
  if (
    count > 2048 ||
    count * capacity > 256 * 1024 * 1024 ||
    offsets?.length !== count ||
    lengths?.length !== count
  )
    throw new Error("Unsupported TIFF block layout.");
  if (![1, 5, 8, 32946].includes(compression))
    throw new Error("Unsupported TIFF compression.");
  for (let i = 0; i < count; i++) {
    const offset = offsets[i];
    const size = lengths[i];
    if (
      !Number.isInteger(offset) ||
      !Number.isInteger(size) ||
      offset < 0 ||
      size < 1 ||
      offset + size > buffer.byteLength
    )
      throw new Error("Invalid TIFF block range.");
    const block = new Uint8Array(buffer, offset, size);
    let expanded = size;
    if (compression === 5) expanded = lzwByteLength(block, capacity);
    if (compression === 8 || compression === 32946)
      expanded = await streamByteLength(
        boundedDecompression(new Blob([block]), "deflate", capacity),
      );
    const visibleRows = tiled
      ? blockHeight
      : Math.min(blockHeight, height - i * blockHeight);
    if (expanded < stride * visibleRows)
      throw new Error("Truncated TIFF image block.");
  }
}

function canvasFor(width: number, height: number) {
  checkCanvasSize(width, height);
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Image decoding is unavailable.");
  return { canvas, context };
}

async function renderHeif(bytes: ArrayBuffer) {
  validateHeifExtent(bytes);
  const { heicTo } = await import("heic-to/csp");
  const image = await heicTo({ blob: new Blob([bytes]), type: "bitmap" });
  try {
    const { canvas, context } = canvasFor(image.width, image.height);
    context.drawImage(image, 0, 0);
    return await canvas.convertToBlob({ type: "image/png" });
  } finally {
    image.close();
  }
}

async function renderTiff(bytes: ArrayBuffer) {
  validateTiffDirectories(bytes);
  const { decode } = await import("tiff");
  const [metadata] = decode(bytes, { pages: [0], ignoreImageData: true });
  if (!metadata) throw new Error("This TIFF has no readable image.");
  const { width, height, components, bitsPerSample, type, orientation } =
    metadata;
  checkCanvasSize(width, height);
  if (
    (orientation && orientation !== 1) ||
    ![0, 1, 2, 3].includes(type) ||
    ![8, 16].includes(bitsPerSample) ||
    ![1, 2, 3, 4].includes(components) ||
    (type === 2 && components < 3) ||
    (metadata.tiled && components !== 1)
  )
    throw new Error("Unsupported TIFF color format or orientation.");
  await checkTiffBlocks(bytes, metadata);
  const [image] = decode(bytes, { pages: [0] });
  const { canvas, context } = canvasFor(width, height);
  const imageData = context.createImageData(width, height);
  const palette = image.palette;
  const sampleMax = bitsPerSample === 16 ? 257 : 1;
  for (
    let source = 0, target = 0;
    target < imageData.data.length;
    source += components, target += 4
  ) {
    const value = image.data[source];
    const color = palette?.[value];
    const gray = value / sampleMax;
    imageData.data[target] = color ? color[0] / 257 : gray;
    imageData.data[target + 1] = color
      ? color[1] / 257
      : type === 2
        ? image.data[source + 1] / sampleMax
        : gray;
    imageData.data[target + 2] = color
      ? color[2] / 257
      : type === 2
        ? image.data[source + 2] / sampleMax
        : gray;
    imageData.data[target + 3] = image.alpha
      ? image.data[source + components - 1] / sampleMax
      : 255;
  }
  context.putImageData(imageData, 0, 0);
  return canvas.convertToBlob({ type: "image/png" });
}

self.addEventListener(
  "message",
  (event: MessageEvent<{ bytes: ArrayBuffer; heif: boolean }>) => {
    const { bytes, heif } = event.data;
    if (bytes.byteLength > ARCHIVE_MAX_BYTES) {
      self.postMessage(
        { error: "Preview limited to files under 50 MB." },
        { transfer: [] },
      );
      return;
    }
    void (heif ? renderHeif(bytes) : renderTiff(bytes)).then(
      (blob) => self.postMessage({ blob }, { transfer: [] }),
      (error: unknown) =>
        self.postMessage(
          {
            error:
              error instanceof Error
                ? error.message
                : "Could not decode image.",
          },
          { transfer: [] },
        ),
    );
  },
);
