import type { JsonValue } from "eve/connections";
import { z } from "zod";
import {
  countFailedPeople,
  workspaceAccounts,
  workspaceLabel,
} from "@db/services/turn-log";
import { alertOwner } from "@agent/lib/owner-alert";

/**
 * The same failure of one workspace is told once an hour: a RouterAI 402
 * fails every message of a person who keeps writing.
 */
const repeatAfterMs = 60 * 60_000;

/**
 * A model provider that is out of balance (402), limiting (429) or down
 * (5xx) fails everyone at once: one alert for all people, keyed by the
 * code alone, says how many it reached — not one per person.
 */
const providerOutagePattern = /^MODEL_CALL_FAILED (?:402|429|5\d\d)$/u;

const failureDetailsSchema = z
  .object({
    statusCode: z.number().optional(),
    upstreamStatusCode: z.number().optional(),
  })
  .optional();

/**
 * The code a failed turn is filed under: eve's code and, for a model call,
 * the provider's HTTP status — a 402 (balance) and a 400 (a rejected
 * request) are different failures for the owner.
 */
export function turnFailureCode(failure: {
  readonly code: string;
  readonly details?: JsonValue;
}) {
  const details = failureDetailsSchema.safeParse(failure.details).data;
  const status = details?.upstreamStatusCode ?? details?.statusCode;
  return status === undefined
    ? failure.code
    : `${failure.code} ${String(status)}`;
}

const moscowTime = new Intl.DateTimeFormat("ru-RU", {
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  month: "2-digit",
  timeZone: "Europe/Moscow",
});

/**
 * Tells the owner that a person's turn failed: who (the account's name and
 * phone or email), the channel, the code and when — never what was said. A
 * provider's outage is one alert for everyone (`providerOutagePattern`).
 * Never throws: the turn has already failed, and the alert is the owner's.
 */
export async function alertTurnFailure(failure: {
  readonly at: Date;
  readonly channel: string;
  readonly errorCode: string;
  readonly workspaceId: string;
}) {
  try {
    const accounts = await workspaceAccounts([failure.workspaceId]);
    const who = workspaceLabel(
      failure.workspaceId,
      accounts.get(failure.workspaceId)
    );
    const when = `Время: ${moscowTime.format(failure.at)} МСК`;
    if (providerOutagePattern.test(failure.errorCode)) {
      const people = await countFailedPeople(
        failure.errorCode,
        new Date(failure.at.getTime() - repeatAfterMs)
      );
      await alertOwner(
        `turn-failed:provider:${failure.errorCode}`,
        [
          "Сбой провайдера модели: ходы людей падают",
          `Код: ${failure.errorCode}`,
          `Людей за последний час: ${String(Math.max(people, 1))}`,
          `Последний: ${who}, ${failure.channel}`,
          when,
        ].join("\n"),
        { now: failure.at, repeatAfterMs }
      );
      return;
    }
    await alertOwner(
      `turn-failed:${failure.workspaceId}:${failure.errorCode}`,
      [
        "Сбой хода у человека",
        `Кто: ${who}`,
        `Канал: ${failure.channel}`,
        `Код: ${failure.errorCode}`,
        when,
      ].join("\n"),
      { now: failure.at, repeatAfterMs }
    );
  } catch (error) {
    console.warn("[turn-log] the failure alert was not sent", {
      cause: error instanceof Error ? error.name : "unknown",
      errorCode: failure.errorCode,
    });
  }
}
