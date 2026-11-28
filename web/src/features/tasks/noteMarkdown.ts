import { Node } from "@tiptap/core";
import { markdownTitle, noteAssetURL } from "./noteAsset";

export const MarkdownImage = Node.create({
  name: "markdownImage",
  inline: true,
  group: "inline",
  atom: true,
  markdownTokenName: "image",
  addAttributes: () => ({
    src: { default: "" },
    alt: { default: "" },
    title: { default: null },
  }),
  parseMarkdown: (token) => ({
    type: "markdownImage",
    attrs: { src: token.href, alt: token.text, title: token.title },
  }),
  renderMarkdown: (node) =>
    `![${String(node.attrs?.alt || "").replace(/[\\[\]]/g, "\\$&")}](<${String(node.attrs?.src || "").replace(/>/g, "%3E")}>${markdownTitle(node.attrs?.title)})`,
  parseHTML: () => [
    {
      tag: "img[data-markdown-src]",
      getAttrs: (el) => ({
        src: el.dataset.markdownSrc,
        alt: el.getAttribute("alt"),
        title: el.getAttribute("title"),
      }),
    },
  ],
  renderHTML({ node }) {
    const { src, alt, title } = node.attrs;
    const url =
      noteAssetURL(src, alt) ?? (/^https?:\/\//i.test(src) ? src : undefined);
    return [
      "img",
      {
        "data-markdown-src": src,
        src: url,
        alt: alt || src,
        title,
        loading: "lazy",
      },
    ];
  },
});

export const NoteLink = Node.create({
  name: "noteLink",
  group: "inline",
  inline: true,
  atom: true,
  addAttributes: () => ({
    id: { default: "", rendered: false },
    label: { default: "", rendered: false },
  }),
  parseHTML: () => [
    {
      tag: "button[data-note-link]",
      getAttrs: (el) => ({
        id: el.dataset.noteLink,
        label: el.textContent?.slice(1),
      }),
    },
  ],
  renderHTML: ({ node }) => [
    "button",
    {
      type: "button",
      "data-note-link": node.attrs.id,
      contenteditable: "false",
    },
    "@" + node.attrs.label,
  ],
  renderText: ({ node }) => "@" + node.attrs.label,
  renderMarkdown: (node) =>
    `[@${String(node.attrs?.label).replace(/[\\[\]]/g, "\\$&")}](lever-note:${node.attrs?.id})`,
});
