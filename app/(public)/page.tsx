import type { Metadata } from "next";
import { Geist, Source_Serif_4 } from "next/font/google";
import Link from "next/link";
import { Button } from "@web/components/ui/button";
import { cn } from "@web/components/class-names";
import { env } from "@shared/environment";
import { PortraitWallpaper } from "./_components/portrait-wallpaper";
import { LandingStory } from "./_components/landing-story";
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
      <main>
        <div className={styles.hero}>
          <PortraitWallpaper />
          <nav aria-label="Главная навигация" className={styles.navigation}>
            <Link className={styles.wordmark} href="/">
              bro.
            </Link>
            <Link className={styles.navVault} href="/vault">
              Сейф
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
              {title}
            </h1>
            <p className={cn("type-supporting-body", styles.description)}>
              {env.IMESSAGE_PHONE_NUMBER
                ? "Написать бро в iMessage"
                : "iMessage пока недоступен"}
            </p>
            <div className={styles.actions}>
              <WriteBro phoneNumber={env.IMESSAGE_PHONE_NUMBER} />
              <Button
                className={styles.secondaryAction}
                nativeButton={false}
                render={<Link href="/vault" />}
                variant="outline"
              >
                Сейф
              </Button>
            </div>
            <Link className={styles.offer} href="/oferta">
              Оферта
            </Link>
          </section>
          <Link className={styles.learnMore} href="#meet-bro">
            Узнать bro <span aria-hidden="true">↓</span>
          </Link>
        </div>
        <LandingStory
          fontClassName={cn(display.variable, body.variable)}
          phoneNumber={env.IMESSAGE_PHONE_NUMBER}
        />
      </main>
      <footer className={styles.footer}>
        <div className={styles.footerInner}>
          <div className={styles.footerTop}>
            <p className={styles.footerStatement}>
              Свои планы. Свой ритм.
              <br />
              Свой bro.
            </p>
            <nav aria-label="О bro">
              <span>Знакомство</span>
              <Link href="#how-it-works">Как это работает</Link>
              <Link href="#features">Возможности</Link>
              <Link href="#questions">Вопросы</Link>
            </nav>
            <nav aria-label="Документы">
              <span>Документы</span>
              <Link href="/oferta">Оферта</Link>
              <Link href="/privacy">Конфиденциальность</Link>
            </nav>
            <nav aria-label="Ваш bro">
              <span>Ваш bro</span>
              <Link href="/sign-in">Кабинет</Link>
              <Link href="/vault">Сейф</Link>
            </nav>
          </div>
          <p aria-hidden="true" className={styles.footerWordmark}>
            bro.
          </p>
          <div className={styles.footerBaseline}>
            <Link className={styles.footerHome} href="/">
              bro.
            </Link>
            <span>Личный ИИ-агент. В твоём ритме.</span>
          </div>
        </div>
      </footer>
    </div>
  );
}
