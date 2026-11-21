import { useId, type ReactNode } from "react";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldTitle,
} from "@/components/ui/field";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";

export function SettingsGroup({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <section className="settings-section" aria-labelledby={id}>
      <h3 id={id}>{title}</h3>
      <FieldGroup className="settings-group panel-surface">
        {children}
      </FieldGroup>
    </section>
  );
}

export function SettingsRow({
  id,
  labelId,
  title,
  description,
  children,
}: {
  id?: string;
  labelId?: string;
  title: ReactNode;
  description?: string;
  children: ReactNode;
}) {
  const descriptionId = id ?? labelId;
  return (
    <Field className="settings-row" orientation="responsive">
      <FieldContent>
        {id ? (
          <FieldLabel htmlFor={id}>{title}</FieldLabel>
        ) : (
          <FieldTitle id={labelId}>{title}</FieldTitle>
        )}
        {description && (
          <FieldDescription
            id={descriptionId ? `${descriptionId}-description` : undefined}
          >
            {description}
          </FieldDescription>
        )}
      </FieldContent>
      <div className="settings-control">{children}</div>
    </Field>
  );
}

export function SettingsChoiceRow({
  title,
  description,
  value,
  onChange,
  options,
  disabled,
}: {
  title: string;
  description?: string;
  value: string;
  onChange: (value: string) => void;
  options: readonly { value: string; label: string }[];
  disabled?: boolean;
}) {
  const labelId = useId();
  return (
    <SettingsRow title={title} description={description} labelId={labelId}>
      <ToggleGroup
        type="single"
        variant="outline"
        spacing={1}
        className="max-w-full flex-wrap"
        aria-labelledby={labelId}
        aria-describedby={description ? `${labelId}-description` : undefined}
        value={value}
        disabled={disabled}
        onValueChange={(next) => {
          if (next) onChange(next);
        }}
      >
        {options.map((option) => (
          <ToggleGroupItem key={option.value} value={option.value}>
            {option.label}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
    </SettingsRow>
  );
}
