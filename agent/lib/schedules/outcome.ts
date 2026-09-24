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

/**
 * The same said in words, as the whole last sentence. «Остальное передавать
 * нечего» after a flight is a handover and does not match.
 */
const nothingToHandOver =
  /(?:^|[.!?\n]\s*)(?:передавать нечего|нечего передавать|nothing to (?:hand over|pass on|report))[.!]?$/iu;

function saysNothing(summary: string) {
  return (
    emptyDeliveryMarker.test(summary) || nothingToHandOver.test(summary.trim())
  );
}

/**
 * Whether a finished run's outcome is worth a report turn. A worker's
 * `<eve-empty-delivery/>` never appears inside a real handover (the proactive
 * worker's instructions say so), so any result carrying it hands over
 * nothing, and the report turn given it anyway told the person «почту и
 * календарь проверил — нового ничего».
 */
export function reportNeeded(outcome: ScheduledRunOutcome) {
  return !(outcome.kind === "result" && saysNothing(outcome.summary));
}

/** The outcome a background worker's final reply records. */
export function workerOutcome(
  message: string | null | undefined
): ScheduledRunOutcome {
  const summary = message?.trim();
  return scheduledRunOutcomeSchema.parse(
    summary && !saysNothing(summary)
      ? { kind: "result", summary: summary.slice(0, 4_000), urgency: "normal" }
      : {
          kind: "nothing_to_report",
          reason: "The scheduled task produced no useful update.",
        }
  );
}
