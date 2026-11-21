import { useTranslation } from "react-i18next";
import { useEffect, useRef } from "react";
import { Loading } from "@/components/common";
import { useEventCallback } from "@/hooks/useEventCallback";
import {
  fileFindShortcut,
  useShortcutListener,
} from "@/features/settings/shortcuts";
import Editor, { loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor";
import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import JsonWorker from "monaco-editor/esm/vs/language/json/json.worker?worker";
import CssWorker from "monaco-editor/esm/vs/language/css/css.worker?worker";
import HtmlWorker from "monaco-editor/esm/vs/language/html/html.worker?worker";
import TypeScriptWorker from "monaco-editor/esm/vs/language/typescript/ts.worker?worker";
import type { FileLocation } from "./filePaths";

self.MonacoEnvironment = {
  getWorker: (_module, language) => {
    if (language === "json") return new JsonWorker();
    if (["css", "scss", "less"].includes(language)) return new CssWorker();
    if (["html", "handlebars", "razor"].includes(language))
      return new HtmlWorker();
    if (["typescript", "javascript"].includes(language))
      return new TypeScriptWorker();
    return new EditorWorker();
  },
};
loader.config({ monaco });

const languages: Record<string, string> = {
  go: "go",
  ts: "typescript",
  tsx: "typescript",
  js: "javascript",
  jsx: "javascript",
  json: "json",
  md: "markdown",
  py: "python",
  rs: "rust",
  css: "css",
  html: "html",
  yaml: "yaml",
  yml: "yaml",
  sh: "shell",
  toml: "ini",
  sql: "sql",
  java: "java",
  swift: "swift",
  c: "c",
  h: "cpp",
  cpp: "cpp",
  txt: "plaintext",
};
export default function FileEditor({
  path,
  content,
  dark,
  readOnly,
  wordWrap,
  selection,
  onChange,
  active,
}: {
  path: string;
  content: string;
  dark: boolean;
  readOnly: boolean;
  wordWrap: boolean;
  selection?: FileLocation;
  onChange: (content: string) => void;
  active: boolean;
}) {
  const { t } = useTranslation();
  const instance = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  useShortcutListener((shortcut) => {
    if (shortcut !== fileFindShortcut || !instance.current) return;
    const find = instance.current.getAction("actions.find");
    if (!find) return;
    void find.run();
    return true;
  }, active);
  const reveal = useEventCallback(
    (editor: monaco.editor.IStandaloneCodeEditor) => {
      if (!selection) return;
      const range = {
        startLineNumber: selection.line,
        endLineNumber: selection.line,
        startColumn: selection.column,
        endColumn: selection.endColumn,
      };
      editor.setSelection(range);
      editor.revealRangeInCenter(range);
      if (active) editor.focus();
    },
  );
  useEffect(() => {
    if (instance.current) reveal(instance.current);
  }, [selection, reveal]);
  return (
    <Editor
      loading={<Loading className="w-full self-start" />}
      height="100%"
      language={languages[path.split(".").pop() ?? ""] ?? "plaintext"}
      value={content}
      onChange={(value) => onChange(value ?? "")}
      onMount={(editor) => {
        instance.current = editor;
        reveal(editor);
      }}
      theme={dark ? "vs-dark" : "vs"}
      options={{
        ariaLabel: t("files.editor"),
        readOnly,
        domReadOnly: readOnly,
        minimap: { enabled: false },
        fontSize: 13,
        fontFamily: "SFMono-Regular, Consolas, monospace",
        scrollBeyondLastLine: false,
        renderLineHighlight: "none",
        padding: { top: 16, bottom: 16 },
        automaticLayout: true,
        wordWrap: wordWrap ? "on" : "off",
        lineNumbersMinChars: 3,
        lineDecorationsWidth: 16,
        overviewRulerLanes: 0,
        hideCursorInOverviewRuler: true,
        stickyScroll: { enabled: false },
        contextmenu: false,
      }}
    />
  );
}
