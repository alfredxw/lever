import { useEffect, useRef, type KeyboardEvent, type MouseEvent } from "react";
import type { LucideIcon } from "lucide-react";
import { isMyGo } from "mygo-runtime";
import { toast } from "sonner";
import { Dialogs } from "@/api/desktop.gen";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  DropdownMenuGroup,
} from "@/components/ui/dropdown-menu";

export type MenuAction = {
  id: string;
  label: string;
  icon?: LucideIcon;
  disabled?: boolean;
  restoreFocus?: boolean;
  run: () => void | Promise<unknown>;
};

type Point = { x: number; y: number };
export type MenuAnchor = Point & { trigger: HTMLElement };

export function rowMenuHandlers(open: (anchor: MenuAnchor) => void) {
  return {
    onContextMenu(event: MouseEvent<HTMLElement>) {
      event.preventDefault();
      event.stopPropagation();
      const trigger =
        event.currentTarget.querySelector<HTMLElement>("[data-menu-focus]") ??
        event.currentTarget;
      open({ x: event.clientX, y: event.clientY, trigger });
    },
    onKeyDownCapture(event: KeyboardEvent<HTMLElement>) {
      if (
        event.key !== "ContextMenu" &&
        !(event.shiftKey && event.key === "F10")
      )
        return;
      event.preventDefault();
      event.stopPropagation();
      const trigger =
        event.target instanceof HTMLElement
          ? event.target
          : event.currentTarget;
      const rect = trigger.getBoundingClientRect();
      open({ x: rect.left, y: rect.bottom, trigger });
    },
  };
}

export function ActionContextMenu({
  actions,
  point,
  label,
  onClose,
  attributes,
}: {
  actions: (MenuAction | null)[];
  point: Point;
  label: string;
  onClose: (restoreFocus: boolean) => void;
  attributes?: Record<`data-${string}`, string>;
}) {
  const select = (id: string) => {
    const action = actions.find((action) => action?.id === id);
    onClose(action?.restoreFocus ?? true);
    if (action && !action.disabled)
      void Promise.resolve()
        .then(action.run)
        .catch((error) =>
          toast.error(error instanceof Error ? error.message : String(error)),
        );
  };
  if (isMyGo())
    return <NativeMenu actions={actions} point={point} onSelect={select} />;
  return (
    <DropdownMenu
      open
      modal={false}
      onOpenChange={(open) => {
        if (!open) onClose(true);
      }}
    >
      <DropdownMenuTrigger asChild>
        <span
          aria-hidden
          tabIndex={-1}
          style={{
            position: "fixed",
            left: point.x,
            top: point.y,
            width: 0,
            height: 0,
            pointerEvents: "none",
          }}
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        className="w-56"
        {...attributes}
        aria-label={label}
        collisionPadding={8}
        onCloseAutoFocus={(event) => event.preventDefault()}
      >
        <DropdownMenuGroup>
          {actions.map((action, index) =>
            action ? (
              <DropdownMenuItem
                key={action.id}
                disabled={action.disabled}
                onSelect={() => select(action.id)}
              >
                {action.icon && <action.icon />}
                {action.label}
              </DropdownMenuItem>
            ) : (
              <DropdownMenuSeparator key={index} />
            ),
          )}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function NativeMenu({
  actions,
  point,
  onSelect,
}: {
  actions: (MenuAction | null)[];
  point: Point;
  onSelect: (id: string) => void;
}) {
  const opened = useRef(false);
  useEffect(() => {
    // StrictMode can replay effects; one right click must open only one OS menu.
    if (opened.current) return;
    opened.current = true;
    void Dialogs.showContextMenu(
      actions.map((action) =>
        action
          ? { id: action.id, label: action.label, disabled: action.disabled }
          : { id: "", label: "" },
      ),
      Math.round(point.x),
      Math.round(point.y),
    )
      .then(onSelect)
      .catch((error) => {
        onSelect("");
        toast.error(error instanceof Error ? error.message : String(error));
      });
  }, [actions, point, onSelect]);
  return null;
}
