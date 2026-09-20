import { Button } from "@web/components/ui/button";

/**
 * iOS wants `&body=` after an `sms:` address, not the `?body=` a URL would
 * take: with a question mark Messages opens an empty draft.
 */
export function imessageLink(phoneNumber: string) {
  return `sms:${phoneNumber}&body=${encodeURIComponent("Привет")}`;
}

/**
 * The only call to action on the landing, and the only line of text under
 * the film: one tap into the iMessage thread with Bro. Nothing is asked for
 * and nothing is provisioned here — the first message on that line creates
 * the account.
 *
 * A deployment without `IMESSAGE_PHONE_NUMBER` has no line to open, and says
 * so instead of offering a link into nowhere.
 */
export function WriteBro({ phoneNumber }: { readonly phoneNumber?: string }) {
  if (!phoneNumber) {
    return (
      <p className="type-fine text-muted-foreground">
        Пока закрыто: iMessage-номер этого деплоя не настроен.
      </p>
    );
  }

  return (
    <Button
      className="type-cta"
      nativeButton={false}
      render={
        <a
          aria-label="Написать бро в iMessage"
          href={imessageLink(phoneNumber)}
        />
      }
      variant="act"
    >
      Написать бро
    </Button>
  );
}
