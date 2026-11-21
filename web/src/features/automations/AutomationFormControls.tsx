import { useId, type ComponentProps, type ReactNode } from "react";
import {
  Field,
  FieldDescription,
  FieldLabel,
  FieldTitle,
} from "@/components/ui/field";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";

export function FormRow({
  id,
  labelId,
  label,
  description,
  stacked,
  children,
}: {
  id?: string;
  labelId?: string;
  label: string;
  description?: string;
  stacked?: boolean;
  children: ReactNode;
}) {
  return (
    <Field
      orientation="horizontal"
      className="automation-form-row"
      data-stacked={stacked || undefined}
    >
      {id ? (
        <FieldLabel htmlFor={id}>{label}</FieldLabel>
      ) : (
        <FieldTitle id={labelId}>{label}</FieldTitle>
      )}
      <div className="automation-form-value">{children}</div>
      {description && (
        <FieldDescription className="automation-row-description">
          {description}
        </FieldDescription>
      )}
    </Field>
  );
}

type ChoiceOption<T extends string = string> = {
  id: T;
  label: ReactNode;
  disabled?: boolean;
};

export function ToggleChoices<T extends string>({
  label,
  labelId,
  value,
  onChange,
  options,
  disabled,
}: {
  label?: string;
  labelId?: string;
  value: T;
  onChange: (value: T) => void;
  options: ChoiceOption<T>[];
  disabled?: boolean;
}) {
  return (
    <ToggleGroup
      type="single"
      variant="outline"
      spacing={1}
      className="automation-toggle-options"
      aria-label={label}
      aria-labelledby={labelId}
      value={value}
      disabled={disabled}
      onValueChange={(id) => {
        const option = options.find((item) => item.id === id);
        if (option) onChange(option.id);
      }}
    >
      {options.map((option) => (
        <ToggleGroupItem
          key={option.id}
          value={option.id}
          disabled={option.disabled}
        >
          {option.label}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}

export function ToggleRow<T extends string>({
  label,
  stacked,
  ...choice
}: Omit<ComponentProps<typeof ToggleChoices<T>>, "label" | "labelId"> & {
  label: string;
  stacked?: boolean;
}) {
  const labelId = useId();
  return (
    <FormRow labelId={labelId} label={label} stacked={stacked}>
      <ToggleChoices {...choice} labelId={labelId} />
    </FormRow>
  );
}

export function Choice({
  id,
  value,
  onChange,
  options,
  placeholder,
  disabled,
  compact,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  options: ChoiceOption[];
  placeholder?: string;
  disabled?: boolean;
  compact?: boolean;
}) {
  return (
    <Select value={value} onValueChange={onChange} disabled={disabled}>
      <SelectTrigger id={id} className="automation-choice">
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent
        position="popper"
        align="end"
        className={compact ? "min-w-20" : undefined}
      >
        <SelectGroup>
          {options.map((option) => (
            <SelectItem
              key={option.id}
              value={option.id}
              disabled={option.disabled}
            >
              {option.label}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}
