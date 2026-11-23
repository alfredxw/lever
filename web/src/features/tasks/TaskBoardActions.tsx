import { useState } from "react";
import { Archive, Ellipsis, ListTodo, Trash2, Undo2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { TaskStatus } from "./taskDocument";
import type { TaskTarget } from "./useTaskDispatch";
import { useTaskWorkflowUpdate } from "./taskWorkflow";

export function TaskBoardActions({
  task,
  status,
  disabled,
  align = "end",
  side,
  size = "icon-xs",
  hideRestore = false,
  onDeleted,
}: {
  task: TaskTarget & { title: string };
  status: TaskStatus;
  disabled?: boolean;
  align?: "start" | "center" | "end";
  side?: "top" | "right" | "bottom" | "left";
  size?: "icon-xs" | "icon-sm";
  hideRestore?: boolean;
  onDeleted?: () => void;
}) {
  const { t } = useTranslation();
  const [confirming, setConfirming] = useState(false);
  const update = useTaskWorkflowUpdate(task);
  const showReturnTodo = status !== "todo" && status !== "unconfirmed";
  const showArchive = status !== "closed";
  const showRestore = status === "closed" && !hideRestore;
  const hasSecondaryActions = showReturnTodo || showArchive || showRestore;
  function change(action: "todo" | "close" | "reopen" | "delete") {
    update.mutate(action, {
      onSuccess: () => {
        setConfirming(false);
        if (action === "delete") onDeleted?.();
      },
      onError: (error) => toast.error(error.message),
    });
  }
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            size={size}
            variant="ghost"
            aria-label={t("tasks.manageItem")}
            aria-description={task.title}
            disabled={disabled || update.isPending}
          >
            <Ellipsis />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align={align} side={side}>
          {showReturnTodo && (
            <DropdownMenuItem onSelect={() => change("todo")}>
              <ListTodo />
              {t("tasks.returnTodo")}
            </DropdownMenuItem>
          )}
          {showRestore && (
            <DropdownMenuItem onSelect={() => change("reopen")}>
              <Undo2 />
              {t("tasks.restoreItem")}
            </DropdownMenuItem>
          )}
          {showArchive && (
            <DropdownMenuItem onSelect={() => change("close")}>
              <Archive />
              {t("tasks.archiveItem")}
            </DropdownMenuItem>
          )}
          {hasSecondaryActions && <DropdownMenuSeparator />}
          <DropdownMenuItem
            variant="destructive"
            onSelect={() => setConfirming(true)}
          >
            <Trash2 />
            {t("tasks.removeItem")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {confirming && (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!update.isPending) setConfirming(open);
          }}
        >
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{t("tasks.removeItem")}</DialogTitle>
              <DialogDescription>
                {t("tasks.removeItemConfirm", { title: task.title })}
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button
                variant="outline"
                disabled={update.isPending}
                onClick={() => setConfirming(false)}
              >
                {t("common.cancel")}
              </Button>
              <Button
                variant="destructive"
                disabled={update.isPending}
                onClick={() => change("delete")}
              >
                {t("tasks.removeItem")}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}
