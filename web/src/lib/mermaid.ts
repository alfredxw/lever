import type { MermaidConfig } from "mermaid";

let nextId = 0;
let pending = Promise.resolve();

export function renderMermaid(
  source: string,
  signal: AbortSignal,
  {
    theme = "default",
    secure = [],
  }: Pick<MermaidConfig, "theme" | "secure"> = {},
) {
  // Mermaid's configuration is global. Change it only between renders.
  const render = pending.then(async () => {
    signal.throwIfAborted();
    const { default: mermaid } = await import("mermaid");
    signal.throwIfAborted();
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      htmlLabels: false,
      secure: [...(mermaid.mermaidAPI.defaultConfig.secure ?? []), ...secure],
      maxTextSize: 100_000,
      maxEdges: 500,
      suppressErrorRendering: true,
      theme,
    });

    const container = document.createElement("div");
    container.style.cssText = "position: fixed; visibility: hidden;";
    document.body.append(container);
    try {
      const { svg } = await mermaid.render(
        `lever-diagram-${++nextId}`,
        source,
        container,
      );
      return svg;
    } finally {
      container.remove();
    }
  });
  pending = render.then(
    () => undefined,
    () => undefined,
  );
  return render;
}
