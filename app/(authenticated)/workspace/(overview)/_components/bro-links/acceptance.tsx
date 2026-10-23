"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { Actions, Section, StatusLine } from "@web/components/paper/document";
import { Button } from "@web/components/ui/button";
import { api } from "@web/trpc/client";
import { broFailure } from "./failure";

/**
 * The card a person sees when they open someone's invite link: who invites,
 * what the link means and what the peer's Bro would see. Opening the link
 * decided nothing; «Принять» is the person's own yes.
 */
export function BroInviteAcceptance({
  inviterName,
  token,
}: {
  readonly inviterName: string | null;
  readonly token: string;
}) {
  const router = useRouter();
  const accept = api.broToBro.acceptInvite.useMutation({
    onSuccess: () => {
      router.replace("/workspace?bro=accepted");
    },
  });
  const name = inviterName ?? "Человек";

  return (
    <Section headingId="bro-invite-heading" title="Приглашение в Бро-связи">
      <p className="type-row">
        {name} приглашает тебя в Бро-связи: ваши Бро смогут договариваться между
        собой — о встрече, о времени, о простом вопросе — и приносить каждому
        итог.
      </p>
      <p className="type-fine mt-[0.6rem] text-muted-foreground">
        Бро собеседника узнает твоё имя и варианты свободного времени по твоему
        календарю — без названий событий, это можно выключить. Больше ничего,
        пока ты сам не разрешишь. Память, почту, контакты, сейф, адрес и где ты
        сейчас он не увидит никогда.
      </p>
      <p className="type-fine text-muted-foreground">
        Встреча и запись в календарь — только после твоего «да». Связь можно
        разорвать в любой момент.
      </p>
      {accept.error ? (
        <p className="type-status mt-2 text-destructive" role="alert">
          {broFailure(accept.error)}
        </p>
      ) : null}
      <Actions className="items-center">
        <Button
          disabled={accept.isPending || accept.isSuccess}
          onClick={() => {
            accept.mutate({ token });
          }}
          type="button"
          variant="paper"
        >
          Принять
        </Button>
        <Button
          nativeButton={false}
          render={<Link href="/workspace" replace scroll={false} />}
          variant="outline"
        >
          Не сейчас
        </Button>
      </Actions>
      <StatusLine className="mt-2">
        Связь заработает, когда {name} подтвердит, что это именно ты.
      </StatusLine>
    </Section>
  );
}
