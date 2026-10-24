"use client";

import { type SubmitEvent, useState } from "react";
import { Button } from "@web/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@web/components/ui/dialog";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from "@web/components/ui/field";
import { Input } from "@web/components/ui/input";
import { api } from "@web/trpc/client";
import { broFailure } from "./failure";
import { broMoment } from "./format";

/**
 * «Пригласить»: a single-use invite for one person, as a link to the bot
 * and a link to the cabinet. The person sends it themselves; Bro sends it to
 * nobody.
 */
export function BroInvite({ timeZone }: { readonly timeZone: string }) {
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState("");
  const invite = api.broToBro.invite.useMutation();
  const submit = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    invite.mutate({ label });
  };
  // Every opening starts a new invite: a link is for one person.
  const openChange = (next: boolean) => {
    if (next) {
      setLabel("");
      invite.reset();
    }
    setOpen(next);
  };

  return (
    <Dialog onOpenChange={openChange} open={open}>
      <DialogTrigger render={<Button type="button" variant="paper" />}>
        Пригласить
      </DialogTrigger>
      <DialogContent className="gap-4 sm:max-w-md">
        <DialogHeader className="pr-10 sm:pr-6">
          <DialogTitle className="type-sheet-title">
            Пригласить в Бро-связи
          </DialogTitle>
          <DialogDescription className="type-fine">
            Ссылка — для одного человека. Связь заработает, когда он её примет,
            а ты подтвердишь, что это именно тот, кого ты приглашаешь.
          </DialogDescription>
        </DialogHeader>
        {invite.data ? (
          <>
            <ul className="min-w-0 list-none">
              {invite.data.telegram ? (
                <InviteLink href={invite.data.telegram} title="В Telegram" />
              ) : null}
              <InviteLink href={invite.data.web} title="На сайте" />
            </ul>
            <p className="type-fine text-muted-foreground">
              Одноразовая, действует до{" "}
              {broMoment(invite.data.expiresAt, timeZone)}. Отправь её сам: Бро
              никому её не пересылает.
            </p>
          </>
        ) : (
          <form noValidate onSubmit={submit}>
            <Field>
              <FieldLabel
                className="type-field-label text-muted-foreground"
                htmlFor="bro-invite-label"
              >
                Как ты называешь этого человека (необязательно)
              </FieldLabel>
              <Input
                id="bro-invite-label"
                maxLength={200}
                onChange={(event) => {
                  setLabel(event.target.value);
                }}
                placeholder="брат"
                value={label}
                variant="paper"
              />
              <FieldDescription className="type-fine">
                Видишь только ты и твой Бро.
              </FieldDescription>
              {invite.error ? (
                <FieldError className="type-fine">
                  {broFailure(invite.error)}
                </FieldError>
              ) : null}
            </Field>
            <DialogFooter className="mt-2">
              <Button disabled={invite.isPending} type="submit" variant="paper">
                Создать ссылку
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

function InviteLink({
  href,
  title,
}: {
  readonly href: string;
  readonly title: string;
}) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    await navigator.clipboard.writeText(href);
    setCopied(true);
  };

  return (
    <li className="flex min-w-0 items-baseline justify-between gap-4 border-t border-border py-[0.6rem] first:border-t-0 first:pt-[0.2rem]">
      <div className="type-row min-w-0 flex-1">
        <p>{title}</p>
        <p className="type-status truncate text-muted-foreground">{href}</p>
      </div>
      <Button
        className="shrink-0"
        onClick={() => {
          copy().catch(() => {
            setCopied(false);
          });
        }}
        size="act-sm"
        type="button"
        variant="act"
      >
        {copied ? "Скопировано" : "Скопировать"}
      </Button>
    </li>
  );
}
