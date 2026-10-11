import { defineState, type SessionContext } from "eve/context";
import { startedByPerson } from "@agent/lib/mode";
import { scopeFromPrincipal } from "@agent/lib/principal-scope";

const goTurn = defineState<{
  turnId: string | null;
  userId: string | null;
  workspaceId: string | null;
  words: string[];
  background: boolean;
}>("bro.go-person-turn", () => ({
  turnId: null,
  userId: null,
  workspaceId: null,
  words: [],
  background: false,
}));

const directBooking =
  /^(?:(?:бро|bro|пожалуйста|please)[\s,!:—-]+)*(?:вызови|закажи|вызвать|заказать|заказывай|вызывай|book|order|call)(?!\p{L})[\s,]*(?:пожалуйста[\s,]+|please\s+)?(?:мне\s+|нам\s+|для\s+меня\s+|me\s+|us\s+|a\s+|an\s+)?(?:такси|taxi|cab)(?!\p{L})/iu;
const qualifiedBooking =
  /(?<!\p{L})(?:не|нет|нельзя|если|когда|потом|завтра|после|сначала|только|узнай|сколько|стоимость|цену|цены|максимум|бюджет|лимит|до\s*[-+]?\d|without|don't|do\s+not|if|later|tomorrow|first|only|price|cost|budget|under|max)(?!\p{L})/iu;
const ceilingPattern =
  /(?<!\p{L})(?:до|не\s+дороже|не\s+более|up\s+to|at\s+most|under)\s*((?:\d{1,3}(?:[ \u00a0\u202f]\d{3})+|\d+)(?:[.,]\d{1,2})?)\s*(?:₽|руб(?:лей|ля|ль)?\.?|rub)(?!\p{L})/giu;
const unsupportedRequest =
  /(?<!\p{L})(?:(?:такси|тариф\p{L}*|класс)\s+(?:комфорт\p{L}*|бизнес|премиум|минивэн)|детск\p{L}*\s+кресл\p{L}*|с\s+реб[её]н\p{L}*|рассроч\p{L}*|кредит\p{L}*|comfort\s+taxi|business\s+taxi|premium\s+taxi|child\s+seat|credit)(?!\p{L})/iu;

export function recordGoTurn(
  session: SessionContext["session"],
  source: "start" | "person-message" | "background-message",
  message = ""
) {
  goTurn.update((previous) => {
    if (source === "start")
      return {
        turnId: session.turn.id,
        userId: null,
        workspaceId: null,
        words: [],
        background: false,
      };
    const caller = session.auth.current;
    const scope =
      caller?.principalType === "user" ? scopeFromPrincipal(caller) : null;
    const sameTurn = previous.turnId === session.turn.id;
    const background =
      source === "background-message" ||
      Boolean(session.parent) ||
      !startedByPerson({ session }) ||
      scope === null ||
      (sameTurn && previous.background) ||
      (sameTurn &&
        previous.userId !== null &&
        (previous.userId !== scope.userId ||
          previous.workspaceId !== scope.workspaceId));
    return {
      turnId: session.turn.id,
      userId: scope?.userId ?? null,
      workspaceId: scope?.workspaceId ?? null,
      words: background ? [] : [...(sameTurn ? previous.words : []), message],
      background,
    };
  });
}

export function goBookingRequest(
  session: SessionContext["session"],
  words: readonly string[] | null
) {
  if (session.parent || !startedByPerson({ session }) || words === null)
    return null;
  const caller = session.auth.current;
  if (caller?.principalType !== "user") return null;
  const scope = scopeFromPrincipal(caller);
  try {
    const turn = goTurn.get();
    if (
      turn.turnId !== session.turn.id ||
      turn.background ||
      turn.userId !== scope.userId ||
      turn.workspaceId !== scope.workspaceId ||
      turn.words.length === 0 ||
      turn.words.some((word) => !words.includes(word))
    )
      return null;
    if (
      !turn.words.some((word) => directBooking.test(word.trim())) ||
      turn.words.some((word) => unsupportedRequest.test(word))
    )
      return null;
    const cash = turn.words.some((word) =>
      /(?<!\p{L})(?:наличн\p{L}*|наличк\p{L}*|cash)(?!\p{L})/iu.test(word)
    );
    const card = turn.words.some((word) =>
      /(?<!\p{L})(?:картой|с\s+(?:моей\s+|банковской\s+)?карты|card)(?!\p{L})/iu.test(
        word
      )
    );
    if (cash && card) return null;
    const payment = cash
      ? ("CASH" as const)
      : card
        ? ("SAVED_CARD" as const)
        : null;
    const ceilings = turn.words.flatMap((word) => [
      ...word.matchAll(ceilingPattern),
    ]);
    if (
      ceilings.length > 1 ||
      turn.words.some(
        (word) =>
          qualifiedBooking.test(word.replaceAll(ceilingPattern, "")) ||
          /[-+]?\d[\d\s.,]*\s*(?:₽|руб\p{L}*|rub|usd|eur|\$|€)(?!\p{L})/iu.test(
            word.replaceAll(ceilingPattern, "")
          ) ||
          /(?<!\p{L})(?:картой|с\s+карты)\s*\d/iu.test(word)
      )
    )
      return null;
    const amount = ceilings[0]?.[1];
    if (amount === undefined) return { quoteCeilingMinor: null, payment };
    const [whole, fraction = ""] = amount
      .replaceAll(/[ \u00a0\u202f]/gu, "")
      .replace(",", ".")
      .split(".");
    if (whole === undefined) return null;
    const minor = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"));
    return minor <= BigInt(Number.MAX_SAFE_INTEGER)
      ? { quoteCeilingMinor: Number(minor), payment }
      : null;
  } catch {
    return null;
  }
}
