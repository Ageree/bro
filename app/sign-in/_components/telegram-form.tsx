"use client";

import { useMutation } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import type { SubmitEvent } from "react";
import * as z from "zod";
import { authClient } from "@web/auth/client";
import { formValue } from "@app/sign-in/_lib/phone-auth";
import { Button } from "@web/components/ui/button";
import {
  Field,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@web/components/ui/field";
import { Input } from "@web/components/ui/input";

const startedSchema = z.object({
  token: z.string().min(1),
  url: z.url().startsWith("https://t.me/"),
});
const refusalSchema = z.object({
  code: z.string().startsWith("TELEGRAM_"),
  message: z.string().min(1),
});
const startFailedMessage =
  "Не вышло начать вход через Telegram. Попробуй ещё раз.";
const verifyFailedMessage = "Не вышло войти. Попробуй ещё раз.";

/**
 * Signing in through Bro's Telegram bot (`telegramLogin`): the bot link
 * opens the chat with `/start login_<token>`, the bot answers with a code,
 * and the code typed here signs this browser in. The link opens Telegram in
 * a new tab or the app, so this page keeps its state for the code.
 */
export function TelegramAuthForm({
  callbackUrl,
}: {
  readonly callbackUrl: string;
}) {
  const start = useMutation({
    mutationFn: async () => {
      const answer = await authClient
        .$fetch("/telegram-login/start", { method: "POST" })
        .catch(() => {
          throw new Error(startFailedMessage);
        });
      const started = startedSchema.safeParse(answer.data);
      if (!started.success) {
        throw new Error(
          refusalSchema.safeParse(answer.error).data?.message ??
            startFailedMessage
        );
      }
      return started.data;
    },
  });

  if (start.isSuccess) {
    return (
      <TelegramCodeForm
        callbackUrl={callbackUrl}
        onRestart={start.reset}
        token={start.data.token}
        url={start.data.url}
      />
    );
  }

  return (
    <FieldGroup className="mt-5 gap-4">
      <FieldError
        className="type-fine"
        errors={start.error ? [start.error] : undefined}
      />
      <Button
        className="w-full"
        disabled={start.isPending}
        onClick={() => {
          start.mutate();
        }}
        type="button"
        variant="paper"
      >
        {start.isPending ? "Готовим вход…" : "Войти через Telegram"}
      </Button>
    </FieldGroup>
  );
}

function TelegramCodeForm({
  callbackUrl,
  onRestart,
  token,
  url,
}: {
  readonly callbackUrl: string;
  readonly onRestart: () => void;
  readonly token: string;
  readonly url: string;
}) {
  const router = useRouter();
  const verify = useMutation({
    mutationFn: async (code: string) => {
      if (!/^\d{6}$/u.test(code)) {
        throw new Error("Введи код из шести цифр.");
      }
      const answer = await authClient
        .$fetch("/telegram-login/verify", {
          body: { code, token },
          method: "POST",
        })
        .catch(() => {
          throw new Error(verifyFailedMessage);
        });
      if (answer.error) {
        throw new Error(
          refusalSchema.safeParse(answer.error).data?.message ??
            verifyFailedMessage
        );
      }
    },
    onSuccess: () => {
      router.replace(callbackUrl);
      router.refresh();
    },
  });

  function submit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    verify.mutate(formValue(event.currentTarget, "code").trim());
  }

  return (
    <form
      className="mt-5"
      onSubmit={(event) => {
        submit(event);
      }}
    >
      <FieldGroup className="gap-4">
        <p className="type-fine text-muted-foreground">
          Открой Bro в Telegram и нажми «Старт» — бот пришлёт код. Введи его
          здесь.
        </p>
        <Button
          className="w-full"
          nativeButton={false}
          render={
            <a
              aria-label="Открыть Telegram"
              href={url}
              rel="noreferrer"
              target="_blank"
            />
          }
          variant="paper"
        >
          Открыть Telegram
        </Button>
        <Field className="gap-[0.35rem]">
          <FieldLabel
            className="type-field-label text-muted-foreground"
            htmlFor="code"
          >
            Код из Telegram
          </FieldLabel>
          <Input
            autoComplete="one-time-code"
            id="code"
            inputMode="numeric"
            maxLength={6}
            name="code"
            pattern="[0-9]{6}"
            required
            variant="paper"
          />
        </Field>
        <FieldError
          className="type-fine"
          errors={verify.error ? [verify.error] : undefined}
        />
        <Button
          className="w-full"
          disabled={verify.isPending}
          type="submit"
          variant="outline"
        >
          {verify.isPending ? "Проверяем…" : "Войти"}
        </Button>
        <Button
          className="w-full"
          disabled={verify.isPending}
          onClick={onRestart}
          size="paper"
          type="button"
          variant="act"
        >
          Начать заново
        </Button>
      </FieldGroup>
    </form>
  );
}
