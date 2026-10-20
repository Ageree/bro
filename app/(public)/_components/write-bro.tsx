import Link from "next/link";
import { Button } from "@web/components/ui/button";
import styles from "../landing.module.css";

/**
 * Bro's iMessage line answers only phones registered with Photon («This
 * number didn't recognize yours»), so a visitor starts at sign-in: the code
 * comes by iMessage, the sign-in registers their phone, and the cabinet's
 * «Написать Bro» opens the line they are on (`photonLineFor`).
 */
export function WriteBro({ open }: { readonly open: boolean }) {
  if (!open) {
    return (
      <Button
        aria-label="Пока закрыто: iMessage этого деплоя не настроен."
        className={styles.primaryAction}
        disabled
        title="iMessage этого деплоя не настроен."
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
