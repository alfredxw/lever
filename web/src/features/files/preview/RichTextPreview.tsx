import { PreviewFailure } from "./PreviewUnavailable";
import { useEffect, useMemo, useState } from "react";
import { Loading } from "@/components/common";
import { renderMermaid } from "@/lib/mermaid";
import { DocumentFrame } from "./DocumentFrame";
import { TablePreview } from "./TablePreview";
import { parseDelimitedPreview } from "./delimited";

export default function RichTextPreview({
  kind,
  text,
  name,
}: {
  kind: "html" | "mermaid" | "table";
  text: string;
  name: string;
}) {
  const table = useMemo(
    () =>
      kind === "table"
        ? parseDelimitedPreview(text, /\.tsv$/i.test(name) ? "\t" : ",", {
            maxRows: 5000,
            maxColumns: 50,
            maxCellLength: 10_000,
          })
        : undefined,
    [kind, text, name],
  );
  if (table) return <TablePreview key={text} {...table} />;
  if (kind === "mermaid") return <MermaidPreview text={text} name={name} />;
  return <DocumentFrame html={text} title={name} />;
}

function MermaidPreview({ text, name }: { text: string; name: string }) {
  const [html, setHtml] = useState<string>();
  const [error, setError] = useState<unknown>();
  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    const timer = setTimeout(() => {
      void renderMermaid(text, signal)
        .then((svg) => {
          if (!signal.aborted) {
            setHtml(svg);
            setError(undefined);
          }
        })
        .catch((error) => {
          if (!signal.aborted) setError(error);
        });
    }, 250);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [text]);
  if (error) return <PreviewFailure error={error} />;
  return html ? <DocumentFrame html={html} title={name} /> : <Loading />;
}
