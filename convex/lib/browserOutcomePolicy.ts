/**
 * Structured Cloud outcome parser («НУЖНО» protocol, goal.md §1).
 *
 * The scaffold (agent/lib/browseruse.ts scaffoldTask / browser-pay.ts
 * payScaffold) ends every Cloud run with a mandatory labelled block:
 *   СДЕЛАНО / ЗАКАЗ / СУММА / КОГДА / ВАРИАНТЫ / НУЖНО / ДЕТАЛИ
 * This module turns that block (or, for a run started under the old
 * free-text scaffold, a heuristic guess) into one clean `CloudOutcome`.
 * Everything downstream (inject decisions, wakeup phase, the human-facing
 * "нужно X" line) reads `needs` off this, not free-text regexes.
 */

export type CloudNeed =
  | "none"
  | "sms_code"
  | "email_code"
  | "push"
  | "3ds"
  | "captcha"
  | "password"
  | "address"
  | "payment"
  | "info";

export type CloudOutcome = {
  done?: string;
  orderId?: string;
  amountRub?: number;
  when?: string;
  options?: string[];
  needs: CloudNeed;
  detail?: string;
  /** true when the result carried a real НУЖНО/NEEDS label — false means the
   *  `needs` field below is a best-effort guess over free text. */
  labelled: boolean;
};

const NEED_VALUES: ReadonlySet<string> = new Set<CloudNeed>([
  "none",
  "sms_code",
  "email_code",
  "push",
  "3ds",
  "captcha",
  "password",
  "address",
  "payment",
  "info",
]);

/** «нет» / «none» / «-» / «—» / «н/д» all mean "nothing in this field". */
const EMPTYISH = /^(?:нет|none|-|—|н\/д)$/iu;

/**
 * One labelled line, tolerating the two decorations a chat model adds to a
 * list it was asked for in prose: a leading bullet («- НУЖНО: none») and
 * markdown bold («**НУЖНО:** none»). Neither used to parse, and the cost of
 * missing the label is not a missing field — `parseCloudOutcome` falls back
 * to guessing `needs` off free text, which drives the inject decisions and
 * the «нужно X» line the human reads.
 *
 * This matters more now that the errand asks for the block in one short
 * sentence instead of four lines of formatting instructions: the shorter the
 * ask, the more the run formats the answer its own way.
 */
function grabLabel(result: string, labels: readonly string[]): string | undefined {
  for (const label of labels) {
    const re = new RegExp(
      `^[ \\t]*(?:[-*•]+[ \\t]*)?\\*{0,2}${label}\\*{0,2}[ \\t]*:[ \\t]*(.+)$`,
      "imu",
    );
    const m = result.match(re);
    // A bolded label often closes after the colon («**СДЕЛАНО:** заказал») and
    // sometimes around the value itself — the asterisks are never the value.
    if (m?.[1] !== undefined) return m[1].replace(/^\*+|[\s*]+$/gu, "").trim();
  }
  return undefined;
}

function cleanValue(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (!trimmed || EMPTYISH.test(trimmed)) return undefined;
  return trimmed;
}

function parseRub(raw: string): number | undefined {
  const compact = raw.replace(/[^\d.,]/g, "").replace(",", ".");
  if (!compact) return undefined;
  const n = Number(compact);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return Math.round(n);
}

// Fallback for a run started before the labelled scaffold shipped (or one
// that skipped the block despite instructions) — same spirit as the old
// browserInjectPolicy.resultWaitsForCode regex sniffing, one guess each.
// Order matters: a more specific channel word (почта/пуш/3ds/капча/пароль/
// адрес) wins over the generic "код" catch-all, so "код пришёл на почту"
// resolves to email_code, not sms_code.
const HEURISTIC: ReadonlyArray<readonly [RegExp, CloudNeed]> = [
  [/почт|e-?mail/iu, "email_code"],
  [/пуш|push|приложени/iu, "push"],
  [/3[-\s]?d[-\s]?secure|3ds/iu, "3ds"],
  [/капч|captcha/iu, "captcha"],
  [/парол/iu, "password"],
  [/адрес/iu, "address"],
  [/sms|смс|код/iu, "sms_code"],
];

// A channel word alone is not enough — a successful order confirmation can
// easily say "код заказа 12345" or "доставка по адресу Ленина 5" without
// asking the human for anything. Only fire the heuristic when the text also
// reads like the Cloud agent stopped and is waiting on the human.
const ASK_CONTEXT =
  /нужен|нужно|требует|введите|ожида|жду|остановил|не могу продолжить|needs user input|requires|подтвердите/iu;

function heuristicNeed(text: string): CloudNeed {
  if (!ASK_CONTEXT.test(text)) return "none";
  for (const [re, need] of HEURISTIC) {
    if (re.test(text)) return need;
  }
  return "none";
}

/**
 * Labelled lines first (case-insensitive, `NEEDS:` tolerated as an alias of
 * `НУЖНО:`). Falls back to a heuristic guess over free text only when no
 * НУЖНО/NEEDS label is present at all — that is the signal a run predates
 * the labelled scaffold (or the model skipped the block).
 */
export function parseCloudOutcome(
  result: string | null | undefined,
  _opts?: { status?: string },
): CloudOutcome {
  const text = (result ?? "").trim();
  if (!text) return { needs: "none", labelled: false };

  const needsRaw = grabLabel(text, ["НУЖНО", "NEEDS"]);
  if (needsRaw === undefined) {
    return { needs: heuristicNeed(text), labelled: false };
  }
  const candidate = needsRaw.trim().toLowerCase().replace(/\s+/gu, "_");
  const needs = (
    NEED_VALUES.has(candidate) ? candidate : heuristicNeed(text)
  ) as CloudNeed;

  const done = cleanValue(grabLabel(text, ["СДЕЛАНО"]));
  const orderId = cleanValue(grabLabel(text, ["ЗАКАЗ"]));
  const sumRaw = cleanValue(grabLabel(text, ["СУММА"]));
  const when = cleanValue(grabLabel(text, ["КОГДА"]));
  const optsRaw = cleanValue(grabLabel(text, ["ВАРИАНТЫ"]));
  const detail = cleanValue(grabLabel(text, ["ДЕТАЛИ"]));
  const amountRub = sumRaw !== undefined ? parseRub(sumRaw) : undefined;
  const options = optsRaw
    ? optsRaw
        .split(/;\s*|\n/u)
        .map((s) => s.trim())
        .filter(Boolean)
        .slice(0, 5)
    : undefined;

  return {
    ...(done ? { done } : {}),
    ...(orderId ? { orderId } : {}),
    ...(amountRub !== undefined ? { amountRub } : {}),
    ...(when ? { when } : {}),
    ...(options && options.length > 0 ? { options } : {}),
    needs,
    ...(detail ? { detail } : {}),
    labelled: true,
  };
}

/** Every value except "none" means the errand is parked on a human. */
export function needsHuman(need: CloudNeed | string | undefined): boolean {
  return typeof need === "string" && need !== "none" && NEED_VALUES.has(need);
}

/**
 * Fluent Russian line Bro sends when a Cloud run is parked on `need`. Never
 * asks for a password, never quotes a code, never uses an English word.
 */
export function humanLineForNeed(
  need: CloudNeed,
  opts?: { site?: string; liveUrl?: string; detail?: string },
): string {
  const liveUrl = opts?.liveUrl?.trim();
  const detail = opts?.detail?.trim();
  const withLink = (line: string): string => (liveUrl ? `${line}\n\n${liveUrl}` : line);
  switch (need) {
    case "sms_code":
      return "Нужен код из SMS — пришли его сюда, введу сам.";
    case "email_code":
      return "Код ушёл на почту, сейчас гляну.";
    case "push":
      return "Подтверди вход в приложении банка/Яндекса и напиши «готово».";
    case "3ds":
      return withLink(
        "Банк просит подтвердить оплату — открой ссылку, подтверди и напиши «готово».",
      );
    case "captcha":
      return withLink("Сайт показал капчу — реши по ссылке и напиши «готово».");
    case "password": {
      if (liveUrl) {
        return withLink("Нужен вход — открой ссылку и войди, пароль я не увижу.");
      }
      const where = opts?.site ? ` на ${opts.site}` : "";
      return `Нужен вход${where} — сохранённого логина нет. Добавь его в сейф, и я продолжу.`;
    }
    case "address":
      return detail ? `Не хватает адреса — ${detail}` : "Куда доставить? Уточни адрес.";
    case "payment":
      return detail ? `Не хватает оплаты — ${detail}` : "Чем платить — картой из сейфа?";
    case "info":
      return detail ?? "Не хватает данных, чтобы закончить — уточни детали.";
    case "none":
    default:
      return "";
  }
}

/** 1–2 line «готово»-draft the model may reuse verbatim or paraphrase. */
export function doneLineHint(outcome: CloudOutcome): string {
  const lines: string[] = [outcome.done ? `Готово: ${outcome.done}.` : "Готово."];
  const facts: string[] = [];
  if (outcome.orderId) facts.push(`заказ №${outcome.orderId}`);
  if (outcome.amountRub !== undefined) facts.push(`${outcome.amountRub} ₽`);
  if (outcome.when) facts.push(outcome.when);
  if (facts.length > 0) lines.push(`${facts.join(", ")}.`);
  if (outcome.options && outcome.options.length > 0) {
    lines.push(`Варианты: ${outcome.options.join("; ")}.`);
  }
  return lines.join("\n");
}
