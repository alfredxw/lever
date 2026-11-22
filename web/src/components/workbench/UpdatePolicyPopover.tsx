import { useId } from "react";
import { ChevronDown, RefreshCw } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { UpdateSettings } from "@/api/types.gen";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";

const modes: UpdateSettings["mode"][] = ["auto", "notify", "manual"];
const intervals: UpdateSettings["interval"][] = ["1h", "6h", "24h"];

export function UpdatePolicyPopover({
  settings,
  hint,
  pending,
  checking,
  onSave,
  onCheckAll,
  hasSources = true,
  compactLabel = false,
}: {
  settings: UpdateSettings;
  hint: string;
  pending?: boolean;
  checking?: boolean;
  onSave: (next: UpdateSettings) => void;
  onCheckAll?: () => void;
  hasSources?: boolean;
  compactLabel?: boolean;
}) {
  const { t } = useTranslation();
  const modeId = useId();
  const intervalId = useId();

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="gap-1.5"
          aria-label={t("updates.policy")}
          title={t("updates.policy")}
        >
          <RefreshCw data-icon="inline-start" />
          <span className="truncate">
            {!compactLabel && `${t("updates.policy")} · `}
            {t(`updates.mode.${settings.mode}`)}
          </span>
          <ChevronDown
            className="size-3 text-muted-foreground"
            aria-hidden="true"
          />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        sideOffset={6}
        aria-label={t("updates.policy")}
        className="grid w-76 max-w-(--radix-popover-content-available-width) gap-3 p-3"
      >
        <div className="grid gap-1.5">
          <span id={modeId} className="text-xs font-medium text-foreground">
            {t("updates.mode")}
          </span>
          <ToggleGroup
            type="single"
            size="sm"
            variant="outline"
            spacing={0}
            className="w-full"
            aria-labelledby={modeId}
            disabled={pending}
            value={settings.mode}
            onValueChange={(value) => {
              if (value && value !== settings.mode) {
                onSave({ ...settings, mode: value as UpdateSettings["mode"] });
              }
            }}
          >
            {modes.map((mode) => (
              <ToggleGroupItem
                key={mode}
                value={mode}
                className="flex-1 text-xs"
              >
                {t(`updates.mode.${mode}`)}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
          <p className="text-xs leading-relaxed text-muted-foreground">
            {hint}
          </p>
        </div>
        {settings.mode !== "manual" && (
          <div className="grid gap-1.5">
            <span
              id={intervalId}
              className="text-xs font-medium text-foreground"
            >
              {t("updates.interval")}
            </span>
            <ToggleGroup
              type="single"
              size="sm"
              variant="outline"
              spacing={0}
              className="w-full"
              aria-labelledby={intervalId}
              disabled={pending}
              value={settings.interval}
              onValueChange={(value) => {
                if (value && value !== settings.interval) {
                  onSave({
                    ...settings,
                    interval: value as UpdateSettings["interval"],
                  });
                }
              }}
            >
              {intervals.map((interval) => (
                <ToggleGroupItem
                  key={interval}
                  value={interval}
                  className="flex-1 text-xs tabular-nums"
                >
                  {t(`updates.interval.${interval}`)}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </div>
        )}
        {onCheckAll && hasSources && (
          <Button
            variant="outline"
            size="sm"
            className="w-full justify-center"
            disabled={checking}
            onClick={onCheckAll}
          >
            <RefreshCw
              data-icon="inline-start"
              className={checking ? "animate-spin" : undefined}
            />
            {t("updates.checkAll")}
          </Button>
        )}
      </PopoverContent>
    </Popover>
  );
}
