"use client";

import { Check, RotateCw } from "lucide-react";
import type { Card } from "@shared/cards/schema";
import { cn } from "@web/components/class-names";
import { Button } from "@web/components/ui/button";
import { Spinner } from "@web/components/ui/spinner";
import { useCardAnswer } from "./answer";
import { BackToBro } from "./telegram";

type Submit = Extract<Card["actions"][number], { submit: string }>;
type Intent = Extract<Card["actions"][number], { intent: string }>;

/**
 * A button that sends the card's answer (`docs/cards.md`, «Как это
 * выглядит»): a pill like a link's, which reads as not yet available (45%)
 * while the answer it would send is not complete — a press then shows what
 * is missing instead of sending — turns into «Отправляю…» while it goes,
 * and into «Отправлено» with a tick once the answer is kept; the card's
 * other submit buttons go then. A viewer who may not answer gets none.
 */
export function SubmitButton({ action }: { readonly action: Submit | Intent }) {
  const answer = useCardAnswer();
  const id = "submit" in action ? action.submit : action.intent;
  const primary = "submit" in action && action.primary;
  if (answer.viewer === "sent") {
    if (answer.answered?.action !== id) return null;
    return (
      <p className="type-act flex min-h-11 w-full items-center justify-center gap-1.5 rounded-full border-2 border-success-border bg-success-subtle px-6 py-2.5 text-success">
        <Check aria-hidden className="size-4 stroke-3" />
        Отправлено
      </p>
    );
  }
  if (
    answer.viewer !== "open" &&
    answer.viewer !== "checking" &&
    answer.viewer !== "preview"
  ) {
    return null;
  }
  const sending = answer.sending === id;
  const ready = answer.ready(id) && answer.sending === undefined;
  return (
    <Button
      aria-busy={sending ? true : undefined}
      aria-disabled={ready ? undefined : true}
      className={cn("w-full", !ready && !sending && "opacity-45")}
      onClick={() => {
        answer.submit(id);
      }}
      size="paper"
      variant={primary ? "paper" : "outline"}
    >
      {sending ? (
        <>
          <Spinner />
          Отправляю…
        </>
      ) : (
        action.label
      )}
    </Button>
  );
}

/** Why this viewer cannot answer, by who they are to the card. */
const notes: ReadonlyMap<string, string> = new Map(
  Object.entries({
    closed: "Эта карточка больше не принимает ответы.",
    foreign:
      "Эту карточку Бро прислал другому человеку: посмотреть её можно, а ответить может только он.",
    outside:
      "Ответить можно в Telegram: откройте карточку кнопкой под сообщением Бро.",
    stale: "Бро обновил карточку, пока она была открыта.",
    unreachable:
      "Не получилось связаться с Бро. Проверьте интернет и попробуйте ещё раз.",
    unverified:
      "Не получилось проверить, что карточку открыли вы. Откройте её заново кнопкой под сообщением Бро.",
  })
);

/**
 * What became of the answer, under the buttons: kept and on its way to Bro,
 * with the way back to the chat; not sent, and why, with a retry; or why
 * this viewer cannot answer at all. Read out as it changes.
 */
export function AnswerStatus() {
  const answer = useCardAnswer();
  const { failure, viewer } = answer;
  return (
    <div aria-live="polite" className="flex flex-col gap-3 empty:hidden">
      {answer.notice && (
        <p className="type-caption text-muted-foreground">{answer.notice}</p>
      )}
      {answer.press &&
        ["waiting", "queued", "working", "searching"].includes(
          answer.press.stage
        ) && (
          <p className="type-row flex items-center gap-2 text-muted-foreground">
            <Spinner />
            {answer.press.stage === "searching"
              ? "Бро ищет на сайте — результат появится здесь"
              : answer.press.stage === "queued"
                ? "Последний запрос принят. Бро закончит предыдущий"
                : "Бро работает — карточку можно не закрывать"}
          </p>
        )}
      {answer.press?.kind === "intent" && answer.press.stage === "failed" && (
        <p className="type-row text-bro-error">
          Запрос не дошёл. Нажмите кнопку ещё раз.
        </p>
      )}
      {answer.press?.kind === "intent" && answer.press.stage === "done" && (
        <p className="type-caption text-muted-foreground">
          Бро завершил запрос.
        </p>
      )}
      {viewer === "sent" && (
        <>
          <p className="type-row text-muted-foreground">
            {answer.answered?.delivery === "failed"
              ? "Ответ не дошёл до Бро. Напишите ему в чат, что выбрали."
              : "Ответ у Бро: он продолжит в чате."}
          </p>
          <BackToBro />
        </>
      )}
      {viewer === "open" && failure !== undefined && (
        <div className="flex flex-col gap-2" role="alert">
          <p className="type-row text-bro-error">{failure.message}</p>
          {failure.action !== undefined && (
            <Button
              className="self-start"
              onClick={answer.retry}
              size="sm"
              variant="outline"
            >
              <RotateCw data-icon="inline-start" />
              Повторить
            </Button>
          )}
        </div>
      )}
      {notes.has(viewer) && (
        <p className="type-row text-muted-foreground" role="note">
          {notes.get(viewer)}
        </p>
      )}
      {viewer === "stale" && (
        <Button
          onClick={() => {
            window.location.reload();
          }}
          size="paper"
          variant="outline"
        >
          Обновить
        </Button>
      )}
      {viewer === "unreachable" && (
        <Button
          className="self-start"
          onClick={answer.retry}
          size="sm"
          variant="outline"
        >
          <RotateCw data-icon="inline-start" />
          Повторить
        </Button>
      )}
    </div>
  );
}
