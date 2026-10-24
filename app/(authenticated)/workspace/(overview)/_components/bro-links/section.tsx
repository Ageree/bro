import { Actions, Rows, Section } from "@web/components/paper/document";
import type { listBroLinks } from "@db/services/bro-to-bro/links";
import type { listBroThreads } from "@db/services/bro-to-bro/threads";
import { BroInvite } from "./invite";
import { BroLinkRow } from "./link";
import { BroThreadRow } from "./threads";

/**
 * «Бро-связи» in the cabinet (docs/bro-to-bro.md, «Кабинет»): the person's
 * links with what each opens to the peer, the threads their Bros held, and
 * the invite. Someone with only a link waiting for its inviter (`linked`)
 * sees it but invites nobody.
 */
export function BroLinksSection({
  access,
  links,
  threads,
  timeZone,
}: {
  readonly access: "on" | "linked";
  readonly links: Awaited<ReturnType<typeof listBroLinks>>;
  readonly threads: Awaited<ReturnType<typeof listBroThreads>>;
  readonly timeZone: string;
}) {
  const waiting = links.filter((link) => link.awaitingMyConfirmation).length;

  return (
    <Section
      headingId="bro-links-heading"
      state={
        waiting > 0
          ? "Ждут твоего подтверждения"
          : links.length > 0
            ? `Связей: ${String(links.length)}`
            : "Пока нет"
      }
      title="Бро-связи"
    >
      <p className="type-fine text-muted-foreground">
        Твой Бро договаривается с Бро близких людей — о встрече, о времени, о
        простом вопросе — и приносит тебе итог или вопрос. Встреча и запись в
        календарь — только после твоего «да».
      </p>
      {links.length === 0 ? (
        <div className="mt-[0.6rem]">
          <p className="type-fine">
            Бро собеседника узнаёт о тебе только имя, варианты свободного
            времени по календарю — без названий событий, если ты разрешишь, — и
            то, что ты сам впишешь в «что можно рассказывать».
          </p>
          <p className="type-fine mt-[0.6rem]">
            Не видит никогда: память, почту, контакты, сейф, адрес и где ты
            сейчас, названия событий, другие переговоры и твою подпись к связи.
          </p>
          <p className="type-fine mt-[0.6rem] text-muted-foreground">
            Связь появляется в три шага: ты приглашаешь, человек принимает, ты
            подтверждаешь, что это он. Разорвать её может любой из вас.
          </p>
        </div>
      ) : (
        <Rows>
          {links.map((link) => (
            <BroLinkRow key={link.id} link={link} />
          ))}
        </Rows>
      )}
      {threads.length > 0 ? (
        <>
          <h3 className="type-clause-title mt-6">Переговоры</h3>
          <Rows>
            {threads.map((thread) => (
              <BroThreadRow
                key={thread.id}
                thread={thread}
                timeZone={timeZone}
              />
            ))}
          </Rows>
          <p className="type-fine mt-[0.6rem] text-muted-foreground">
            Ответить Бро, разрешить черновик или подтвердить договорённость — в
            чате с Бро.
          </p>
        </>
      ) : null}
      {access === "on" ? (
        <Actions className="items-center">
          <BroInvite timeZone={timeZone} />
        </Actions>
      ) : null}
    </Section>
  );
}
