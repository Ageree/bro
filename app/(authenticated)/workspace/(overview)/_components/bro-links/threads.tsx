"use client";

import { ChevronRightIcon } from "lucide-react";
import { useState } from "react";
import type { listBroThreads } from "@db/services/bro-to-bro/threads";
import type { broClosedThreadStatuses } from "@shared/bro-to-bro/contract";
import { Badge } from "@web/components/ui/badge";
import { Button } from "@web/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@web/components/ui/dialog";
import { api } from "@web/trpc/client";
import type { RouterOutputs } from "@web/trpc/types";
import { broFailure } from "./failure";
import { broMoment, broProposalLine } from "./format";

type BroThread = Awaited<ReturnType<typeof listBroThreads>>[number];
type BroThreadView = RouterOutputs["broToBro"]["thread"];

const closedStatus = {
  confirmed: "подтверждено",
  answered: "ответ получен",
  declined: "отказ",
  cancelled: "отменено",
  expired: "не успели",
  stalled: "застряли",
} as const satisfies Record<(typeof broClosedThreadStatuses)[number], string>;

/** Where a thread stands, and whether it waits for this person. */
function threadStatus(
  thread: Pick<BroThread, "status"> & {
    readonly asks: boolean;
    readonly holds: boolean;
    readonly confirmedByMe: boolean;
  }
) {
  if (thread.status === "negotiating") {
    if (thread.asks) return { text: "ждёт твоего ответа", mine: true };
    if (thread.holds) return { text: "ждёт твоего разрешения", mine: true };
    return { text: "договариваются", mine: false };
  }
  if (thread.status === "agreed") {
    return thread.confirmedByMe
      ? { text: "ждёт «да» собеседника", mine: false }
      : { text: "ждёт твоего «да»", mine: true };
  }
  return { text: closedStatus[thread.status], mine: false };
}

function peerOf(peer: {
  readonly name: string | null;
  readonly label: string | null;
}) {
  const name = peer.name ?? "Без имени";
  return peer.label ? `${name} («${peer.label}»)` : name;
}

/**
 * One thread in the cabinet: its topic, the peer and where it stands; the
 * journal opens from the row and is read only then.
 */
export function BroThreadRow({
  thread,
  timeZone,
}: {
  readonly thread: BroThread;
  readonly timeZone: string;
}) {
  const [open, setOpen] = useState(false);
  const status = threadStatus({
    asks: thread.pendingQuestion !== null,
    confirmedByMe: thread.confirmedByMe,
    holds: thread.heldDraftId !== null,
    status: thread.status,
  });

  return (
    <li className="border-t border-border first:border-t-0">
      <Dialog onOpenChange={setOpen} open={open}>
        <DialogTrigger
          render={
            <Button
              className="flex w-full items-baseline justify-between gap-4 py-3"
              size="none"
              type="button"
              variant="act"
            />
          }
        >
          <span className="type-row min-w-0 flex-1">
            {thread.topic ?? "Без темы"}
            <span className="type-status block text-muted-foreground">
              {peerOf({ label: thread.peerLabel, name: thread.peerName })} ·{" "}
              {broMoment(thread.updatedAt, timeZone)}
            </span>
          </span>
          <span className="type-status flex shrink-0 items-center gap-1 text-muted-foreground">
            {status.mine ? (
              <Badge variant="outline">{status.text}</Badge>
            ) : (
              status.text
            )}
            <ChevronRightIcon aria-hidden="true" className="size-4" />
          </span>
        </DialogTrigger>
        <DialogContent
          animated={false}
          className="no-scrollbar overflow-y-auto"
          variant="responsive"
        >
          <BroThreadJournal threadId={thread.id} timeZone={timeZone} />
        </DialogContent>
      </Dialog>
    </li>
  );
}

function BroThreadJournal({
  threadId,
  timeZone,
}: {
  readonly threadId: string;
  readonly timeZone: string;
}) {
  const thread = api.broToBro.thread.useQuery({ threadId });

  if (!thread.data) {
    return (
      <DialogHeader className="pr-10 sm:pr-6">
        <DialogTitle className="type-sheet-title">Переговоры</DialogTitle>
        <DialogDescription className="type-fine">
          {thread.error ? broFailure(thread.error) : "Загружаем…"}
        </DialogDescription>
      </DialogHeader>
    );
  }
  return <ThreadView thread={thread.data} timeZone={timeZone} />;
}

const speakers = { peer: "Бро собеседника", self: "Твой Бро" } as const;

/** What a message did besides its words, as one line of the journal. */
function actionLine(
  message: BroThreadView["messages"][number],
  timeZone: string
) {
  if (message.action === "propose" && message.proposal)
    return broProposalLine(message.proposal, timeZone);
  if (message.action === "accept") return "Принимает предложение";
  if (message.action === "decline") return "Отказ";
  if (message.action === "close") return "Закрывает переговоры";
  return null;
}

/**
 * The journal of a thread from this person's side: their own errand,
 * question and held draft, what each Bro said with the proposals in the
 * person's own time, and where both owners stand.
 */
function ThreadView({
  thread,
  timeZone,
}: {
  readonly thread: BroThreadView;
  readonly timeZone: string;
}) {
  const { own, peer } = thread;
  const status = threadStatus({
    asks: own.question !== null,
    confirmedByMe: own.confirmed,
    holds: own.held !== null && !own.held.approved,
    status: thread.status,
  });
  const open = thread.closedAt === null;

  return (
    <>
      <DialogHeader className="pr-10 sm:pr-6">
        <DialogTitle className="type-sheet-title">
          {thread.topic ?? "Без темы"}
        </DialogTitle>
        <DialogDescription className="type-fine">
          {[
            `Собеседник: ${peerOf(peer)}`,
            status.text,
            open ? `до ${broMoment(thread.deadlineAt, timeZone)}` : null,
          ]
            .filter((part) => part !== null)
            .join(" · ")}
        </DialogDescription>
      </DialogHeader>

      {own.goal ? (
        <div>
          <p className="type-field-label text-muted-foreground">
            Твоё поручение — видишь только ты
          </p>
          <p className="type-row wrap-break-word">{own.goal}</p>
          {own.details ? (
            <p className="type-fine wrap-break-word text-muted-foreground">
              {own.details}
            </p>
          ) : null}
        </div>
      ) : null}

      {own.question ? (
        <div className="rounded-3xl border-2 border-foreground p-4">
          <p className="type-field-label text-muted-foreground">
            Бро спрашивает тебя · {broMoment(own.question.at, timeZone)}
          </p>
          <p className="type-row wrap-break-word">{own.question.text}</p>
          <p className="type-fine text-muted-foreground">
            Ответь ему в чате с Бро.
          </p>
        </div>
      ) : null}

      {own.held ? (
        <div className="rounded-3xl border-2 border-foreground p-4">
          <p className="type-field-label text-muted-foreground">
            Бро хочет сказать · {broMoment(own.held.at, timeZone)}
          </p>
          <p className="type-row wrap-break-word">«{own.held.body}»</p>
          {own.held.proposal ? (
            <p className="type-fine text-muted-foreground">
              {broProposalLine(own.held.proposal, timeZone)}
            </p>
          ) : null}
          <p className="type-fine text-muted-foreground">
            {own.held.approved
              ? "Разрешено — уйдёт следующим сообщением."
              : `Задержал до твоего «да»: ${own.held.reason}. Разреши или поправь в чате с Бро.`}
          </p>
        </div>
      ) : null}

      <section aria-label="Журнал переговоров">
        <p className="type-field-label text-muted-foreground">Журнал</p>
        {thread.messages.length === 0 ? (
          <p className="type-fine text-muted-foreground">
            Бро ещё ничего друг другу не сказали.
          </p>
        ) : (
          <ul className="list-none">
            {thread.messages.map((message) => {
              const action = actionLine(message, timeZone);
              return (
                <li
                  className="border-t border-border py-[0.6rem] first:border-t-0 first:pt-[0.2rem]"
                  key={message.id}
                >
                  <p className="type-status text-muted-foreground">
                    {speakers[message.from]} · {broMoment(message.at, timeZone)}
                    {message.approvedByOwner ? " · с твоего разрешения" : ""}
                  </p>
                  <p className="type-row wrap-break-word">{message.body}</p>
                  {action ? (
                    <p className="type-fine text-muted-foreground">{action}</p>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {own.answers.length > 0 ? (
        <section aria-label="Твои ответы Бро">
          <p className="type-field-label text-muted-foreground">
            Твои ответы Бро — видишь только ты
          </p>
          <ul className="list-none">
            {own.answers.map((answer) => (
              <li
                className="border-t border-border py-[0.6rem] first:border-t-0 first:pt-[0.2rem]"
                key={answer.id}
              >
                <p className="type-status text-muted-foreground">
                  {broMoment(answer.at, timeZone)}
                </p>
                <p className="type-row wrap-break-word">{answer.text}</p>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {own.confirmed || own.declined || peer.confirmed || peer.declined ? (
        <p className="type-fine text-muted-foreground">
          {[
            own.confirmed ? "Твоё «да» есть." : null,
            own.declined ? "Твой отказ записан." : null,
            peer.confirmed ? "Собеседник подтвердил." : null,
            peer.declined ? "Собеседник отказался." : null,
            own.calendar === "created" ? "Встреча в твоём календаре." : null,
          ]
            .filter((part) => part !== null)
            .join(" ")}
        </p>
      ) : null}
    </>
  );
}
