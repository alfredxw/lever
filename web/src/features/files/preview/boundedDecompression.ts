export function boundedDecompression(
  source: Blob,
  format: CompressionFormat,
  maxBytes: number,
) {
  let remaining = maxBytes;
  return source
    .stream()
    .pipeThrough(new DecompressionStream(format))
    .pipeThrough(
      new TransformStream<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>({
        transform(chunk, controller) {
          remaining -= chunk.byteLength;
          if (remaining < 0)
            throw new Error("Expanded data exceeds the preview size limit.");
          controller.enqueue(chunk);
        },
      }),
    );
}

export async function streamByteLength(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return length;
      length += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
}
