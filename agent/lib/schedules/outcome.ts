import {
  endsWithEmptyDeliveryMarker,
  withoutEmptyDeliveryMarker,
} from "@agent/lib/delivery/empty";
import {
  type ScheduledRunOutcome,
  scheduledRunOutcomeSchema,
} from "@shared/schedules/outcome";

/**
 * «Передавать нечего» as the whole last sentence. «Остальное передавать
 * нечего» after a flight is a handover and does not match.
 */
const nothingToHandOver =
  /(?:^|[.!?\n]\s*)(?:передавать нечего|нечего передавать|nothing to (?:hand over|pass on|report))[.!]?$/iu;

/**
 * What a background worker's reply hands over, or nothing. eve's empty
 * delivery marker is the worker's verdict only as its whole reply or its last
 * word, after the reasoning a worker writes first («Разряды: … рассылка.
 * Передавать нечего.» and then the marker). Named anywhere else it is left out
 * and the rest goes on: on 26.09 a worker put the marker down mid-reply, took
 * it back and wrote a flight reminder and a phishing warning, and the whole
 * reply was dropped as saying nothing.
 */
function handover(reply: string) {
  if (endsWithEmptyDeliveryMarker(reply)) return undefined;
  const text = withoutEmptyDeliveryMarker(reply);
  return text && !nothingToHandOver.test(text) ? text : undefined;
}

/**
 * Whether a finished run's outcome is worth a report turn. Given one for a
 * result that hands nothing over, the report turn told the person «почту и
 * календарь проверил — нового ничего».
 */
export function reportNeeded(outcome: ScheduledRunOutcome) {
  return outcome.kind !== "result" || handover(outcome.summary) !== undefined;
}

/**
 * How a worker says its handover cannot wait for the morning: the handover
 * opens with exactly this. Only Bro's own checks are held overnight, and only
 * a handover so marked — a flight within hours, a real security alert — goes
 * out during the person's night.
 */
export const urgentHandoverMarker = "[срочно]";

// At the start of any line, since a worker often writes its reasoning before
// the handover; bold or italic around it still counts: «**[срочно]**».
const urgentHandover = /^([ \t]*[*_]*)\[(?:срочно|urgent)\][ \t]*/imu;
const bareEmphasisLine = /^[ \t]*[*_]+[ \t]*$/gmu;

/** The outcome a background worker's final reply records. */
export function workerOutcome(
  message: string | null | undefined
): ScheduledRunOutcome {
  const reply = message ?? "";
  const urgent = urgentHandover.test(reply);
  const summary = handover(
    urgent
      ? reply.replace(urgentHandover, "$1").replace(bareEmphasisLine, "")
      : reply
  );
  return scheduledRunOutcomeSchema.parse(
    summary
      ? {
          kind: "result",
          summary: summary.slice(0, 4_000),
          urgency: urgent ? "time_sensitive" : "normal",
        }
      : {
          kind: "nothing_to_report",
          reason: "The scheduled task produced no useful update.",
        }
  );
}
