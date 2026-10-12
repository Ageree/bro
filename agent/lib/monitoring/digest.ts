import { summarizeOwnerDay } from "@db/services/turn-log";
import { alertOwner } from "@agent/lib/owner-alert";
import { env } from "@shared/environment";

const dayMs = 24 * 60 * 60_000;
/**
 * The summary is said once a day: the hourly tick that sends it, on one
 * instance or several, claims it past the rest of the day's send hours.
 */
const repeatAfterMs = 20 * 60 * 60_000;
/**
 * How many hours from OWNER_DIGEST_HOUR on a tick still tries: a send that
 * failed (Telegram, the database) is tried again at the next ticks, and
 * the claim above keeps the day's summary to one.
 */
const sendHours = 4;
/** The most people the summary names by cost. */
const costLines = 15;

const moscowHour = new Intl.DateTimeFormat("en-GB", {
  hour: "2-digit",
  hourCycle: "h23",
  timeZone: "Europe/Moscow",
});

const kindNames = new Map([
  ["person", "сообщения людей"],
  ["browser-report", "отчёты браузера"],
  ["background", "фоновые и расписания"],
  ["task", "помощник"],
]);

function rub(value: number) {
  return `${value.toFixed(2)} ₽`;
}

/** A day's summary (`summarizeOwnerDay`) as the owner reads it. */
export function ownerDigestText(
  day: Awaited<ReturnType<typeof summarizeOwnerDay>>
) {
  const turns = Object.values(day.turnsByKind).reduce((a, b) => a + b, 0);
  const total = day.costs.reduce((sum, row) => sum + row.costRub, 0);
  const lines = [
    "Сводка за сутки",
    `Активных людей: ${String(day.activePeople)}`,
    `Ходов: ${String(turns)}${
      turns === 0
        ? ""
        : ` (${Object.entries(day.turnsByKind)
            .map(
              ([kind, count]) =>
                `${kindNames.get(kind) ?? kind} — ${String(count)}`
            )
            .join(", ")})`
    }`,
    day.failures.length === 0
      ? "Сбоев нет"
      : `Сбои: ${day.failures
          .map((row) => `${row.errorCode} — ${String(row.turns)}`)
          .join(", ")}`,
    `Расход: ${rub(total)}`,
    ...day.costs
      .slice(0, costLines)
      .map((row) => `  ${row.label}: ${rub(row.costRub)}`),
    ...(day.costs.length > costLines
      ? [`  и ещё ${String(day.costs.length - costLines)}`]
      : []),
    day.signedUp.length === 0
      ? "Новых регистраций нет"
      : `Новые регистрации (${String(day.signedUp.length)}): ${day.signedUp.join(", ")}`,
  ];
  return lines.join("\n");
}

/**
 * Sends the owner the summary of the last 24 hours, once a day, from
 * OWNER_DIGEST_HOUR (Moscow time) for `sendHours` hours until it is sent.
 * False outside those hours, when the day's summary was already sent, or
 * when no alert chat is configured.
 */
export async function sendOwnerDigest(now = new Date()) {
  const sinceHour =
    (Number(moscowHour.format(now)) - env.OWNER_DIGEST_HOUR + 24) % 24;
  if (sinceHour >= sendHours) return false;
  const day = await summarizeOwnerDay({
    from: new Date(now.getTime() - dayMs),
    to: now,
  });
  return alertOwner("owner-digest", ownerDigestText(day), {
    kind: "digest",
    now,
    repeatAfterMs,
  });
}
