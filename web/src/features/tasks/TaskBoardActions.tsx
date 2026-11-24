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
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ToolbarButton } from "@/components/ui/toolbar-button";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { TaskStatus } from "./taskDocument";
import type { TaskTarget } from "./useTaskDispatch";
import { useTaskWorkflowUpdate } from "./taskWorkflow";

export function TaskBoardActions({
  task,
  status,
  disabled,
  inline = false,
  onDeleted,
}: {
  task: TaskTarget & { title: string };
  status: TaskStatus;
  disabled?: boolean;
  inline?: boolean;
  onDeleted?: () => void;
}) {
  const { t } = useTranslation();
  const [confirming, setConfirming] = useState(false);
  const update = useTaskWorkflowUpdate(task);
  const busy = disabled || update.isPending;
  const deleteLabel = t("tasks.removeItem");
  const actions = [
    status !== "todo" &&
      status !== "unconfirmed" && {
        action: "todo" as const,
        icon: ListTodo,
        label: t("tasks.returnTodo"),
      },
    status === "closed" &&
      !inline && {
        action: "reopen" as const,
        icon: Undo2,
        label: t("tasks.restoreItem"),
      },
    status !== "closed" && {
      action: "close" as const,
      icon: Archive,
      label: t("tasks.archiveItem"),
    },
  ].filter((entry) => entry !== false);
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
    <Dialog
      open={confirming}
      onOpenChange={(open) => {
        if (!update.isPending) setConfirming(open);
      }}
    >
      {inline ? (
        <TooltipProvider delayDuration={350}>
          <div className="flex shrink-0 items-center gap-1">
            {actions.map(({ action, icon: Icon, label }) => (
              <ToolbarButton
                key={action}
                label={label}
                disabled={busy}
                onClick={() => change(action)}
              >
                <Icon />
              </ToolbarButton>
            ))}
            <DialogTrigger asChild>
              <ToolbarButton
                label={deleteLabel}
                className="hover:text-destructive focus-visible:text-destructive"
                disabled={busy}
              >
                <Trash2 />
              </ToolbarButton>
            </DialogTrigger>
          </div>
        </TooltipProvider>
      ) : (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label={t("tasks.manageItem")}
              aria-description={task.title}
              disabled={busy}
            >
              <Ellipsis />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {actions.map(({ action, icon: Icon, label }) => (
              <DropdownMenuItem key={action} onSelect={() => change(action)}>
                <Icon />
                {label}
              </DropdownMenuItem>
            ))}
            {actions.length > 0 && <DropdownMenuSeparator />}
            <DropdownMenuItem
              variant="destructive"
              onSelect={() => setConfirming(true)}
            >
              <Trash2 />
              {deleteLabel}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{deleteLabel}</DialogTitle>
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
            {deleteLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
