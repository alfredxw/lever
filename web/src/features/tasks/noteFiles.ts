import type { JSONContent, Editor } from "@tiptap/core";
import { DOMSerializer } from "@tiptap/pm/model";
import { isMyGo } from "mygo-runtime";
import { Dialogs } from "@/api/desktop.gen";
import { api } from "@/api/client";
import type { TaskNote, TaskNotesDirectory } from "@/api/types.gen";
import { noteAssetURL, type NoteAsset } from "./noteAsset";
import {
  parseNoteFile,
  serializeNoteMarkdown,
  taskNoteSchema,
} from "./taskDocument";
import { createTaskNote } from "./useTaskNote";
import i18n from "@/i18n";

export function downloadNote(data: Blob, name: string) {
  const url = URL.createObjectURL(data);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

function filename(title: string) {
  return title.replace(/[/\\:*?"<>|\u0000-\u001f]/g, "-").trim() || "Note";
}

function noteAssets(doc: Editor["state"]["doc"]) {
  const assets = new Map<string, string>();
  doc.descendants((node) => {
    const { path, name, scenePath, previewPath, title } = node.attrs;
    if (node.type.name === "noteAsset") assets.set(path, name);
    if (node.type.name === "noteWhiteboard") {
      if (scenePath) assets.set(scenePath, title + ".drawnix");
      if (previewPath) assets.set(previewPath, title + ".png");
    }
    if (node.type.name === "markdownImage" && noteAssetURL(node.attrs.src, ""))
      assets.set(node.attrs.src, node.attrs.alt || "image");
  });
  return assets;
}

export async function exportNoteMarkdown(title: string, editor: Editor) {
  const doc = editor.state.doc;
  const md = serializeNoteMarkdown(doc.toJSON());
  const assets = noteAssets(doc);
  const base = filename(title);
  if (!assets.size) {
    downloadNote(
      new Blob([md], { type: "text/markdown;charset=utf-8" }),
      base + ".md",
    );
    return;
  }
  const { default: JSZip } = await import("jszip");
  const zip = new JSZip();
  zip.file(base + ".md", md);
  for (const [path, name] of assets) {
    const url = noteAssetURL(path, name);
    if (!url) throw new Error(i18n.t("tasks.assetMissing", { name }));
    const response = await fetch(url);
    if (!response.ok) throw new Error(i18n.t("tasks.assetMissing", { name }));
    zip.file(path, await response.arrayBuffer());
  }
  downloadNote(await zip.generateAsync({ type: "blob" }), base + ".zip");
}

// Both the system print dialog and the desktop PDF renderer use print media.
export async function printNote(title: string, editor: Editor) {
  document.querySelector(".note-print-document")?.remove();
  const article = document.createElement("article");
  article.className = "note-print-document";
  const heading = document.createElement("h1");
  heading.textContent = title;
  article.append(
    heading,
    DOMSerializer.fromSchema(editor.schema).serializeFragment(
      editor.state.doc.content,
    ),
  );
  document.body.append(article);
  try {
    const images = Array.from(article.querySelectorAll("img"));
    images.forEach((img) => {
      img.loading = "eager";
    });
    await Promise.allSettled(images.map((image) => image.decode()));
    if (!article.isConnected) return;
    if (isMyGo()) {
      const data = await Dialogs.notePDF();
      const bytes = Uint8Array.from(atob(data), (char) => char.charCodeAt(0));
      downloadNote(
        new Blob([bytes], { type: "application/pdf" }),
        filename(title) + ".pdf",
      );
      article.remove();
    } else {
      window.addEventListener("afterprint", () => article.remove(), {
        once: true,
      });
      window.print();
    }
  } catch (error) {
    article.remove();
    throw error;
  }
}

async function pdfText(file: File) {
  const [{ getDocument, GlobalWorkerOptions }, { default: worker }] =
    await Promise.all([
      import("pdfjs-dist"),
      import("pdfjs-dist/build/pdf.worker.min.mjs?url"),
    ]);
  GlobalWorkerOptions.workerSrc = worker;
  const task = getDocument({
    data: await file.arrayBuffer(),
    cMapUrl: "/pdfjs/cmaps/",
    cMapPacked: true,
    standardFontDataUrl: "/pdfjs/standard_fonts/",
  });
  try {
    const pdf = await task.promise;
    const pages: JSONContent[] = [];
    let size = 0;
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const items = await page.getTextContent();
      const text = items.items
        .map((item) =>
          "str" in item ? item.str + (item.hasEOL ? "\n" : " ") : "",
        )
        .join("")
        .trim();
      size += text.length;
      if (size > 1024 * 1024) throw new Error(i18n.t("tasks.importTooLarge"));
      for (const line of text.split(/\n+/).filter(Boolean))
        pages.push({
          type: "paragraph",
          content: [{ type: "text", text: line }],
        });
    }
    if (!pages.length) throw new Error(i18n.t("tasks.pdfNoText"));
    return { type: "doc", content: pages };
  } finally {
    await task.destroy();
  }
}

export async function importNoteFile(file: File): Promise<TaskNote> {
  const { path: directory } = await api<TaskNotesDirectory>(
    "/tasks/notes-directory",
  );
  let name = file.name;
  let content: JSONContent;
  if (/\.pdf$/i.test(name)) content = await pdfText(file);
  else {
    if (/\.zip$/i.test(name)) {
      const { boundedZip } =
        await import("@/features/files/preview/boundedZip");
      const entries = await boundedZip(
        await file.arrayBuffer(),
        Math.max(50 * 1024 * 1024, file.size),
        20 * 1024 * 1024,
      );
      const docs = [...entries.keys()].filter(
        (path) => !path.includes("/") && /\.(md|markdown)$/i.test(path),
      );
      if (docs.length !== 1) throw new Error(i18n.t("tasks.invalidNoteBundle"));
      name = docs[0];
      content = parseNoteFile(
        new TextDecoder("utf-8", { fatal: true }).decode(
          entries.get(name)!.bytes,
        ),
      );
      for (const [path, assetName] of noteAssets(
        taskNoteSchema.nodeFromJSON(content),
      )) {
        const entry = entries.get(path);
        if (!entry || entry.directory)
          throw new Error(i18n.t("tasks.assetMissing", { name: assetName }));
        const digest = await crypto.subtle.digest("SHA-256", entry.bytes);
        const hash = Array.from(new Uint8Array(digest), (byte) =>
          byte.toString(16).padStart(2, "0"),
        ).join("");
        if (".assets/" + hash !== path)
          throw new Error(i18n.t("tasks.invalidNoteBundle"));
        const form = new FormData();
        form.append("file", new Blob([entry.bytes]), hash);
        await api<NoteAsset>(
          "/tasks/note-assets?" + new URLSearchParams({ directory }),
          form,
        );
      }
    } else {
      if (file.size > 1024 * 1024)
        throw new Error(i18n.t("tasks.importTooLarge"));
      content = parseNoteFile(
        new TextDecoder("utf-8", { fatal: true }).decode(
          await file.arrayBuffer(),
        ),
      );
    }
  }
  return createTaskNote({
    id: crypto.randomUUID(),
    title:
      Array.from(name.replace(/\.(md|markdown|pdf)$/i, ""))
        .slice(0, 100)
        .join("") || "Note",
    directory,
    content,
  });
}
