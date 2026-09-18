"use client";

import { useMutation } from "@tanstack/react-query";
import { z } from "zod";
import { Button } from "@web/components/ui/button";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@web/components/ui/field";
import { Input } from "@web/components/ui/input";

/** Shown when the endpoint answers with something other than its own text. */
const accessFallbackMessage =
  "Не получилось связаться с сервером. Попробуй ещё раз.";

const formValueSchema = z.string().catch("");

const accessResponseSchema = z.object({
  assignedPhoneNumber: z.string().min(1).optional(),
  message: z.string().min(1).optional(),
});

/**
 * iOS wants `&body=` after an `sms:` address, not the `?body=` a URL would
 * take: with a question mark Messages opens an empty draft.
 */
export function imessageLink(assignedPhoneNumber: string) {
  return `sms:${assignedPhoneNumber}&body=${encodeURIComponent("Привет")}`;
}

async function requestAccess(phoneNumber: string) {
  const response = await fetch("/api/access", {
    body: JSON.stringify({ phoneNumber }),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  const body = accessResponseSchema.safeParse(
    await response.json().catch(() => undefined)
  );
  const parsed = body.success ? body.data : undefined;
  if (response.ok && parsed?.assignedPhoneNumber) {
    return parsed.assignedPhoneNumber;
  }
  throw new Error(parsed?.message ?? accessFallbackMessage);
}

export function AccessForm() {
  const access = useMutation({ mutationFn: requestAccess });
  const copyNumber = useMutation({
    mutationFn: (value: string) => navigator.clipboard.writeText(value),
  });
  const assignedPhoneNumber = access.data;

  if (assignedPhoneNumber) {
    return (
      <section
        aria-labelledby="access-ready-heading"
        className="space-y-4 rounded-xl bg-card p-5 ring-1 ring-foreground/10"
      >
        <div className="space-y-1">
          <h2 className="type-label" id="access-ready-heading">
            Твой Бро ждёт на этом номере
          </h2>
          <p className="type-banner-metric type-numeric">
            {assignedPhoneNumber}
          </p>
        </div>
        <Button
          className="w-full"
          nativeButton={false}
          render={
            <a
              aria-label="Написать Бро в iMessage"
              href={imessageLink(assignedPhoneNumber)}
            />
          }
          size="lg"
        >
          Написать Бро
        </Button>
        <Button
          className="w-full"
          onClick={() => {
            copyNumber.mutate(assignedPhoneNumber);
          }}
          size="lg"
          variant="outline"
        >
          {copyNumber.isSuccess ? "Номер скопирован" : "Скопировать номер"}
        </Button>
        <p className="type-caption text-muted-foreground">
          Первое сообщение создаёт твой аккаунт. Если сейчас ты не на iPhone —
          открой эту страницу на нём или сохрани номер: Бро отвечает только в
          iMessage.
        </p>
      </section>
    );
  }

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        access.mutate(
          formValueSchema.parse(
            new FormData(event.currentTarget).get("phone-number")
          )
        );
      }}
    >
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="phone-number">Твой номер телефона</FieldLabel>
          <Input
            autoComplete="tel"
            id="phone-number"
            inputMode="tel"
            name="phone-number"
            placeholder="+7 999 123-45-67"
            required
            size="xl"
            type="tel"
          />
          <FieldDescription>
            Только синий iMessage; SMS не подойдёт.
          </FieldDescription>
        </Field>
        <FieldError errors={access.error ? [access.error] : undefined} />
        <Button
          className="w-full"
          disabled={access.isPending}
          size="lg"
          type="submit"
        >
          {access.isPending ? "Выдаём номер…" : "Получить своего Бро"}
        </Button>
      </FieldGroup>
    </form>
  );
}
