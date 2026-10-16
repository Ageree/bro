import { z } from "zod";
import type { resolveModeValue } from "@agent/lib/mode";
import { env } from "@shared/environment";

/**
 * The pilot of one-offs on the clock of an event elsewhere
 * (SCHEDULE_EVENT_ZONE_WORKSPACES, docs/roadmap.md item 18): a step before an
 * event in another city, above all online check-in before a flight, is set
 * as the event itself on its own clock and how long before it to run
 * (`minutesBefore`), and code subtracts that on the event's clock
 * (`resolveScheduleTiming`). How long before a flight check-in opens is the
 * airline's, which code does not know: the model says it.
 * Ids only, or `*`, so the verdict needs no lookup.
 */
export function eventZonePilot(workspaceId: string | undefined) {
  const list = env.SCHEDULE_EVENT_ZONE_WORKSPACES ?? [];
  return (
    workspaceId !== undefined &&
    (list.includes("*") || list.includes(workspaceId))
  );
}

/** Whether this turn's workspace is in the pilot, whoever started the turn. */
export function eventZoneOfCaller(
  context: Parameters<typeof resolveModeValue>[0]
) {
  const caller = context.session.auth.current ?? context.session.auth.initiator;
  if (caller?.principalType !== "user") return false;
  return eventZonePilot(
    z.string().min(1).safeParse(caller.attributes.workspaceId).data
  );
}

/**
 * The lines of Bro's instructions the pilot reads otherwise. Outside it they
 * set a later step at the moment it opens; the pilot's `schedules-create`
 * takes the event itself, and a model reading both would subtract the day
 * twice. Each pair is text as `agent/instructions/content/**` has it and as
 * the pilot reads it; outside the pilot nothing changes, byte for byte
 * (`tests/agent/skills/flag-off.test.ts`), and a test holds every line to
 * its source.
 */
export const eventZoneRewrites = [
  // follow-through.md, in full and in the schedules skill. The core keeps
  // its line within its budget: the skill comes with `schedules-create`.
  [
    "Заведи `schedules-create` на момент, когда шаг станет возможен (`once`; ежемесячный — `calendar`)",
    "Заведи `schedules-create` на момент, когда шаг станет возможен (`once`; ежемесячный — `calendar`; регистрация на рейс — `once` с `at` самого вылета по часам аэропорта, его `timezone` и `minutesBefore` — упреждением авиакомпании: вылет минус момент открытия регистрации из `Next` отчёта или по правилам авиакомпании, 1440 — только если момент неизвестен)",
  ],
  // role/interactive.md, the schedules skill.
  [
    "другую — только если он её назвал («по Нью-Йорку»).",
    "другую — только если он её назвал («по Нью-Йорку») или для шага перед событием в другом городе: регистрация на рейс — `at` самого вылета по часам аэропорта, `timezone` этого аэропорта и `minutesBefore` — упреждение авиакомпании (вылет минус момент открытия регистрации; 1440 — только если момент неизвестен).",
  ],
] as const;

/** A text as the pilot reads it. */
export function withEventZoneRules(text: string) {
  return eventZoneRewrites.reduce(
    (rewritten, [line, pilotLine]) => rewritten.replaceAll(line, pilotLine),
    text
  );
}

/**
 * What a browser report adds in the pilot after its later-step instruction
 * (`laterStepInstruction`), which sets the step at the moment it opens.
 */
export const laterStepEventZoneNote =
  "For check-in before a flight, schedules-create takes the departure itself, not the moment check-in opens: kind once with at the departure on its airport's clock, timezone that airport's IANA zone and minutesBefore the airline's lead, the departure minus the moment check-in opens from Next or the airline's rules; 1440 only when that moment is unknown.";
