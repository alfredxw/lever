import {
  createContext,
  memo,
  useCallback,
  useMemo,
  useContext,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type SyntheticEvent,
} from "react";
import {
  AutoScrollActivator,
  closestCenter,
  DndContext,
  pointerWithin,
  PointerSensor,
  useDroppable,
  useSensor,
  useSensors,
  type ClientRect,
} from "@dnd-kit/core";
import {
  horizontalListSortingStrategy,
  SortableContext,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useReducedMotion } from "motion/react";
import {
  Folders,
  Globe,
  GitCompare,
  MessageCircle,
  MessagesCircle,
  NotebookText,
  TerminalSquare,
  User,
  X,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  ActionContextMenu,
  rowMenuHandlers,
  type MenuAction,
  type MenuAnchor,
} from "@/components/ui/action-context-menu";
import {
  RenameConversationDialog,
  type RenameTarget,
} from "@/features/chat/RenameConversationDialog";
import { cn } from "@/lib/utils";
import { paneOf, type Pane, type WorkspaceTab } from "./useWorkspaces";

export const tabIcons = {
  chat: MessageCircle,
  shared: MessageCircle,
  draft: MessageCircle,
  topic: MessagesCircle,
  files: Folders,
  diff: GitCompare,
  terminal: TerminalSquare,
  browser: Globe,
  notes: NotebookText,
  profile: User,
};
export type TabKind = keyof typeof tabIcons;
type TabDrag = { id: string; rect: ClientRect; row: DOMRect };
const TabDragContext = createContext<TabDrag | undefined>(undefined);

export function WorkspaceDrag({
  scope,
  children,
  onDrop,
}: {
  scope: string;
  children: ReactNode;
  onDrop: (id: string, targetId: string) => void;
}) {
  const [drag, setDrag] = useState<TabDrag>();
  const [dragScope, setDragScope] = useState(scope);
  if (dragScope !== scope) {
    setDrag(undefined);
    setDragScope(scope);
  }
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
  );
  return (
    <DndContext
      sensors={sensors}
      autoScroll={{ activator: AutoScrollActivator.DraggableRect }}
      modifiers={[
        ({ transform, activeNodeRect }) => ({
          ...transform,
          x:
            drag && activeNodeRect
              ? Math.max(
                  drag.row.left - activeNodeRect.left,
                  Math.min(drag.row.right - activeNodeRect.right, transform.x),
                )
              : transform.x,
          y: 0,
        }),
      ]}
      collisionDetection={(args) => {
        // Use the row-aligned position even when the pointer strays vertically.
        const hits = pointerWithin({
          ...args,
          pointerCoordinates: {
            x: args.collisionRect.left + args.collisionRect.width / 2,
            y: args.collisionRect.top + args.collisionRect.height / 2,
          },
        });
        const pane = hits.find((hit) => String(hit.id).startsWith("pane:"));
        if (!pane) return [];
        const containerId = String(pane.id).slice("pane:".length);
        const tabs = args.droppableContainers.filter(
          (item) => item.data.current?.sortable?.containerId === containerId,
        );
        const lastRight = Math.max(
          ...tabs.map((item) => args.droppableRects.get(item.id)?.right ?? 0),
        );
        const samePane =
          args.active.data.current?.sortable?.containerId === containerId;
        return tabs.length &&
          (samePane ||
            args.collisionRect.left + args.collisionRect.width / 2 <= lastRight)
          ? closestCenter({ ...args, droppableContainers: tabs })
          : [pane];
      }}
      onDragStart={({ active, activatorEvent }) => {
        const target = activatorEvent.target as HTMLElement;
        const tab = target.closest(".workspace-tab-slot");
        const row = target.closest(".workspace-layout");
        if (tab && row)
          setDrag({
            id: String(active.id),
            rect: tab.getBoundingClientRect(),
            row: row.getBoundingClientRect(),
          });
      }}
      onDragMove={({ active }) => {
        const rect = active.rect.current.translated;
        if (rect) setDrag((current) => current && { ...current, rect });
      }}
      onDragCancel={() => setDrag(undefined)}
      onDragEnd={({ active, over }) => {
        setDrag(undefined);
        if (drag && over && active.id !== over.id)
          onDrop(String(active.id), String(over.id));
      }}
    >
      <TabDragContext value={drag}>{children}</TabDragContext>
    </DndContext>
  );
}

export function WorkspaceTabs({
  tabs,
  selected,
  previewId,
  onSelect,
  onClose,
  onClosePaneTabs,
  onMove,
  onKeep,
  onPrefetch,
  pane = "main",
  visible = true,
  onFocus,
  leading,
  actions,
}: {
  tabs: WorkspaceTab[];
  selected?: string;
  previewId?: string;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onClosePaneTabs: (id: string, scope: "all" | "others") => void;
  onMove: (id: string, pane: Pane) => void;
  onKeep: (id: string) => void;
  onPrefetch?: (id: string) => void;
  pane?: Pane;
  visible?: boolean;
  onFocus?: () => void;
  leading?: ReactNode;
  actions?: ReactNode;
}) {
  const { t } = useTranslation();
  const scroll = useRef<HTMLDivElement>(null);
  const { setNodeRef, isOver } = useDroppable({
    id: `pane:${pane}`,
    disabled: !visible,
  });
  const tabIds = useMemo(() => tabs.map((tab) => tab.id), [tabs]);
  const setScrollElement = useCallback(
    (element: HTMLDivElement | null) => {
      scroll.current = element;
      setNodeRef(element);
    },
    [setNodeRef],
  );
  useEffect(() => {
    const element = scroll.current;
    if (!element || !visible) return;
    // The initial resize notification arrives after layout with the new selection.
    const observer = new ResizeObserver(() => {
      const active = element.querySelector<HTMLElement>(
        ".workspace-tab.selected",
      );
      if (!active) return;
      const item = active.getBoundingClientRect(),
        viewport = element.getBoundingClientRect();
      if (item.left < viewport.left)
        element.scrollLeft += item.left - viewport.left;
      else if (item.right > viewport.right)
        element.scrollLeft += item.right - viewport.right;
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [selected, tabs.length, visible]);
  const navigate = useCallback(
    (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
      let next: number;
      switch (event.key) {
        case "ArrowRight":
          next = (index + 1) % tabs.length;
          break;
        case "ArrowLeft":
          next = (index + tabs.length - 1) % tabs.length;
          break;
        case "Home":
          next = 0;
          break;
        case "End":
          next = tabs.length - 1;
          break;
        case "Delete":
          onClose(tabs[index].id);
          return;
        default:
          return;
      }
      event.preventDefault();
      onSelect(tabs[next].id);
      document
        .getElementById(`tab-${encodeURIComponent(tabs[next].id)}`)
        ?.focus();
    },
    [tabs, onSelect, onClose],
  );
  function focusStrip(event: SyntheticEvent) {
    // Selecting another tab should switch directly from the current tab.
    if (
      !(event.target instanceof Element) ||
      !event.currentTarget.contains(event.target) ||
      event.target.closest('.tab-close, [role="tab"][aria-selected="false"]')
    )
      return;
    onFocus?.();
  }
  return (
    <div
      className={cn("tab-strip", isOver && "drop-target")}
      data-pane={pane}
      aria-hidden={!visible}
      inert={!visible}
      onPointerDown={(event) => {
        if (event.button === 0) focusStrip(event);
      }}
      onFocusCapture={focusStrip}
    >
      {leading}
      <SortableContext
        id={pane}
        items={tabIds}
        strategy={horizontalListSortingStrategy}
      >
        <div
          className="tab-scroll"
          role="tablist"
          aria-label={t(
            pane === "main" ? "workspace.label" : "workspace.sidePane",
          )}
          ref={setScrollElement}
        >
          {tabs.map((tab) => (
            <SortableTab
              key={tab.id}
              tab={tab}
              active={tab.id === selected}
              preview={tab.id === previewId}
              onSelect={onSelect}
              onClose={onClose}
              onClosePaneTabs={onClosePaneTabs}
              onMove={onMove}
              onKeep={onKeep}
              onPrefetch={onPrefetch}
              onKeyDown={navigate}
            />
          ))}
        </div>
      </SortableContext>
      <div className="tab-shortcuts">{actions}</div>
    </div>
  );
}

const SortableTab = memo(function SortableTab({
  tab,
  active,
  preview,
  onSelect,
  onClose,
  onClosePaneTabs,
  onMove,
  onKeep,
  onPrefetch,
  onKeyDown,
}: {
  tab: WorkspaceTab;
  active: boolean;
  preview: boolean;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onClosePaneTabs: (id: string, scope: "all" | "others") => void;
  onMove: (id: string, pane: Pane) => void;
  onKeep: (id: string) => void;
  onPrefetch?: (id: string) => void;
  onKeyDown: (event: KeyboardEvent<HTMLButtonElement>, index: number) => void;
}) {
  const { t } = useTranslation();
  const [menu, setMenu] = useState<MenuAnchor>();
  const [renaming, setRenaming] = useState<RenameTarget>();
  const canRename = tab.kind === "chat" || tab.kind === "topic";
  const menuActions: (MenuAction | null)[] = [];
  if (menu) {
    if (preview)
      menuActions.push({
        id: "keep",
        label: t("workspace.keepTabOpen"),
        run: () => onKeep(tab.id),
      });
    if (canRename)
      menuActions.push({
        id: "rename",
        label: t("agents.renameConversation") + "…",
        run: () =>
          setRenaming({
            chatId: tab.topic?.chatId ?? tab.id,
            topicId: tab.topic?.sessionId,
            title: tab.title,
            trigger: menu.trigger,
          }),
      });
    const destination = paneOf(tab) === "main" ? "side" : "main";
    menuActions.push(
      {
        id: "move",
        label: t(
          destination === "side"
            ? "workspace.moveTabRight"
            : "workspace.moveTabLeft",
        ),
        restoreFocus: false,
        run: () => onMove(tab.id, destination),
      },
      null,
      {
        id: "close-others",
        label: t("workspace.closeOtherTabs"),
        run: () => onClosePaneTabs(tab.id, "others"),
      },
      {
        id: "close-all",
        label: t("workspace.closeAllTabs"),
        run: () => onClosePaneTabs(tab.id, "all"),
      },
    );
  }
  const reduceMotion = useReducedMotion();
  const drag = useContext(TabDragContext);
  const {
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
    active: draggingTab,
    over,
    items,
    index,
  } = useSortable({
    id: tab.id,
    data: { tab },
    transition: reduceMotion
      ? null
      : { duration: 160, easing: "cubic-bezier(0.23, 1, 0.32, 1)" },
  });
  const Icon = tabIcons[tab.kind];
  const position = isDragging && drag?.id === tab.id ? drag : undefined;
  const makeRoom =
    drag &&
    draggingTab &&
    over &&
    !items.includes(draggingTab.id) &&
    items.includes(over.id) &&
    index >= items.indexOf(over.id);
  return (
    <div
      ref={setNodeRef}
      className="workspace-tab-slot"
      style={
        isDragging
          ? undefined
          : {
              transform: makeRoom
                ? `translateX(${drag.rect.width + 4}px)`
                : CSS.Translate.toString(transform),
              transition,
            }
      }
    >
      <div
        {...rowMenuHandlers(setMenu)}
        className={cn(
          "workspace-tab",
          active && "selected",
          isDragging && "dragging",
        )}
        // Move the existing tab, keeping its slot in the flex layout. Positioning
        // against the shared row lets it cross pane scrollports without a clone.
        style={
          position
            ? {
                position: "absolute",
                left: position.rect.left - position.row.left,
                top: position.rect.top - position.row.top,
                width: position.rect.width,
                height: position.rect.height,
              }
            : undefined
        }
      >
        <button
          {...listeners}
          ref={setActivatorNodeRef}
          data-menu-focus
          role="tab"
          id={`tab-${encodeURIComponent(tab.id)}`}
          aria-controls={`panel-${encodeURIComponent(tab.id)}`}
          aria-selected={active}
          tabIndex={active ? 0 : -1}
          aria-description={preview ? t("workspace.previewTab") : undefined}
          title={
            preview ? `${tab.title} · ${t("workspace.previewTab")}` : tab.title
          }
          onClick={() => onSelect(tab.id)}
          onDoubleClick={preview ? () => onKeep(tab.id) : undefined}
          onPointerEnter={() => {
            if (!drag) onPrefetch?.(tab.id);
          }}
          onFocus={() => onPrefetch?.(tab.id)}
          onKeyDown={(event) => {
            if (preview && active && event.key === "Enter") {
              event.preventDefault();
              onKeep(tab.id);
            } else {
              onKeyDown(event, index);
            }
          }}
        >
          <Icon size={14} />
          <span className={preview ? "italic" : undefined}>{tab.title}</span>
        </button>
        {menu && (
          <ActionContextMenu
            point={menu}
            label={tab.title}
            actions={menuActions}
            onClose={(restoreFocus) => {
              setMenu(undefined);
              if (restoreFocus) menu.trigger.focus({ preventScroll: true });
            }}
          />
        )}
        {renaming && (
          <RenameConversationDialog
            target={renaming}
            onClose={() => setRenaming(undefined)}
          />
        )}
        <button
          className="tab-close"
          tabIndex={active ? 0 : -1}
          aria-label={t("workspace.closeTab", { title: tab.title })}
          onClick={() => onClose(tab.id)}
        >
          <X size={12} />
        </button>
      </div>
    </div>
  );
});
