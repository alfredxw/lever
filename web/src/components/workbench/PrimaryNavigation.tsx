import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from "react";
import {
  Blocks,
  InfinityIcon,
  Settings,
  Sparkles,
  SquareKanban,
  Users,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { isMyGo, runtime } from "mygo-runtime";
import {
  animate,
  motion,
  useMotionValue,
  useReducedMotion,
  type MotionStyle,
} from "motion/react";
import { cn } from "@/lib/utils";
import type { ProviderInfo } from "@/api/types.gen";
import { SubscriptionUsage } from "@/features/runtime/SubscriptionUsage";
import { usePreferences } from "@/features/settings/Preferences";
import {
  ariaShortcut,
  binding,
  formatShortcut,
} from "@/features/settings/shortcuts";

const STORAGE_KEY = "lever:navigation";
const NAVIGATION_ITEM_SIZE = 36;
const NAVIGATION_INSET = 8;
const ICON_RAIL_WIDTH = NAVIGATION_ITEM_SIZE + 2 * NAVIGATION_INSET;
const MIN_EXPANDED_WIDTH = 112;
const MAX = 288;
const macDesktop =
  isMyGo() && runtime().platform === "darwin" ? runtime() : undefined;

function readTitleBarInset() {
  if (!macDesktop) return;
  const inset = Number.parseFloat(
    getComputedStyle(document.documentElement).getPropertyValue(
      "--mygo-titlebar-inset-left",
    ),
  );
  return Number.isFinite(inset) ? inset : undefined;
}

type Sizing = { expanded: boolean; width: number };
function readSizing(): Sizing {
  try {
    const value = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null");
    if (typeof value?.expanded === "boolean" && Number.isFinite(value.width))
      return {
        expanded: value.expanded,
        width: clampWidth(value.width, ICON_RAIL_WIDTH + 1),
      };
  } catch {
    /* Restore defaults if an old preference is invalid. */
  }
  return { expanded: true, width: 160 };
}
const clampWidth = (width: number, minimum: number) =>
  Math.max(minimum, Math.min(MAX, Math.round(width)));

/** The gesture previews locally. Only pointer-up or a keyboard action saves it. */
function useNavigationSizing(continuousResize: boolean) {
  const minimumExpanded = continuousResize
    ? ICON_RAIL_WIDTH + 1
    : MIN_EXPANDED_WIDTH;
  const widthOf = (sizing: Sizing) =>
    sizing.expanded ? Math.max(sizing.width, minimumExpanded) : ICON_RAIL_WIDTH;
  const [saved, setSaved] = useState(readSizing);
  const [preview, setPreview] = useState<Sizing | null>(null);
  const width = useMotionValue(widthOf(saved));
  const reduceMotion = useReducedMotion();
  const gesture = useRef<{
    pointer: number;
    startX: number;
    startWidth: number;
    original: Sizing;
    next: Sizing;
    handle: HTMLDivElement;
  } | null>(null);
  const settle = (next: Sizing) => {
    animate(width, widthOf(next), {
      duration: reduceMotion ? 0 : 0.22,
      ease: continuousResize ? [0.4, 0, 0.2, 1] : [0.22, 1, 0.36, 1],
    });
  };
  const commit = (next: Sizing) => {
    setSaved(next);
    settle(next);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  };
  const finish = (save: boolean) => {
    const current = gesture.current;
    if (!current) return;
    gesture.current = null;
    if (current.handle.hasPointerCapture(current.pointer))
      current.handle.releasePointerCapture(current.pointer);
    setPreview(null);
    if (save) commit(current.next);
    else settle(current.original);
  };
  useEffect(() => {
    const cancel = () => finish(false);
    const escape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape" && gesture.current) {
        event.preventDefault();
        cancel();
      }
    };
    window.addEventListener("blur", cancel);
    window.addEventListener("keydown", escape);
    return () => {
      cancel();
      window.removeEventListener("blur", cancel);
      window.removeEventListener("keydown", escape);
    };
  }, [minimumExpanded, reduceMotion, width]);
  const move = (event: PointerEvent<HTMLDivElement>) => {
    const current = gesture.current;
    if (!current || current.pointer !== event.pointerId) return;
    const requested = current.startWidth + event.clientX - current.startX;
    const expanded = continuousResize
      ? Math.round(requested) > ICON_RAIL_WIDTH
      : requested >= minimumExpanded - (current.next.expanded ? 8 : 0);
    current.next = {
      expanded,
      width: expanded
        ? clampWidth(requested, minimumExpanded)
        : current.original.width,
    };
    // Preview the pointer width even where the layout will snap on release.
    width.set(Math.max(ICON_RAIL_WIDTH, Math.min(MAX, requested)));
    setPreview(current.next);
  };
  const keyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (gesture.current) return;
    let next = saved;
    switch (event.key) {
      case "Enter":
      case " ":
        next = { ...saved, expanded: !saved.expanded };
        break;
      case "Home":
        next = { ...saved, expanded: false };
        break;
      case "End":
        next = { expanded: true, width: MAX };
        break;
      case "ArrowLeft": {
        if (!saved.expanded) return;
        const current = widthOf(saved);
        const requested = current - 8;
        const expanded = continuousResize
          ? requested > ICON_RAIL_WIDTH
          : current > minimumExpanded;
        next = {
          expanded,
          width: expanded
            ? clampWidth(requested, minimumExpanded)
            : saved.width,
        };
        break;
      }
      case "ArrowRight":
        next = {
          expanded: true,
          width: saved.expanded
            ? clampWidth(widthOf(saved) + 8, minimumExpanded)
            : saved.width,
        };
        break;
      default:
        return;
    }
    event.preventDefault();
    commit(next);
  };
  return {
    sizing: preview ?? saved,
    restingWidth: widthOf(preview ?? saved),
    width,
    resizing: preview !== null,
    toggle: () => {
      if (!gesture.current) commit({ ...saved, expanded: !saved.expanded });
    },
    handleProps: {
      onPointerDown: (event: PointerEvent<HTMLDivElement>) => {
        if (event.button !== 0 || !event.isPrimary || gesture.current) return;
        event.preventDefault();
        width.stop();
        gesture.current = {
          pointer: event.pointerId,
          startX: event.clientX,
          startWidth: event.currentTarget
            .closest("nav")!
            .getBoundingClientRect().width,
          original: saved,
          next: saved,
          handle: event.currentTarget,
        };
        event.currentTarget.setPointerCapture(event.pointerId);
        setPreview(saved);
      },
      onPointerMove: move,
      onPointerUp: (event: PointerEvent<HTMLDivElement>) => {
        if (gesture.current?.pointer !== event.pointerId) return;
        move(event);
        finish(true);
      },
      onPointerCancel: () => finish(false),
      onLostPointerCapture: () => finish(false),
      onKeyDown: keyDown,
    },
  };
}

export type PrimaryPage =
  | "agents"
  | "tasks"
  | "automations"
  | "skills"
  | "plugins"
  | "settings";

type NavigationProps = {
  page: PrimaryPage;
  providers: ProviderInfo[];
  taskAlert?: boolean;
  onPreview: (page: PrimaryPage) => void;
  onAgents: () => void;
  onTasks: () => void;
  onAutomations: () => void;
  onSkills: () => void;
  onSettings: () => void;
  onPlugins: () => void;
};

export function WorkbenchShell({
  children,
  secondarySidebarWidth,
  ...navigationProps
}: NavigationProps & {
  children: ReactNode;
  secondarySidebarWidth: number | null;
}) {
  const [titleBarInset, setTitleBarInset] = useState(readTitleBarInset);
  useEffect(() => {
    if (!macDesktop) return;
    const update = () => setTitleBarInset(readTitleBarInset());
    document.documentElement.addEventListener("lever-frame", update);
    update();
    return () => document.documentElement.removeEventListener("lever-frame", update);
  }, []);
  // MyGo reports zero inset when macOS hides the buttons in full screen.
  const fullScreen = titleBarInset === 0;
  const navigation = useNavigationSizing(!!macDesktop);
  return (
    <motion.div
      className="app-shell"
      data-desktop-fullscreen={fullScreen || undefined}
      style={
        {
          "--navigation-motion-width": navigation.width,
          "--navigation-collapsed-width": ICON_RAIL_WIDTH,
          "--navigation-item-size": `${NAVIGATION_ITEM_SIZE}px`,
          "--navigation-inset": `${NAVIGATION_INSET}px`,
          "--desktop-titlebar-inset": titleBarInset,
          "--secondary-sidebar-width": secondarySidebarWidth
            ? `${secondarySidebarWidth}px`
            : undefined,
        } as MotionStyle
      }
    >
      <PrimaryNavigation {...navigationProps} navigation={navigation} />
      {children}
    </motion.div>
  );
}

function PrimaryNavigation({
  page,
  providers,
  taskAlert = false,
  onPreview,
  onAgents,
  onTasks,
  onAutomations,
  onSkills,
  onSettings,
  onPlugins,
  navigation,
}: NavigationProps & { navigation: ReturnType<typeof useNavigationSizing> }) {
  const { t } = useTranslation();
  const { preferences } = usePreferences();
  const settingsShortcut = binding(
    preferences.shortcutOverrides,
    "openSettings",
  );
  const { sizing, restingWidth, width, resizing, toggle, handleProps } =
    navigation;
  return (
    <nav
      className="primary-navigation"
      aria-label={t("nav.label")}
      data-expanded={sizing.expanded}
      data-resizing={resizing}
    >
      <div className="navigation-drag-area" aria-hidden="true">
        <span className="navigation-wordmark">Lever</span>
      </div>
      <button
        className={cn("navigation-item", page === "agents" && "active")}
        aria-label={t("nav.agents")}
        title={t("nav.agents")}
        onClick={onAgents}
        aria-current={page === "agents" ? "page" : undefined}
      >
        <Users size={19} strokeWidth={1.6} />
        <span>{t("nav.agents")}</span>
      </button>
      <button
        className={cn("navigation-item", page === "tasks" && "active")}
        aria-label={t("nav.tasks")}
        title={t("nav.tasks")}
        onPointerEnter={() => onPreview("tasks")}
        onFocus={() => onPreview("tasks")}
        onClick={onTasks}
        aria-current={page === "tasks" ? "page" : undefined}
      >
        <SquareKanban size={19} strokeWidth={1.6} />
        <span>{t("nav.tasks")}</span>
        {taskAlert && (
          <span
            className="navigation-item-dot"
            aria-label={t("tasks.reminder.pendingAlert")}
          />
        )}
      </button>
      <button
        className={cn("navigation-item", page === "automations" && "active")}
        aria-label={t("nav.automations")}
        title={t("nav.automations")}
        onPointerEnter={() => onPreview("automations")}
        onFocus={() => onPreview("automations")}
        onClick={onAutomations}
        aria-current={page === "automations" ? "page" : undefined}
      >
        <InfinityIcon size={19} strokeWidth={1.6} />
        <span>{t("nav.automations")}</span>
      </button>
      <button
        className={cn("navigation-item", page === "skills" && "active")}
        aria-label={t("nav.skills")}
        title={t("nav.skills")}
        onPointerEnter={() => onPreview("skills")}
        onFocus={() => onPreview("skills")}
        onClick={onSkills}
        aria-current={page === "skills" ? "page" : undefined}
      >
        <Sparkles size={19} strokeWidth={1.6} />
        <span>{t("nav.skills")}</span>
      </button>
      <button
        className={cn("navigation-item", page === "plugins" && "active")}
        aria-label={t("nav.plugins")}
        title={t("nav.plugins")}
        onPointerEnter={() => onPreview("plugins")}
        onFocus={() => onPreview("plugins")}
        onClick={onPlugins}
        aria-current={page === "plugins" ? "page" : undefined}
      >
        <Blocks size={19} strokeWidth={1.6} />
        <span>{t("nav.plugins")}</span>
      </button>
      <div className="flex-1" />
      <SubscriptionUsage providers={providers} />
      <button
        className={cn("navigation-item", page === "settings" && "active")}
        aria-label={t("nav.settings")}
        aria-keyshortcuts={ariaShortcut(settingsShortcut)}
        title={
          settingsShortcut
            ? `${t("nav.settings")} (${formatShortcut(settingsShortcut)})`
            : t("nav.settings")
        }
        onClick={onSettings}
        aria-current={page === "settings" ? "page" : undefined}
      >
        <Settings size={18} strokeWidth={1.6} />
        <span>{t("nav.settings")}</span>
      </button>
      <div
        className="navigation-resize"
        role="separator"
        tabIndex={0}
        aria-label={t("nav.resize")}
        aria-orientation="vertical"
        aria-valuemin={ICON_RAIL_WIDTH}
        aria-valuemax={MAX}
        aria-valuenow={resizing ? Math.round(width.get()) : restingWidth}
        aria-valuetext={t(
          sizing.expanded ? "nav.expandedWidth" : "nav.collapsed",
          { width: restingWidth },
        )}
        onDoubleClick={toggle}
        {...handleProps}
      />
    </nav>
  );
}
