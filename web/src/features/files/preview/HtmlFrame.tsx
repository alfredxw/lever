import type { ComponentProps } from "react";

export function HtmlFrame(
  props: Pick<
    ComponentProps<"iframe">,
    "ref" | "className" | "style" | "loading"
  > & { src: string; title: string },
) {
  return (
    <iframe {...props} sandbox="allow-scripts" referrerPolicy="no-referrer" />
  );
}
