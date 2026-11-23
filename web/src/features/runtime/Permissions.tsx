import { useId } from "react";
import type { TFunction } from "i18next";
import {
  ChevronDown,
  ClipboardList,
  Eye,
  LoaderCircle,
  LockKeyhole,
  PencilLine,
  Shield,
  ShieldAlert,
  ShieldCheck,
  ShieldQuestionMark,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import type { PermissionInfo } from "@/api/types.gen";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldLabel,
  FieldTitle,
} from "@/components/ui/field";
import { InputGroupButton } from "@/components/ui/input-group";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";

type PermissionProps = {
  providerType?: string;
  permissions?: PermissionInfo[];
  legacyPermissions?: PermissionInfo[];
  value: string;
  onChange: (value: string) => void;
};

export function permissionLabel(
  t: TFunction,
  providerType: string | undefined,
  id: string,
  name?: string,
) {
  return id
    ? t(`permissions.${providerType}.${id}`, { defaultValue: name || id })
    : t("permissions.default");
}

function permissionDetail(
  t: TFunction,
  providerType: string | undefined,
  { id, description }: PermissionInfo,
) {
  return t(`permissions.${providerType}.${id}.detail`, {
    defaultValue: description || "",
  });
}

export function PermissionOptions({
  providerType,
  permissions = [],
  legacyPermissions = [],
  value,
  onChange,
}: PermissionProps) {
  const { t } = useTranslation();
  const id = useId();
  const missing = value && !permissions.some((option) => option.id === value);
  const saved = legacyPermissions.find((option) => option.id === value);
  return (
    <Field>
      <FieldTitle id={id} title={t("profile.permissionHint")}>
        {t("profile.permission")}
      </FieldTitle>
      {permissions.length > 0 ? (
        <RadioGroup aria-labelledby={id} value={value} onValueChange={onChange}>
          {permissions.map((option, index) => {
            const optionId = `${id}-${index}`;
            const detail = permissionDetail(t, providerType, option);
            return (
              <Field key={option.id} orientation="horizontal">
                <RadioGroupItem
                  id={optionId}
                  value={option.id}
                  aria-describedby={detail ? `${optionId}-detail` : undefined}
                />
                <FieldContent className="min-w-0">
                  <FieldLabel htmlFor={optionId}>
                    {permissionLabel(t, providerType, option.id, option.name)}
                  </FieldLabel>
                  {detail && (
                    <FieldDescription
                      id={`${optionId}-detail`}
                      className="text-xs"
                    >
                      {detail}
                    </FieldDescription>
                  )}
                </FieldContent>
              </Field>
            );
          })}
        </RadioGroup>
      ) : (
        !value && (
          <FieldDescription>{t("permissions.default")}</FieldDescription>
        )
      )}
      {missing && (
        <FieldDescription>
          {t("permissions.saved", {
            mode: permissionLabel(t, providerType, value, saved?.name),
          })}
        </FieldDescription>
      )}
    </Field>
  );
}

const neutral = { icon: Shield, tone: "stroke-muted-foreground" };
const ask = {
  icon: ShieldQuestionMark,
  tone: "stroke-amber-700 dark:stroke-amber-400",
};
const edit = {
  icon: PencilLine,
  tone: "stroke-emerald-700 dark:stroke-emerald-400",
};
const fullAccess = { icon: ShieldAlert, tone: "stroke-destructive" };
const appearance = new Map<string, typeof neutral>([
  ["ask", ask],
  ["request_review", { ...ask, icon: Eye }],
  ["auto", { ...edit, icon: ShieldCheck }],
  ["read_only", { ...neutral, icon: LockKeyhole }],
  ["full_access", fullAccess],
  ["bypass_permissions", fullAccess],
  ["plan", { ...neutral, icon: ClipboardList }],
  ["accept_edits", edit],
  ["workspace_edit", edit],
]);

function permissionAppearance(option?: PermissionInfo) {
  if (!option) return neutral;
  if (option.mode) return appearance.get(option.mode) ?? neutral;
  // ACP IDs are runtime-defined. A recognizable label can describe an opaque
  // ID such as "default" for display without mapping it across providers.
  const key = (text: string) => text.toLowerCase().replace(/[\s-]+/g, "_");
  return (
    appearance.get(key(option.id)) ??
    appearance.get(key(option.name)) ??
    neutral
  );
}

export function PermissionMenu({
  providerType,
  permissions = [],
  legacyPermissions = [],
  value,
  onChange,
  disabled,
  pending,
  nextTurn,
  activeValue,
  autoApproving,
  showLabel,
  compact,
  side = "top",
  align = "end",
  className,
  id,
}: PermissionProps & {
  disabled?: boolean;
  pending?: boolean;
  nextTurn: boolean;
  activeValue?: string;
  autoApproving?: boolean;
  showLabel?: boolean;
  compact?: boolean;
  side?: "top" | "bottom";
  align?: "start" | "center" | "end";
  className?: string;
  id?: string;
}) {
  const { t } = useTranslation();
  if (!permissions.length) return null;

  const displayed = activeValue || value;
  const selected =
    permissions.find((option) => option.id === displayed) ??
    legacyPermissions.find((option) => option.id === displayed);
  const label = t("profile.permission");
  const current = permissionLabel(t, providerType, displayed, selected?.name);
  const status = autoApproving
    ? `${current} · ${t("permissions.allowRun")}`
    : current;
  const { icon: CurrentIcon, tone } = autoApproving
    ? fullAccess
    : permissionAppearance(selected);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        {showLabel ? (
          <Button
            id={id}
            type="button"
            variant="outline"
            size={compact ? "xs" : "sm"}
            disabled={disabled || pending}
            aria-label={`${label} · ${status}`}
            title={`${label} · ${status}`}
            className={className}
          >
            {pending ? (
              <LoaderCircle
                className="size-3.5 animate-spin text-muted-foreground"
                aria-hidden="true"
              />
            ) : (
              <CurrentIcon className={`size-3.5 ${tone}`} aria-hidden="true" />
            )}
            <span className="truncate">{current}</span>
            <ChevronDown
              className="size-3 text-muted-foreground"
              aria-hidden="true"
            />
          </Button>
        ) : (
          <InputGroupButton
            id={id}
            variant="ghost"
            size="icon-sm"
            disabled={disabled || pending}
            aria-label={`${label} · ${status}`}
            title={`${label} · ${status}`}
            className={className}
          >
            {pending ? (
              <LoaderCircle
                className="animate-spin text-muted-foreground"
                aria-hidden="true"
              />
            ) : (
              <CurrentIcon className={tone} aria-hidden="true" />
            )}
          </InputGroupButton>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent
        aria-label={label}
        side={side}
        align={align}
        sideOffset={8}
        collisionPadding={12}
        className="w-72 max-w-[calc(100vw-24px)]"
      >
        <DropdownMenuRadioGroup
          value={value}
          onValueChange={(next) => {
            if (next !== value) onChange(next);
          }}
        >
          {permissions.map((option) => {
            const { id, name } = option;
            const label = permissionLabel(t, providerType, id, name);
            const { icon: Icon, tone } = permissionAppearance(option);
            const detail = permissionDetail(t, providerType, option);
            return (
              <DropdownMenuRadioItem
                key={id}
                value={id}
                textValue={label}
                title={
                  activeValue && option.nextTurnOnly
                    ? t("permissions.nextTurn")
                    : undefined
                }
                className="items-start gap-2 py-1.5"
              >
                <Icon className={`mt-0.5 ${tone}`} aria-hidden="true" />
                <span className="min-w-0 wrap-break-word">
                  {label}
                  {detail && (
                    <span className="block text-xs text-muted-foreground">
                      {detail}
                    </span>
                  )}
                </span>
              </DropdownMenuRadioItem>
            );
          })}
        </DropdownMenuRadioGroup>
        {nextTurn && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="font-normal">
              {activeValue && activeValue !== value
                ? t("permissions.currentAndNext", { mode: current })
                : t("permissions.nextTurn")}
            </DropdownMenuLabel>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
