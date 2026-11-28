export const PASTED_TEXT_ATTACHMENT_THRESHOLD_BYTES = 64 * 1024;
export const MAX_MESSAGE_TEXT_BYTES = 1024 * 1024;
export const MAX_ATTACHMENT_COUNT = 8;
export const MAX_ATTACHMENT_TOTAL_BYTES = 20 * 1024 * 1024;
export const PASTE_AS_TEXT_WINDOW_MS = 1000;

const textEncoder = new TextEncoder();

export type PastedTextDisposition = "attachment" | "inline";

export function utf8ByteLength(text: string): number {
  return textEncoder.encode(text).byteLength;
}

// Non-Latin layouts and macOS Option-chords report non-ASCII keys; fall back to physical KeyV.
function isVKey(event: {
  readonly key: string;
  readonly code?: string;
}): boolean {
  const key = event.key.toLowerCase();
  return /^[a-z]$/.test(key) ? key === "v" : event.code === "KeyV";
}

export function isPasteAsTextShortcut(
  event: Pick<
    KeyboardEvent,
    "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey"
  > & { readonly code?: string },
  macPlatform: boolean,
): boolean {
  if (!event.shiftKey || !isVKey(event)) return false;
  if (macPlatform) {
    return event.metaKey && !event.ctrlKey;
  }
  return event.ctrlKey && !event.metaKey && !event.altKey;
}

export function wouldTextPasteExceedLimit(input: {
  readonly currentBytes: number;
  readonly selectedBytes: number;
  readonly pastedBytes: number;
  readonly maxBytes?: number;
}): boolean {
  const maxBytes = input.maxBytes ?? MAX_MESSAGE_TEXT_BYTES;
  const retainedBytes = Math.max(0, input.currentBytes - input.selectedBytes);
  return retainedBytes + input.pastedBytes > maxBytes;
}

export function pastedTextDisposition(input: {
  readonly text: string;
  readonly canAttach: boolean;
  readonly bypassAutoAttachment?: boolean;
  readonly wouldExceedInputLimit?: boolean;
  readonly thresholdBytes?: number;
}): PastedTextDisposition {
  if (
    input.bypassAutoAttachment ||
    !input.canAttach ||
    input.text.length === 0
  ) {
    return "inline";
  }
  const thresholdBytes =
    input.thresholdBytes ?? PASTED_TEXT_ATTACHMENT_THRESHOLD_BYTES;
  // UTF-8 byte length is always >= UTF-16 code unit length, so text.length is a sound fast path.
  return input.wouldExceedInputLimit ||
    input.text.length >= thresholdBytes ||
    utf8ByteLength(input.text) >= thresholdBytes
    ? "attachment"
    : "inline";
}

export function nextPastedTextFileName(
  existingNames: ReadonlyArray<string>,
): string {
  const names = new Set(existingNames.map((name) => name.toLowerCase()));
  if (!names.has("pasted-text.txt")) {
    return "pasted-text.txt";
  }
  for (let sequence = 2; ; sequence += 1) {
    const candidate = `pasted-text-${sequence}.txt`;
    if (!names.has(candidate)) {
      return candidate;
    }
  }
}

export function hasLeverReferenceHtml(html: string): boolean {
  return /<span\b[^>]*\bdata-lever-reference\s*=/i.test(html);
}
