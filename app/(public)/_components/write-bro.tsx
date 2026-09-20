import { Button } from "@web/components/ui/button";

/**
 * iOS wants `&body=` after an `sms:` address, not the `?body=` a URL would
 * take: with a question mark Messages opens an empty draft.
 */
export function imessageLink(phoneNumber: string) {
  return `sms:${phoneNumber}&body=${encodeURIComponent("Привет")}`;
}

/**
 * The only call to action on the landing: one tap into the iMessage thread
 * with Bro. Nothing is asked for and nothing is provisioned here — the first
 * message on that line creates the account — so a visitor on an iPhone goes
 * from the page to the conversation without typing a number.
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
    <div className="mx-auto flex w-full max-w-[22rem] flex-col items-center gap-3">
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
      {/* A number is read character by character: machine strings get the
          gothic, words get the serif. */}
      <p className="type-numeric text-muted-foreground">{phoneNumber}</p>
      <p className="type-fine text-muted-foreground">
        Первое сообщение создаёт твой аккаунт. Только синий iMessage; SMS не
        подойдёт. Если сейчас ты не на iPhone — открой эту страницу на нём или
        сохрани номер.
      </p>
    </div>
  );
}
