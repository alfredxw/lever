import assert from "node:assert/strict";
import { test } from "node:test";
import JSZip from "jszip";
import {
  fileKind,
  isTextKind,
} from "../src/features/files/preview/fileKind.ts";
import { parseDelimitedPreview } from "../src/features/files/preview/delimited.ts";
import { boundedZip } from "../src/features/files/preview/boundedZip.ts";
import { openPresentation } from "../src/features/files/preview/presentation.ts";

test("preview types preserve literal filenames and route binary formats away from editing", () => {
  for (const path of [
    "icon.PNG",
    "folder/a#b.svg",
    "folder/a?b.heic",
    "a.tiff",
  ])
    assert.equal(fileKind(path), "image");
  for (const path of [
    "pdf",
    "README",
    "dir.with.dot/source",
    "image.png.backup",
  ])
    assert.equal(fileKind(path), "text");
  for (const path of [
    "book.pdf",
    "a.mp4",
    "a.woff2",
    "book.xlsx",
    "a.sqlite",
    "a.tgz",
  ])
    assert.equal(isTextKind(fileKind(path)), false);
  for (const path of ["a.csv", "a.mmd", "a.html", "a.mdx", "a.go"])
    assert.equal(isTextKind(fileKind(path)), true);
});

test("table previews preserve quoted delimiters, newlines and escaped quotes", () => {
  assert.deepEqual(
    parseDelimitedPreview('name,value\r\n"a,b","line 1\nline ""2"""\r\n', ","),
    {
      rows: [
        ["name", "value"],
        ["a,b", 'line 1\nline "2"'],
      ],
      truncated: false,
    },
  );
  assert.equal(
    parseDelimitedPreview("a\nb\nc", ",", {
      maxRows: 2,
      maxColumns: 1,
      maxCellLength: 10,
    }).truncated,
    true,
  );
});

test("archive expansion limits are enforced before content reaches renderers", async () => {
  const zip = new JSZip();
  zip.file("small.txt", "hello");
  const bytes = await zip.generateAsync({ type: "arraybuffer" });
  assert.equal(
    new TextDecoder().decode((await boundedZip(bytes)).get("small.txt")?.bytes),
    "hello",
  );
  zip.file("large.txt", "x".repeat(2 * 1024 * 1024));
  await assert.rejects(
    boundedZip(
      await zip.generateAsync({ type: "arraybuffer", compression: "DEFLATE" }),
    ),
    /Expanded archive/,
  );
});

test("PowerPoint content follows relationships instead of filename or numeric slide id", async () => {
  const zip = new JSZip();
  zip.file(
    "ppt/presentation.xml",
    '<p:presentation xmlns:p="urn:slides" xmlns:r="urn:relations"><p:sldIdLst><p:sldId r:id="second" id="100"/><p:sldId r:id="first" id="101"/></p:sldIdLst></p:presentation>',
  );
  zip.file(
    "ppt/_rels/presentation.xml.rels",
    '<Relationships><Relationship Id="first" Target="slides/slide1.xml"/><Relationship Id="second" Target="slides/slide2.xml"/></Relationships>',
  );
  for (const number of [1, 2])
    zip.file(
      `ppt/slides/slide${number}.xml`,
      `<p:sld xmlns:p="urn:slides" xmlns:a="urn:drawing"><p:sp><a:p><a:r><a:t>Slide ${number}</a:t></a:r></a:p></p:sp></p:sld>`,
    );
  const result = await openPresentation(zip);
  assert.equal(result.type, "document");
  if (result.type === "document")
    assert.deepEqual(
      result.pages.map((page) => page.html),
      ["<p>Slide 2</p>", "<p>Slide 1</p>"],
    );
});
