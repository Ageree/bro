import { BellIcon, MailIcon, SendIcon, ShoppingBagIcon } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { Logo } from "@web/components/ui/logo";
import { AccessForm } from "./_components/access-form";

export const metadata: Metadata = {
  title: "Бро — личный агент в iMessage",
  description:
    "Свой номер в iMessage, своя память и руки в интернете. Записать, забронировать, заказать — просто напиши Бро.",
};

const benefits = [
  {
    description: "Найдёт на сайте, оформит заказ и доведёт покупку до конца.",
    icon: ShoppingBagIcon,
    id: "orders",
    title: "Заказы и покупки",
  },
  {
    description: "Разберёт почту, ответит на письмо, назначит встречу.",
    icon: MailIcon,
    id: "mail",
    title: "Письма и календарь",
  },
  {
    description: "Сам напомнит о важном и вернётся, когда будет результат.",
    icon: BellIcon,
    id: "reminders",
    title: "Напоминания",
  },
  {
    description: "Тот же Бро, если писать удобнее там.",
    icon: SendIcon,
    id: "telegram",
    title: "Telegram",
  },
] as const;

export default function Page() {
  return (
    <div
      className="flex min-h-svh flex-col bg-background text-foreground"
      lang="ru"
    >
      <header className="mx-auto flex w-full max-w-xl items-center justify-between gap-4 px-4 py-5">
        <span className="flex items-center gap-2 type-label">
          <Logo />
          бро
        </span>
        <nav
          aria-label="Служебные страницы"
          className="flex items-center gap-4"
        >
          <Link
            className="type-label text-muted-foreground hover:text-foreground"
            href="/oferta"
          >
            Оферта
          </Link>
          <Link
            className="type-label text-muted-foreground hover:text-foreground"
            href="/workspace"
          >
            Кабинет
          </Link>
        </nav>
      </header>

      <main className="mx-auto flex w-full max-w-xl flex-1 flex-col gap-10 px-4 pt-4 pb-16">
        <section className="space-y-3">
          <h1 className="type-product-title">
            Бро — личный агент со своим номером
          </h1>
          <p className="type-body text-muted-foreground">
            Своя память, свои руки в интернете. Записать к врачу, забронировать,
            заказать — просто напиши ему, как написал бы другу.
          </p>
        </section>

        <section aria-labelledby="benefits-heading" className="space-y-3">
          <h2 className="type-section-title" id="benefits-heading">
            Что он берёт на себя
          </h2>
          <ul className="divide-y divide-border/50 border-y border-border/50">
            {benefits.map((benefit) => {
              const Icon = benefit.icon;
              return (
                <li className="flex items-start gap-3 py-4" key={benefit.id}>
                  <span className="flex size-9 shrink-0 items-center justify-center rounded-md border border-border bg-muted/50 text-muted-foreground">
                    <Icon />
                  </span>
                  <div className="min-w-0">
                    <p className="type-label">{benefit.title}</p>
                    <p className="type-caption text-muted-foreground">
                      {benefit.description}
                    </p>
                  </div>
                </li>
              );
            })}
          </ul>
        </section>

        <section aria-labelledby="access-heading" className="space-y-3">
          <h2 className="type-section-title" id="access-heading">
            Получить своего Бро
          </h2>
          <p className="type-supporting-body text-muted-foreground">
            Оставь номер — мы выдадим линию iMessage, на которой он отвечает.
          </p>
          <AccessForm />
        </section>
      </main>

      <footer className="mx-auto w-full max-w-xl px-4 pb-8">
        <p className="type-caption text-muted-foreground">
          Пользуясь сервисом, ты принимаешь{" "}
          <Link className="underline underline-offset-4" href="/oferta">
            публичную оферту
          </Link>
          .
        </p>
      </footer>
    </div>
  );
}
