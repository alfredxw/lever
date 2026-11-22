import * as React from "react";
import { DayPicker } from "react-day-picker";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "cn";
import { buttonVariants } from "@/components/ui/button";

export type CalendarProps = React.ComponentProps<typeof DayPicker>;

function Calendar({
  className,
  classNames,
  showOutsideDays = true,
  ...props
}: CalendarProps) {
  return (
    <DayPicker
      showOutsideDays={showOutsideDays}
      className={cn("relative p-2 select-none", className)}
      classNames={{
        months: "flex flex-col gap-2",
        month: "flex flex-col gap-2",
        month_caption: "flex h-7 items-center justify-center px-7",
        caption_label: "text-xs font-semibold text-foreground tabular-nums",
        nav: "pointer-events-none absolute inset-x-2 top-2 flex h-7 items-center justify-between",
        button_previous: cn(
          buttonVariants({ variant: "ghost", size: "icon-xs" }),
          "pointer-events-auto text-muted-foreground hover:text-foreground",
        ),
        button_next: cn(
          buttonVariants({ variant: "ghost", size: "icon-xs" }),
          "pointer-events-auto text-muted-foreground hover:text-foreground",
        ),
        month_grid: "w-full border-collapse",
        weekdays: "grid grid-cols-7",
        weekday:
          "flex h-7 items-center justify-center text-[11px] font-medium text-muted-foreground",
        weeks: "flex flex-col gap-0.5",
        week: "grid grid-cols-7",
        day: "flex items-center justify-center p-0 text-center",
        disabled: "pointer-events-none opacity-40",
        hidden: "invisible",
        ...classNames,
      }}
      components={{
        Chevron: ({ orientation, className: iconClass }) =>
          orientation === "left" ? (
            <ChevronLeft className={cn("size-3.5", iconClass)} />
          ) : (
            <ChevronRight className={cn("size-3.5", iconClass)} />
          ),
        DayButton: ({
          day: _day,
          modifiers,
          className: buttonClass,
          ...buttonProps
        }) => (
          <button
            {...buttonProps}
            data-selected={modifiers.selected || undefined}
            data-today={modifiers.today || undefined}
            className={cn(
              "inline-flex size-8 items-center justify-center rounded-md text-xs font-normal tabular-nums transition-colors duration-150 outline-none",
              modifiers.selected
                ? "bg-primary font-medium text-primary-foreground hover:bg-primary/90 focus-visible:bg-primary/80"
                : modifiers.today
                  ? "bg-control-selected font-semibold text-foreground hover:bg-control-hover focus-visible:bg-control-focus"
                  : modifiers.outside
                    ? "text-muted-foreground/45 hover:bg-control-hover hover:text-muted-foreground focus-visible:bg-control-focus"
                    : "text-foreground hover:bg-control-hover focus-visible:bg-control-focus",
              buttonClass,
            )}
          />
        ),
      }}
      {...props}
    />
  );
}

export { Calendar };
