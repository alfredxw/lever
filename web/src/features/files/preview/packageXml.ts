import { decodeHTMLStrict } from "entities";
import type JSZip from "jszip";
import { SaxesParser } from "saxes";

export type XmlElement = {
  name: string;
  namespace: string;
  attributes: Record<string, string>;
  content: (string | XmlElement)[];
};

export async function readPackageXml(
  archive: JSZip,
  path: string,
  xhtml = false,
) {
  const source = await archive.file(path)?.async("string");
  if (!source) throw new Error(`Missing document entry: ${path}`);
  const parser = new SaxesParser({ xmlns: true });
  if (xhtml) {
    // Older XHTML refers to named HTML entities from a DTD. Resolve the names locally.
    for (const [entity, name] of source.matchAll(/&([a-z][a-z0-9]{0,39});/gi)) {
      if (name in parser.ENTITIES) continue;
      const value = decodeHTMLStrict(entity);
      if (value !== entity) parser.ENTITIES[name] = value;
    }
  }
  parser.on("doctype", (declaration) => {
    if (!xhtml || declaration.includes("["))
      throw new Error("Unsupported document type declaration.");
  });
  parser.on("error", () => {
    throw new Error("This document contains invalid XML.");
  });
  const stack: XmlElement[] = [];
  let root: XmlElement | undefined;
  let elements = 0;
  parser.on("opentag", (tag) => {
    if (++elements > 100_000 || stack.length >= 100)
      throw new Error("The document structure exceeds the preview limits.");
    const attributes: Record<string, string> = Object.create(null);
    for (const { local, uri, value } of Object.values(tag.attributes)) {
      attributes[uri ? `${uri} ${local}` : local] = value;
    }
    const element = {
      name: tag.local,
      namespace: tag.uri,
      attributes,
      content: [],
    };
    const parent = stack.at(-1);
    if (parent) parent.content.push(element);
    else root = element;
    stack.push(element);
  });
  parser.on("closetag", () => {
    stack.pop();
  });
  const append = (text: string) => stack.at(-1)?.content.push(text);
  parser.on("text", append);
  parser.on("cdata", append);
  parser.write(source).close();
  if (!root) throw new Error("This document has no readable content.");
  return root;
}

export function xmlChildren(
  element: XmlElement,
  name: string,
  namespace?: string,
) {
  return element.content.filter(
    (child): child is XmlElement =>
      typeof child !== "string" &&
      child.name === name &&
      (namespace === undefined || child.namespace === namespace),
  );
}

export function xmlText(element: XmlElement | undefined): string {
  return (
    element?.content
      .map((child) => (typeof child === "string" ? child : xmlText(child)))
      .join("") ?? ""
  );
}
