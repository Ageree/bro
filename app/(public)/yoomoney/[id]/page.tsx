import { Check } from "lucide-react";
import type { Metadata } from "next";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import * as z from "zod";
import {
  onYoomoneyOnboardingDevice,
  readYoomoneyOnboardingByLink,
  yoomoneyOnboardingCookie,
} from "@db/services/yoomoney/onboarding";
import { env } from "@shared/environment";
import { Capsule } from "@web/components/paper/capsule";
import { Button, buttonVariants } from "@web/components/ui/button";
import { requestSession } from "@web/auth/request-scope";
import { BackToChat, LaunchDataField, TelegramScope } from "./telegram";

export const metadata: Metadata = {
  title: { absolute: "ЮMoney — bro" },
  // The link is a secret; a chat app that previews it must not index it.
  robots: { follow: false, index: false },
};

const querySchema = z.object({
  t: z.string().max(100).catch(""),
  e: z.string().max(40).optional().catch(undefined),
});

const steps = [
  {
    title: "Войди в ЮMoney",
    hint: "Нет кошелька — создашь его там же по номеру телефона.",
  },
  {
    title: "Разреши Бро платить",
    hint: "Каждый платёж — только после твоего «да» с точной суммой.",
  },
  {
    title: "Привяжи карту",
    hint: "Тогда Бро платит с неё и кошелёк пополнять не нужно.",
  },
] as const;

/** The three steps, those behind the person ticked. */
function Steps({ done }: { readonly done: number }) {
  return (
    <ol className="flex flex-col gap-4">
      {steps.map((step, index) => (
        <li className="flex gap-3" key={step.title}>
          <span
            aria-hidden
            className={`flex size-8 shrink-0 items-center justify-center rounded-full border-2 border-foreground type-label ${index < done ? "bg-foreground text-background" : ""}`}
          >
            {index < done ? <Check className="size-4" /> : index + 1}
          </span>
          <span className="flex flex-col gap-0.5 pt-1">
            <span
              className={`type-label ${index < done ? "text-muted-foreground line-through" : ""}`}
            >
              {step.title}
            </span>
            {index >= done && (
              <span className="type-caption text-muted-foreground">
                {step.hint}
              </span>
            )}
          </span>
        </li>
      ))}
    </ol>
  );
}

/** A press of one of the page's buttons. */
function Action({
  action,
  children,
  id,
  quiet = false,
  t,
}: {
  readonly action: "start" | "check" | "skip";
  readonly children: ReactNode;
  readonly id: string;
  readonly quiet?: boolean;
  readonly t: string;
}) {
  return (
    <form
      action={`/api/yoomoney/onboarding/${id}`}
      className="contents"
      method="post"
    >
      <input name="t" type="hidden" value={t} />
      <input name="action" type="hidden" value={action} />
      <LaunchDataField />
      <Button
        className="w-full"
        type="submit"
        variant={quiet ? "act" : "paper"}
      >
        {children}
      </Button>
    </form>
  );
}

function Sheet({ children }: { readonly children: ReactNode }) {
  return (
    <div className="flex min-h-svh flex-col">
      <Capsule items={[]} />
      <main className="mx-auto w-full max-w-[72rem] flex-1 px-bro-pad pt-[5.5rem] pb-12">
        <div className="mx-auto flex w-full max-w-[30rem] flex-col gap-5 bro-plate p-6 sm:p-8">
          {children}
        </div>
      </main>
    </div>
  );
}

/**
 * Connecting the wallet from a chat (`db/services/yoomoney/onboarding.ts`),
 * by the link or Telegram button Bro sent: three steps on one sheet, one
 * button at a time, and back to the chat, where Bro carries on by itself.
 * Opening the page changes nothing; its buttons post to
 * `/api/yoomoney/onboarding/<id>`.
 */
export default async function Page(props: PageProps<"/yoomoney/[id]">) {
  const { id } = await props.params;
  const query = querySchema.parse(await props.searchParams);
  const onboarding = await readYoomoneyOnboardingByLink(id, query.t);
  if (!onboarding) {
    return (
      <Sheet>
        <h1 className="type-doc-heading">Ссылка устарела</h1>
        <p className="type-body">
          Она живёт полчаса. Напиши Бро «подключи ЮMoney» — он пришлёт новую.
        </p>
      </Sheet>
    );
  }
  const telegram = onboarding.conversationChannel === "telegram";
  const onDevice = onYoomoneyOnboardingDevice(
    onboarding,
    (await cookies()).get(yoomoneyOnboardingCookie)?.value
  );
  // A web chat or iMessage proves the person by the cabinet's session; in
  // Telegram the button's signed data does, or — the page opened some other
  // way — the session too.
  const signIn = `/sign-in?callbackUrl=${encodeURIComponent(`/yoomoney/${id}?t=${encodeURIComponent(query.t)}`)}`;
  if (!telegram && !onDevice && !(await requestSession())) redirect(signIn);
  const notices = new Map(
    Object.entries({
      declined:
        "Доступ не выдан — ничего не подключено. Можно попробовать ещё раз.",
      failed: "ЮMoney не ответил. Попробуй ещё раз.",
      gone: "Доступ к кошельку пропал. Подключи его ещё раз.",
      no_card:
        "Карты пока не видно. Если только что привязал — подожди минуту и проверь снова.",
      who: telegram
        ? "Открой эту страницу кнопкой «Подключить ЮMoney» из чата с Бро в Telegram — так мы знаем, что это ты. Или войди в кабинет Бро."
        : "Войди в кабинет Бро с номером, с которого пишешь Бро, и открой ссылку снова.",
    })
  );
  const notice = query.e === undefined ? undefined : notices.get(query.e);
  const chat =
    onboarding.conversationChannel === "eve"
      ? `/chat/${onboarding.conversationId}`
      : telegram && env.TELEGRAM_BOT_USERNAME !== undefined
        ? `https://t.me/${env.TELEGRAM_BOT_USERNAME}`
        : undefined;
  const done =
    onboarding.connectedAt === null ? 0 : onboarding.readyAt === null ? 2 : 3;
  return (
    <TelegramScope telegram={telegram}>
      <Sheet>
        {done === 0 && (
          <>
            <div className="flex flex-col gap-2">
              <p className="type-caption text-muted-foreground">
                ЮMoney · один раз, около минуты
              </p>
              <h1 className="type-doc-heading">Бро будет платить за тебя</h1>
              <p className="type-body">
                Связь, интернет, ЖКХ и другие услуги — прямо из чата.
              </p>
            </div>
            <Steps done={0} />
          </>
        )}
        {done === 2 && (
          <>
            <div className="flex flex-col gap-2">
              <p className="type-caption text-muted-foreground">
                Кошелёк подключён
              </p>
              <h1 className="type-doc-heading">Последний шаг — карта</h1>
              <p className="type-body">
                Открой ЮMoney и привяжи банковскую карту в разделе карт. Потом
                вернись сюда и нажми «Я привязал карту».
              </p>
            </div>
            <Steps done={2} />
          </>
        )}
        {done === 3 && (
          <>
            <div className="flex flex-col gap-2">
              <h1 className="type-doc-heading">Готово</h1>
              <p className="type-body">
                ЮMoney подключён. Возвращайся в чат — Бро уже продолжает.
              </p>
            </div>
            <Steps done={3} />
          </>
        )}
        {notice !== undefined && (
          <p className="type-body text-destructive">{notice}</p>
        )}
        {telegram && query.e === "who" && (
          <a className="type-body underline" href={signIn}>
            Войти в кабинет Бро
          </a>
        )}
        <div className="flex flex-col gap-3">
          {done === 0 && (
            <Action action="start" id={id} t={query.t}>
              Подключить ЮMoney
            </Action>
          )}
          {done === 2 && (
            <>
              <a
                className={buttonVariants({
                  className: "w-full",
                  size: "paper",
                  variant: "paper",
                })}
                href="https://yoomoney.ru/main"
                rel="noopener noreferrer"
                target="_blank"
              >
                Открыть ЮMoney
              </a>
              <Action action="check" id={id} quiet t={query.t}>
                Я привязал карту
              </Action>
              <Action action="skip" id={id} quiet t={query.t}>
                Пропустить — пополню кошелёк сам
              </Action>
            </>
          )}
          {done === 3 && <BackToChat href={chat} />}
        </div>
        <p className="type-caption text-muted-foreground">
          {done === 3
            ? "Отключить кошелёк можно в любой момент — просто скажи Бро."
            : "Пароль и коды вводятся только на сайте ЮMoney — Бро их не видит. Отключить можно в любой момент."}
        </p>
      </Sheet>
    </TelegramScope>
  );
}
