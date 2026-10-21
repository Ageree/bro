"use client";

import { useMutation } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import type { SubmitEvent } from "react";
import * as z from "zod";
import { authClient } from "@web/auth/client";
import { formValue, verifyPhoneNumber } from "@app/sign-in/_lib/phone-auth";
import {
  isE164PhoneNumber,
  normalizeAuthPhoneNumber,
} from "@shared/identity/phone-number";
import { Button } from "@web/components/ui/button";
import {
  Field,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@web/components/ui/field";
import { Input } from "@web/components/ui/input";
import { PhoneNumberField } from "./phone-field";

/** A refused code that a message to the named line would let through. */
class SendCodeError extends Error {
  readonly line: string | undefined;

  constructor(message: string, line?: string) {
    super(message);
    this.name = "SendCodeError";
    this.line = line;
  }
}

const sendCodeFallbackMessage = "Не вышло отправить код. Попробуй ещё раз.";
const codeLimitMessage = "Слишком много кодов подряд. Попробуй через 10 минут.";

export function PhoneOtpAuthForm({
  callbackUrl,
}: {
  readonly callbackUrl: string;
}) {
  const sendOtp = useMutation({
    mutationFn: async (phoneNumberValue: string) => {
      const phoneNumber = normalizeAuthPhoneNumber(phoneNumberValue);
      if (!phoneNumber) throw new Error("Введи номер телефона.");

      const result = await authClient.phoneNumber
        .sendOtp({ phoneNumber })
        .catch(() => {
          throw new Error(sendCodeFallbackMessage);
        });
      if (result.error) {
        throw new SendCodeError(
          phoneOtpErrorMessage(result.error),
          writeFirstLine(result.error)
        );
      }
      return phoneNumber;
    },
  });

  function submit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    sendOtp.mutate(formValue(event.currentTarget, "phone-number"));
  }

  if (sendOtp.isSuccess) {
    return (
      <VerificationCodeForm
        callbackUrl={callbackUrl}
        onUseDifferentNumber={sendOtp.reset}
        phoneNumber={sendOtp.data}
      />
    );
  }

  return (
    <>
      <form
        className="mt-5"
        onSubmit={(event) => {
          submit(event);
        }}
      >
        <FieldGroup className="gap-4">
          <PhoneNumberField />
          <FieldError
            className="type-fine"
            errors={sendOtp.error ? [sendOtp.error] : undefined}
          />
          {sendOtp.error instanceof SendCodeError && sendOtp.error.line ? (
            <WriteBroFirst line={sendOtp.error.line} />
          ) : null}
          <Button
            className="w-full"
            disabled={sendOtp.isPending}
            type="submit"
            variant="paper"
          >
            {sendOtp.isPending ? "Отправляем…" : "Получить код"}
          </Button>
        </FieldGroup>
      </form>
      <IMessageCodeNotice />
    </>
  );
}

function VerificationCodeForm({
  callbackUrl,
  onUseDifferentNumber,
  phoneNumber,
}: {
  readonly callbackUrl: string;
  readonly onUseDifferentNumber: () => void;
  readonly phoneNumber: string;
}) {
  const router = useRouter();
  const verifyCode = useMutation({
    mutationFn: async (code: string) => {
      if (!/^\d{6}$/.test(code)) {
        throw new Error("Введи код из шести цифр.");
      }

      await verifyPhoneNumber({
        code,
        errorMessage: "Код не подошёл. Запроси новый и попробуй ещё раз.",
        phoneNumber,
      });
    },
    onSuccess: () => {
      router.replace(callbackUrl);
      router.refresh();
    },
  });

  function submit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    verifyCode.mutate(formValue(event.currentTarget, "code").trim());
  }

  return (
    <form
      className="mt-5"
      onSubmit={(event) => {
        submit(event);
      }}
    >
      <FieldGroup className="gap-4">
        {/* The number as it was sent: a typo shows here, not in a code
            that never comes. */}
        <p className="type-fine text-muted-foreground">
          Код отправлен в iMessage на {phoneNumber}.
        </p>
        <Field className="gap-[0.35rem]">
          <FieldLabel
            className="type-field-label text-muted-foreground"
            htmlFor="code"
          >
            Код
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
          errors={verifyCode.error ? [verifyCode.error] : undefined}
        />
        <Button
          className="w-full"
          disabled={verifyCode.isPending}
          type="submit"
          variant="paper"
        >
          {verifyCode.isPending ? "Проверяем…" : "Войти"}
        </Button>
        <Button
          className="w-full"
          disabled={verifyCode.isPending}
          onClick={onUseDifferentNumber}
          size="paper"
          type="button"
          variant="outline"
        >
          Другой номер
        </Button>
      </FieldGroup>
    </form>
  );
}

/**
 * The code comes from the iMessage line Photon picks (`adapter.openDM`), not
 * from `IMESSAGE_PHONE_NUMBER`, which is only a fallback and has named a stale
 * line: the sheet names no number. Before the first code the line answers a
 * newcomer «This number didn't recognize yours»: asking for a code puts the
 * phone into the Photon project (`photonLineFor`), and only then the line
 * Photon bound it to is named (`WriteBroFirst`).
 */
function IMessageCodeNotice() {
  return (
    <p className="type-status mt-4 text-center text-muted-foreground">
      Код придёт с iMessage-номера этого сервиса.
    </p>
  );
}

/**
 * A shared Photon line can refuse a phone that never wrote to it, even once
 * it is in the project: the person writes to the line the server named, then
 * asks again. Opens Messages on the phone they are signing in from.
 */
function WriteBroFirst({ line }: { readonly line: string }) {
  return (
    <Button
      className="w-full"
      nativeButton={false}
      render={<a aria-label="Написать Bro в iMessage" href={`sms:${line}`} />}
      size="paper"
      variant="outline"
    >
      Написать Bro в iMessage
    </Button>
  );
}

const writeFirstSchema = z.object({
  code: z.literal("IMESSAGE_WRITE_FIRST"),
  line: z.string().refine(isE164PhoneNumber),
});

/** The line to write to, when the server refused the code for want of it. */
export function writeFirstLine(error: {
  readonly code?: string;
  readonly line?: string;
}) {
  return writeFirstSchema.safeParse(error).data?.line;
}

export function phoneOtpErrorMessage(error: {
  readonly code?: string;
  readonly message?: string;
  readonly status?: number;
}) {
  // Bro's own limit (`db/services/auth/code-sends.ts`) and Better Auth's
  // per-address one, which answers 429 with no code.
  if (error.code === "IMESSAGE_CODE_LIMIT_REACHED" || error.status === 429) {
    return codeLimitMessage;
  }
  return error.code?.startsWith("IMESSAGE_") && error.message
    ? error.message
    : sendCodeFallbackMessage;
}
