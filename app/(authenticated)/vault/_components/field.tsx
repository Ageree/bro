"use client";

import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from "@web/components/ui/field";
import { Input } from "@web/components/ui/input";

export function FormField({
  error,
  description,
  id,
  label,
  onChange,
  ...inputProps
}: Omit<React.ComponentProps<typeof Input>, "onChange" | "variant"> & {
  readonly description?: string;
  readonly error?: string;
  readonly label: string;
  readonly onChange: (value: string) => void;
}) {
  return (
    <Field data-invalid={error ? true : undefined}>
      <FieldLabel
        className="type-field-label text-muted-foreground"
        htmlFor={id}
      >
        {label}
      </FieldLabel>
      <Input
        {...inputProps}
        aria-invalid={error ? true : undefined}
        id={id}
        onChange={(event) => {
          onChange(event.target.value);
        }}
        variant="paper"
      />
      {description ? (
        <FieldDescription className="type-fine">{description}</FieldDescription>
      ) : null}
      <FieldError
        className="type-fine"
        errors={error ? [{ message: error }] : undefined}
      />
    </Field>
  );
}
