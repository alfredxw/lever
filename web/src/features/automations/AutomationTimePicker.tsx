import { useId, useMemo, useRef, useState } from "react";
import { Command } from "cmdk";
import { Check, ChevronDown } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";

const quarterHours = Array.from({ length: 24 * 4 }, (_, index) => {
  const hour = String(Math.floor(index / 4)).padStart(2, "0");
  const minute = String((index % 4) * 15).padStart(2, "0");
  return `${hour}:${minute}`;
});

function exactTime(input: string) {
  const match = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(input.trim());
  if (match) return `${match[1].padStart(2, "0")}:${match[2]}`;
}

export function AutomationTimePicker({
  value,
  onChange,
  disabled,
}: {
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
}) {
  const { t, i18n } = useTranslation();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const valueId = useId();
  const list = useRef<HTMLDivElement>(null);
  const currentItem = useRef<HTMLDivElement>(null);
  const enteredTime = exactTime(query);
  const { display, options } = useMemo(() => {
    const formatter = new Intl.DateTimeFormat(i18n.language, {
      hour: "numeric",
      minute: "2-digit",
      timeZone: "UTC",
    });
    const label = (time: string) =>
      formatter.format(new Date(`2000-01-01T${time}:00Z`));
    const times = new Set([...quarterHours, value]);
    if (enteredTime) times.add(enteredTime);
    return {
      display: label(value),
      options: open
        ? [...times].sort().map((time) => ({ time, label: label(time) }))
        : [],
    };
  }, [enteredTime, i18n.language, open, value]);

  function changeOpen(next: boolean) {
    setOpen(next);
    if (!next) setQuery("");
  }

  function centerCurrentTime() {
    // The popover measures its available height after mounting.
    requestAnimationFrame(() => {
      const viewport = list.current;
      const item = currentItem.current;
      if (!viewport || !item) return;
      const offset =
        item.getBoundingClientRect().top - viewport.getBoundingClientRect().top;
      viewport.scrollTop +=
        offset - (viewport.clientHeight - item.offsetHeight) / 2;
    });
  }

  return (
    <Popover modal open={open} onOpenChange={changeOpen}>
      <PopoverTrigger asChild>
        <Button
          id="automation-time"
          type="button"
          variant="outline"
          className="w-32 max-w-full justify-between tabular-nums"
          disabled={disabled}
          aria-describedby={valueId}
        >
          <span id={valueId}>{display}</span>
          <ChevronDown data-icon="inline-end" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        sideOffset={4}
        aria-label={t("automations.time")}
        className="w-40 max-w-(--radix-popover-content-available-width) p-1"
        onOpenAutoFocus={centerCurrentTime}
      >
        <Command
          label={t("automations.chooseTime")}
          defaultValue={value}
          className="flex max-h-[min(20rem,calc(var(--radix-popover-content-available-height)-0.5rem))] flex-col gap-1"
          filter={(time, search, [label] = []) => {
            const exact = exactTime(search);
            if (exact) return time === exact ? 1 : 0;
            const term = search.trim().toLowerCase();
            return time.includes(term) || label?.toLowerCase().includes(term)
              ? 1
              : 0;
          }}
        >
          <Command.Input asChild value={query} onValueChange={setQuery}>
            <Input
              className="shrink-0 tabular-nums"
              placeholder={t("automations.enterTime")}
              spellCheck={false}
            />
          </Command.Input>
          <Command.List
            ref={list}
            className="min-h-0 overflow-y-auto overscroll-contain"
          >
            <Command.Empty className="p-2 text-xs text-muted-foreground">
              {t("automations.noTimes")}
            </Command.Empty>
            <Command.Group>
              {options.map(({ time, label }) => (
                <Command.Item
                  key={time}
                  ref={time === value ? currentItem : undefined}
                  value={time}
                  keywords={[label]}
                  aria-current={time === value || undefined}
                  className="flex min-h-8 cursor-default items-center justify-between gap-2 rounded-md px-2 text-sm tabular-nums aria-current:bg-control-selected data-[selected=true]:bg-control-focus"
                  onSelect={() => {
                    onChange(time);
                    changeOpen(false);
                  }}
                >
                  <span>{label}</span>
                  {time === value && (
                    <Check className="size-4 shrink-0" aria-hidden="true" />
                  )}
                </Command.Item>
              ))}
            </Command.Group>
          </Command.List>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
