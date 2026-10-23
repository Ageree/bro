"use client";

import {
  createContext,
  type ReactNode,
  use,
  useEffect,
  useEffectEvent,
  useMemo,
  useState,
} from "react";
import type * as z from "zod";
import {
  respondReplySchema,
  type respondRequestSchema,
} from "@shared/cards/respond";
import {
  type CardAnswer,
  cardDraftSchema,
  cardQuestions,
  cardResponseSchema,
  mainSubmit,
} from "@shared/cards/response";
import { cardAnswersPath } from "@shared/cards/routes";
import type { Card } from "@shared/cards/schema";
import { haptic, useTelegramLaunch } from "./telegram";

/**
 * The answer of an interactive card on its page (`docs/cards.md`,
 * «Интерактивные карточки»): what the person chose and typed so far, who
 * they are to this card, and what the submit buttons did. The page asks the
 * server first whether the viewer is the person the card was sent to
 * (`POST /api/cards/[id]/respond`); only they may answer, and only they see
 * the answer kept. The same checks the server makes run here first
 * (`cardResponseSchema`), so a button only sends what the server takes.
 *
 * A draft stays in the tab (`sessionStorage`) through a reload and goes to
 * the server only with a press of a button.
 */

type Draft = z.infer<typeof cardDraftSchema>;
type Reply = z.infer<typeof respondReplySchema>;
type Kept = Extract<Reply, { answer: CardAnswer }>;

/**
 * Who the viewer is to the card: `preview` — no page around it; `checking` —
 * not known yet; `outside` — opened outside Telegram; `unverified` —
 * Telegram's data did not check out; `foreign` — someone else's card;
 * `closed` — it takes no answers; `stale` — it changed since the page
 * loaded; `unreachable` — the server did not answer; `open` — theirs to
 * answer; `sent` — answered.
 */
type Viewer =
  | "checking"
  | "closed"
  | "foreign"
  | "open"
  | "outside"
  | "preview"
  | "sent"
  | "stale"
  | "unreachable"
  | "unverified";

interface AnswerContext {
  readonly answered?: {
    readonly action: string;
    readonly delivery: Kept["delivery"];
  };
  readonly draft: Draft;
  readonly errors: Readonly<Record<string, string>>;
  readonly failure?: { readonly action?: string; readonly message: string };
  readonly ready: (action: string) => boolean;
  readonly retry: () => void;
  readonly sending?: string;
  readonly set: (id: string, value: string | string[]) => void;
  readonly submit: (action: string) => void;
  readonly touch: (id: string) => void;
  readonly viewer: Viewer;
}

/** A question's own value before anyone answered: its `initial`. */
export function initialValue(
  question: ReturnType<typeof cardQuestions>[number]
) {
  if (question.type === "field") return question.initial ?? "";
  return question.multiple ? question.initial : (question.initial[0] ?? "");
}

/** The card's own values before anyone answered. */
function initialDraft(card: Card): Draft {
  return Object.fromEntries(
    cardQuestions(card).map((question) => [question.id, initialValue(question)])
  );
}

/** A kept answer as the questions show it: a number as a field's text. */
function answerDraft(card: Card, answer: CardAnswer): Draft {
  return Object.fromEntries(
    cardQuestions(card).map((question) => {
      const picked = [answer.values[question.id] ?? []].flat().map(String);
      return [
        question.id,
        question.type === "choice" && question.multiple
          ? picked
          : (picked[0] ?? ""),
      ];
    })
  );
}

/** The tab's draft of the card, if it kept one and it still reads as one. */
function storedDraft(key: string) {
  try {
    return cardDraftSchema.safeParse(
      JSON.parse(sessionStorage.getItem(key) ?? "null")
    ).data;
  } catch {
    return undefined;
  }
}

/**
 * Keeps the draft in the tab, or drops it with `undefined`: whether the tab
 * could. A webview without storage keeps none, and the draft lives as long
 * as the page.
 */
function keepDraft(key: string, draft: Draft | undefined) {
  try {
    if (draft === undefined) sessionStorage.removeItem(key);
    else sessionStorage.setItem(key, JSON.stringify(draft));
    return true;
  } catch {
    return false;
  }
}

const Answer = createContext<AnswerContext | null>(null);

/**
 * The answer a card's questions and buttons show. Outside `CardAnswerScope`
 * — a card drawn without its page — they show the card as it was sent
 * (`initialValue`) and take nothing.
 */
export function useCardAnswer(): AnswerContext {
  const answer = use(Answer);
  if (answer !== null) return answer;
  return {
    draft: {},
    errors: {},
    ready: () => false,
    retry: () => undefined,
    set: () => undefined,
    submit: () => undefined,
    touch: () => undefined,
    viewer: "preview",
  };
}

const unreachable =
  "Не получилось связаться с Бро. Проверьте интернет и попробуйте ещё раз.";

const secretMessages = {
  "card-number":
    "Похоже на номер карты. Его в карточке не передают: уберите номер, а Бро спросит в чате, если нужно.",
  document:
    "Похоже на номер паспорта или СНИЛС. Его в карточке не передают: уберите номер.",
  secret:
    "Похоже на пароль или код. Их в карточке не передают: уберите его, а Бро спросит в чате, если нужно.",
} as const;

/**
 * Asks the card's route: the page's own policy is no-referrer, under which a
 * POST goes out with `Origin: null`, so this one sends the origin, which the
 * route checks. A server that failed throws, as a lost connection does.
 */
async function respond(
  link: string,
  body: z.input<typeof respondRequestSchema>
) {
  const response = await fetch(`/api/cards/${link}/respond`, {
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
    method: "POST",
    referrerPolicy: "strict-origin",
  });
  if (response.status >= 500) throw new Error("The card's server failed.");
  return respondReplySchema.parse(await response.json());
}

/**
 * Holds the answer of the card `link` opens, at `revision`, for its
 * questions and buttons.
 */
export function CardAnswerScope({
  card,
  children,
  link,
  revision,
}: {
  readonly card: Card;
  readonly children: ReactNode;
  readonly link: string;
  readonly revision: number;
}) {
  const launch = useTelegramLaunch();
  const storageKey = `bro-card:${link}:${String(revision)}`;
  const schema = useMemo(
    () => cardResponseSchema(card, revision),
    [card, revision]
  );
  const [verdict, setVerdict] = useState<Viewer>();
  const [draft, setDraft] = useState<Draft>(() => initialDraft(card));
  const [touched, setTouched] = useState<ReadonlySet<string>>(() => new Set());
  const [serverErrors, setServerErrors] = useState<
    Readonly<Record<string, string>>
  >({});
  const [answered, setAnswered] = useState<AnswerContext["answered"]>();
  const [sending, setSending] = useState<string>();
  const [failure, setFailure] = useState<AnswerContext["failure"]>();
  const viewer: Viewer =
    launch === null
      ? "checking"
      : launch === ""
        ? "outside"
        : (verdict ?? "checking");

  const { apply, context } = useMemo(() => {
    const issuesOf = (action: string) =>
      Object.fromEntries(
        (
          schema.safeParse({ action, revision, values: draft }).error?.issues ??
          []
        ).flatMap((issue) =>
          issue.path[0] === "values" && issue.path.length > 1
            ? [[String(issue.path[1]), issue.message]]
            : []
        )
      );
    const settle = (reply: Reply) => {
      if (reply.status === "sent" || reply.status === "answered") {
        setDraft(answerDraft(card, reply.answer));
        setAnswered({ action: reply.answer.action, delivery: reply.delivery });
        setVerdict("sent");
        keepDraft(storageKey, undefined);
        return;
      }
      if (reply.status === "open") {
        const stored = storedDraft(storageKey);
        if (stored !== undefined) setDraft((now) => ({ ...now, ...stored }));
        setVerdict("open");
        return;
      }
      setVerdict(
        reply.status === "foreign" ||
          reply.status === "unverified" ||
          reply.status === "stale"
          ? reply.status
          : "closed"
      );
    };
    const send = async (action: string, initData: string) => {
      setSending(action);
      setFailure(undefined);
      try {
        const reply = await respond(link, {
          action,
          initData,
          kind: "send",
          revision,
          values: draft,
        });
        if (reply.status === "sent" || reply.status === "answered") {
          settle(reply);
          haptic(reply.status === "sent" ? "success" : "warning");
          if (reply.delivery === "received") {
            void fetch(cardAnswersPath, {
              keepalive: true,
              method: "POST",
            }).catch(() => undefined);
          }
          return;
        }
        haptic("error");
        if (reply.status === "invalid") {
          setServerErrors(
            Object.fromEntries(
              reply.issues.flatMap((issue) =>
                issue.id === null ? [] : [[issue.id, issue.message]]
              )
            )
          );
          setFailure({ message: "Проверьте ответы: что-то не подошло." });
        } else if (reply.status === "secret") {
          setServerErrors({ [reply.id]: secretMessages[reply.kind] });
          setFailure({ message: "Ответ не отправлен: уберите отмеченное." });
        } else if (reply.status === "busy") {
          setFailure({
            action,
            message:
              "Слишком много ответов подряд. Попробуйте через пару минут.",
          });
        } else {
          settle(reply);
        }
      } catch {
        haptic("error");
        setFailure({ action, message: unreachable });
      } finally {
        setSending(undefined);
      }
    };
    const submit = (action: string) => {
      if (viewer !== "open" || sending !== undefined || !launch) return;
      const [first] = Object.keys(issuesOf(action));
      if (first === undefined) {
        void send(action, launch);
        return;
      }
      setTouched(new Set(cardQuestions(card).map((question) => question.id)));
      haptic("error");
      document.getElementById(`card-question-${first}`)?.focus();
    };
    const main = mainSubmit(card)?.submit;
    const value: AnswerContext = {
      answered,
      draft,
      errors: {
        ...Object.fromEntries(
          Object.entries(main === undefined ? {} : issuesOf(main)).filter(
            ([id]) => touched.has(id)
          )
        ),
        ...serverErrors,
      },
      failure,
      ready: (action) =>
        viewer === "open" && Object.keys(issuesOf(action)).length === 0,
      retry: () => {
        if (viewer === "unreachable") {
          setVerdict(undefined);
          return;
        }
        if (failure?.action !== undefined) submit(failure.action);
      },
      sending,
      set: (id, next) => {
        if (viewer !== "open" || sending !== undefined) return;
        const updated = { ...draft, [id]: next };
        setDraft(updated);
        setServerErrors((now) =>
          Object.fromEntries(Object.entries(now).filter(([key]) => key !== id))
        );
        setFailure(undefined);
        keepDraft(storageKey, updated);
      },
      submit,
      touch: (id) => {
        setTouched((now) => new Set([...now, id]));
      },
      viewer,
    };
    return { apply: settle, context: value };
  }, [
    answered,
    card,
    draft,
    failure,
    launch,
    link,
    revision,
    schema,
    sending,
    serverErrors,
    storageKey,
    touched,
    viewer,
  ]);

  const opened = useEffectEvent((reply: Reply | undefined) => {
    if (reply === undefined) setVerdict("unreachable");
    else apply(reply);
  });

  useEffect(() => {
    if (!launch || verdict !== undefined) return undefined;
    let current = true;
    const ask = async () => {
      const reply = await respond(link, {
        initData: launch,
        kind: "open",
        revision,
      }).catch(() => undefined);
      if (current) opened(reply);
    };
    void ask();
    return () => {
      current = false;
    };
  }, [launch, link, revision, verdict]);

  return <Answer value={context}>{children}</Answer>;
}
