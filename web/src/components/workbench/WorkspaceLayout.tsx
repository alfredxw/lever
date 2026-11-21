import { useState, type CSSProperties, type ReactNode } from "react";
import { motion } from "motion/react";
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
    <motion.div
      className="workspace-layout"
      data-view={view}
      data-animated={transition.animated && !reduceMotion}
      initial={false}
      transition={{
        duration: transition.animated && !reduceMotion ? 0.24 : 0,
        ease: [0.22, 1, 0.36, 1],
      }}
      animate={{
        "--workspace-main": `${view === "main" ? 100 : view === "side" ? 0 : ratio}fr`,
        "--workspace-side": `${view === "side" ? 100 : view === "main" ? 0 : 100 - ratio}fr`,
        "--workspace-divider": view === "split" ? "1px" : "0px",
        "--workspace-main-header": view === "side" ? "0px" : "36px",
        "--workspace-side-header": view === "main" ? "0px" : "36px",
      }}
      style={
        {
          "--workspace-duration":
            transition.animated && !reduceMotion ? "240ms" : "0ms",
        } as CSSProperties
      }
    >
      {children}
    </motion.div>
  );
}
