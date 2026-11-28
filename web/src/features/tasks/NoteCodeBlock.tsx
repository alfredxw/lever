import { useEffect, useRef, useState } from "react";
import {
  NodeViewContent,
  NodeViewWrapper,
  ReactNodeViewRenderer,
  type NodeViewProps,
} from "@tiptap/react";
import type { CodeBlockOptions } from "@tiptap/extension-code-block";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { Captions, Copy, WrapText, Presentation } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { promptCodeBlock } from "@/features/chat/prompt";
import { codeLanguages, languageAliases } from "@/lib/codeLanguages";
import { renderMermaid } from "@/lib/mermaid";
import { protectBlockInput, isolateNoteEdit } from "./taskEditing";
import { NoteBoardDialog } from "./NoteWhiteboard";

const colors = new PluginKey<DecorationSet>("note-code-colors");
function CodeView({
  editor,
  getPos,
  node,
  updateAttributes,
  extension,
}: NodeViewProps) {
  const { t } = useTranslation();
  const source = node.textContent,
    language = String(node.attrs.language || "text");
  const [mode, setMode] = useState("source");
  const [captionOpen, setCaptionOpen] = useState(!!node.attrs.caption);
  const [convert, setConvert] = useState(false);
  const [diagram, setDiagram] = useState("");
  const [error, setError] = useState("");
  const [visible, setVisible] = useState(false);
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!host.current) return;
    const observer = new IntersectionObserver(
      ([entry]) => setVisible(entry.isIntersecting),
      { rootMargin: "160px" },
    );
    observer.observe(host.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!visible || editor.isDestroyed) return;
    let active = true;
    const timer = setTimeout(async () => {
      try {
        const { codeTokenStyles } = await import("@/lib/highlighter");
        const tokens = await codeTokenStyles(source, language);
        if (!active || editor.isDestroyed) return;
        const pos = getPos();
        if (pos === undefined || editor.state.doc.nodeAt(pos) !== node) return;
        const decorations = tokens.map((token) =>
          Decoration.inline(pos + 1 + token.from, pos + 1 + token.to, {
            class: "note-code-token",
            style: token.style,
          }),
        );
        editor.view.dispatch(
          editor.state.tr
            .setMeta(colors, {
              from: pos,
              to: pos + node.nodeSize,
              decorations,
            })
            .setMeta("addToHistory", false),
        );
      } catch {
        /* Unknown grammars leave editable plain text. */
      }
    }, 120);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [editor, getPos, node, language, source, visible]);
  const preview = language === "mermaid" && mode !== "source";
  useEffect(() => {
    if (!visible || !preview) return;
    const controller = new AbortController();
    const render = () => {
      const dark = document.documentElement.classList.contains("dark");
      renderMermaid(source, controller.signal, {
        theme: dark ? "dark" : "neutral",
        secure: ["htmlLabels", "themeCSS"],
      })
        .then((svg) => {
          if (!controller.signal.aborted) {
            setDiagram("data:image/svg+xml," + encodeURIComponent(svg));
            setError("");
          }
        })
        .catch((e) => {
          if (!controller.signal.aborted) {
            setError(String(e));
            setDiagram("");
          }
        });
    };
    const timer = setTimeout(render, 180);
    const observer = new MutationObserver(render);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });
    return () => {
      controller.abort();
      clearTimeout(timer);
      observer.disconnect();
    };
  }, [source, visible, preview]);
  return (
    <NodeViewWrapper
      ref={host}
      className="note-code-block"
      data-wrap={node.attrs.wrap || undefined}
      data-mode={language === "mermaid" ? mode : "source"}
    >
      <div className="note-code-tools" contentEditable={false}>
        <SearchableSelect
          value={language}
          currentLabel={language}
          label={t("tasks.code.language")}
          placeholder={t("tasks.code.language")}
          searchLabel={t("tasks.search")}
          emptyLabel={t("tasks.noBlocks")}
          align="start"
          options={["text", ...codeLanguages, "mermaid"].map((id) => ({
            id,
            label: id,
            keywords: Object.keys(languageAliases).filter(
              (alias) => languageAliases[alias] === id,
            ),
          }))}
          onChange={(language) =>
            updateAttributes({
              language: language === "text" ? null : language,
            })
          }
        />
        {language === "mermaid" && (
          <ToggleGroup
            type="single"
            size="sm"
            value={mode}
            onValueChange={(v) => v && setMode(v)}
          >
            {["source", "preview", "split"].map((k) => (
              <ToggleGroupItem key={k} value={k}>
                {t("tasks.code." + k)}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        )}
        {captionOpen && (
          <Input
            className="h-7 max-w-44"
            aria-label={t("tasks.code.caption")}
            placeholder={t("tasks.code.caption")}
            value={node.attrs.caption || ""}
            onChange={(e) => updateAttributes({ caption: e.target.value })}
          />
        )}
        <span className="flex-1" />
        <Button
          size="icon-xs"
          variant="ghost"
          aria-pressed={captionOpen}
          aria-label={t("tasks.code.caption")}
          onClick={() => setCaptionOpen(!captionOpen)}
        >
          <Captions />
        </Button>
        {language === "mermaid" && (
          <Button
            variant="ghost"
            size="icon-xs"
            title={t("tasks.board.convert")}
            aria-label={t("tasks.board.convert")}
            onClick={() => setConvert(true)}
          >
            <Presentation />
          </Button>
        )}
        <Button
          variant="ghost"
          size="icon-xs"
          aria-pressed={!!node.attrs.wrap}
          title={t("tasks.code.wrap")}
          aria-label={t("tasks.code.wrap")}
          onClick={() => updateAttributes({ wrap: !node.attrs.wrap })}
        >
          <WrapText />
        </Button>
        <Button
          variant="ghost"
          size="icon-xs"
          title={t("chat.copyCode")}
          aria-label={t("chat.copyCode")}
          onClick={() =>
            void navigator.clipboard
              .writeText(source)
              .catch((e) => toast.error(String(e)))
          }
        >
          <Copy />
        </Button>
      </div>
      <div className="note-code-body">
        <NodeViewContent<"pre"> as="pre" />
        {preview && (
          <div contentEditable={false} className="note-code-preview">
            {error ? (
              <span role="status">{t("chat.mermaidUnavailable")}</span>
            ) : (
              diagram && <img src={diagram} alt={t("chat.mermaidDiagram")} />
            )}
          </div>
        )}
      </div>
      {convert && (
        <NoteBoardDialog
          noteId={extension.options.noteId}
          title="Mermaid"
          mermaid={source}
          onClose={() => setConvert(false)}
          onSave={(assets) => {
            const pos = getPos();
            if (pos === undefined || editor.state.doc.nodeAt(pos) !== node)
              throw new Error(t("tasks.sourceRemoved"));
            const tr = editor.state.tr.insert(
              pos + node.nodeSize,
              editor.schema.nodes.noteWhiteboard.create(assets),
            );
            isolateNoteEdit(tr);
            editor.view.dispatch(tr);
            setConvert(false);
          }}
        />
      )}
    </NodeViewWrapper>
  );
}

export const NoteCodeBlock = promptCodeBlock.extend<
  CodeBlockOptions & { noteId: string }
>({
  ...protectBlockInput,
  addOptions() {
    return { ...this.parent!(), noteId: "" };
  },
  addAttributes() {
    return {
      ...this.parent?.(),
      caption: {
        default: undefined,
        parseHTML: (el) => el.dataset.caption,
        renderHTML: (attrs) =>
          attrs.caption ? { "data-caption": attrs.caption } : {},
      },
      wrap: {
        default: false,
        parseHTML: (el) => el.dataset.wrap === "true",
        renderHTML: (attrs) => (attrs.wrap ? { "data-wrap": "true" } : {}),
      },
    };
  },
  addNodeView: () =>
    ReactNodeViewRenderer(CodeView, { contentDOMElementTag: "code" }),
  addProseMirrorPlugins() {
    return [
      ...(this.parent?.() ?? []),
      new Plugin({
        key: colors,
        state: {
          init: () => DecorationSet.empty,
          apply(tr, set) {
            const mapped = set.map(tr.mapping, tr.doc);
            const update = tr.getMeta(colors);
            return update
              ? mapped
                  .remove(mapped.find(update.from, update.to))
                  .add(tr.doc, update.decorations)
              : mapped;
          },
        },
        props: { decorations: (state) => colors.getState(state) },
      }),
    ];
  },
});
