import { useId, useState, type ComponentProps, type ReactNode } from "react";
import { Command } from "cmdk";
import { Check, ChevronDown, Search } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";

type Option = {
  id: string;
  label: string;
  icon?: ReactNode;
  description?: string;
  keywords?: string[];
  disabled?: boolean;
};

export function SearchableSelect({
  id,
  label,
  placeholder,
  searchLabel,
  emptyLabel,
  options,
  value,
  currentLabel,
  onChange,
  onCloseAutoFocus,
  disabled,
  defaultOpen = false,
  align = "end",
  className,
}: {
  id?: string;
  label: string;
  placeholder: string;
  searchLabel: string;
  emptyLabel: string;
  options: readonly Option[];
  value?: string;
  currentLabel?: string;
  onChange: (value: string) => void;
  onCloseAutoFocus?: ComponentProps<typeof PopoverContent>["onCloseAutoFocus"];
  disabled?: boolean;
  defaultOpen?: boolean;
  align?: ComponentProps<typeof PopoverContent>["align"];
  className?: string;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const valueId = useId();
  const selected = options.find((option) => option.id === value);
  const valueLabel = selected?.label ?? currentLabel;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          id={id}
          type="button"
          variant="outline"
          className={cn("min-w-0 justify-between font-normal", className)}
          aria-label={label}
          aria-describedby={valueLabel ? valueId : undefined}
          disabled={disabled}
        >
          <span className="flex min-w-0 items-center gap-2">
            {selected?.icon}
            <span
              id={valueId}
              className={cn("truncate", !valueLabel && "text-muted-foreground")}
            >
              {valueLabel ?? placeholder}
            </span>
          </span>
          <ChevronDown
            data-icon="inline-end"
            className="text-muted-foreground"
          />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align={align}
        aria-label={label}
        onCloseAutoFocus={onCloseAutoFocus}
        className="flex max-h-[min(22rem,var(--radix-popover-content-available-height))] w-(--radix-popover-trigger-width) min-w-[min(15rem,var(--radix-popover-content-available-width))] max-w-(--radix-popover-content-available-width) p-1"
      >
        <Command
          className="flex min-h-0 w-full flex-col gap-1"
          label={searchLabel}
          defaultValue={
            selected && !selected.disabled ? `option:${selected.id}` : undefined
          }
          filter={(_, search, keywords) =>
            Number(
              (keywords ?? [])
                .join(" ")
                .toLocaleLowerCase()
                .includes(search.trim().toLocaleLowerCase()),
            )
          }
          loop
        >
          <InputGroup className="shrink-0">
            <InputGroupAddon>
              <Search />
            </InputGroupAddon>
            <Command.Input asChild>
              <InputGroupInput
                aria-label={searchLabel}
                placeholder={searchLabel}
              />
            </Command.Input>
          </InputGroup>
          <Command.List className="min-h-0 overflow-y-auto overscroll-contain">
            <Command.Empty className="px-2 py-1.5 text-xs text-muted-foreground">
              {emptyLabel}
            </Command.Empty>
            <Command.Group>
              {options.map((option) => (
                <Command.Item
                  key={option.id}
                  value={`option:${option.id}`}
                  keywords={[option.label, ...(option.keywords ?? [])]}
                  disabled={option.disabled}
                  aria-label={option.label}
                  aria-description={option.description}
                  aria-current={option.id === value || undefined}
                  className="flex min-h-8 cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-control data-[disabled=true]:opacity-60 data-[selected=true]:bg-control-focus"
                  onSelect={() => {
                    setOpen(false);
                    if (option.id !== value) onChange(option.id);
                  }}
                >
                  {option.icon}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate" title={option.label}>
                      {option.label}
                    </span>
                    {option.description && (
                      <span className="block wrap-anywhere text-xs text-muted-foreground">
                        {option.description}
                      </span>
                    )}
                  </span>
                  {option.id === value && (
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
