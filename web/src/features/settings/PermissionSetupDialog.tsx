import { useId, useState } from "react";
import { RadioGroup as RadioGroupPrimitive } from "radix-ui";
import { Check, ShieldAlert, ShieldCheck } from "lucide-react";
import { useTranslation } from "react-i18next";
import { ErrorNotice } from "@/components/common";
import { Badge } from "@/components/ui/badge";
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
  useSavePermissionSettings,
  type DefaultPermissionPreset,
} from "@/features/runtime/permissionSettings";
import { cn } from "@/lib/utils";

const options: readonly {
  value: DefaultPermissionPreset;
  icon: typeof ShieldCheck;
  iconTone: string;
  recommended?: boolean;
}[] = [
  {
    value: "auto",
    icon: ShieldCheck,
    iconTone: "stroke-emerald-700 dark:stroke-emerald-400",
    recommended: true,
  },
  {
    value: "yolo",
    icon: ShieldAlert,
    iconTone: "stroke-destructive",
  },
];

export function PermissionSetupDialog({ open }: { open: boolean }) {
  const { t } = useTranslation();
  const [selected, setSelected] = useState<DefaultPermissionPreset>("auto");
  const titleId = useId();
  const descriptionId = useId();
  const save = useSavePermissionSettings();

  function commit(mode: DefaultPermissionPreset) {
    if (save.isPending) return;
    save.mutate({ defaultMode: mode });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) commit("auto");
      }}
    >
      <DialogContent
        className="sm:max-w-lg"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
      >
        <DialogHeader>
          <DialogTitle id={titleId}>{t("permissionSetup.title")}</DialogTitle>
          <DialogDescription id={descriptionId}>
            {t("permissionSetup.description")}
          </DialogDescription>
        </DialogHeader>

        <RadioGroupPrimitive.Root
          className="grid gap-2.5"
          aria-labelledby={titleId}
          value={selected}
          disabled={save.isPending}
          onValueChange={(value) => {
            if (value === "auto" || value === "yolo") setSelected(value);
          }}
        >
          {options.map(({ value, icon: Icon, iconTone, recommended }) => {
            const active = selected === value;
            return (
              <RadioGroupPrimitive.Item
                key={value}
                value={value}
                className={cn(
                  "flex w-full cursor-pointer items-start gap-3 rounded-xl border p-3.5 text-left transition-colors outline-none",
                  active
                    ? "border-foreground/25 bg-control-hover"
                    : "border-border bg-transparent hover:bg-control-hover/60",
                  "focus-visible:bg-control-focus disabled:cursor-not-allowed disabled:opacity-60",
                )}
              >
                <Icon
                  className={cn("mt-0.5 size-4 shrink-0", iconTone)}
                  aria-hidden="true"
                />
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-semibold text-foreground">
                      {t(`settings.defaultPermissionMode.${value}`)}
                    </span>
                    {recommended && (
                      <Badge
                        variant="outline"
                        className="h-5 px-1.5 text-[11px] font-medium text-muted-foreground"
                      >
                        {t("permissionSetup.recommended")}
                      </Badge>
                    )}
                  </div>
                  <p className="text-[length:var(--text-control)] leading-snug text-foreground/90">
                    {t(`permissionSetup.${value}.summary`)}
                  </p>
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    {t(`permissionSetup.${value}.mapping`)}
                  </p>
                </div>
                <span
                  aria-hidden="true"
                  className={cn(
                    "mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border transition-colors",
                    active
                      ? "border-primary bg-primary text-primary-foreground"
                      : "border-input bg-transparent",
                  )}
                >
                  {active && <Check className="size-2.5" strokeWidth={3} />}
                </span>
              </RadioGroupPrimitive.Item>
            );
          })}
        </RadioGroupPrimitive.Root>

        {save.error && <ErrorNotice error={save.error} />}

        <DialogFooter className="sm:items-center sm:justify-between">
          <span className="text-xs text-muted-foreground">
            {t("permissionSetup.settingsHint")}
          </span>
          <Button
            type="button"
            disabled={save.isPending}
            onClick={() => commit(selected)}
          >
            {t("permissionSetup.confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
