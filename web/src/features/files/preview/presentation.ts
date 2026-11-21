import { XMLParser, XMLValidator } from "fast-xml-parser";
import type JSZip from "jszip";
import type { OfficeWorkerResult } from "./officePreviewProtocol";

const escape = (text: string) =>
  text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
const localName = (key: string) => key.split(":").at(-1) ?? key;
const element = (value: any, name: string): any =>
  Object.entries(value ?? {}).find(
    ([key]) => !key.startsWith("@_") && localName(key) === name,
  )?.[1];
const attribute = (value: any, name: string): string | undefined =>
  Object.entries(value ?? {}).find(
    ([key]) => key.startsWith("@_") && localName(key.slice(2)) === name,
  )?.[1] as string | undefined;
const array = <T>(value: T | T[] | undefined): T[] =>
  value === undefined ? [] : Array.isArray(value) ? value : [value];
// Content preview follows the deck's relationship order, including reordered slides.
export async function openPresentation(
  archive: JSZip,
): Promise<OfficeWorkerResult> {
  const parser = new XMLParser({
    ignoreAttributes: false,
    removeNSPrefix: false,
    parseTagValue: false,
    processEntities: true,
  });
  const xml = async (path: string) => {
    const source = await archive.file(path)?.async("string");
    if (!source || XMLValidator.validate(source) !== true)
      throw new Error("Invalid presentation XML.");
    return parser.parse(source);
  };
  const deck = await xml("ppt/presentation.xml");
  const relationships = await xml("ppt/_rels/presentation.xml.rels");
  const refs = new Map<string, string>(
    array<any>(element(element(relationships, "Relationships"), "Relationship"))
      .filter((r) => r["@_TargetMode"] !== "External")
      .map((r) => [r["@_Id"], r["@_Target"]]),
  );
  const slides = array<any>(
    element(element(element(deck, "presentation"), "sldIdLst"), "sldId"),
  );
  if (!slides.length || slides.length > 500)
    throw new Error("Preview limited to 1–500 slides.");
  const pages = [];
  let markupSize = 0;
  for (const [index, slide] of slides.entries()) {
    const target = refs.get(
      Object.entries(slide).find(
        ([key]) =>
          key.startsWith("@_") && key.includes(":") && localName(key) === "id",
      )?.[1] as string,
    );
    if (!target || /^(?:[a-z]+:|\/|\\)/i.test(target))
      throw new Error("Invalid slide relationship.");
    const path = new URL(target, "https://preview.invalid/ppt/").pathname.slice(
      1,
    );
    const data = await xml(path);
    const paragraphs: string[] = [];
    const images: string[] = [];
    // Paragraphs and tables retain their reading order; no scripts or external assets.
    const collect = (node: unknown, depth = 0) => {
      if (depth > 100) throw new Error("Presentation is nested too deeply.");
      if (!node || typeof node !== "object") return;
      for (const [key, value] of Object.entries(node)) {
        if (!key.startsWith("@_") && localName(key) === "blip") {
          for (const blip of array(value)) {
            const id = attribute(blip, "embed");
            if (id) images.push(id);
          }
        } else if (!key.startsWith("@_") && localName(key) === "p") {
          for (const paragraph of array(value)) {
            const runs: string[] = [];
            const text = (part: any, depth = 0) => {
              if (depth > 100)
                throw new Error("Presentation is nested too deeply.");
              if (!part || typeof part !== "object") return;
              for (const [tag, child] of Object.entries(part)) {
                if (!tag.startsWith("@_") && localName(tag) === "t")
                  runs.push(String(child));
                else if (!tag.startsWith("@_") && localName(tag) === "br")
                  runs.push("\n");
                else if (!tag.startsWith("@_"))
                  for (const item of array(child)) text(item, depth + 1);
              }
            };
            text(paragraph);
            if (runs.length) paragraphs.push(`<p>${escape(runs.join(""))}</p>`);
          }
        } else for (const child of array(value)) collect(child, depth + 1);
      }
    };
    collect(data);
    const relPath = path.replace(/([^/]+)$/, "_rels/$1.rels");
    if (images.length && archive.file(relPath)) {
      const slideRefs = element(
        element(await xml(relPath), "Relationships"),
        "Relationship",
      );
      for (const id of images.slice(0, 100)) {
        const ref = array<any>(slideRefs).find(
          (value) =>
            value["@_Id"] === id && value["@_TargetMode"] !== "External",
        );
        const target = ref?.["@_Target"] as string | undefined;
        if (!target || /^(?:[a-z]+:|\/|\\)/i.test(target)) continue;
        const imagePath = new URL(
          target,
          `https://preview.invalid/${path}`,
        ).pathname.slice(1);
        const type = /\.(png|jpe?g|gif|webp)$/i
          .exec(imagePath)?.[1]
          ?.toLowerCase()
          .replace("jpg", "jpeg");
        const image = archive.file(imagePath);
        if (type && image) {
          const data = await image.async("base64");
          markupSize += data.length;
          if (markupSize > 16 * 1024 * 1024)
            throw new Error("Presentation exceeds the preview size limit.");
          paragraphs.push(
            `<img src="data:image/${type};base64,${data}" alt=""/>`,
          );
        }
      }
    }
    const html = paragraphs.join("") || "<p>—</p>";
    markupSize += html.length;
    if (markupSize > 16 * 1024 * 1024)
      throw new Error("Presentation exceeds the preview size limit.");
    pages.push({
      title: `Slide ${index + 1}`,
      html,
    });
  }
  return { type: "document", navigation: "slide", pages };
}
