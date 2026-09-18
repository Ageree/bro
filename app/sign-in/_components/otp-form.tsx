"use client";

import { useMutation } from "@tanstack/react-query";
import { MessageSquareIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import type { SubmitEvent } from "react";
import { authClient } from "@web/auth/client";
import { formValue, verifyPhoneNumber } from "@app/sign-in/_lib/phone-auth";
import { normalizeAuthPhoneNumber } from "@shared/identity/phone-number";
import { Alert, AlertDescription, AlertTitle } from "@web/components/ui/alert";
import { Button } from "@web/components/ui/button";
import {
  Field,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@web/components/ui/field";
import { Input } from "@web/components/ui/input";
import { PhoneNumberField } from "./phone-field";

export function PhoneOtpAuthForm({
  callbackUrl,
  imessagePhoneNumber,
}: {
  readonly callbackUrl: string;
  readonly imessagePhoneNumber?: string;
}) {
  const sendOtp = useMutation({
    mutationFn: async (phoneNumberValue: string) => {
      const phoneNumber = normalizeAuthPhoneNumber(phoneNumberValue);
      if (!phoneNumber) throw new Error("Enter a valid phone number.");

      const result = await authClient.phoneNumber
        .sendOtp({ phoneNumber })
        .catch(() => {
          throw new Error("Unable to send a code. Please try again.");
        });
      if (result.error) throw new Error(phoneOtpErrorMessage(result.error));
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
      <IMessageCodeNotice phoneNumber={imessagePhoneNumber} />
      <form
        className="mt-4"
        onSubmit={(event) => {
          submit(event);
        }}
      >
        <FieldGroup>
          <PhoneNumberField />
          <FieldError errors={sendOtp.error ? [sendOtp.error] : undefined} />
          <Button className="w-full" disabled={sendOtp.isPending} type="submit">
            {sendOtp.isPending ? "Sending…" : "Send code"}
          </Button>
        </FieldGroup>
      </form>
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
        throw new Error("Enter the six-digit code.");
      }

      await verifyPhoneNumber({
        code,
        errorMessage:
          "That code could not be verified. Request a new code and try again.",
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
      className="mt-6"
      onSubmit={(event) => {
        submit(event);
      }}
    >
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="code">Verification Code</FieldLabel>
          <Input
            autoComplete="one-time-code"
            id="code"
            inputMode="numeric"
            maxLength={6}
            name="code"
            pattern="[0-9]{6}"
            required
          />
        </Field>
        <FieldError
          errors={verifyCode.error ? [verifyCode.error] : undefined}
        />
        <Button
          className="w-full"
          disabled={verifyCode.isPending}
          type="submit"
        >
          {verifyCode.isPending ? "Verifying…" : "Verify code"}
        </Button>
        <Button
          className="w-full"
          disabled={verifyCode.isPending}
          onClick={onUseDifferentNumber}
          type="button"
          variant="ghost"
        >
          Use a different number
        </Button>
      </FieldGroup>
    </form>
  );
}

function IMessageCodeNotice({
  phoneNumber,
}: {
  readonly phoneNumber?: string;
}) {
  return (
    <Alert className="mt-6" variant="information">
      <MessageSquareIcon />
      <AlertTitle>Your code arrives by iMessage</AlertTitle>
      <AlertDescription>
        <p>
          Enter a phone number that can receive iMessage, then open Messages to
          read the code.
        </p>
        {phoneNumber ? (
          <Button
            className="mt-3 w-full"
            nativeButton={false}
            render={
              <a aria-label="Open Messages" href={`sms:${phoneNumber}`} />
            }
            variant="outline"
          >
            Open Messages
          </Button>
        ) : (
          <p className="mt-2">
            The code comes from the iMessage number of this deployment.
          </p>
        )}
      </AlertDescription>
    </Alert>
  );
}

export function phoneOtpErrorMessage(error: {
  readonly code?: string;
  readonly message?: string;
}) {
  return error.code?.startsWith("IMESSAGE_") && error.message
    ? error.message
    : "Unable to send a code. Please try again.";
}
