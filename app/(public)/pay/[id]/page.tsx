import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { z } from "zod";
import { readYoomoneyPaymentByLink } from "@db/services/yoomoney/card";
import { Capsule } from "@web/components/paper/capsule";
import { Button } from "@web/components/ui/button";
import { Input } from "@web/components/ui/input";
import { yoomoneyRefusal } from "@shared/yoomoney/payments";

export const metadata: Metadata = {
  title: { absolute: "Оплата — bro" },
  // The link is a secret; a chat app that previews it must not index it.
  robots: { follow: false, index: false },
};

const querySchema = z.object({
  t: z.string().max(100).catch(""),
  e: z.string().max(40).optional().catch(undefined),
});

/** Why the last press did not pay, as the page says it. */
const notices = new Map(
  Object.entries({
    busy: "С кошелька сейчас идёт другой платёж. Попросите Бро проверить его и попробуйте ещё раз.",
    changed:
      "Сумма или карта изменились, либо платёж устарел. Попросите Бро подготовить его заново.",
    csc_needed: "Нужен CVV — три цифры на обороте карты.",
    expired: "Ссылка устарела. Попросите Бро подготовить платёж заново.",
    wallet_changed:
      "Сейчас подключён другой кошелёк ЮMoney или он отключён. Попросите Бро подготовить платёж заново.",
  })
);

const rub = (amountMinor: number) =>
  new Intl.NumberFormat("ru-RU", { currency: "RUB", style: "currency" }).format(
    amountMinor / 100
  );

/**
 * A payment from the wallet's linked card, by the link Bro sent
 * (`db/services/yoomoney/card.ts`): what is paid, how much and from which
 * card, and «Оплатить». Reading the page pays nothing; the form posts to
 * `/api/yoomoney/pay/<id>`.
 */
export default async function Page(props: PageProps<"/pay/[id]">) {
  const { id } = await props.params;
  const query = querySchema.parse(await props.searchParams);
  const payment = await readYoomoneyPaymentByLink(id, query.t);
  if (!payment) notFound();
  const notice = query.e === undefined ? undefined : notices.get(query.e);
  const askCsc = payment.cscRequired !== false;
  return (
    <div className="flex min-h-svh flex-col">
      <Capsule items={[]} />
      <main className="mx-auto w-full max-w-[72rem] flex-1 px-bro-pad pt-[5.5rem] pb-12">
        <div className="mx-auto flex w-full max-w-[34rem] flex-col gap-4 bro-plate p-6 sm:p-8">
          <h1 className="type-doc-heading wrap-break-word">{payment.title}</h1>
          {payment.shown.length > 0 && (
            <dl className="flex flex-col gap-1">
              {payment.shown.map(({ label, value }) => (
                <div className="type-body flex gap-2" key={label}>
                  <dt className="text-muted-foreground">{label}:</dt>
                  <dd className="wrap-break-word">{value}</dd>
                </div>
              ))}
            </dl>
          )}
          <p className="type-body">
            С карты <strong>{payment.cardLabel}</strong> через ЮMoney:{" "}
            <strong>{rub(payment.amountMinor)}</strong> с учётом комиссии.
          </p>
          {payment.state === "quoted" && (
            <form
              action={`/api/yoomoney/pay/${payment.id}`}
              className="flex flex-col gap-3"
              method="post"
            >
              <input name="t" type="hidden" value={query.t} />
              {askCsc && (
                <div className="flex flex-col gap-2">
                  <label className="type-label" htmlFor="csc">
                    CVV карты
                  </label>
                  <Input
                    id="csc"
                    autoComplete="cc-csc"
                    inputMode="numeric"
                    maxLength={4}
                    minLength={3}
                    name="csc"
                    pattern="[0-9]{3,4}"
                    required
                    type="password"
                    variant="paper"
                  />
                  <span className="type-caption text-muted-foreground">
                    CVV уходит прямо в ЮMoney и нигде не сохраняется.
                  </span>
                </div>
              )}
              {notice !== undefined && (
                <p className="type-body text-destructive">{notice}</p>
              )}
              <Button className="w-full" type="submit" variant="paper">
                Оплатить {rub(payment.amountMinor)}
              </Button>
              <p className="type-caption text-muted-foreground">
                Банк может попросить подтвердить платёж кодом на своей странице.
              </p>
            </form>
          )}
          {payment.state === "paid" && (
            <p className="type-body">
              <strong>Оплачено.</strong> Можно вернуться к Бро.
            </p>
          )}
          {payment.state === "refused" && (
            <p className="type-body">
              <strong>Не прошло.</strong> {yoomoneyRefusal(payment.error ?? "")}{" "}
              Деньги не списаны.
            </p>
          )}
          {(payment.state === "pending" || payment.state === "submitting") && (
            <div className="flex flex-col gap-3">
              {payment.state === "pending" && payment.bankUri !== null ? (
                <form
                  action={payment.bankUri}
                  className="flex flex-col gap-3"
                  method="post"
                >
                  {Object.entries(payment.bankParams ?? {}).map(
                    ([name, value]) => (
                      <input
                        key={name}
                        name={name}
                        type="hidden"
                        value={value}
                      />
                    )
                  )}
                  <p className="type-body">
                    Банк просит подтвердить платёж на своей странице.
                  </p>
                  <Button className="w-full" type="submit" variant="paper">
                    Подтвердить в банке
                  </Button>
                </form>
              ) : (
                <p className="type-body">
                  Платёж ждёт ответа ЮMoney. Не оплачивайте его ещё раз.
                </p>
              )}
              <a
                className="type-body underline"
                href={`/api/yoomoney/pay/${payment.id}/return?t=${encodeURIComponent(query.t)}`}
              >
                Проверить ещё раз
              </a>
            </div>
          )}
          {payment.state === "unknown" && (
            <p className="type-body">
              ЮMoney не ответил, прошёл ли платёж. Не оплачивайте его ещё раз:
              Бро проверит его по истории кошелька.
            </p>
          )}
        </div>
      </main>
    </div>
  );
}
