import { ChevronDown, Folder, Folders } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { WorkingCopy } from "@/api/types.gen";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { directoryName } from "@/lib/paths";
import { availableGroup, groupSummary } from "./queries";
import { primaryDirectory } from "./scope";

export function WorkingDirectoryPicker({
  copies,
  originalPath,
  selected,
  disabled,
  onSelect,
}: {
  copies?: WorkingCopy[];
  originalPath: string;
  selected?: string;
  disabled?: boolean;
  onSelect: (id?: string) => void;
}) {
  const { t } = useTranslation();
  const available = copies?.filter(availableGroup);
  if (!selected && !available?.length) return null;
  const copy = copies?.find((item) => item.id === selected);
  const label = selected
    ? (copy?.name ?? t("worktrees.group"))
    : t("worktrees.defaultScope");
  const path = copy ? primaryDirectory(copy) : originalPath;
  const Icon = selected ? Folders : Folder;
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="composer-directory-trigger"
          aria-label={t("worktrees.group")}
          title={path}
          disabled={disabled}
        >
          <Icon className="size-3.5" />
          <span className="truncate composer-action-detail">{label}</span>
          <ChevronDown className="size-3 opacity-70 composer-action-detail" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        side="top"
        sideOffset={6}
        collisionPadding={12}
        className="w-72 max-w-[calc(100vw-1.5rem)] data-open:animate-none data-closed:animate-none"
      >
        <DropdownMenuRadioGroup
          value={selected ?? ""}
          onValueChange={(id) => onSelect(id || undefined)}
        >
          <DropdownMenuRadioItem
            value=""
            className="py-1.5"
            title={originalPath}
          >
            <Folder />
            <span className="grid min-w-0 gap-0.5">
              <span className="truncate">{t("worktrees.defaultScope")}</span>
              <span className="truncate text-xs text-muted-foreground">
                {t("worktrees.startsIn", { name: directoryName(originalPath) })}
              </span>
            </span>
          </DropdownMenuRadioItem>
          {available?.map((item) => (
            <DropdownMenuRadioItem
              value={item.id}
              key={item.id}
              title={groupSummary(item)}
              className="py-1.5"
            >
              <Folders />
              <span className="grid min-w-0 gap-0.5">
                <span className="truncate">{item.name}</span>
                <span className="truncate text-xs text-muted-foreground">
                  {groupSummary(item)}
                </span>
              </span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
