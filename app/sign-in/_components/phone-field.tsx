import { Field, FieldLabel } from "@web/components/ui/field";
import { Input } from "@web/components/ui/input";

export function PhoneNumberField() {
  return (
    <Field className="gap-[0.35rem]">
      <FieldLabel
        className="type-field-label text-muted-foreground"
        htmlFor="phone-number"
      >
        Телефон
      </FieldLabel>
      <Input
        autoComplete="tel"
        id="phone-number"
        inputMode="tel"
        name="phone-number"
        placeholder="+7 999 123-45-67"
        required
        type="tel"
        variant="paper"
      />
    </Field>
  );
}
