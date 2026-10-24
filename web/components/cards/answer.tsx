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
  readonly card?: Card;
  readonly revision?: number;
  readonly changed?: ReadonlySet<number>;
  readonly notice?: string;
  readonly press?: Extract<Reply, { status: "watch" }>["press"];
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
  if (question.type === "field")
    return (
      question.initial ??
      (question.input === "count" || question.input === "slider"
        ? String(question.min ?? 0)
        : "")
    );
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
  body: z.input<typeof respondRequestSchema>,
  signal?: AbortSignal
) {
  const response = await fetch(`/api/cards/${link}/respond`, {
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
    method: "POST",
    referrerPolicy: "strict-origin",
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(10_000)])
      : AbortSignal.timeout(10_000),
  });
  if (response.status >= 500) throw new Error("The card's server failed.");
  return respondReplySchema.parse(await response.json());
}

/**
 * Holds the answer of the card `link` opens, at `revision`, for its
 * questions and buttons.
 */
export function CardAnswerScope({
  card: sentCard,
  children,
  link,
  revision: sentRevision,
}: {
  readonly card: Card;
  readonly children: ReactNode;
  readonly link: string;
  readonly revision: number;
}) {
  const launch = useTelegramLaunch();
  const [{ card, revision }, setCurrent] = useState(() => ({
    card: sentCard,
    revision: sentRevision,
  }));
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
  const [press, setPress] = useState<AnswerContext["press"]>();
  const [notice, setNotice] = useState<string>();
  const [changed, setChanged] = useState<ReadonlySet<number>>(() => new Set());
  const [watchGeneration, setWatchGeneration] = useState(0);
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
          setPress({
            action,
            kind: "submit",
            revision,
            stage: reply.delivery === "failed" ? "failed" : "waiting",
          });
          setWatchGeneration((now) => now + 1);
          haptic(reply.status === "sent" ? "success" : "warning");
          if (reply.delivery === "received") {
            void fetch(cardAnswersPath, {
              keepalive: true,
              method: "POST",
            }).catch(() => undefined);
          }
          return;
        }
        if (reply.status === "intent") {
          setPress(
            reply.press ?? {
              action,
              kind: "intent",
              revision,
              stage: "waiting",
            }
          );
          setNotice(
            reply.outcome === "replaced"
              ? "Последнее нажатие принято. Бро учтёт новые параметры."
              : "Запрос принят. Карточка остаётся открытой."
          );
          setWatchGeneration((now) => now + 1);
          haptic("success");
          void fetch(cardAnswersPath, {
            keepalive: true,
            method: "POST",
          }).catch(() => undefined);
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
      card,
      revision,
      changed,
      notice,
      press,
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
    changed,
    notice,
    press,
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

  const watch = useEffectEvent(async (signal: AbortSignal) => {
    if (!launch) return undefined;
    const reply = await respond(
      link,
      { initData: launch, kind: "watch", revision },
      signal
    );
    if (signal.aborted) return undefined;
    if (reply.status !== "watch") {
      if (reply.status === "unverified" || reply.status === "foreign")
        setVerdict(reply.status);
      else setVerdict("closed");
      return undefined;
    }
    if (reply.card && reply.revision !== revision) {
      const next = reply.card;
      const nextDraft = initialDraft(next);
      const lost: string[] = [];
      for (const question of cardQuestions(next)) {
        const old = cardQuestions(card).find((each) => each.id === question.id);
        if (
          !old ||
          old.type !== question.type ||
          (old.type === "field" &&
            question.type === "field" &&
            old.input !== question.input)
        )
          continue;
        const value = draft[question.id];
        if (value === undefined) continue;
        if (question.type === "choice") {
          const picked = [value].flat();
          const kept = picked.filter((key) =>
            question.options.some((option) => option.value === key)
          );
          if (kept.length !== picked.length) lost.push(question.label);
          nextDraft[question.id] = question.multiple
            ? kept
            : (kept[0] ?? initialValue(question));
        } else nextDraft[question.id] = value;
      }
      const action = next.actions.find(
        (each) => "intent" in each || "submit" in each
      );
      if (action && !("href" in action)) {
        const parsed = cardResponseSchema(next, reply.revision).safeParse({
          action: "intent" in action ? action.intent : action.submit,
          revision: reply.revision,
          values: nextDraft,
        });
        for (const issue of parsed.error?.issues ?? []) {
          const id =
            issue.path[0] === "values" ? String(issue.path[1]) : undefined;
          const question = cardQuestions(next).find((each) => each.id === id);
          if (question) {
            const initial = initialValue(question);
            if (
              JSON.stringify(nextDraft[question.id]) !== JSON.stringify(initial)
            )
              lost.push(question.label);
            nextDraft[question.id] = initial;
          }
        }
      }
      setDraft(nextDraft);
      setCurrent({ card: next, revision: reply.revision });
      setChanged(
        new Set(
          next.blocks.flatMap((block, index) =>
            JSON.stringify(block) === JSON.stringify(card.blocks[index])
              ? []
              : [index]
          )
        )
      );
      setTouched(new Set());
      setServerErrors({});
      setFailure(undefined);
      setAnswered(undefined);
      setVerdict("open");
      setNotice(
        lost.length > 0
          ? `Карточка обновлена. Проверьте выбор: ${lost.join(", ")}.`
          : "Бро обновил карточку. Ваши параметры сохранены."
      );
      keepDraft(`bro-card:${link}:${String(reply.revision)}`, nextDraft);
    }
    if (reply.answer) {
      setAnswered({
        action: reply.answer.answer.action,
        delivery: reply.answer.delivery,
      });
      setDraft(answerDraft(reply.card ?? card, reply.answer.answer));
      setVerdict("sent");
    }
    setPress(reply.press);
    return reply.press?.stage;
  });

  const canWatch = viewer === "open" || viewer === "sent" || viewer === "stale";
  const watching =
    canWatch &&
    !(
      viewer === "sent" &&
      (press?.stage === "done" || press?.stage === "failed")
    );
  useEffect(() => {
    if (!launch || !canWatch) return undefined;
    const controller = new AbortController();
    const stopped = () => controller.signal.aborted;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let pending = false;
    let failures = 0;
    const started = Date.now();
    async function run() {
      clearTimeout(timer);
      if (stopped() || document.hidden || pending) return;
      pending = true;
      let busy = false;
      try {
        const stage = await watch(controller.signal);
        failures = 0;
        busy =
          stage === "waiting" ||
          stage === "queued" ||
          stage === "working" ||
          stage === "searching";
      } catch {
        failures += 1;
      } finally {
        pending = false;
      }
      if (stopped() || !watching) return;
      const elapsed = Date.now() - started;
      const base = busy
        ? elapsed < 20_000
          ? 2000
          : elapsed < 120_000
            ? 5000
            : 15_000
        : 20_000;
      timer = setTimeout(
        () => {
          void run();
        },
        Math.min(60_000, base * 2 ** failures)
      );
    }
    const visible = () => {
      if (!document.hidden) void run();
    };
    if (watching)
      timer = setTimeout(
        () => {
          void run();
        },
        watchGeneration > 0 ? 300 : 500
      );
    document.addEventListener("visibilitychange", visible);
    window.addEventListener("pageshow", visible);
    return () => {
      controller.abort();
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", visible);
      window.removeEventListener("pageshow", visible);
    };
  }, [launch, canWatch, watching, watchGeneration]);

  return <Answer value={context}>{children}</Answer>;
}
