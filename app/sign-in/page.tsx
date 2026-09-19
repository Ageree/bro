import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { Masthead, OfferLink } from "@web/components/paper/masthead";
import { LocalPhoneAuthForm } from "@app/sign-in/_components/local-form";
import { PhoneOtpAuthForm } from "@app/sign-in/_components/otp-form";
import { env, localPhoneAuthBypassEnabled } from "@shared/environment";
import { getAuthSession } from "@db/services/auth/session";
import { photonConfigured } from "@shared/photon/credentials";

export const metadata: Metadata = { title: "Вход" };

/**
 * The login sheet: on the old site it floated over the page; here it is the
 * page, set on the same paper under the same masthead.
 */
export default async function SignInPage({
  searchParams,
}: PageProps<"/sign-in">) {
  if (await getAuthSession(await headers())) redirect("/workspace");

  const callbackValue = (await searchParams).callbackUrl;
  const requestedCallback = Array.isArray(callbackValue)
    ? callbackValue[0]
    : callbackValue;
  const callbackUrl =
    requestedCallback?.startsWith("/") && !requestedCallback.startsWith("//")
      ? requestedCallback
      : "/workspace";
  const imessageConfigured = photonConfigured();
  const imessagePhoneNumber =
    localPhoneAuthBypassEnabled || !imessageConfigured
      ? undefined
      : env.IMESSAGE_PHONE_NUMBER;

  return (
    <div className="flex min-h-svh flex-col">
      <Masthead start={<OfferLink />} />

      <main className="flex flex-1 justify-center px-bro-pad pt-[1.1rem] pb-20">
        <section aria-labelledby="login-title" className="w-full max-w-[23rem]">
          <h1 className="type-sheet-title mb-[0.6rem]" id="login-title">
            Вход
          </h1>
          <p className="type-fine text-muted-foreground">
            Введи телефон, с которого пишешь Bro.
            {!localPhoneAuthBypassEnabled && imessageConfigured
              ? " Код придёт в iMessage."
              : null}
          </p>
          {!localPhoneAuthBypassEnabled && !imessageConfigured ? (
            <p className="type-fine mt-4 text-muted-foreground">
              Вход через iMessage на этом деплое не настроен: задай переменные
              проекта Photon.
            </p>
          ) : localPhoneAuthBypassEnabled ? (
            <LocalPhoneAuthForm callbackUrl={callbackUrl} />
          ) : (
            <PhoneOtpAuthForm
              callbackUrl={callbackUrl}
              imessagePhoneNumber={imessagePhoneNumber}
            />
          )}
        </section>
      </main>
    </div>
  );
}
