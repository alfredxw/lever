import { useState } from "react";
import { Command } from "cmdk";
import { Check, ChevronDown, Search } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  Choice,
  FormRow,
  ToggleChoices,
  ToggleRow,
} from "./AutomationFormControls";
import { AutomationTimePicker } from "./AutomationTimePicker";
import {
  frequencies,
  intervalUnits,
  maxIntervalMinutes,
  minutesPerUnit,
  type ScheduleDraft,
  weekdayOrder,
} from "./automationSchedule";

const monthDays = Array.from({ length: 31 }, (_, index) => {
  const day = String(index + 1);
  return { id: day, label: day };
});
const timeZones = Intl.supportedValuesOf?.("timeZone");

function TimeZonePicker({
  value,
  onChange,
  disabled,
}: {
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  if (!timeZones?.length) {
    return (
      <Input
        id="automation-zone"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        required
      />
    );
  }
  const options = [...new Set([value, "UTC", ...timeZones])];
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          id="automation-zone"
          type="button"
          variant="outline"
          disabled={disabled}
          className="max-w-full justify-between"
        >
          <span className="truncate">{value}</span>
          <ChevronDown data-icon="inline-end" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        aria-label={t("automations.timezone")}
        className="w-64 max-w-(--radix-popover-content-available-width) p-1.5"
      >
        <Command label={t("automations.timezone")} defaultValue={value} loop>
          <InputGroup className="mb-1">
            <InputGroupAddon>
              <Search />
            </InputGroupAddon>
            <Command.Input asChild>
              <InputGroupInput
                aria-label={t("automations.searchTimezone")}
                placeholder={t("automations.searchTimezone")}
              />
            </Command.Input>
          </InputGroup>
          <Command.List className="max-h-52 overflow-y-auto">
            <Command.Empty className="p-2 text-sm text-muted-foreground">
              {t("automations.noTimezones")}
            </Command.Empty>
            <Command.Group>
              {options.map((zone) => (
                <Command.Item
                  key={zone}
                  value={zone}
                  keywords={[zone.replaceAll("_", " ")]}
                  className="flex min-h-8 cursor-default items-center justify-between gap-2 rounded-md px-2 text-sm data-[selected=true]:bg-control-focus"
                  onSelect={() => {
                    onChange(zone);
                    setOpen(false);
                  }}
                >
                  <span className="truncate">{zone}</span>
                  {zone === value && (
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

export function AutomationScheduleFields({
  schedule,
  onChange,
  disabled,
}: {
  schedule: ScheduleDraft;
  onChange: (patch: Partial<ScheduleDraft>) => void;
  disabled: boolean;
}) {
  const { t } = useTranslation();
  const { frequency } = schedule;
  const selectProps = { disabled };
  return (
    <>
      <ToggleRow
        {...selectProps}
        label={t("automations.frequency")}
        stacked
        value={frequency}
        onChange={(frequency) => onChange({ frequency })}
        options={frequencies.map((id) => ({
          id,
          label: t("automations.frequency." + id),
        }))}
      />
      {frequency === "once" && (
        <FormRow id="automation-date" label={t("automations.date")}>
          <Input
            id="automation-date"
            type="date"
            value={schedule.date}
            onChange={(event) => onChange({ date: event.target.value })}
            required
          />
        </FormRow>
      )}
      {frequency === "weekly" && (
        <FormRow
          labelId="automation-days-label"
          label={t("automations.days")}
          stacked
        >
          <ToggleGroup
            {...selectProps}
            aria-labelledby="automation-days-label"
            type="multiple"
            variant="outline"
            spacing={1}
            className="grid w-full max-w-xs grid-cols-7"
            value={schedule.days.map(String)}
            onValueChange={(days) => onChange({ days: days.map(Number) })}
          >
            {weekdayOrder.map((day) => (
              <ToggleGroupItem
                className="min-w-0 px-1"
                key={day}
                value={String(day)}
              >
                {t("automations.weekday." + day)}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </FormRow>
      )}
      {frequency === "monthly" && (
        <FormRow
          id="automation-month-day"
          label={t("automations.dayOfMonth")}
          description={
            schedule.dayOfMonth > 28
              ? t("automations.skipMissingDays")
              : undefined
          }
        >
          <Choice
            {...selectProps}
            compact
            id="automation-month-day"
            value={String(schedule.dayOfMonth)}
            onChange={(day) => onChange({ dayOfMonth: Number(day) })}
            options={monthDays}
          />
        </FormRow>
      )}
      {frequency === "interval" ? (
        <FormRow id="automation-interval" label={t("automations.interval")}>
          <div className="automation-interval-controls">
            <Input
              id="automation-interval"
              className="automation-count"
              type="number"
              min={1}
              max={maxIntervalMinutes / minutesPerUnit[schedule.intervalUnit]}
              value={schedule.intervalAmount}
              onChange={(event) =>
                onChange({ intervalAmount: event.target.value })
              }
              required
            />
            <ToggleChoices
              {...selectProps}
              label={t("automations.intervalUnit")}
              value={schedule.intervalUnit}
              onChange={(intervalUnit) => onChange({ intervalUnit })}
              options={intervalUnits.map((id) => ({
                id,
                label: t("automations.unit." + id),
              }))}
            />
          </div>
        </FormRow>
      ) : (
        <>
          <FormRow id="automation-time" label={t("automations.time")}>
            <AutomationTimePicker
              disabled={disabled}
              value={schedule.time}
              onChange={(time) => onChange({ time })}
            />
          </FormRow>
          <FormRow id="automation-zone" label={t("automations.timezone")}>
            <TimeZonePicker
              disabled={disabled}
              value={schedule.zone}
              onChange={(zone) => onChange({ zone })}
            />
          </FormRow>
        </>
      )}
    </>
  );
}
