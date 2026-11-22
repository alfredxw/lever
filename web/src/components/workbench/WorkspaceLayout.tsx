import { useState, type CSSProperties, type ReactNode } from "react";
import { usePrefersReducedMotion } from "@/hooks/usePrefersReducedMotion";

export function WorkspaceLayout({
  scope,
  split,
  maximized,
  ratio,
  children,
}: {
  scope: string;
  split: boolean;
  maximized: boolean;
  ratio: number;
  children: ReactNode;
}) {
  const view = maximized ? "side" : split ? "split" : "main";
  const main = maximized ? 0 : split ? ratio : 100;
  const reduceMotion = usePrefersReducedMotion();
  const [transition, setTransition] = useState({
    scope,
    view,
    ratio,
    animated: false,
  });
  if (
    transition.scope !== scope ||
    transition.view !== view ||
    transition.ratio !== ratio
  ) {
    // Animate panel controls, but keep resizing and Agent switches immediate.
    setTransition({
      scope,
      view,
      ratio,
      animated: transition.scope === scope && transition.view !== view,
    });
  }
  return (
    <div
      className="workspace-layout"
      data-view={view}
      data-animated={transition.animated && !reduceMotion}
      style={
        {
          "--workspace-main": `${main}fr`,
          "--workspace-side": `${100 - main}fr`,
          "--workspace-divider": view === "split" ? "1px" : "0px",
          "--workspace-main-header": view === "side" ? "0px" : "36px",
          "--workspace-side-header": view === "main" ? "0px" : "36px",
        } as CSSProperties
      }
    >
      {children}
    </div>
  );
}
