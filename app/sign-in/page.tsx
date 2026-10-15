import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { Capsule } from "@web/components/paper/capsule";
import { SiteFooter } from "@web/components/paper/footer";
import { LocalPhoneAuthForm } from "@app/sign-in/_components/local-form";
import { PhoneOtpAuthForm } from "@app/sign-in/_components/otp-form";
import { env, localPhoneAuthBypassEnabled } from "@shared/environment";
import { getAuthSession } from "@db/services/auth/session";
import { photonConfigured } from "@shared/photon/credentials";

export const metadata: Metadata = { title: "Вход" };

/**
 * The login sheet: one white plate centred on the paper, under the shared
 * capsule and above the shared footer.
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
      <Capsule items={[{ href: "/oferta", id: "oferta", label: "Оферта" }]} />

      <main className="flex flex-1 items-start justify-center px-bro-pad pt-[5.5rem] pb-4 sm:items-center">
        <section
          aria-labelledby="login-title"
          className="w-full max-w-[28rem] bro-plate p-6 sm:p-8"
        >
          <h1 className="type-doc-heading mb-2" id="login-title">
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
          <p className="type-fine mt-6 text-center text-muted-foreground">
            Продолжая, вы соглашаетесь на обработку персональных данных по{" "}
            <Link
              className="underline underline-offset-[0.2em]"
              href="/privacy"
            >
              политике конфиденциальности
            </Link>{" "}
            и принимаете{" "}
            <Link className="underline underline-offset-[0.2em]" href="/oferta">
              оферту
            </Link>
            .
          </p>
        </section>
      </main>

      <SiteFooter />
    </div>
  );
}
