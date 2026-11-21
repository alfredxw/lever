import {
  useEffect,
  useState,
  type ComponentProps,
  type ReactNode,
} from "react";
import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  MouseSensor,
  pointerWithin,
  TouchSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { ChevronRight, NotebookPen, Plus, Rss, SquareKanban } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";

const groups = [
  { id: "board", label: "tasks.board", add: "tasks.newView", icon: SquareKanban },
  { id: "note", label: "tasks.notes", add: "tasks.newNote", icon: NotebookPen },
  { id: "sources", label: "tasks.sources", add: "tasks.addSource", icon: Rss },
] as const;

export type TaskSection = (typeof groups)[number]["id"];
export type TaskDragTrigger = ComponentProps<"button">;

function readOrder(key: string): string[] {
  try {
    const order = JSON.parse(localStorage.getItem(key) ?? "[]");
    if (Array.isArray(order)) return order;
  } catch {
    // An unreadable layout preference falls back to the original list order.
  }
  return [];
}

export function TaskSidebarItems<T extends { id: string }>({
  scope,
  items,
  matches,
  children,
}: {
  scope: "groups" | "views" | "notes" | "sources";
  items: readonly T[];
  matches?: (item: T) => boolean;
  children: (item: T, drag: TaskDragTrigger) => ReactNode;
}) {
  const { t } = useTranslation();
  const key = "lever:works-order:" + scope;
  const [order, setOrder] = useState(() => readOrder(key));
  useEffect(() => {
    function onStorage(event: StorageEvent) {
      if (
        event.storageArea === localStorage &&
        (event.key === key || event.key === null)
      )
        setOrder(readOrder(key));
    }
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [key]);
  const ranks = new Map(order.map((id, index) => [id, index]));
  const ordered = [...items].sort(
    (a, b) =>
      (ranks.get(a.id) ?? order.length) - (ranks.get(b.id) ?? order.length),
  );
  const shown = matches ? ordered.filter(matches) : ordered;
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: { y: 10 } } }),
    useSensor(TouchSensor, {
      activationConstraint: { delay: 200, tolerance: 5 },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );
  return (
    <DndContext
      sensors={sensors}
      collisionDetection={(args) =>
        args.pointerCoordinates ? pointerWithin(args) : closestCenter(args)
      }
      accessibility={{
        screenReaderInstructions: {
          draggable: t("tasks.sidebarDragInstructions"),
        },
      }}
      onDragEnd={({ active, over }) => {
        if (!over || active.id === over.id) return;
        const ids = ordered.map((item) => item.id);
        const from = ids.indexOf(String(active.id));
        const to = ids.indexOf(String(over.id));
        if (from < 0 || to < 0) return;
        const next = arrayMove(ids, from, to);
        localStorage.setItem(key, JSON.stringify(next));
        setOrder(next);
      }}
    >
      <SortableContext
        items={shown.map((item) => item.id)}
        strategy={verticalListSortingStrategy}
      >
        {shown.map((item) => (
          <SortableRow key={item.id} id={item.id} disabled={shown.length < 2}>
            {(drag) => children(item, drag)}
          </SortableRow>
        ))}
      </SortableContext>
    </DndContext>
  );
}

function SortableRow({
  id,
  disabled,
  children,
}: {
  id: string;
  disabled: boolean;
  children: (drag: TaskDragTrigger) => ReactNode;
}) {
  const {
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    attributes,
    listeners,
    isDragging,
  } = useSortable({ id, disabled });
  return (
    <li
      ref={setNodeRef}
      className="task-sortable-row"
      data-dragging={isDragging || undefined}
      style={{
        transform: CSS.Translate.toString(transform && { ...transform, x: 0 }),
        transition,
      }}
    >
      {children(
        disabled
          ? {}
          : {
              ...attributes,
              ...listeners,
              ref: setActivatorNodeRef,
              "aria-keyshortcuts": "Shift+Space",
              onKeyDown(event) {
                // Keep ordinary Space and Enter available for opening the row.
                if (event.shiftKey && event.code === "Space")
                  listeners?.onKeyDown?.(event);
              },
            },
      )}
    </li>
  );
}

export function TaskSidebarGroups({
  expanded,
  onOpenChange,
  onCreate,
  children,
}: {
  expanded: Record<TaskSection, boolean>;
  onOpenChange: (section: TaskSection, open: boolean) => void;
  onCreate: (section: TaskSection, trigger: HTMLButtonElement) => void;
  children: Record<TaskSection, ReactNode>;
}) {
  const { t } = useTranslation();
  return (
    <ul>
      <TaskSidebarItems scope="groups" items={groups}>
        {({ id, label, add, icon: Icon }, drag) => (
          <Collapsible
            open={expanded[id]}
            onOpenChange={(open) => onOpenChange(id, open)}
          >
            <div className="task-nav-row">
              <CollapsibleTrigger asChild>
                <Button
                  {...drag}
                  variant="ghost"
                  className="sidebar-nav-item task-nav-parent"
                >
                  <Icon data-icon="inline-start" />
                  <span className="truncate">{t(label)}</span>
                  <ChevronRight className="task-nav-chevron" />
                </Button>
              </CollapsibleTrigger>
              <Button
                variant="ghost"
                size="icon-sm"
                className="task-nav-add"
                aria-label={t(add)}
                title={t(add)}
                onClick={(event) => onCreate(id, event.currentTarget)}
              >
                <Plus />
              </Button>
            </div>
            <CollapsibleContent>{children[id]}</CollapsibleContent>
          </Collapsible>
        )}
      </TaskSidebarItems>
    </ul>
  );
}
