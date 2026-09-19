import type { Metadata } from "next";
import Link from "next/link";
import { Masthead, OfferLink } from "@web/components/paper/masthead";
import { yooKassaConfigured } from "@db/services/yookassa";
import { env } from "@shared/environment";
import { AccessForm } from "./_components/access-form";
import { HeroVideo } from "./_components/hero-video";

const title = "bro — твой личный ИИ-агент";

export const metadata: Metadata = {
  title: { absolute: title },
  description:
    "bro — персональный ИИ-агент со своим номером, памятью и руками в интернете. Записать к врачу, забронировать, заказать — просто напиши ему.",
  openGraph: {
    description:
      "Свой номер, своя память, свои руки в интернете. Записать к врачу, забронировать, заказать — просто напиши ему.",
    images: ["/brand/bro-og.png"],
    title,
    type: "website",
  },
  twitter: { card: "summary_large_image" },
};

/**
 * Stage — a white page with one figure standing in it. A flex column: the
 * masthead, the call to action and the tariff line take their own height,
 * the film gets whatever is left and shrinks instead of pushing the form
 * off-screen. Below the floor height the page scrolls, so a keyboard on a
 * phone never covers the form for good.
 */
export default function Page() {
  return (
    <main className="flex h-svh min-h-[30rem] flex-col overflow-x-hidden overflow-y-auto">
      <h1 className="sr-only">{title}</h1>
      <Masthead
        end={
          <nav aria-label="Служебные страницы" className="flex gap-[0.9rem]">
            <Link className="type-nav bro-link" href="/sign-in">
              Кабинет
            </Link>
            <Link className="type-nav bro-link" href="/vault">
              Сейф
            </Link>
          </nav>
        }
        start={<OfferLink />}
      />

      <div className="relative min-h-0 flex-1">
        <HeroVideo />
      </div>

      <section
        aria-label="Получить своего бро"
        className="p-bro-pad text-center"
      >
        <AccessForm />
      </section>

      <Pricing />
    </main>
  );
}

/**
 * The tariffs, in two lines of fine print under the call to action: the
 * offer points here as `#pricing`. The numbers are the deployment's own,
 * and a deployment without YooKassa names no price it cannot take.
 */
function Pricing() {
  const billingOn = yooKassaConfigured();
  return (
    <section
      aria-labelledby="pricing-heading"
      className="px-bro-pad pb-bro-pad text-center"
      id="pricing"
    >
      <h2 className="sr-only" id="pricing-heading">
        Тарифы
      </h2>
      <p className="type-fine text-muted-foreground">
        Бесплатный режим — до {env.FREE_MESSAGES_PER_DAY} сообщений в день и{" "}
        {env.FREE_BROWSER_RUNS_PER_MONTH} поручений в браузере в месяц.
      </p>
      <p className="type-fine text-muted-foreground">
        {billingOn ? (
          <>
            Полный доступ — {env.PRICE_RUB} ₽ за 30 календарных дней: до{" "}
            {env.PAID_MESSAGES_PER_DAY} сообщений в день и{" "}
            {env.PAID_BROWSER_RUNS_PER_MONTH} поручений в месяц. Тариф не
            продлевается автоматически.
          </>
        ) : (
          <>
            Полный доступ — до {env.PAID_MESSAGES_PER_DAY} сообщений в день и{" "}
            {env.PAID_BROWSER_RUNS_PER_MONTH} поручений в месяц. Оплата пока не
            подключена.
          </>
        )}
      </p>
    </section>
  );
}
