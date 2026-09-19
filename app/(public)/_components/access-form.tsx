"use client";

import { useMutation } from "@tanstack/react-query";
import { z } from "zod";
import { Button } from "@web/components/ui/button";
import {
  Field,
  FieldDescription,
  FieldError,
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
        className="mx-auto flex w-full max-w-[22rem] flex-col items-center gap-3"
      >
        <h2
          className="type-fine text-muted-foreground"
          id="access-ready-heading"
        >
          Твой бро ждёт на этом номере
        </h2>
        {/* A number is read character by character: machine strings get the
            gothic, words get the serif. */}
        <p className="type-numeric text-2xl font-medium tracking-[-0.02em]">
          {assignedPhoneNumber}
        </p>
        <Button
          className="type-cta"
          nativeButton={false}
          render={
            <a
              aria-label="Написать бро в iMessage"
              href={imessageLink(assignedPhoneNumber)}
            />
          }
          variant="act"
        >
          Написать бро
        </Button>
        <Button
          onClick={() => {
            copyNumber.mutate(assignedPhoneNumber);
          }}
          variant="act"
        >
          {copyNumber.isSuccess ? "Номер скопирован" : "Скопировать номер"}
        </Button>
        <p className="type-fine text-muted-foreground">
          Первое сообщение создаёт твой аккаунт. Если сейчас ты не на iPhone —
          открой эту страницу на нём или сохрани номер: бро отвечает только в
          iMessage.
        </p>
      </section>
    );
  }

  return (
    <form
      className="mx-auto flex w-full max-w-[22rem] flex-col items-center gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        access.mutate(
          formValueSchema.parse(
            new FormData(event.currentTarget).get("phone-number")
          )
        );
      }}
    >
      <Field className="items-center text-center">
        <FieldLabel
          className="type-fine justify-center text-muted-foreground"
          htmlFor="phone-number"
        >
          Твой номер телефона
        </FieldLabel>
        <Input
          autoComplete="tel"
          className="text-center"
          id="phone-number"
          inputMode="tel"
          name="phone-number"
          placeholder="+7 999 123-45-67"
          required
          type="tel"
          variant="paper"
        />
        <FieldDescription className="type-fine text-center">
          Только синий iMessage; SMS не подойдёт.
        </FieldDescription>
      </Field>
      <FieldError
        className="type-fine"
        errors={access.error ? [access.error] : undefined}
      />
      <Button
        className="type-cta"
        disabled={access.isPending}
        type="submit"
        variant="act"
      >
        {access.isPending ? "Выдаём номер…" : "Получить своего бро"}
      </Button>
    </form>
  );
}
