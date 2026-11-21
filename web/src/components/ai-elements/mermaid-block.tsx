import { useEffect, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { useIsCodeFenceIncomplete } from "streamdown";
import {
  CodeBlock,
  CodeBlockActions,
  CodeBlockCopyButton,
  CodeBlockHeader,
  CodeBlockTitle,
} from "@/components/ui/code-block";
import { renderMermaid } from "@/lib/mermaid";
import { CodeSnippet } from "./code-block";

function subscribeToTheme(update: () => void) {
  const observer = new MutationObserver(update);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["class"],
  });
  return () => observer.disconnect();
}

const isDark = () => document.documentElement.classList.contains("dark");

type Diagram = { src: string; width?: number; height?: number; title?: string };

export function MermaidBlock({ code }: { code: string }) {
  const { t } = useTranslation();
  const incomplete = useIsCodeFenceIncomplete();
  const dark = useSyncExternalStore(subscribeToTheme, isDark, () => false);
  const [result, setResult] = useState<{ code: string; diagram?: Diagram }>();

  useEffect(() => {
    if (incomplete || !code.trim()) return;
    const controller = new AbortController();
    const { signal } = controller;
    void renderMermaid(code, signal, {
      theme: dark ? "dark" : "neutral",
      secure: ["htmlLabels", "themeCSS"],
    })
      .then((svg) => {
        if (signal.aborted) return;
        const chart = new DOMParser()
          .parseFromString(svg, "text/html")
          .querySelector("svg");
        if (!chart) throw new Error("Mermaid did not return a diagram");
        const { width, height } = chart.viewBox.baseVal;
        // Image mode isolates diagram styles and disables links and scripts.
        const markup = new XMLSerializer().serializeToString(chart);
        setResult({
          code,
          diagram: {
            src: `data:image/svg+xml,${encodeURIComponent(markup)}`,
            width: Math.ceil(width) || undefined,
            height: Math.ceil(height) || undefined,
            title:
              chart.querySelector(":scope > title")?.textContent || undefined,
          },
        });
      })
      .catch(() => {
        if (!signal.aborted) setResult({ code });
      });
    return () => controller.abort();
  }, [code, dark, incomplete]);

  const current = !incomplete && result?.code === code ? result : undefined;
  if (!current?.diagram) {
    return (
      <CodeSnippet
        code={code}
        language="mermaid"
        title={current ? t("chat.mermaidUnavailable") : undefined}
        failed={!!current}
      />
    );
  }

  const { src, height, width, title } = current.diagram;
  return (
    <CodeBlock size="sm">
      <CodeBlockHeader>
        <CodeBlockTitle>mermaid</CodeBlockTitle>
        <CodeBlockActions>
          <CodeBlockCopyButton
            value={code}
            copyLabel={t("chat.copyCode")}
            copiedLabel={t("chat.copied")}
            onCopyError={() => toast.error(t("chat.copyFailed"))}
          />
        </CodeBlockActions>
      </CodeBlockHeader>
      <div
        className="mermaid-diagram max-h-[min(32rem,70dvh)] overflow-auto p-3 outline-none focus-visible:bg-control-focus"
        role="region"
        aria-label={t("chat.mermaidDiagram")}
        tabIndex={0}
      >
        <img
          src={src}
          width={width}
          height={height}
          alt={title || t("chat.mermaidDiagram")}
          onError={() =>
            setResult((value) => (value === current ? { code } : value))
          }
        />
      </div>
    </CodeBlock>
  );
}
