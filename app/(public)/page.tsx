import type { Metadata } from "next";
import { Geist, Source_Serif_4 } from "next/font/google";
import Link from "next/link";
import { Button } from "@web/components/ui/button";
import { cn } from "@web/components/class-names";
import { photonConfigured } from "@shared/photon/credentials";
import { PortraitWallpaper } from "./_components/portrait-wallpaper";
import { WriteBro } from "./_components/write-bro";
import styles from "./landing.module.css";

const display = Source_Serif_4({
  display: "swap",
  subsets: ["cyrillic", "latin"],
  variable: "--font-landing-display",
  weight: "400",
});
const body = Geist({
  display: "swap",
  subsets: ["cyrillic", "latin"],
  variable: "--font-landing-body",
});
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

export default function Page() {
  return (
    <div className={cn(display.variable, body.variable, styles.landing)}>
      <main className={styles.hero}>
        <PortraitWallpaper />
        <nav aria-label="Главная навигация" className={styles.navigation}>
          <Link className={styles.wordmark} href="/">
            bro.
          </Link>
          <Button
            className={styles.navAction}
            nativeButton={false}
            render={<Link href="/sign-in" />}
          >
            Кабинет
          </Button>
        </nav>
        <section aria-labelledby="bro-title" className={styles.plate}>
          <h1 className="type-product-title" id="bro-title">
            bro — твой последний ИИ-агент
          </h1>
          <WriteBro open={photonConfigured()} />
          <Link className={styles.offer} href="/oferta">
            Оферта
          </Link>
        </section>
      </main>
    </div>
  );
}
