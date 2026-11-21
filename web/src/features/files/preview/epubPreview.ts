import { escapeAttribute, escapeText } from "entities";
import type JSZip from "jszip";
import {
  DocumentMarkup,
  packageRaster,
  resolvePackagePath,
} from "./documentMarkup";
import type { OfficeWorkerResult } from "./officePreviewProtocol";
import {
  readPackageXml,
  xmlChildren,
  xmlText,
  type XmlElement,
} from "./packageXml";

const XHTML_ELEMENTS = new Set(
  "p h1 h2 h3 h4 h5 h6 div span strong b em i u s ul ol li blockquote pre code table thead tbody tr th td caption figure figcaption sub sup dl dt dd".split(
    " ",
  ),
);
const OMIT = new Set(
  "head script style iframe object embed svg math form".split(" "),
);

async function renderChapter(
  archive: JSZip,
  path: string,
  markup: DocumentMarkup,
  element: XmlElement,
): Promise<void> {
  const tag = element.name.toLowerCase();
  if (OMIT.has(tag)) return;
  if (tag === "img") {
    const source = await packageRaster(
      archive,
      resolvePackagePath(path, element.attributes.src ?? ""),
    );
    if (source)
      markup.append(
        `<img src="${source}" alt="${escapeAttribute(element.attributes.alt ?? "")}">`,
      );
    return;
  }
  if (tag === "br" || tag === "hr") {
    markup.append(`<${tag}>`);
    return;
  }
  const renderTag = XHTML_ELEMENTS.has(tag);
  if (renderTag) {
    let attributes = "";
    if (tag === "th" || tag === "td") {
      for (const name of ["rowspan", "colspan"]) {
        const span = element.attributes[name];
        if (span && /^\d{1,4}$/.test(span)) attributes += ` ${name}="${span}"`;
      }
    }
    markup.append(`<${tag}${attributes}>`);
  }
  for (const child of element.content) {
    if (typeof child === "string") markup.append(escapeText(child));
    else await renderChapter(archive, path, markup, child);
  }
  if (renderTag) markup.append(`</${tag}>`);
}

function firstHeading(node: XmlElement): XmlElement | undefined {
  if (node.name === "h1") return node;
  for (const child of node.content) {
    if (typeof child === "string") continue;
    const heading = firstHeading(child);
    if (heading) return heading;
  }
}

export async function openEpub(archive: JSZip): Promise<OfficeWorkerResult> {
  const container = await readPackageXml(archive, "META-INF/container.xml");
  const roots = xmlChildren(container, "rootfiles")[0];
  const packageRef =
    roots && xmlChildren(roots, "rootfile")[0]?.attributes["full-path"];
  const packagePath = resolvePackagePath("", packageRef ?? "");
  if (!packagePath) throw new Error("This EPUB has no readable package.");
  const book = await readPackageXml(archive, packagePath);
  const [manifest] = xmlChildren(book, "manifest");
  const [spine] = xmlChildren(book, "spine");
  if (!manifest || !spine)
    throw new Error("This EPUB has no readable chapters.");
  const entries = new Map(
    xmlChildren(manifest, "item").map(({ attributes }) => [
      attributes.id,
      attributes,
    ]),
  );
  const order = xmlChildren(spine, "itemref");
  if (order.length > 500) throw new Error("Preview limited to 500 chapters.");
  const pages = [];
  const markup = new DocumentMarkup();
  for (const reference of order) {
    const item = entries.get(reference.attributes.idref);
    if (item?.["media-type"] !== "application/xhtml+xml") continue;
    const path = resolvePackagePath(packagePath, item.href ?? "");
    if (!path || !archive.file(path)) continue;
    const chapter = await readPackageXml(archive, path, true);
    const [head] = xmlChildren(chapter, "head");
    const body = xmlChildren(chapter, "body")[0] ?? chapter;
    const title = (
      (head && xmlText(xmlChildren(head, "title")[0]).trim()) ||
      xmlText(firstHeading(body)).trim()
    ).slice(0, 120);
    await renderChapter(archive, path, markup, body);
    pages.push({
      title: title || `Chapter ${pages.length + 1}`,
      html: markup.finishPage(),
    });
  }
  if (!pages.length)
    throw new Error("This EPUB has no readable XHTML chapters.");
  return { type: "document", navigation: "chapter", pages };
}
