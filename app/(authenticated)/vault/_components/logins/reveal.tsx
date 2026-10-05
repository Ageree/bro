"use client";

import { useState } from "react";
import { Badge } from "@web/components/ui/badge";
import { Button } from "@web/components/ui/button";
import { api } from "@web/trpc/client";

/**
 * A login Bro registered with its own mailbox, as the vault lists it: marked
 * as Bro's account, with its email and password read from the server only
 * when the person asks (`vault.reveal`), never with the page. Hiding them
 * drops them from memory, mutation cache included.
 */
export function BroLoginReveal({ id }: { readonly id: string }) {
  const [login, setLogin] = useState<{
    readonly email: string;
    readonly password: string;
  }>();
  const reveal = api.vault.reveal.useMutation({
    onSuccess: (data) => {
      setLogin(data);
    },
  });

  return (
    <div className="mt-1 flex flex-col items-start gap-2">
      <Badge variant="secondary">аккаунт Бро</Badge>
      {login === undefined ? (
        <Button
          disabled={reveal.isPending}
          onClick={() => {
            reveal.mutate({ id });
          }}
          size="act-sm"
          type="button"
          variant="act"
        >
          Показать данные для входа
        </Button>
      ) : (
        <RevealedLogin
          email={login.email}
          onHide={() => {
            setLogin(undefined);
            reveal.reset();
          }}
          password={login.password}
        />
      )}
      {reveal.isError ? (
        <p className="type-fine text-destructive">
          Не получилось показать данные. Попробуй ещё раз.
        </p>
      ) : null}
    </div>
  );
}

/** The email and the password Bro signed up with, each ready to copy. */
export function RevealedLogin({
  email,
  onHide,
  password,
}: {
  readonly email: string;
  readonly onHide: () => void;
  readonly password: string;
}) {
  return (
    <div className="flex w-full flex-col gap-2">
      <LoginValue label="Почта" value={email} />
      <LoginValue label="Пароль" value={password} />
      <Button onClick={onHide} size="act-sm" type="button" variant="act">
        Скрыть
      </Button>
    </div>
  );
}

function LoginValue({
  label,
  value,
}: {
  readonly label: string;
  readonly value: string;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex min-w-0 items-baseline justify-between gap-3">
      <div className="min-w-0">
        <p className="type-status text-muted-foreground">{label}</p>
        <p className="type-mono break-all">{value}</p>
      </div>
      <Button
        aria-label={`Скопировать: ${label.toLocaleLowerCase()}`}
        onClick={() => {
          void navigator.clipboard.writeText(value).then(
            () => {
              setCopied(true);
              return undefined;
            },
            () => undefined
          );
        }}
        size="act-sm"
        type="button"
        variant="act"
      >
        {copied ? "Скопировано" : "Скопировать"}
      </Button>
    </div>
  );
}
