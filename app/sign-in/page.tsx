import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Capsule } from "@web/components/paper/capsule";
import { SiteFooter } from "@web/components/paper/footer";
import { LocalPhoneAuthForm } from "@app/sign-in/_components/local-form";
import { PhoneOtpAuthForm } from "@app/sign-in/_components/otp-form";
import { Button } from "@web/components/ui/button";
import {
  telegramLinkConfigured,
  telegramStartUrl,
} from "@shared/identity/telegram-link";
import { ownCallbackUrl } from "@app/sign-in/_lib/callback";
import { localPhoneAuthBypassEnabled } from "@shared/environment";
import { requestSession } from "@web/auth/request-scope";
import { photonConfigured } from "@shared/photon/credentials";

export const metadata: Metadata = { title: "Вход" };

/**
 * The login sheet: one white plate centred on the paper, under the shared
 * capsule and above the shared footer.
 */
export default async function SignInPage({
  searchParams,
}: PageProps<"/sign-in">) {
  if (await requestSession()) redirect("/workspace");

  const query = await searchParams;
  const callbackValue = query.callbackUrl;
  // The bot's sign-in button sends a used or stale link back here.
  const telegramExpired = query.telegram === "expired";
  const requestedCallback = Array.isArray(callbackValue)
    ? callbackValue[0]
    : callbackValue;
  const callbackUrl = ownCallbackUrl(requestedCallback);
  const imessageConfigured = photonConfigured();
  const telegramConfigured = telegramLinkConfigured();

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
          {localPhoneAuthBypassEnabled ? (
            <>
              <p className="type-fine text-muted-foreground">
                Введи телефон, с которого пишешь Bro.
              </p>
              <LocalPhoneAuthForm callbackUrl={callbackUrl} />
            </>
          ) : (
            <>
              {telegramConfigured ? (
                <TelegramSignIn expired={telegramExpired} />
              ) : null}
              {imessageConfigured ? (
                <PhoneSignIn
                  callbackUrl={callbackUrl}
                  secondary={telegramConfigured}
                />
              ) : null}
              {telegramConfigured || imessageConfigured ? null : (
                <p className="type-fine mt-4 text-muted-foreground">
                  Вход на этом деплое не настроен: задай TELEGRAM_BOT_USERNAME
                  или переменные проекта Photon.
                </p>
              )}
            </>
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

/**
 * Signing in through the bot (`telegramLogin`): the link opens the chat with
 * `/start login`, and the bot answers with a button that opens the cabinet
 * already signed in — nothing to type here.
 */
function TelegramSignIn({ expired }: { readonly expired: boolean }) {
  return (
    <>
      <p className="type-fine text-muted-foreground">
        Bro живёт в Telegram. Открой бота — он пришлёт кнопку входа в кабинет.
      </p>
      {expired ? (
        <p className="type-fine mt-4" role="alert">
          Эта кнопка входа уже не действует: она работает 10 минут и один раз.
          Открой бота ещё раз — он пришлёт новую.
        </p>
      ) : null}
      <Button
        className="mt-5 w-full"
        nativeButton={false}
        render={
          <a
            aria-label="Войти через Telegram"
            href={telegramStartUrl("login")}
          />
        }
        variant="paper"
      >
        Войти через Telegram
      </Button>
    </>
  );
}

/**
 * The iMessage code, for a phone account made before Telegram became the
 * main channel: signing in to it through an unbound Telegram would open a
 * new, empty cabinet. Under the Telegram button it stays folded away.
 */
function PhoneSignIn({
  callbackUrl,
  secondary,
}: {
  readonly callbackUrl: string;
  readonly secondary: boolean;
}) {
  if (!secondary) {
    return (
      <>
        <p className="type-fine text-muted-foreground">
          Введи телефон, с которого пишешь Bro. Код придёт в iMessage.
        </p>
        <PhoneOtpAuthForm callbackUrl={callbackUrl} />
      </>
    );
  }
  return (
    <details className="mt-6 border-t pt-4">
      <summary className="type-fine cursor-pointer text-muted-foreground">
        Уже пишешь Bro в iMessage? Войти по номеру телефона
      </summary>
      <PhoneOtpAuthForm callbackUrl={callbackUrl} />
    </details>
  );
}
