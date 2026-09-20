import type { Metadata } from "next";
import Link from "next/link";
import { Masthead, OfferLink } from "@web/components/paper/masthead";
import { env } from "@shared/environment";
import { HeroVideo } from "./_components/hero-video";
import { WriteBro } from "./_components/write-bro";

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
 * Stage — a white page with one figure standing in it. A flex column of
 * three: the masthead and the call to action take their own height, the
 * film takes everything else. Nothing else stands under it — the tariffs
 * live in the offer now — so the figure gets the whole page between them.
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
        aria-label="Написать бро"
        className="px-bro-pad pt-[0.6rem] pb-bro-pad text-center"
      >
        <WriteBro phoneNumber={env.IMESSAGE_PHONE_NUMBER} />
      </section>
    </main>
  );
}
