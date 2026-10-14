import { Button } from "@web/components/ui/button";
import styles from "../landing.module.css";

/**
 * iOS wants `&body=` after an `sms:` address, not the `?body=` a URL would
 * take: with a question mark Messages opens an empty draft.
 */
export function imessageLink(phoneNumber: string) {
  return `sms:${phoneNumber}&body=${encodeURIComponent("Привет")}`;
}

export function WriteBro({ phoneNumber }: { readonly phoneNumber?: string }) {
  if (!phoneNumber) {
    return (
      <Button
        aria-label="Пока закрыто: iMessage-номер этого деплоя не настроен."
        className={styles.primaryAction}
        disabled
        title="iMessage-номер этого деплоя не настроен."
      >
        Пока закрыто
      </Button>
    );
  }
  return (
    <Button
      className={styles.primaryAction}
      nativeButton={false}
      render={
        <a
          aria-label="Написать бро в iMessage"
          href={imessageLink(phoneNumber)}
        />
      }
    >
      Написать бро
    </Button>
  );
}
