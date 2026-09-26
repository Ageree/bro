import {
  type ScheduledRunOutcome,
  scheduledRunOutcomeSchema,
} from "@shared/schedules/outcome";

/**
 * The marker a background worker ends with when it has nothing to hand over.
 * eve turns a reply that is exactly this into no message at all, but a
 * worker often writes its reasoning first — «Разряды: … рассылка, не
 * передаётся. Передавать нечего.» — and then the marker, and that reply
 * reached the report turn as a result to tell the person about.
 */
const emptyDeliveryMarker =
  /<eve-empty-delivery\/>|&lt;eve-empty-delivery\/&gt;/u;
const everyEmptyDeliveryMarker =
  /<eve-empty-delivery\/>|&lt;eve-empty-delivery\/&gt;/gu;
const endsWithEmptyDelivery =
  /(?:<eve-empty-delivery\/>|&lt;eve-empty-delivery\/&gt;)\s*$/u;

/**
 * The same said in words, as the whole last sentence. «Остальное передавать
 * нечего» after a flight is a handover and does not match.
 */
const nothingToHandOver =
  /(?:^|[.!?\n]\s*)(?:передавать нечего|нечего передавать|nothing to (?:hand over|pass on|report))[.!]?$/iu;

/**
 * Nothing to hand over: the reply is only the empty-delivery marker, or it
 * ends with that marker (reasoning, then the decision that there is nothing).
 * Naming the marker and then writing the handover — «the marker is not right
 * here», followed by the flight — is still a handover.
 */
function saysNothing(summary: string) {
  const trimmed = summary.trim();
  if (nothingToHandOver.test(trimmed)) return true;
  if (!emptyDeliveryMarker.test(trimmed)) return false;
  const rest = trimmed.replace(everyEmptyDeliveryMarker, "").trim();
  return rest.length === 0 || endsWithEmptyDelivery.test(trimmed);
}

/**
 * Whether a finished run's outcome is worth a report turn. A reply that is
 * the empty-delivery marker, or that ends with it, hands over nothing: the
 * report turn given that text told the person «почту и календарь проверил —
 * нового ничего». A handover that only mentions the marker and then says
 * what happened still goes out.
 */
export function reportNeeded(outcome: ScheduledRunOutcome) {
  return !(outcome.kind === "result" && saysNothing(outcome.summary));
}

/**
 * How a worker says its handover cannot wait for the morning: the first line
 * is exactly this. Only Bro's own checks are held overnight, and only a
 * handover so marked — a flight within hours, a real security alert — goes
 * out during the person's night.
 */
export const urgentHandoverMarker = "[срочно]";

// Bold or italic around the marker still counts: «**[срочно]**».
const urgentHandover = /^\s*[*_]*\[(?:срочно|urgent)\][*_]*\s*/iu;

/** The outcome a background worker's final reply records. */
export function workerOutcome(
  message: string | null | undefined
): ScheduledRunOutcome {
  const text = message?.trim();
  const urgent = text !== undefined && urgentHandover.test(text);
  const unmarked = urgent ? text.replace(urgentHandover, "").trim() : text;
  // Decide from the reply as written. A kept handover then loses the marker,
  // so the report turn does not read it as «say nothing».
  const summary =
    unmarked === undefined || saysNothing(unmarked)
      ? undefined
      : unmarked.replace(everyEmptyDeliveryMarker, "").trim();
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
