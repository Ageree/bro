import Link from "next/link";
import { Button } from "@web/components/ui/button";
import styles from "../landing.module.css";

/**
 * Where a visitor starts. Bro lives in Telegram, and the bot makes an
 * account on the first message, so the button opens the bot itself. Without
 * Telegram it leads to sign-in: Bro's iMessage line answers only phones
 * registered with Photon («This number didn't recognize yours»), and asking
 * for the sign-in code registers the phone.
 */
export function WriteBro({
  imessage,
  telegramHref,
}: {
  readonly imessage: boolean;
  readonly telegramHref?: string;
}) {
  if (telegramHref) {
    return (
      <Button
        className={styles.primaryAction}
        nativeButton={false}
        render={<a aria-label="Написать бро в Telegram" href={telegramHref} />}
      >
        Написать bro
      </Button>
    );
  }
  if (!imessage) {
    return (
      <Button
        aria-label="Пока закрыто: Telegram и iMessage этого деплоя не настроены."
        className={styles.primaryAction}
        disabled
        title="Telegram и iMessage этого деплоя не настроены."
      >
        Написать bro
      </Button>
    );
  }
  return (
    <Button
      className={styles.primaryAction}
      nativeButton={false}
      render={<Link aria-label="Написать бро" href="/sign-in" />}
    >
      Написать bro
    </Button>
  );
}
