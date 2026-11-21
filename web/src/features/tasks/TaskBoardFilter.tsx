import { useLayoutEffect, useRef, useState } from "react";
import { Bookmark, ChevronDown, Funnel, type LucideIcon } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { TaskView, TaskViewFilters } from "@/api/types.gen";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { FieldLegend, FieldSet, FieldTitle } from "@/components/ui/field";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";

import { TaskFilterOptions } from "./TaskFilterOptions";

type QuickFilter = NonNullable<TaskView["quickFilter"]>;
type FilterField = {
  id: keyof TaskViewFilters;
  label: string;
  icon: LucideIcon;
  options: {
    id: string;
    label: string;
    shortLabel?: string;
    icon?: LucideIcon;
  }[];
};

const quickFilterChoices = [
  "agent",
  "kind",
  "status",
  "project",
  "none",
] as const satisfies readonly QuickFilter[];
const maxInlineOptions = 4;

export function TaskBoardFilter({
  filters,
  count,
  fields,
  quickFilter = "agent",
  onChange,
  onQuickFilterChange,
  onSaveAs,
}: {
  filters: TaskViewFilters;
  count: number;
  fields: FilterField[];
  quickFilter?: QuickFilter;
  onChange: (filters: TaskViewFilters) => void;
  onQuickFilterChange: (quickFilter: QuickFilter) => void;
  onSaveAs?: () => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const field = fields.find(({ id }) => id === quickFilter);
  const setField = (id: keyof TaskViewFilters, values: string[]) =>
    onChange({ ...filters, [id]: values });

  return (
    <div className="flex shrink-0 items-center gap-2">
      {!!field?.options.length && (
        <TaskBoardQuickFilter
          key={field.id}
          field={field}
          selected={filters[field.id] ?? []}
          onChange={(values) => setField(field.id, values)}
        />
      )}
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button variant="outline" data-filtered={count > 0}>
            <Funnel data-icon="inline-start" />
            {t("tasks.filter")}
            {count > 0 && <span className="task-board-count">{count}</span>}
          </Button>
        </PopoverTrigger>
        <PopoverContent
          align="end"
          aria-label={t("tasks.filter")}
          className="task-board-filter-panel"
        >
          <div className="flex shrink-0 items-center justify-between gap-2 border-b px-2 pb-1.5">
            <span className="text-sm font-medium">{t("tasks.filter")}</span>
            <Button
              variant="ghost"
              size="sm"
              disabled={!count}
              onClick={() => onChange({})}
            >
              {t("tasks.clearFilters")}
            </Button>
          </div>
          <div className="flex min-h-0 flex-col gap-0.5 overflow-y-auto overscroll-contain">
            {fields.map((field) =>
              field.options.length > 0 ? (
                <FilterSection
                  key={field.id}
                  field={field}
                  selected={filters[field.id] ?? []}
                  onChange={(values) => setField(field.id, values)}
                />
              ) : null,
            )}
          </div>
          <div className="flex shrink-0 flex-col gap-2 border-t px-2 pt-2 pb-1">
            <div className="flex min-w-0 flex-col gap-1.5">
              <FieldTitle>{t("tasks.quickFilter")}</FieldTitle>
              <ToggleGroup
                type="single"
                variant="outline"
                spacing={1}
                size="sm"
                className="max-w-full flex-wrap"
                aria-label={t("tasks.quickFilter")}
                value={quickFilter}
                onValueChange={(value) => {
                  const choice = quickFilterChoices.find((id) => id === value);
                  if (choice) onQuickFilterChange(choice);
                }}
              >
                {quickFilterChoices.map((id) => (
                  <ToggleGroupItem key={id} value={id}>
                    {id === "none"
                      ? t("tasks.quickFilterNone")
                      : fields.find((field) => field.id === id)?.label}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
            </div>
            {onSaveAs && (
              <Button
                variant="outline"
                size="sm"
                className="self-start"
                onClick={() => {
                  setOpen(false);
                  onSaveAs();
                }}
              >
                <Bookmark data-icon="inline-start" />
                {t("tasks.saveView")}
              </Button>
            )}
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}

type QuickFilterProps = {
  field: FilterField;
  selected: string[];
  onChange: (values: string[]) => void;
};

function FilterSection({ field, selected, onChange }: QuickFilterProps) {
  const { label, icon: Icon, options } = field;
  const summary = options
    .filter((option) => selected.includes(option.id))
    .map((option) => option.label)
    .join(" · ");
  return (
    <Collapsible defaultOpen={selected.length > 0}>
      <CollapsibleTrigger asChild>
        <Button
          variant="ghost"
          className="h-auto min-h-8 w-full justify-start py-1"
          aria-label={label}
          aria-description={summary || undefined}
        >
          <Icon className="text-muted-foreground" />
          <span className="min-w-0 flex-1 text-start">
            {label}
            {summary && (
              <span
                className="block truncate text-xs font-normal text-muted-foreground"
                title={summary}
              >
                {summary}
              </span>
            )}
          </span>
          {!!selected.length && (
            <span className="task-board-count">{selected.length}</span>
          )}
          <ChevronDown className="text-muted-foreground group-aria-expanded/button:rotate-180" />
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent className="px-2 py-1">
        <FieldSet className="min-w-0 gap-1">
          <FieldLegend className="sr-only">{label}</FieldLegend>
          <TaskFilterOptions
            options={options}
            selected={selected}
            onChange={onChange}
          />
        </FieldSet>
      </CollapsibleContent>
    </Collapsible>
  );
}

function TaskBoardQuickFilter({ field, selected, onChange }: QuickFilterProps) {
  const anchor = useRef<HTMLDivElement>(null);
  const toggleGroup = useRef<HTMLDivElement>(null);
  const [fits, setFits] = useState(false);
  const { label, options, icon: Icon } = field;
  const canShowInline = options.length <= maxInlineOptions;
  const showInline = canShowInline && fits;

  useLayoutEffect(() => {
    const slot = anchor.current;
    const buttons = toggleGroup.current;
    const toolbar = slot?.closest(".task-board-toolbar");
    const heading = toolbar?.querySelector(".task-board-heading");
    if (!slot || !buttons || !toolbar || !heading) return;
    const measure = () => {
      if (getComputedStyle(toolbar).flexDirection === "column") {
        setFits(false);
        return;
      }
      const style = getComputedStyle(heading);
      const titleControls = Array.from(heading.children);
      const titleWidth = titleControls.reduce(
        (width, child) =>
          width +
          Math.max(child.scrollWidth, child.getBoundingClientRect().width),
        parseFloat(style.paddingInlineStart) +
          parseFloat(style.paddingInlineEnd) +
          parseFloat(style.columnGap) * (titleControls.length - 1),
      );
      // Both representations can use the slot plus any space left by the title controls.
      const available =
        slot.getBoundingClientRect().width +
        heading.getBoundingClientRect().width -
        titleWidth;
      setFits(buttons.getBoundingClientRect().width <= available);
    };
    measure();
    const resize = new ResizeObserver(measure);
    [toolbar, heading, slot, buttons].forEach((element) =>
      resize.observe(element),
    );
    const titleChanges = new MutationObserver(measure);
    titleChanges.observe(heading, {
      childList: true,
      characterData: true,
      subtree: true,
    });
    return () => {
      resize.disconnect();
      titleChanges.disconnect();
    };
  }, [canShowInline]);

  return (
    <div ref={anchor} className="relative">
      {!showInline && (
        <Popover>
          <PopoverTrigger asChild>
            <Button variant="outline" data-filtered={selected.length > 0}>
              <Icon data-icon="inline-start" aria-hidden="true" />
              {label}
              {selected.length > 0 && (
                <span className="task-board-count">{selected.length}</span>
              )}
              <ChevronDown data-icon="inline-end" aria-hidden="true" />
            </Button>
          </PopoverTrigger>
          <PopoverContent
            align="start"
            sideOffset={4}
            className="task-board-quick-picker"
            aria-label={label}
          >
            <TaskFilterOptions
              options={options}
              searchable
              selected={selected}
              onChange={onChange}
            />
          </PopoverContent>
        </Popover>
      )}
      {canShowInline && (
        <ToggleGroup
          ref={toggleGroup}
          type="multiple"
          variant="outline"
          spacing={0}
          className={
            showInline ? "w-max" : "invisible absolute end-0 top-0 w-max"
          }
          aria-label={label}
          value={selected}
          onValueChange={onChange}
        >
          {options.map(({ id, label, shortLabel, icon: OptionIcon }) => (
            <ToggleGroupItem
              key={id}
              value={id}
              className="max-w-40"
              aria-label={label}
              title={label}
            >
              {OptionIcon && (
                <OptionIcon data-icon="inline-start" aria-hidden="true" />
              )}
              <span className="truncate">{shortLabel ?? label}</span>
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      )}
    </div>
  );
}
