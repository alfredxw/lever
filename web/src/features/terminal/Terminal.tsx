import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentProps,
  type CSSProperties,
} from "react";
import { useTranslation } from "react-i18next";
import {
  Plus,
  SquareSplitHorizontal,
  SquareSplitVertical,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import TerminalPane from "./TerminalPane";

import {
  closeTerminals,
  terminalPath,
  type SplitDirection,
  type TerminalLayout,
  type TerminalLeaf,
} from "./terminalSession";

const MAX_PANES = 4;

function replacePane(
  layout: TerminalLayout,
  id: string,
  replace: (leaf: TerminalLeaf) => TerminalLayout | null,
): TerminalLayout | null {
  if ("id" in layout) return layout.id === id ? replace(layout) : layout;
  const first = replacePane(layout.first, id, replace);
  const second = replacePane(layout.second, id, replace);
  if (!first || !second) return first ?? second;
  return { ...layout, first, second };
}

// Keep the surfaces as keyed siblings. A split or collapse only changes
// their bounds, so React never remounts a surviving shell.
function paneBounds(
  layout: TerminalLayout,
  x = 0,
  y = 0,
  width = 100,
  height = 100,
): (TerminalLeaf & { style: CSSProperties })[] {
  if ("id" in layout) {
    return [
      {
        ...layout,
        style: {
          left: `${x}%`,
          top: `${y}%`,
          width: `${width}%`,
          height: `${height}%`,
          borderInlineStartWidth: x > 0 ? 1 : 0,
          borderTopWidth: y > 0 ? 1 : 0,
        },
      },
    ];
  }
  if (layout.direction === "right") {
    const half = width / 2;
    return [
      ...paneBounds(layout.first, x, y, half, height),
      ...paneBounds(layout.second, x + half, y, half, height),
    ];
  }
  const half = height / 2;
  return [
    ...paneBounds(layout.first, x, y, width, half),
    ...paneBounds(layout.second, x, y + half, width, half),
  ];
}

export default function Terminal({
  focused,
  layout,
  closingTab,
  onLayoutChange,
  onNew,
  onClose,
  onOpenLocalPreview,
  ...session
}: Pick<ComponentProps<typeof TerminalPane>, "dark" | "onOpenLocalPreview"> & {
  agentId: string;
  sessionId?: string;
  focused: boolean;
  layout: TerminalLayout;
  closingTab: boolean;
  onLayoutChange: (change: (layout: TerminalLayout) => TerminalLayout) => void;
  onNew: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const panel = useRef<HTMLElement>(null);
  const focusInput = useRef<() => void>(null);
  const [selection, setSelected] = useState<string>();
  const [closing, setClosing] = useState(false);
  const panes = paneBounds(layout);
  const selected =
    panes.find((pane) => pane.id === selection)?.id ?? panes[0].id;
  const atSplitLimit = panes.length >= MAX_PANES;

  useEffect(() => {
    if (!focused) return;
    const frame = requestAnimationFrame(() => {
      if (!panel.current?.contains(document.activeElement))
        focusInput.current?.();
    });
    return () => cancelAnimationFrame(frame);
  }, [focused]);

  const focusRequested = useRef<string>(undefined);
  useLayoutEffect(() => {
    if (focusRequested.current !== selected) return;
    const frame = requestAnimationFrame(() => {
      if (focusRequested.current !== selected) return;
      focusRequested.current = undefined;
      focusInput.current?.();
    });
    return () => cancelAnimationFrame(frame);
  }, [selected, layout]);

  function selectPane(id: string) {
    focusRequested.current = id;
    setSelected(id);
  }

  function split(direction: SplitDirection) {
    if (atSplitLimit || closing || closingTab) return;
    const id = crypto.randomUUID();
    onLayoutChange(
      (current) =>
        replacePane(current, selected, (leaf) => ({
          direction,
          first: leaf,
          second: { id },
        }))!,
    );
    selectPane(id);
  }

  async function closePane() {
    if (closing || closingTab) return;
    if (panes.length === 1) {
      onClose();
      return;
    }
    setClosing(true);
    try {
      await closeTerminals(session.agentId, session.sessionId, [selected]);
      onLayoutChange(
        (current) => replacePane(current, selected, () => null) ?? current,
      );
      const index = panes.findIndex((pane) => pane.id === selected);
      selectPane((panes[index + 1] ?? panes[index - 1]).id);
    } catch (error) {
      toast.error(String(error));
    } finally {
      setClosing(false);
    }
  }

  const actions = [
    {
      icon: SquareSplitHorizontal,
      label: "splitRight",
      run: () => split("right"),
      disabled: atSplitLimit || closing || closingTab,
    },
    {
      icon: SquareSplitVertical,
      label: "splitDown",
      run: () => split("down"),
      disabled: atSplitLimit || closing || closingTab,
    },
    { icon: Plus, label: "new", run: onNew, disabled: false },
    {
      icon: Trash2,
      label: "close",
      run: closePane,
      disabled: closing || closingTab,
    },
  ] as const;

  return (
    <section
      ref={panel}
      className="terminal-panel"
      aria-label={t("workspace.terminal")}
    >
      <div className="terminal-panes">
        {panes.map(({ id, style, started }) => (
          <TerminalPane
            key={id}
            ref={selected === id ? focusInput : undefined}
            style={style}
            terminalId={id}
            started={started === true}
            closing={closingTab || closing}
            onStarted={() =>
              onLayoutChange(
                (current) =>
                  replacePane(current, id, () => ({ id, started: true })) ??
                  current,
              )
            }
            onRestart={async () => {
              await closeTerminals(session.agentId, session.sessionId, [id]);
              const next = crypto.randomUUID();
              onLayoutChange(
                (current) =>
                  replacePane(current, id, () => ({ id: next })) ?? current,
              );
              if (selected === id) selectPane(next);
            }}
            selected={panes.length > 1 && selected === id}
            onSelect={() => setSelected(id)}
            onOpenLocalPreview={onOpenLocalPreview}
            path={terminalPath(session.agentId, session.sessionId)}
            dark={session.dark}
          />
        ))}
      </div>
      <div
        className="terminal-actions"
        role="group"
        aria-label={t("terminal.actions")}
      >
        {actions.map(({ icon: Icon, label, run, disabled }) => (
          <Button
            key={label}
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={t(`terminal.${label}`)}
            title={
              disabled
                ? t("terminal.splitLimit", { count: MAX_PANES })
                : t(`terminal.${label}`)
            }
            aria-disabled={disabled || undefined}
            onClick={run}
          >
            <Icon aria-hidden="true" />
          </Button>
        ))}
      </div>
    </section>
  );
}
