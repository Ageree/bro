import type { Metadata } from "next";
import Link from "next/link";
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
 * masthead and the call to action take their own height, the film gets
 * whatever is left and shrinks instead of pushing the form off-screen.
 */
export default function Page() {
  return (
    <main className="flex h-svh min-h-[30rem] flex-col overflow-hidden">
      <header className="flex items-center justify-between gap-4 p-bro-pad">
        <div className="flex flex-1 basis-0 gap-[0.9rem]">
          <Link className="type-nav bro-link" href="/oferta">
            Оферта
          </Link>
        </div>
        <Link className="type-wordmark bro-link" href="/">
          bro.
        </Link>
        <nav
          aria-label="Служебные страницы"
          className="flex flex-1 basis-0 justify-end gap-[0.9rem]"
        >
          <Link className="type-nav bro-link" href="/sign-in">
            Кабинет
          </Link>
          <Link className="type-nav bro-link" href="/vault">
            Сейф
          </Link>
        </nav>
      </header>

      <div className="relative min-h-0 flex-1">
        <HeroVideo />
      </div>

      <section
        aria-label="Получить своего бро"
        className="p-bro-pad text-center"
      >
        <AccessForm />
      </section>
    </main>
  );
}
