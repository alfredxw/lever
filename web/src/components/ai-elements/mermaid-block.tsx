import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Maximize2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { useIsCodeFenceIncomplete } from "streamdown";
import { ImageViewer } from "@/components/ImageViewer";
import { Button } from "@/components/ui/button";
import {
  CodeBlock,
  CodeBlockActions,
  CodeBlockCopyButton,
  CodeBlockHeader,
  CodeBlockTitle,
} from "@/components/ui/code-block";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
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
  const [expandedCode, setExpandedCode] = useState<string>();
  const returnFocus = useRef<HTMLButtonElement | null>(null);

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
        if (width > 0 && height > 0) {
          chart.setAttribute("width", String(width));
          chart.setAttribute("height", String(height));
          chart.style.removeProperty("max-width");
          if (!chart.getAttribute("style")?.trim()) {
            chart.removeAttribute("style");
          }
        }
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
  const diagramLabel = title || t("chat.mermaidDiagram");
  const expanded = expandedCode === code;
  const openPreview = (trigger: HTMLButtonElement) => {
    returnFocus.current = trigger;
    setExpandedCode(code);
  };
  return (
    <>
      <CodeBlock size="sm">
        <CodeBlockHeader className="pb-2">
          <CodeBlockTitle>mermaid</CodeBlockTitle>
          <CodeBlockActions>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label={t("chat.expandDiagram")}
              title={t("chat.expandDiagram")}
              onClick={(event) => openPreview(event.currentTarget)}
            >
              <Maximize2 />
            </Button>
            <CodeBlockCopyButton
              value={code}
              copyLabel={t("chat.copyCode")}
              copiedLabel={t("chat.copied")}
              onCopyError={() => toast.error(t("chat.copyFailed"))}
            />
          </CodeBlockActions>
        </CodeBlockHeader>
        <button
          type="button"
          className="mermaid-diagram block w-full cursor-zoom-in p-3 pt-2 outline-none transition-colors duration-150 motion-reduce:transition-none hover:bg-control-hover/40 focus-visible:bg-control-focus"
          onClick={(event) => openPreview(event.currentTarget)}
        >
          <img
            src={src}
            width={width}
            height={height}
            alt={diagramLabel}
            draggable={false}
            onError={() =>
              setResult((value) => (value === current ? { code } : value))
            }
          />
        </button>
      </CodeBlock>
      <Dialog
        open={expanded}
        onOpenChange={(open) => {
          if (!open) setExpandedCode(undefined);
        }}
      >
        <DialogContent
          className="mermaid-diagram-dialog flex h-[calc(100dvh-2rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-[calc(100%-2rem)]"
          showCloseButton={false}
          aria-describedby={undefined}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            returnFocus.current?.focus({ preventScroll: true });
          }}
        >
          <DialogTitle className="sr-only">{diagramLabel}</DialogTitle>
          <ImageViewer
            src={src}
            name={diagramLabel}
            label={diagramLabel}
            maxZoom={8}
            onClose={() => setExpandedCode(undefined)}
          />
        </DialogContent>
      </Dialog>
    </>
  );
}
