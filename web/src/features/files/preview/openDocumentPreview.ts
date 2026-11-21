import { escapeText } from "entities";
import type JSZip from "jszip";
import {
  DocumentMarkup,
  packageRaster,
  resolvePackagePath,
} from "./documentMarkup";
import type { OfficeWorkerResult } from "./officePreviewProtocol";
import { readPackageXml, xmlChildren, type XmlElement } from "./packageXml";

const odf = "urn:oasis:names:tc:opendocument:xmlns:";
const office = `${odf}office:1.0`;
const table = `${odf}table:1.0`;
const text = `${odf}text:1.0`;
const drawing = `${odf}drawing:1.0`;
const link = "http://www.w3.org/1999/xlink";

const htmlTags = new Map([
  [`${text} p`, "p"],
  [`${text} h`, "h2"],
  [`${text} span`, "span"],
  [`${text} list`, "ul"],
  [`${text} list-item`, "li"],
  [`${table} table`, "table"],
  [`${table} table-row`, "tr"],
  [`${table} table-cell`, "td"],
]);
const omit = new Set([
  `${office} annotation`,
  `${office} scripts`,
  `${text} tracked-changes`,
  `${drawing} object`,
  `${drawing} object-ole`,
]);

function repetitions(
  element: XmlElement,
  namespace: string,
  name: string,
  maximum: number,
) {
  const count = Number(element.attributes[`${namespace} ${name}`] ?? 1);
  if (!Number.isSafeInteger(count) || count < 1)
    throw new Error("Invalid repetition in OpenDocument content.");
  return Math.min(count, maximum);
}

function whitespace(element: XmlElement) {
  if (element.namespace !== text) return;
  if (element.name === "line-break") return "\n";
  if (element.name === "tab") return "\t";
  if (element.name === "s")
    return " ".repeat(repetitions(element, text, "c", 100));
}

async function renderContent(
  archive: JSZip,
  markup: DocumentMarkup,
  element: XmlElement,
): Promise<void> {
  const key = `${element.namespace} ${element.name}`;
  if (omit.has(key)) return;
  if (key === `${drawing} image`) {
    const path = resolvePackagePath(
      "content.xml",
      element.attributes[`${link} href`] ?? "",
    );
    const src = await packageRaster(archive, path);
    if (src) markup.append(`<img alt="" src="${src}">`);
    return;
  }
  const space = whitespace(element);
  if (space !== undefined) {
    markup.append(
      space === "\n" ? "<br>" : `<span style="white-space:pre">${space}</span>`,
    );
    return;
  }
  const tag = htmlTags.get(key);
  if (tag) markup.append(`<${tag}>`);
  for (const child of element.content) {
    if (typeof child === "string") markup.append(escapeText(child));
    else await renderContent(archive, markup, child);
  }
  if (tag) markup.append(`</${tag}>`);
}

function visibleText(element: XmlElement): string {
  if (omit.has(`${element.namespace} ${element.name}`)) return "";
  return (
    whitespace(element) ??
    element.content
      .map((child) => (typeof child === "string" ? child : visibleText(child)))
      .join("")
  );
}

function* paragraphs(element: XmlElement): Generator<string> {
  if (omit.has(`${element.namespace} ${element.name}`)) return;
  if (element.namespace === text && element.name === "p")
    yield visibleText(element);
  else
    for (const child of element.content) {
      if (typeof child !== "string") yield* paragraphs(child);
    }
}

function* sheetRows(element: XmlElement): Generator<XmlElement> {
  for (const child of element.content) {
    if (typeof child === "string" || child.namespace !== table) continue;
    if (child.name === "table-row") yield child;
    if (
      ["table-rows", "table-header-rows", "table-row-group"].includes(
        child.name,
      )
    )
      yield* sheetRows(child);
  }
}

const MAX_ROWS = 500;
const MAX_COLUMNS = 50;

function workbookPreview(body: XmlElement): OfficeWorkerResult {
  const sheets = xmlChildren(body, "table", table);
  if (sheets.length === 0 || sheets.length > 100)
    throw new Error(
      "This workbook has no sheets or too many sheets to preview.",
    );
  let remaining = 8 * 1024 * 1024;
  return {
    type: "ods",
    sheets: sheets.map((sheet, index) => {
      const rows: string[][] = [];
      let emptyRows = 0;
      let truncated = false;
      let columns = 1;
      for (const row of sheetRows(sheet)) {
        const copies = repetitions(
          row,
          table,
          "number-rows-repeated",
          MAX_ROWS + 1,
        );
        const values: string[] = [];
        let hasContent = false;
        let rowSize = 0;
        for (const cell of row.content) {
          if (
            typeof cell === "string" ||
            cell.namespace !== table ||
            !["table-cell", "covered-table-cell"].includes(cell.name)
          )
            continue;
          const attrs = cell.attributes;
          const value =
            [...paragraphs(cell)].join("\n") ||
            attrs[`${office} value`] ||
            attrs[`${office} date-value`] ||
            attrs[`${office} boolean-value`] ||
            attrs[`${office} string-value`] ||
            "";
          if (value) hasContent = true;
          const count = repetitions(
            cell,
            table,
            "number-columns-repeated",
            MAX_COLUMNS + 1,
          );
          const visible = Math.min(count, MAX_COLUMNS - values.length);
          if (value && (count > visible || value.length > 10_000))
            truncated = true;
          const clipped = value.slice(0, 10_000);
          for (let i = 0; i < visible; i++) values.push(clipped);
          rowSize += clipped.length * visible;
        }
        if (!hasContent) {
          emptyRows = Math.min(MAX_ROWS, emptyRows + copies);
          continue;
        }
        while (emptyRows > 0 && rows.length < MAX_ROWS) {
          rows.push([]);
          emptyRows--;
        }
        emptyRows = 0;
        const visible = Math.min(copies, MAX_ROWS - rows.length);
        if (visible < copies) truncated = true;
        if (!visible) break;
        remaining -= rowSize * visible;
        if (remaining < 0)
          throw new Error("This spreadsheet has too much text to preview.");
        for (let i = 0; i < visible; i++) rows.push(values);
        columns = Math.max(columns, values.length);
      }
      return {
        name: sheet.attributes[`${table} name`] || `Sheet ${index + 1}`,
        rows,
        rowCount: rows.length,
        columns,
        truncated,
      };
    }),
  };
}

export async function openDocument(
  archive: JSZip,
  kind: "odt" | "ods" | "odp",
): Promise<OfficeWorkerResult> {
  const root = await readPackageXml(archive, "content.xml");
  const [body] = xmlChildren(root, "body", office);
  const sectionName = { odt: "text", ods: "spreadsheet", odp: "presentation" }[
    kind
  ];
  const section = body && xmlChildren(body, sectionName, office)[0];
  if (!section)
    throw new Error("This OpenDocument file has no readable content.");
  if (kind === "ods") return workbookPreview(section);
  const sections =
    kind === "odp" ? xmlChildren(section, "page", drawing) : [section];
  if (!sections.length || sections.length > 500)
    throw new Error("This document has no pages or too many pages to preview.");
  const markup = new DocumentMarkup();
  const pages = [];
  for (const [index, page] of sections.entries()) {
    await renderContent(archive, markup, page);
    pages.push({
      title: page.attributes[`${drawing} name`] || `Page ${index + 1}`,
      html: markup.finishPage(),
    });
  }
  return {
    type: "document",
    navigation: kind === "odp" ? "slide" : "page",
    pages,
  };
}
