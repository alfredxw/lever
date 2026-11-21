import { escapeText } from "entities";
import { DocumentMarkup } from "./documentMarkup";
import type { OfficeWorkerResult } from "./officePreviewProtocol";

const OMITTED_DESTINATIONS = new Set(
  "colortbl stylesheet info pict object fldinst header headerl headerr headerf footer footerl footerr footerf filetbl datastore themedata".split(
    " ",
  ),
);
// RTF font charsets and ANSI code pages use different numeric identifiers.
const fontCharsets: Readonly<Partial<Record<number, number>>> = {
  77: 10000,
  128: 932,
  129: 949,
  134: 936,
  136: 950,
  161: 1253,
  162: 1254,
  163: 1258,
  177: 1255,
  178: 1256,
  186: 1257,
  204: 1251,
  222: 874,
  238: 1250,
  255: 866,
};
const namedEncodings: Readonly<Partial<Record<number, string>>> = {
  866: "ibm866",
  932: "shift_jis",
  936: "gbk",
  949: "euc-kr",
  950: "big5",
  10000: "macintosh",
  65001: "utf-8",
};
function codePageEncoding(codePage: number) {
  return namedEncodings[codePage] ?? `windows-${codePage}`;
}
const literals = new Map([
  ["tab", "\t"],
  ["cell", "\t"],
  ["endash", "–"],
  ["emdash", "—"],
  ["bullet", "•"],
  ["lquote", "‘"],
  ["rquote", "’"],
  ["ldblquote", "“"],
  ["rdblquote", "”"],
]);
const formatting = new Map([
  ["b", "strong"],
  ["i", "em"],
  ["ul", "u"],
]);

export function openRtf(buffer: ArrayBuffer): OfficeWorkerResult {
  const limit = 8 * 1024 * 1024;
  if (buffer.byteLength > limit)
    throw new Error("Rich text preview limited to files under 8 MB.");
  const bytes = new Uint8Array(buffer);
  // Windows-1252 maps each source byte to one code unit. Decode visible runs later, using their selected font.
  const source = new TextDecoder("windows-1252").decode(bytes);
  if (!/^\{\\rtf\d+/.test(source))
    throw new Error("This is not a valid rich text document.");
  const markup = new DocumentMarkup(limit);
  const pages: { title: string; html: string }[] = [];
  const fonts = new Map<number, TextDecoder>();
  let defaultFont = 0;
  let style = {
    decoder: new TextDecoder("windows-1252"),
    font: 0,
    fontTable: false,
    tags: new Set<string>(),
    fallbackLength: 1,
    hidden: false,
  };
  const groups: (typeof style)[] = [];
  let skip = 0;
  let run = "";
  let pageHasContent = false;
  const encoded = new Uint8Array(bytes.length);
  let used = 0;
  markup.append("<p>");

  const flushBytes = () => {
    if (!used) return;
    run += (fonts.get(style.font) ?? style.decoder).decode(
      encoded.subarray(0, used),
    );
    used = 0;
  };
  const flush = () => {
    flushBytes();
    if (!run) return;
    const tags = [...style.tags];
    for (const tag of tags) markup.append(`<${tag}>`);
    markup.append(escapeText(run));
    for (const tag of tags.reverse()) markup.append(`</${tag}>`);
    run = "";
    pageHasContent = true;
  };
  const literal = (text: string) => {
    if (skip) skip--;
    else if (!style.hidden) run += text;
  };
  const page = () => {
    if (pages.length >= 500)
      throw new Error("Rich text preview limited to 500 pages.");
    markup.append("</p>");
    pages.push({
      title: `Page ${pages.length + 1}`,
      html: markup.finishPage(),
    });
    markup.append("<p>");
    pageHasContent = false;
  };
  const line = () => {
    if (!style.hidden) {
      flush();
      markup.append("<br>");
      pageHasContent = true;
    }
  };

  // Each token is a byte escape, control word, control symbol, group boundary, or text run.
  const token =
    /\\(?:'([0-9a-f]{2})|([a-z]+)(-?\d+)? ?|([\s\S]))|([{}])|[\r\n]+|([^\\{}\r\n]+)/iy;
  let match: RegExpExecArray | null;
  while ((match = token.exec(source))) {
    const [whole, hex, word, parameter, symbol, group, raw] = match;
    if (!groups.length && group !== "{" && !/^\s+$/.test(whole))
      throw new Error("Unexpected content outside the rich text document.");
    if (raw !== undefined) {
      if (!groups.length) continue;
      const count = Math.min(skip, raw.length);
      skip -= count;
      if (!style.hidden) {
        const visible = bytes.subarray(match.index + count, token.lastIndex);
        encoded.set(visible, used);
        used += visible.length;
      }
      continue;
    }
    if (hex !== undefined) {
      if (skip) skip--;
      else if (!style.hidden) encoded[used++] = Number.parseInt(hex, 16);
      continue;
    }
    if (group) {
      flush();
      skip = 0;
      if (group === "{") {
        if (groups.length >= 100)
          throw new Error("Rich text document is nested too deeply.");
        groups.push(style);
        style = { ...style, tags: new Set(style.tags) };
      } else {
        const parent = groups.pop();
        if (!parent) throw new Error("Unbalanced rich text groups.");
        style = parent;
      }
      continue;
    }
    if (symbol !== undefined) {
      flushBytes();
      if (symbol === "*") {
        flush();
        style.hidden = true;
      } else if (symbol === "'")
        throw new Error("Invalid rich text byte escape.");
      else if (symbol === "\n" || symbol === "\r") line();
      else if (symbol === "~") literal("\u00a0");
      else if (symbol === "_" || symbol === "-")
        literal(symbol === "_" ? "\u2011" : "\u00ad");
      else if ("{}\\".includes(symbol)) literal(symbol);
      continue;
    }
    if (word === undefined) continue;
    flushBytes();
    const control = word.toLowerCase();
    const value = parameter === undefined ? 1 : Number(parameter);
    const tag = formatting.get(control);
    if (tag || control === "ulnone" || control === "plain") {
      flush();
      if (control === "plain") {
        style.tags.clear();
        style.font = defaultFont;
      } else if (tag && value) style.tags.add(tag);
      else style.tags.delete(tag ?? "u");
    } else if (control === "fonttbl" || OMITTED_DESTINATIONS.has(control)) {
      flush();
      style.hidden = true;
      if (control === "fonttbl") style.fontTable = true;
    } else if (control === "bin") {
      if (
        value < 0 ||
        value > source.length - token.lastIndex ||
        !Number.isSafeInteger(value)
      )
        throw new Error("Invalid rich text binary data.");
      token.lastIndex += value;
    } else if (control === "deff" || control === "f") {
      style.font = value;
      if (control === "deff") defaultFont = value;
    } else if (control === "fcharset" && style.fontTable) {
      const codePage = fontCharsets[value];
      const encoding =
        codePage === undefined
          ? style.decoder.encoding
          : codePageEncoding(codePage);
      fonts.set(style.font, new TextDecoder(encoding));
    } else if (control === "ansicpg" || control === "mac") {
      style.decoder = new TextDecoder(
        control === "mac" ? "macintosh" : codePageEncoding(value),
      );
    } else if (control === "uc") {
      style.fallbackLength = Math.max(0, Math.min(10, value));
    } else if (control === "u") {
      skip = 0;
      literal(String.fromCharCode(value));
      skip = style.fallbackLength;
    } else if (control === "page" && !style.hidden) {
      flush();
      page();
    } else if (control === "par" || control === "line" || control === "row") {
      line();
    } else if (literals.has(control)) {
      literal(literals.get(control)!);
    }
  }
  if (groups.length) throw new Error("Unbalanced rich text groups.");
  if (pageHasContent || !pages.length) page();
  return { type: "document", navigation: "page", pages };
}
