"use client";

import { useMutation } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { formValue, verifyPhoneNumber } from "@app/sign-in/_lib/phone-auth";
import { normalizeAuthPhoneNumber } from "@shared/identity/phone-number";
import { Button } from "@web/components/ui/button";
import { FieldError, FieldGroup } from "@web/components/ui/field";
import { PhoneNumberField } from "./phone-field";

export function LocalPhoneAuthForm({
  callbackUrl,
}: {
  readonly callbackUrl: string;
}) {
  const router = useRouter();
  const signIn = useMutation({
    mutationFn: async (phoneNumberValue: string) => {
      const phoneNumber = normalizeAuthPhoneNumber(phoneNumberValue);
      if (!phoneNumber) throw new Error("Введи номер телефона.");

      await verifyPhoneNumber({
        code: "000000",
        errorMessage: "Не вышло войти. Попробуй ещё раз.",
        phoneNumber,
      });
    },
    onSuccess: () => {
      router.replace(callbackUrl);
      router.refresh();
    },
  });

  return (
    <form
      className="mt-[0.9rem]"
      onSubmit={(event) => {
        event.preventDefault();
        signIn.mutate(formValue(event.currentTarget, "phone-number"));
      }}
    >
      <FieldGroup className="gap-4">
        <PhoneNumberField />
        <FieldError
          className="type-fine"
          errors={signIn.error ? [signIn.error] : undefined}
        />
        <Button
          className="w-full"
          disabled={signIn.isPending}
          type="submit"
          variant="paper"
        >
          {signIn.isPending ? "Входим…" : "Войти"}
        </Button>
      </FieldGroup>
    </form>
  );
}
