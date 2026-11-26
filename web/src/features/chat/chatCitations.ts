import type { Citation, CitationSource, Item } from "@/api/types.gen";

const PUA_START = "\uE200";
const PUA_END = "\uE201";
const PUA_SEP = "\uE202";

export const CITATION_SENTINEL_START = "\uE210";
export const CITATION_SENTINEL_END = "\uE211";
export const CITATION_SENTINEL_PATTERN = /\uE210(\d+)\uE211/g;

export function safeCitationURL(raw?: string): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    if (
      (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      parsed.hostname
    ) {
      return trimmed;
    }
  } catch {
    return null;
  }
  return null;
}

export function citationDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./i, "");
  } catch {
    return url;
  }
}

function isCiteMarkerKind(kind: string): boolean {
  return kind === "cite" || kind === "filecite";
}

function isIncompleteCiteBody(tail: string): boolean {
  return (
    tail.startsWith(`cite${PUA_SEP}`) || tail.startsWith(`filecite${PUA_SEP}`)
  );
}

function isPartialCiteToken(tail: string): boolean {
  if (isIncompleteCiteBody(tail)) return true;
  return (
    `cite${PUA_SEP}`.startsWith(tail) || `filecite${PUA_SEP}`.startsWith(tail)
  );
}

const TRIM_BEFORE_AFTER = new Set([
  " ",
  "\t",
  "\n",
  "\r",
  ".",
  ",",
  ";",
  ":",
  "!",
  "?",
  ")",
  "]",
  "}",
  "。",
  "，",
  "；",
  "：",
  "！",
  "？",
  "）",
  "】",
  "》",
  "、",
]);

function shouldTrimSpaceBeforeCitation(after: string): boolean {
  if (!after || after.startsWith(PUA_START)) return true;
  return TRIM_BEFORE_AFTER.has(after[0]);
}

function scanCodeFenceLine(
  s: string,
  start: number,
  openChar: string,
  openLen: number,
): { next: number; char: string; count: number; handled: boolean } {
  let p = start;
  let spaces = 0;
  while (spaces < 3 && p < s.length && s[p] === " ") {
    p++;
    spaces++;
  }
  const c = s[p];
  if (c !== "`" && c !== "~") {
    return { next: start, char: openChar, count: openLen, handled: false };
  }
  let runEnd = p;
  while (runEnd < s.length && s[runEnd] === c) runEnd++;
  const n = runEnd - p;
  if (n < 3) {
    return { next: start, char: openChar, count: openLen, handled: false };
  }
  const nl = s.indexOf("\n", runEnd);
  const lineEnd = nl >= 0 ? nl + 1 : s.length;
  const rest = s.slice(runEnd, lineEnd).replace(/[\r\n]+$/, "");
  if (openLen === 0) {
    if (c === "`" && rest.includes("`")) {
      return { next: start, char: "", count: 0, handled: false };
    }
    return { next: lineEnd, char: c, count: n, handled: true };
  }
  if (c === openChar && n >= openLen && /^[ \t]*$/.test(rest)) {
    return { next: lineEnd, char: "", count: 0, handled: true };
  }
  return { next: start, char: openChar, count: openLen, handled: false };
}

function hasClosingBackticks(s: string, from: number, n: number): boolean {
  for (let i = from; i < s.length; ) {
    if (s[i] === "\n" && s[i + 1] === "\n") return false;
    if (s[i] !== "`") {
      i++;
      continue;
    }
    let end = i;
    while (end < s.length && s[end] === "`") end++;
    if (end - i === n) return true;
    i = end;
  }
  return false;
}

function findCitationClose(s: string, start: number): number {
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (ch === "\n" || ch === PUA_START) return -1;
    if (ch === PUA_END) return i;
  }
  return -1;
}

function appendMergedCitation(
  list: Citation[],
  offset: number,
  sources: CitationSource[],
) {
  if (!sources.length) return;
  const last = list.at(-1);
  if (last && last.offset === offset) {
    const seen = new Set(last.sources.map((s) => s.url));
    for (const source of sources) {
      if (!seen.has(source.url)) {
        seen.add(source.url);
        last.sources.push(source);
      }
    }
    return;
  }
  list.push({ offset, sources: [...sources] });
}

function resolveInlineCitations(
  raw: string,
  index: ReadonlyMap<string, CitationSource> | null,
  streaming: boolean,
): { text: string; citations: Citation[] } {
  if (!raw.includes(PUA_START)) {
    return { text: raw, citations: [] };
  }
  let out = "";
  const citations: Citation[] = [];
  const trimTrailingSpace = () => {
    if (out.length >= 2 && out.endsWith(" ")) {
      const prev = out[out.length - 2];
      if (prev !== " " && prev !== "\n" && prev !== "\t") {
        out = out.slice(0, -1);
      }
    }
  };

  let atLineStart = true;
  let fenceChar = "";
  let fenceLen = 0;
  let inlineCodeLen = 0;

  for (let i = 0; i < raw.length; ) {
    if (atLineStart && inlineCodeLen === 0) {
      atLineStart = false;
      const fence = scanCodeFenceLine(raw, i, fenceChar, fenceLen);
      if (fence.handled) {
        out += raw.slice(i, fence.next);
        fenceChar = fence.char;
        fenceLen = fence.count;
        i = fence.next;
        atLineStart = i > 0 && raw[i - 1] === "\n";
        continue;
      }
    }

    if (fenceLen > 0) {
      const nl = raw.indexOf("\n", i);
      if (nl < 0) {
        out += raw.slice(i);
        break;
      }
      out += raw.slice(i, nl + 1);
      i = nl + 1;
      atLineStart = true;
      continue;
    }

    if (raw[i] === "`") {
      let end = i;
      while (end < raw.length && raw[end] === "`") end++;
      const runLen = end - i;
      if (inlineCodeLen === 0) {
        if (hasClosingBackticks(raw, end, runLen)) inlineCodeLen = runLen;
      } else if (runLen === inlineCodeLen) {
        inlineCodeLen = 0;
      }
      out += raw.slice(i, end);
      i = end;
      continue;
    }

    if (inlineCodeLen === 0 && raw[i] === PUA_START) {
      const afterStart = i + 1;
      const closeIdx = findCitationClose(raw, afterStart);
      if (closeIdx >= 0) {
        const body = raw.slice(afterStart, closeIdx);
        const sepIdx = body.indexOf(PUA_SEP);
        if (sepIdx >= 0 && isCiteMarkerKind(body.slice(0, sepIdx))) {
          const afterEnd = closeIdx + 1;
          if (shouldTrimSpaceBeforeCitation(raw.slice(afterEnd))) {
            trimTrailingSpace();
          }
          if (index && index.size > 0) {
            const refs = body.slice(sepIdx + 1).split(PUA_SEP);
            const sources: CitationSource[] = [];
            const seen = new Set<string>();
            for (const ref of refs) {
              const source = index.get(ref.trim());
              if (source && !seen.has(source.url)) {
                seen.add(source.url);
                sources.push(source);
              }
            }
            appendMergedCitation(citations, out.length, sources);
          }
          i = afterEnd;
          continue;
        }
      } else {
        const tail = raw.slice(afterStart);
        const nl = tail.indexOf("\n");
        if (streaming && nl < 0 && isPartialCiteToken(tail)) {
          trimTrailingSpace();
          break;
        }
        if (!streaming && isIncompleteCiteBody(tail)) {
          const end = nl >= 0 ? afterStart + nl : raw.length;
          if (shouldTrimSpaceBeforeCitation(raw.slice(end))) {
            trimTrailingSpace();
          }
          i = end;
          continue;
        }
      }
    }

    const ch = raw[i];
    out += ch;
    atLineStart = ch === "\n";
    i++;
  }

  return { text: out, citations };
}

export function stripCitationMarkers(text: string, streaming = false): string {
  return resolveInlineCitations(text, null, streaming).text;
}

function addSource(
  map: Map<string, CitationSource>,
  refID: string,
  title: string,
  rawURL: string,
) {
  const key = refID.trim();
  const url = safeCitationURL(rawURL);
  if (!key || !url) return;
  const cleanTitle = title.trim();
  const existing = map.get(key);
  if (existing && existing.url === url && !cleanTitle) return;
  map.set(key, { title: cleanTitle || undefined, url });
}

function readJSONString(
  s: string,
  quoteIndex: number,
): [string, number] | null {
  if (s[quoteIndex] !== '"') return null;
  let i = quoteIndex + 1;
  while (i < s.length) {
    const ch = s[i];
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === '"') {
      try {
        return [JSON.parse(s.slice(quoteIndex, i + 1)) as string, i + 1];
      } catch {
        return null;
      }
    }
    i++;
  }
  return null;
}

// Extracts top-level string fields ("title", "url", "ref_id") from a JSON
// object starting at `openBrace` without requiring the full parent document to
// be unclipped.
function scanObjectFields(
  s: string,
  openBrace: number,
  maxChars = 100_000,
): { title?: string; url?: string; refId?: string } {
  const result: { title?: string; url?: string; refId?: string } = {};
  const limit = Math.min(s.length, openBrace + maxChars);
  let depth = 0;
  for (let i = openBrace; i < limit; ) {
    const ch = s[i];
    if (ch === "{") {
      depth++;
      i++;
      continue;
    }
    if (ch === "}") {
      depth--;
      i++;
      if (depth === 0) break;
      continue;
    }
    if (ch === '"') {
      const parsed = readJSONString(s, i);
      if (!parsed) break;
      const [key, afterKey] = parsed;
      i = afterKey;
      if (
        depth === 1 &&
        (key === "title" || key === "url" || key === "ref_id")
      ) {
        let j = i;
        while (
          j < limit &&
          (s[j] === " " || s[j] === "\t" || s[j] === "\n" || s[j] === "\r")
        ) {
          j++;
        }
        if (s[j] === ":") {
          j++;
          while (
            j < limit &&
            (s[j] === " " || s[j] === "\t" || s[j] === "\n" || s[j] === "\r")
          ) {
            j++;
          }
          if (s[j] === '"') {
            const val = readJSONString(s, j);
            if (val) {
              if (key === "title") result.title = val[0];
              else if (key === "url") result.url = val[0];
              else result.refId = val[0];
              i = val[1];
            }
          }
        }
      }
      continue;
    }
    i++;
  }
  return result;
}

function findEnclosingBrace(s: string, pos: number, maxBack = 20_000): number {
  const min = Math.max(0, pos - maxBack);
  let depth = 0;
  let inString = false;
  for (let i = pos - 1; i >= min; i--) {
    const ch = s[i];
    if (ch === '"') {
      let backslashes = 0;
      for (let k = i - 1; k >= min && s[k] === "\\"; k--) backslashes++;
      if (backslashes % 2 === 0) inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "}") depth++;
    else if (ch === "{") {
      if (depth === 0) return i;
      depth--;
    }
  }
  return -1;
}

function extractTextHeaderCitations(
  text: string,
  map: Map<string, CitationSource>,
) {
  if (!text.includes("【")) return;
  const pattern =
    /([^\r\n"]+?)\s*\((https?:\/\/[^\s)]+)\)(?:\\r\\n|\\n|\r?\n)【([A-Za-z0-9_-]{1,64})】/g;
  for (const match of text.matchAll(pattern)) {
    let title = match[1].trim();
    const textPrefix = title.lastIndexOf('"text":');
    if (textPrefix >= 0) {
      const q = title.indexOf('"', textPrefix + 7);
      if (q >= 0) title = title.slice(q + 1);
    }
    title = title.replace(/\\"/g, '"').replace(/\\\\/g, "\\");
    addSource(map, match[3], title, match[2]);
  }
}

// Legacy fallback for historical runs saved before Codex citation resolution
// existed on the backend. Only inspects tool items when raw markers remain.
export function extractLegacyToolCitations(
  items?: Item[],
): Map<string, CitationSource> {
  const map = new Map<string, CitationSource>();
  if (!items?.length) return map;
  for (const item of items) {
    if (item.kind !== "tool" || !item.text) continue;
    const text = item.text;
    if (
      !text.includes("ref_id") &&
      !text.includes("sonic_browser_tool") &&
      !text.includes("【")
    ) {
      continue;
    }
    // 1. raw_messages[*].content objects carrying "ref_id", "title", "url".
    for (const match of text.matchAll(
      /"ref_id"\s*:\s*"([A-Za-z0-9_-]{1,64})"/g,
    )) {
      const brace = findEnclosingBrace(text, match.index ?? 0);
      if (brace < 0) continue;
      const fields = scanObjectFields(text, brace);
      if (fields.refId && fields.url) {
        addSource(map, fields.refId, fields.title ?? "", fields.url);
      }
    }
    // 2. sonic_browser_tool.content["<ref_id>"] = { ..., "title": ..., "url": ... }.
    for (const match of text.matchAll(/"(turn\d+[A-Za-z]+\d+)"\s*:\s*\{/g)) {
      const brace = (match.index ?? 0) + match[0].length - 1;
      const fields = scanObjectFields(text, brace);
      if (fields.url) {
        addSource(map, match[1], fields.title ?? "", fields.url);
      }
    }
    // 3. "<Title> (<URL>)\n【<ref_id>】" text blocks.
    extractTextHeaderCitations(text, map);
  }
  return map;
}

export function resolveDisplayCitations(
  text: string,
  citations?: Citation[],
  fallbackItems?: Item[],
  running = false,
): { text: string; citations: Citation[] } {
  if (citations?.length) {
    if (!text.includes(PUA_START)) {
      return { text, citations };
    }
    return { text: stripCitationMarkers(text, running), citations };
  }
  if (!text.includes(PUA_START)) {
    return { text, citations: [] };
  }
  const index = extractLegacyToolCitations(fallbackItems);
  return resolveInlineCitations(text, index.size ? index : null, running);
}

function findCodeRanges(s: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  let atLineStart = true;
  let fenceChar = "";
  let fenceLen = 0;
  let fenceStart = -1;
  let inlineCodeLen = 0;
  let inlineStart = -1;

  for (let i = 0; i < s.length; ) {
    if (atLineStart && inlineCodeLen === 0) {
      atLineStart = false;
      const fence = scanCodeFenceLine(s, i, fenceChar, fenceLen);
      if (fence.handled) {
        if (fenceLen === 0) {
          fenceStart = i;
        } else {
          ranges.push([fenceStart, fence.next]);
          fenceStart = -1;
        }
        fenceChar = fence.char;
        fenceLen = fence.count;
        i = fence.next;
        atLineStart = i > 0 && s[i - 1] === "\n";
        continue;
      }
    }
    if (fenceLen > 0) {
      const nl = s.indexOf("\n", i);
      if (nl < 0) break;
      i = nl + 1;
      atLineStart = true;
      continue;
    }
    if (s[i] === "`") {
      let end = i;
      while (end < s.length && s[end] === "`") end++;
      const runLen = end - i;
      if (inlineCodeLen === 0) {
        if (hasClosingBackticks(s, end, runLen)) {
          inlineCodeLen = runLen;
          inlineStart = i;
        }
      } else if (runLen === inlineCodeLen) {
        ranges.push([inlineStart, end]);
        inlineCodeLen = 0;
        inlineStart = -1;
      }
      i = end;
      continue;
    }
    atLineStart = s[i] === "\n";
    i++;
  }
  if (fenceStart >= 0) ranges.push([fenceStart, s.length]);
  return ranges;
}

function insideRanges(
  offset: number,
  ranges: Array<[number, number]>,
): boolean {
  for (const [start, end] of ranges) {
    if (offset > start && offset < end) return true;
  }
  return false;
}

export function insertCitationSentinels(
  text: string,
  rawCitations: Citation[],
): { markdown: string; citations: Citation[] } {
  if (!rawCitations.length || text.includes(CITATION_SENTINEL_START)) {
    return { markdown: text, citations: [] };
  }
  const normalized: Citation[] = [];
  for (const citation of rawCitations) {
    const sources: CitationSource[] = [];
    const seen = new Set<string>();
    for (const source of citation.sources ?? []) {
      const url = safeCitationURL(source.url);
      if (!url || seen.has(url)) continue;
      seen.add(url);
      sources.push({ title: source.title?.trim() || undefined, url });
    }
    if (!sources.length) continue;
    const offset = Math.max(
      0,
      Math.min(text.length, Math.trunc(citation.offset)),
    );
    normalized.push({ offset, sources });
  }
  if (!normalized.length) {
    return { markdown: text, citations: [] };
  }
  normalized.sort((a, b) => a.offset - b.offset);

  const merged: Citation[] = [];
  for (const citation of normalized) {
    appendMergedCitation(merged, citation.offset, citation.sources);
  }

  const codeRanges = findCodeRanges(text);
  const placed: Citation[] = [];
  let markdown = "";
  let cursor = 0;
  for (const citation of merged) {
    if (insideRanges(citation.offset, codeRanges)) continue;
    markdown += text.slice(cursor, citation.offset);
    markdown += `${CITATION_SENTINEL_START}${placed.length}${CITATION_SENTINEL_END}`;
    placed.push(citation);
    cursor = citation.offset;
  }
  markdown += text.slice(cursor);
  return { markdown, citations: placed };
}
